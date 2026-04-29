const { test } = require('node:test');
const assert = require('node:assert');

const {
  createMarketAlertsScheduler,
  getETDateKey,
  isRTH,
  evaluate,
  extractContext,
  buildMessage,
} = require('./market-alerts');

// ── Fakes ─────────────────────────────────────────────────────────────

// In-memory dedup DB. Réplique exactement le contrat de db/sqlite.js :
// markAlertFired() retourne true ssi cet appel a inséré (atomique).
function makeFakeDb() {
  const fired = new Map(); // key = ticker|alertType|etDate
  return {
    alertWasFired(ticker, alertType, etDate) {
      return fired.has(ticker + '|' + alertType + '|' + etDate);
    },
    markAlertFired(ticker, alertType, etDate, firedAtMs) {
      const key = ticker + '|' + alertType + '|' + etDate;
      if (fired.has(key)) return false;
      fired.set(key, firedAtMs);
      return true;
    },
    _dump() { return new Map(fired); },
  };
}

// Market client fake — satisfait le contrat { getQuote, getDailyBars }.
// `quotes[ticker] = { price, volume }` ou Error pour tester les pannes.
// `bars[ticker] = [bar, ...]` ou Error.
function makeFakeMarket({ quotes = {}, bars = {} } = {}) {
  const calls = { quote: 0, dailyBars: 0 };
  return {
    calls,
    async getQuote(ticker) {
      calls.quote++;
      const v = quotes[ticker];
      if (v instanceof Error) throw v;
      return v != null ? v : null;
    },
    async getDailyBars(ticker) {
      calls.dailyBars++;
      const v = bars[ticker];
      if (v instanceof Error) throw v;
      return v != null ? v : [];
    },
  };
}

// Sink pour sendAlert — collecte les messages.
function makeSink() {
  const messages = [];
  const fn = async (msg) => { messages.push(msg); };
  return { fn, messages };
}

// Helper pour générer une bar daily Yahoo-shape.
function bar(dateIso, { open = 100, high = 101, low = 99, close = 100, volume = 1_000_000 } = {}) {
  return { date: new Date(dateIso), open, high, low, close, volume };
}

// Silent logger pour ne pas polluer la sortie test.
const silent = { log() {}, error() {}, warn() {} };

// Quiet logger qui ravale tout — par défaut dans les tests pour éviter
// le bruit. Si besoin de debug, remplacer par `console`.
const TEST_LOGGER = silent;

// ── Tests purs ────────────────────────────────────────────────────────

test('getETDateKey returns ET date for UTC instant just after midnight ET', () => {
  // 2026-04-28T04:01:00Z = 00:01 ET 2026-04-28 (EDT, UTC-4)
  assert.strictEqual(getETDateKey(new Date('2026-04-28T04:01:00Z')), '2026-04-28');
});

test('getETDateKey returns previous ET date for UTC instant just before midnight ET', () => {
  // 2026-04-28T03:00:00Z = 23:00 ET 2026-04-27 (EDT)
  assert.strictEqual(getETDateKey(new Date('2026-04-28T03:00:00Z')), '2026-04-27');
});

test('isRTH true at 09:30 ET Monday, false at 09:29 ET, false at 16:00 ET, false on Saturday', () => {
  // 2026-04-27 is a Monday. 09:30 EDT = 13:30 UTC.
  assert.strictEqual(isRTH(new Date('2026-04-27T13:30:00Z')), true,  '09:30 ET Mon');
  assert.strictEqual(isRTH(new Date('2026-04-27T13:29:00Z')), false, '09:29 ET Mon');
  assert.strictEqual(isRTH(new Date('2026-04-27T20:00:00Z')), false, '16:00 ET Mon (closed at 16:00)');
  assert.strictEqual(isRTH(new Date('2026-04-27T19:59:00Z')), true,  '15:59 ET Mon');
  // 2026-04-25 = Saturday
  assert.strictEqual(isRTH(new Date('2026-04-25T15:00:00Z')), false, 'Saturday');
});

test('evaluate fires yday_high when price strictly above yesterday high', () => {
  const fires = evaluate({
    snap: { price: 101, todayVolume: 0 },
    ctx:  { yHigh: 100, yLow: 90, weekHigh: 105, weekLow: 85, yVolume: 0 },
  });
  assert.deepStrictEqual(fires, ['yday_high']);
});

test('evaluate fires yday_low when price strictly below yesterday low', () => {
  const fires = evaluate({
    snap: { price: 89, todayVolume: 0 },
    ctx:  { yHigh: 100, yLow: 90, weekHigh: 105, weekLow: 85, yVolume: 0 },
  });
  assert.deepStrictEqual(fires, ['yday_low']);
});

test('evaluate fires both yday_high AND week_high when price exceeds both', () => {
  const fires = evaluate({
    snap: { price: 110, todayVolume: 0 },
    ctx:  { yHigh: 100, yLow: 90, weekHigh: 109, weekLow: 85, yVolume: 0 },
  });
  assert.deepStrictEqual(fires, ['yday_high', 'week_high']);
});

test('evaluate volume_spike threshold edges (9.9% no, 10% yes, 11% yes)', () => {
  const ctxBase = { yHigh: 1e9, yLow: 0, weekHigh: 1e9, weekLow: 0, yVolume: 100_000 };
  // 9.9% above → 109,900. Threshold = 110,000. Should NOT fire.
  let fires = evaluate({
    snap: { price: 1, todayVolume: 109_900 },
    ctx: ctxBase,
  });
  assert.deepStrictEqual(fires, []);
  // Exactly 10% (1.10×) → 110,000. Should fire (>=).
  fires = evaluate({
    snap: { price: 1, todayVolume: 110_000 },
    ctx: ctxBase,
  });
  assert.deepStrictEqual(fires, ['volume_spike']);
  // 11% → 111,000. Should fire.
  fires = evaluate({
    snap: { price: 1, todayVolume: 111_000 },
    ctx: ctxBase,
  });
  assert.deepStrictEqual(fires, ['volume_spike']);
});

test('evaluate does not fire volume_spike when yVolume is 0 (avoids div-by-zero on illiquid)', () => {
  const fires = evaluate({
    snap: { price: 1, todayVolume: 1_000_000 },
    ctx:  { yHigh: 1e9, yLow: 0, weekHigh: 1e9, weekLow: 0, yVolume: 0 },
  });
  assert.deepStrictEqual(fires, []);
});

test('evaluate returns [] when snap or ctx is null', () => {
  assert.deepStrictEqual(evaluate({ snap: null, ctx: { yHigh: 1 } }), []);
  assert.deepStrictEqual(evaluate({ snap: { price: 1 }, ctx: null }), []);
});

test('extractContext takes last bar before today as yesterday', () => {
  // Today = 2026-04-28 ET. Bars Mon 21 .. Mon 27.
  const bars = [
    bar('2026-04-21T20:00:00Z', { high: 95, low: 90, volume: 100 }),  // Tue
    bar('2026-04-22T20:00:00Z', { high: 96, low: 91, volume: 110 }),  // Wed
    bar('2026-04-23T20:00:00Z', { high: 97, low: 92, volume: 120 }),  // Thu
    bar('2026-04-24T20:00:00Z', { high: 98, low: 93, volume: 130 }),  // Fri
    bar('2026-04-27T20:00:00Z', { high: 99, low: 94, volume: 140 }),  // Mon (yesterday)
  ];
  const ctx = extractContext(bars, '2026-04-28');
  assert.strictEqual(ctx.yHigh, 99);
  assert.strictEqual(ctx.yLow, 94);
  assert.strictEqual(ctx.yVolume, 140);
  assert.strictEqual(ctx.weekHigh, 99);
  assert.strictEqual(ctx.weekLow, 90);
});

test('extractContext on Monday correctly picks Friday as yesterday (skips weekend)', () => {
  // Today = Monday 2026-04-27. Yahoo only returns trading days, so the
  // last bar before Monday is Friday — no special-casing needed.
  const bars = [
    bar('2026-04-20T20:00:00Z', { high: 90, low: 85 }),
    bar('2026-04-21T20:00:00Z', { high: 91, low: 86 }),
    bar('2026-04-22T20:00:00Z', { high: 92, low: 87 }),
    bar('2026-04-23T20:00:00Z', { high: 93, low: 88 }),
    bar('2026-04-24T20:00:00Z', { high: 94, low: 89, volume: 999 }), // Friday
  ];
  const ctx = extractContext(bars, '2026-04-27');
  assert.strictEqual(ctx.yHigh, 94, 'Friday is yesterday on Monday');
  assert.strictEqual(ctx.yLow, 89);
  assert.strictEqual(ctx.yVolume, 999);
});

test('extractContext with fewer than 5 sessions still computes weekly window', () => {
  const bars = [
    bar('2026-04-23T20:00:00Z', { high: 100, low: 90 }),
    bar('2026-04-24T20:00:00Z', { high: 105, low: 95 }),
    bar('2026-04-27T20:00:00Z', { high: 110, low: 80 }),
  ];
  const ctx = extractContext(bars, '2026-04-28');
  assert.strictEqual(ctx.weekHigh, 110);
  assert.strictEqual(ctx.weekLow, 80);
});

test('extractContext returns null when no past bars exist', () => {
  // All bars are today or future.
  const bars = [bar('2026-04-28T15:00:00Z', { high: 100, low: 90 })];
  assert.strictEqual(extractContext(bars, '2026-04-28'), null);
});

test('extractContext returns null on empty bars', () => {
  assert.strictEqual(extractContext([], '2026-04-28'), null);
  assert.strictEqual(extractContext(null, '2026-04-28'), null);
});

test('buildMessage formats yday_high in plain English with prices', () => {
  const msg = buildMessage('yday_high', 'AAPL',
    { price: 185.42, todayVolume: 0 },
    { yHigh: 184.10 });
  assert.match(msg, /\*\*AAPL\*\* broke yesterday/);
  assert.match(msg, /\$185\.42/);
  assert.match(msg, /\$184\.10/);
});

test('buildMessage formats volume_spike with percentage', () => {
  const msg = buildMessage('volume_spike', 'TSLA',
    { price: 200, todayVolume: 88_200_000 },
    { yVolume: 72_500_000 });
  assert.match(msg, /\*\*TSLA\*\* volume spike/);
  assert.match(msg, /88\.2M/);
  assert.match(msg, /72\.5M/);
  assert.match(msg, /\+21\.7%/);
});

// ── Tests scheduler/integration ───────────────────────────────────────

test('tick is a no-op outside RTH (no Yahoo calls, no alerts)', async () => {
  const market = makeFakeMarket({});
  const sink = makeSink();
  const db = makeFakeDb();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db,
    now: () => new Date('2026-04-27T13:29:00Z'), // 09:29 ET — pre-RTH
    logger: TEST_LOGGER,
  });
  const r = await s.tick();
  assert.strictEqual(r.skipped, 'not-RTH');
  assert.strictEqual(market.calls.quote, 0);
  assert.strictEqual(market.calls.dailyBars, 0);
  assert.strictEqual(sink.messages.length, 0);
});

test('tick is a no-op on weekend', async () => {
  const market = makeFakeMarket({});
  const sink = makeSink();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db: makeFakeDb(),
    now: () => new Date('2026-04-25T15:00:00Z'), // Saturday
    logger: TEST_LOGGER,
  });
  const r = await s.tick();
  assert.strictEqual(r.skipped, 'not-RTH');
});

test('tick is a no-op when tickers list is empty', async () => {
  const market = makeFakeMarket({});
  const sink = makeSink();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: [],
    db: makeFakeDb(),
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  const r = await s.tick();
  assert.strictEqual(r.skipped, 'no-tickers');
  assert.strictEqual(market.calls.quote, 0);
});

// Helper: bars where price 101.5 breaks ONLY yesterday's high, not the
// rolling 5-day high. We seed an earlier bar (Tue Apr 21) with high=120
// so the weekHigh ceiling stays out of reach AND remains in the last-5
// window even on Tue (when Mon Apr 27 also enters the slice).
function barsYdayHighOnly() {
  return [
    bar('2026-04-21T20:00:00Z', { high: 120, low: 90, volume: 100 }),  // ceiling
    bar('2026-04-22T20:00:00Z', { high: 99,  low: 90, volume: 100 }),
    bar('2026-04-23T20:00:00Z', { high: 99,  low: 90, volume: 100 }),
    bar('2026-04-24T20:00:00Z', { high: 100, low: 95, volume: 200 }),  // Fri = yesterday
  ];
}

test('tick fires yday_high alert exactly once on first cross', async () => {
  // Today = Mon 2026-04-27 ET, RTH. Yesterday's bar = Friday with high=100.
  // Earlier-week bar has high=120, so week_high stays unbroken.
  const market = makeFakeMarket({
    quotes: {
      AAPL: { price: 101.5, volume: 50 },
    },
    bars: { AAPL: barsYdayHighOnly() },
  });
  const sink = makeSink();
  const db = makeFakeDb();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db,
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  assert.strictEqual(sink.messages.length, 1, 'first tick fires once (yday_high only)');
  assert.match(sink.messages[0], /\*\*AAPL\*\*.*yesterday/);
});

test('dedup: same alert never fires twice on same ET date', async () => {
  // Price 101.5 breaks only yday_high (week ceiling = 120).
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 101.5, volume: 50 } },
    bars: { AAPL: barsYdayHighOnly() },
  });
  const sink = makeSink();
  const db = makeFakeDb();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db,
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  await s.tick();
  await s.tick();
  assert.strictEqual(sink.messages.length, 1, 'three ticks → one alert');
});

test('dedup: next ET trading day re-allows the same alert', async () => {
  // Two days of charts: today=Mon picks Fri as yday; tomorrow=Tue picks Mon as yday.
  // Both setups have an earlier high=120 to keep weekHigh out of reach.
  // The 120-high bar sits at Apr 21 (Tuesday) so it's in BOTH the 5-day
  // window viewed from Mon (past = Apr 20-24, slice(-5) = Apr 20-24) AND
  // from Tue (past = Apr 20-27, slice(-5) = Apr 21-27). Otherwise on Tue
  // the ceiling falls out and week_high also fires → spurious extra alert.
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 101.5, volume: 50 } },
    bars: {
      AAPL: [
        bar('2026-04-21T20:00:00Z', { high: 120, low: 90, volume: 100 }),  // Tue, ceiling
        bar('2026-04-22T20:00:00Z', { high: 99,  low: 90, volume: 100 }),
        bar('2026-04-23T20:00:00Z', { high: 99,  low: 90, volume: 100 }),
        bar('2026-04-24T20:00:00Z', { high: 100, low: 95, volume: 200 }),  // Fri = yday on Mon
        bar('2026-04-27T20:00:00Z', { high: 100, low: 95, volume: 200 }),  // Mon = yday on Tue
      ],
    },
  });
  const sink = makeSink();
  const db = makeFakeDb();
  let nowDate = new Date('2026-04-27T15:00:00Z');
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db,
    now: () => nowDate,
    logger: TEST_LOGGER,
  });
  await s.tick();
  // Same day: no second alert.
  await s.tick();
  assert.strictEqual(sink.messages.length, 1);
  // Next trading day (Tue 2026-04-28).
  nowDate = new Date('2026-04-28T15:00:00Z');
  await s.tick();
  assert.strictEqual(sink.messages.length, 2, 'fires again on next ET date');
});

test('daily context cache: 1 chart call per ticker for the same ET date', async () => {
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 50, volume: 50 } },
    bars: { AAPL: [bar('2026-04-24T20:00:00Z', { high: 100, low: 40, volume: 200 })] },
  });
  const sink = makeSink();
  const db = makeFakeDb();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db,
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  await s.tick();
  await s.tick();
  assert.strictEqual(market.calls.dailyBars, 1, 'cache hit on subsequent ticks');
  // Quote cache is the Yahoo client's responsibility — here our fake
  // counts every call. We verify the alerts module re-asks each tick.
  assert.strictEqual(market.calls.quote, 3);
});

test('daily context cache resets on ET-date rollover', async () => {
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 50, volume: 50 } },
    bars: {
      AAPL: [
        bar('2026-04-24T20:00:00Z', { high: 100, low: 40, volume: 200 }),
        bar('2026-04-27T20:00:00Z', { high: 110, low: 50, volume: 200 }),
      ],
    },
  });
  const sink = makeSink();
  const db = makeFakeDb();
  let nowDate = new Date('2026-04-27T15:00:00Z');
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db,
    now: () => nowDate,
    logger: TEST_LOGGER,
  });
  await s.tick();
  assert.strictEqual(market.calls.dailyBars, 1);
  nowDate = new Date('2026-04-28T15:00:00Z');
  await s.tick();
  assert.strictEqual(market.calls.dailyBars, 2, 'refetch on new ET date');
});

test('no-data: getChart returns empty quotes → no alerts, no errors', async () => {
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 100, volume: 50 } },
    bars: { AAPL: [] },
  });
  const sink = makeSink();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db: makeFakeDb(),
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  assert.strictEqual(sink.messages.length, 0);
});

test('no-data: getQuote returns null → no alerts', async () => {
  const market = makeFakeMarket({
    quotes: { AAPL: null },
    bars: { AAPL: [bar('2026-04-24T20:00:00Z', { high: 100, low: 95 })] },
  });
  const sink = makeSink();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db: makeFakeDb(),
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  assert.strictEqual(sink.messages.length, 0);
});

test('sendAlert failure does not poison dedup (alert lost rather than spammed)', async () => {
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 101.5, volume: 50 } },
    bars: { AAPL: barsYdayHighOnly() },
  });
  let attempts = 0;
  const failingSend = async () => { attempts++; throw new Error('discord 500'); };
  const db = makeFakeDb();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: failingSend,
    tickers: ['AAPL'],
    db,
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  await s.tick();
  await s.tick();
  // First tick attempts the send (and fails). Subsequent ticks see the
  // dedup row and skip — preferred trade-off vs spam-on-retry.
  assert.strictEqual(attempts, 1, 'only one send attempt — dedup persisted on failure');
});

test('multiple alert types in one tick — all fire once each', async () => {
  // Price breaks both yday_high AND week_high; volume above 110% threshold.
  const market = makeFakeMarket({
    quotes: { AAPL: { price: 200, volume: 200_000 } },
    bars: {
      AAPL: [
        bar('2026-04-23T20:00:00Z', { high: 150, low: 100, volume: 100_000 }),
        bar('2026-04-24T20:00:00Z', { high: 160, low: 110, volume: 100_000 }),
        bar('2026-04-27T20:00:00Z', { high: 170, low: 120, volume: 100_000 }),
      ],
    },
  });
  const sink = makeSink();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL'],
    db: makeFakeDb(),
    now: () => new Date('2026-04-28T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  // Expected: yday_high, week_high, volume_spike. yday_low/week_low don't fire.
  assert.strictEqual(sink.messages.length, 3);
  const types = sink.messages.map(m => {
    if (/volume spike/.test(m)) return 'volume_spike';
    if (/5-day high/.test(m)) return 'week_high';
    if (/yesterday/.test(m)) return 'yday_high';
    return 'unknown';
  });
  assert.deepStrictEqual(types.sort(), ['volume_spike', 'week_high', 'yday_high']);
});

test('getYesterdayContext skips a missing trading day (holiday robustness)', () => {
  // Gap between Friday and Tuesday — Monday holiday. extractContext just
  // takes the last past bar regardless.
  const bars = [
    bar('2026-04-17T20:00:00Z', { high: 90, low: 85 }),  // Fri
    bar('2026-04-21T20:00:00Z', { high: 95, low: 88 }),  // Tue (after Mon holiday)
    bar('2026-04-22T20:00:00Z', { high: 96, low: 89 }),  // Wed
  ];
  const ctx = extractContext(bars, '2026-04-23');  // today = Thursday
  assert.strictEqual(ctx.yHigh, 96, 'Wednesday is yesterday — gap was transparent');
});

test('error in getQuote is caught — does not crash tick or block other tickers', async () => {
  const market = makeFakeMarket({
    quotes: {
      AAPL: new Error('yahoo down'),
      MSFT: { price: 101.5, volume: 50 },
    },
    bars: {
      AAPL: barsYdayHighOnly(),
      MSFT: barsYdayHighOnly(),
    },
  });
  const sink = makeSink();
  const s = createMarketAlertsScheduler({
    marketClient: market,
    sendAlert: sink.fn,
    tickers: ['AAPL', 'MSFT'],
    db: makeFakeDb(),
    now: () => new Date('2026-04-27T15:00:00Z'),
    logger: TEST_LOGGER,
  });
  await s.tick();
  // AAPL errored, MSFT still fired its alert.
  assert.strictEqual(sink.messages.length, 1);
  assert.match(sink.messages[0], /MSFT/);
});
