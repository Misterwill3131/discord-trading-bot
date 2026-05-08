const { test } = require('node:test');
const assert = require('node:assert');
const { isUSMarketOpen } = require('./trend-scanner');

// Build a Date from a "wall-clock ET" specification by computing the
// corresponding UTC. The trick: hard-code the UTC offset for the case
// at hand (EST = -5, EDT = -4). Tests below use canonical examples.
//
// Helper: New York 2026-04-30 is in EDT (UTC-4).
// 2026-12-15 is in EST (UTC-5).
function utcFromET(yyyy, mm, dd, hh, mi, isDST) {
  const offset = isDST ? 4 : 5;
  return new Date(Date.UTC(yyyy, mm - 1, dd, hh + offset, mi, 0));
}

test('isUSMarketOpen: weekday 10:00 ET (EDT) is open', () => {
  const d = utcFromET(2026, 4, 30, 10, 0, true); // Thursday Apr 30, 2026
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 9:29 ET is closed (pre-open)', () => {
  const d = utcFromET(2026, 4, 30, 9, 29, true);
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 9:30 ET is open (boundary)', () => {
  const d = utcFromET(2026, 4, 30, 9, 30, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 16:00 ET is closed (boundary)', () => {
  const d = utcFromET(2026, 4, 30, 16, 0, true);
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 15:59 ET is open', () => {
  const d = utcFromET(2026, 4, 30, 15, 59, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: Saturday 12:00 ET is closed', () => {
  const d = utcFromET(2026, 5, 2, 12, 0, true); // Saturday May 2, 2026
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: Sunday 12:00 ET is closed', () => {
  const d = utcFromET(2026, 5, 3, 12, 0, true); // Sunday
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 10:00 ET in winter (EST) is open', () => {
  const d = utcFromET(2026, 12, 15, 10, 0, false); // Tuesday Dec 15, 2026 (EST)
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 10:00 ET on March DST switch day is open', () => {
  // 2026 DST starts Sunday March 8. Monday March 9 is EDT.
  const d = utcFromET(2026, 3, 9, 10, 0, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

const Database = require('better-sqlite3');
const { createTrendStore } = require('../db/trend-store');
const { runScanCycle } = require('./trend-scanner');

function makeStoreDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trend_watchlist (
      guild_id TEXT NOT NULL, ticker TEXT NOT NULL, added_at INTEGER NOT NULL,
      quote_type TEXT,
      PRIMARY KEY (guild_id, ticker)
    );
    CREATE TABLE trend_channel (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, set_at INTEGER NOT NULL,
      gap_channel_id TEXT,
      direction_disabled INTEGER DEFAULT 0
    );
    CREATE TABLE trend_state (
      ticker TEXT PRIMARY KEY,
      direction TEXT, direction_changed_at INTEGER,
      last_breakout_at INTEGER,
      last_bullish_reversal_at INTEGER,
      last_bearish_reversal_at INTEGER,
      last_scan_at INTEGER,
      daily_state_date TEXT,
      pdh_alerts_today INTEGER DEFAULT 0,
      pdh_below_since INTEGER,
      pdl_alerts_today INTEGER DEFAULT 0,
      pdl_above_since INTEGER,
      pmh_alerts_today INTEGER DEFAULT 0,
      pmh_below_since INTEGER,
      pml_alerts_today INTEGER DEFAULT 0,
      pml_above_since INTEGER,
      gap_alerted_today INTEGER DEFAULT 0,
      volume_above_alerted_today INTEGER DEFAULT 0
    );
  `);
  return { db, store: createTrendStore(db) };
}

// Build candles representing a steady uptrend, suitable for triggering
// "uptrend" direction + a breakout on the last bar.
function uptrendCandles() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const c = 100 + i * 0.5;
    out.push({ t: i, o: c, h: c, l: c, c, v: 1000 });
  }
  // Last bar: above prev high + volume spike.
  const lastClose = out[out.length - 1].c + 0.5;
  out.push({ t: 40, o: out[out.length - 1].c, h: lastClose, l: out[out.length - 1].c, c: lastClose, v: 5000 });
  return out;
}

// Build candles that resolve to "sideways" direction.
// Pattern : uptrend seed (100→105) puis oscillation ±2.5 autour de 105.
// Casse l'alignement EMA9/EMA20/pente requis pour uptrend ou downtrend.
// Same approach as the sideways detectDirection test in trend-engine.test.js.
function sidewaysCandles() {
  const out = [];
  for (let i = 0; i < 20; i++) {
    const c = 100 + i * 0.25;
    out.push({ t: i, o: c, h: c, l: c, c, v: 1000 });
  }
  for (let i = 0; i < 20; i++) {
    const c = 105 + (i % 2 ? -2.5 : 2.5);
    out.push({ t: 20 + i, o: c, h: c, l: c, c, v: 1000 });
  }
  return out;
}

function fakeYahoo(arg) {
  // Backwards-compat: fakeYahoo({ AAPL: [...] }) — old shape, used by existing tests.
  // New shape: fakeYahoo({ intraday: ..., daily: ..., fiveDay: ..., quote: ... })
  const isNewShape = arg && (arg.intraday || arg.daily || arg.fiveDay || arg.quote);
  const intradayMap = isNewShape ? (arg.intraday || {}) : (arg || {});
  const dailyMap    = isNewShape ? (arg.daily || {}) : {};
  const fiveDayMap  = isNewShape ? (arg.fiveDay || {}) : {};
  const quoteMap    = isNewShape ? (arg.quote || {}) : {};

  return {
    getChart: async (ticker, range) => {
      const map = range === '1M' ? dailyMap
                : range === '5D' ? fiveDayMap
                : intradayMap;
      return {
        quotes: (map[ticker] || []).map(b => ({
          date: new Date(b.t),
          open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
        })),
      };
    },
    getQuote: async (ticker) => quoteMap[ticker] || {},
  };
}

function fakeDiscordClient() {
  const sent = [];
  return {
    sent,
    channels: {
      fetch: async (channelId) => ({
        send: async (content) => { sent.push({ channelId, content }); },
      }),
    },
  };
}

test('runScanCycle: no tickers → no alerts', async () => {
  const { store } = makeStoreDb();
  const yahoo = fakeYahoo({});
  const discord = fakeDiscordClient();
  const stats = await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  assert.strictEqual(stats.tickers, 0);
  assert.strictEqual(stats.alerts, 0);
  assert.strictEqual(discord.sent.length, 0);
});

test('runScanCycle: direction transition → alerts dispatched to all watching guilds', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.addToWatchlist('g2', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  store.setChannel('g2', 'c2', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // At least the direction transition (NULL → uptrend) fires.
  assert.ok(discord.sent.length >= 2, 'expected ≥2 messages (one per guild)');
  const channels = discord.sent.map(s => s.channelId);
  assert.ok(channels.includes('c1') && channels.includes('c2'));
  // State persisted.
  assert.strictEqual(store.getState('AAPL').direction, 'uptrend');
});

test('runScanCycle: deduplicates alerts when multiple guilds share the same channel', async () => {
  const { store } = makeStoreDb();
  // Same ticker watched by 4 guilds, all routing to 'shared-c' (same Discord channel).
  store.addToWatchlist('g1', 'AAPL', 1);
  store.addToWatchlist('g2', 'AAPL', 1);
  store.addToWatchlist('g3', 'AAPL', 1);
  store.addToWatchlist('g4', 'AAPL', 1);
  store.setChannel('g1', 'shared-c', 1);
  store.setChannel('g2', 'shared-c', 1);
  store.setChannel('g3', 'shared-c', 1);
  store.setChannel('g4', 'shared-c', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // Each unique (channel, msg.type) sent exactly once, regardless of guild count.
  // We expect at most 1 direction alert + 1 breakout alert (uptrendCandles fires both).
  const directionMsgs = discord.sent.filter(s => /Now: uptrend/.test(s.content));
  assert.strictEqual(directionMsgs.length, 1, 'direction alert should fire only once on shared channel');
  // All sent messages should target the shared channel.
  for (const msg of discord.sent) {
    assert.strictEqual(msg.channelId, 'shared-c');
  }
});

test('runScanCycle: re-running same state → no re-alert', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  const firstCount = discord.sent.length;
  // Run again — same candles, same state → no new alerts (within dedup window).
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 + 60_000 });
  assert.strictEqual(discord.sent.length, firstCount);
});

test('runScanCycle: guild without channel → no dispatch', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  // No setChannel('g1', ...)
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  assert.strictEqual(discord.sent.length, 0);
  // But state still updates globally.
  assert.strictEqual(store.getState('AAPL').direction, 'uptrend');
});

test('runScanCycle: yahoo error on a ticker is skipped, others continue', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.addToWatchlist('g1', 'BAD', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = {
    getChart: async (t, range) => {
      if (t === 'BAD') throw new Error('not found');
      return fakeYahoo({ AAPL: uptrendCandles() }).getChart(t, range);
    },
  };
  const discord = fakeDiscordClient();
  const stats = await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // AAPL alerts go through; BAD is skipped.
  assert.ok(discord.sent.length >= 1);
  assert.strictEqual(stats.errors, 1);
});

test('runScanCycle: deleted channel → cleaned from DB', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const err = new Error('Unknown Channel');
  err.code = 10003;  // Discord.js DiscordAPIError.UnknownChannel
  const discord = {
    channels: {
      fetch: async () => { throw err; },
    },
  };
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  assert.strictEqual(store.getChannel('g1'), null, 'channel should be cleaned');
});

test('runScanCycle: transition to sideways updates state but does NOT alert', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({ AAPL: sidewaysCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // State updated to sideways
  const s = store.getState('AAPL');
  assert.strictEqual(s.direction, 'sideways');
  // No direction alert sent (sideways is filtered out)
  const directionAlert = discord.sent.find(m => /Now: sideways/.test(m.content));
  assert.strictEqual(directionAlert, undefined, 'sideways alert should be suppressed');
});

test('runScanCycle: transition to uptrend (from sideways) DOES alert', async () => {
  const { store } = makeStoreDb();
  // Pre-set state as sideways from a prior scan
  store.applyStateUpdates('AAPL', { direction: 'sideways', direction_changed_at: 500_000 });
  store.addToWatchlist('g1', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // State now uptrend
  assert.strictEqual(store.getState('AAPL').direction, 'uptrend');
  // Alert sent with "Was: sideways · Now: uptrend"
  const directionAlert = discord.sent.find(m => /Was: sideways · Now: uptrend/.test(m.content));
  assert.ok(directionAlert, 'expected sideways → uptrend alert');
});

const { formatDateET } = require('./trend-scanner');

test('formatDateET returns YYYY-MM-DD in NY timezone — EDT case', () => {
  // 2026-05-01 14:00 ET = 2026-05-01 18:00 UTC (EDT = UTC-4)
  const d = new Date(Date.UTC(2026, 4, 1, 18, 0, 0));
  assert.strictEqual(formatDateET(d), '2026-05-01');
});

test('formatDateET returns YYYY-MM-DD in NY timezone — EST case', () => {
  // 2026-12-15 10:00 ET = 2026-12-15 15:00 UTC (EST = UTC-5)
  const d = new Date(Date.UTC(2026, 11, 15, 15, 0, 0));
  assert.strictEqual(formatDateET(d), '2026-12-15');
});

test('formatDateET handles UTC-day-rollover correctly', () => {
  // 2026-05-01 23:30 ET = 2026-05-02 03:30 UTC
  // ET date is still 2026-05-01.
  const d = new Date(Date.UTC(2026, 4, 2, 3, 30, 0));
  assert.strictEqual(formatDateET(d), '2026-05-01');
});

test('formatDateET defaults to current time when no arg', () => {
  const result = formatDateET();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

const { getDailyContext } = require('./trend-scanner');

function makeFakeYahoo(quotesByRange) {
  return {
    getChart: async (ticker, range) => ({
      quotes: (quotesByRange[range] || []).map(b => ({
        date: new Date(b.t),
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      })),
    }),
  };
}

test('getDailyContext: extracts yesterday OHLCV and today open from 1M chart', async () => {
  const yahoo = makeFakeYahoo({
    '1M': [
      { t: 1, o: 100, h: 105, l: 99,  c: 104, v: 8000 },  // dayBefore : high=105, low=99
      { t: 2, o: 104, h: 110, l: 102, c: 108, v: 9500 },  // yesterday : high=110, low=102
      { t: 3, o: 109, h: 112, l: 107, c: 111, v: 5000 },  // today (in progress)
    ],
  });
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.ok(ctx);
  assert.strictEqual(ctx.yesterday.high, 110);
  assert.strictEqual(ctx.yesterday.low, 102);
  assert.strictEqual(ctx.yesterday.close, 108);
  assert.strictEqual(ctx.yesterday.volume, 9500);
  // priorHigh = max(yesterday.high=110, dayBefore.high=105) = 110
  assert.strictEqual(ctx.priorHigh, 110);
  // priorLow  = min(yesterday.low=102, dayBefore.low=99) = 99
  assert.strictEqual(ctx.priorLow, 99);
  assert.strictEqual(ctx.todayOpen, 109);
  assert.strictEqual(ctx.todayCumVolume, 5000);
});

test('getDailyContext: priorHigh/priorLow fallback to yesterday when only 2 quotes', async () => {
  const yahoo = makeFakeYahoo({
    '1M': [
      { t: 1, o: 104, h: 110, l: 102, c: 108, v: 9500 },  // yesterday
      { t: 2, o: 109, h: 112, l: 107, c: 111, v: 5000 },  // today
    ],
  });
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.ok(ctx);
  assert.strictEqual(ctx.priorHigh, 110);  // = yesterday.high (no dayBefore)
  assert.strictEqual(ctx.priorLow, 102);   // = yesterday.low
});

test('getDailyContext: extracts prevSessionClose from last yesterday bar in 5D intraday', async () => {
  // Build a 5D chart with bars guaranteed in different ET dates regardless of
  // when the test runs : "today" = now, "yesterday" bars = 26h+30h ago (always
  // a different calendar day even at extreme test times).
  const todayPremarket = Date.now();
  const yesterdayLast  = todayPremarket - 26 * 60 * 60 * 1000;  // 26h ago
  const yesterdayClose = todayPremarket - 30 * 60 * 60 * 1000;  // 30h ago

  const yahoo = makeFakeYahoo({
    '1M': [
      { t: 1, o: 100, h: 105, l: 99, c: 104, v: 8000 },
      { t: 2, o: 104, h: 110, l: 102, c: 108, v: 9500 },
      { t: 3, o: 109, h: 112, l: 107, c: 111, v: 5000 },
    ],
    '5D': [
      { t: yesterdayClose, o: 108, h: 109, l: 107, c: 108.5, v: 1000 },
      { t: yesterdayLast,  o: 108.5, h: 109, l: 108, c: 108.7, v: 200 },  // after-hours close
      { t: todayPremarket, o: 110, h: 110.5, l: 109.5, c: 110.2, v: 100 },
    ],
  });
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.ok(ctx);
  assert.strictEqual(ctx.prevSessionClose, 108.7);
});

test('getDailyContext: prevSessionClose is null when 5D fetch fails', async () => {
  const yahoo = {
    getChart: async (ticker, range) => {
      if (range === '5D') throw new Error('not found');
      return {
        quotes: [
          { date: new Date(1), open: 100, high: 105, low: 99, close: 104, volume: 8000 },
          { date: new Date(2), open: 104, high: 110, low: 102, close: 108, volume: 9500 },
          { date: new Date(3), open: 109, high: 112, low: 107, close: 111, volume: 5000 },
        ],
      };
    },
  };
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.ok(ctx);
  assert.strictEqual(ctx.prevSessionClose, null);
});

test('getDailyContext: returns null with fewer than 2 quotes', async () => {
  const yahoo = makeFakeYahoo({ '1M': [{ t: 1, o: 100, h: 100, l: 100, c: 100, v: 1000 }] });
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.strictEqual(ctx, null);
});

test('getDailyContext: returns null on yahoo error', async () => {
  const yahoo = { getChart: async () => { throw new Error('not found'); } };
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.strictEqual(ctx, null);
});

test('runScanCycle: daily reset clears daily state when ET date changes', async () => {
  const { store } = makeStoreDb();
  // Simulate previous day state (PDH already alerted, gap already alerted, etc.)
  store.applyStateUpdates('AAPL', {
    daily_state_date: '2026-04-30',
    pdh_alerts_today: 1, pdh_below_since: 100,
    gap_alerted_today: 1, volume_above_alerted_today: 1,
  });
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'c1', 1);

  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: Date.UTC(2026, 4, 1, 13, 30), o: 110, h: 115, l: 105, c: 113, v: 8000 },  // 2 days ago
      { t: Date.UTC(2026, 4, 1, 13, 30), o: 113, h: 119, l: 108, c: 118, v: 9500 },  // yesterday
      { t: Date.UTC(2026, 4, 1, 13, 30), o: 118, h: 121, l: 117, c: 120, v: 5000 },  // today
    ]},
    quote: { AAPL: { quoteType: 'EQUITY' } },
  });
  const discord = fakeDiscordClient();
  // now = 2026-05-01 14:00 UTC = 10:00 ET on 2026-05-01 → date = '2026-05-01' (different)
  const now = () => Date.UTC(2026, 4, 1, 14, 0);
  await runScanCycle({ store, yahoo, discord, now });
  const s = store.getState('AAPL');
  // After scan: reset (date now = today), and possibly new flags from this scan
  assert.strictEqual(s.daily_state_date, '2026-05-01');
});

test('runScanCycle: backfills quote_type via yahoo.getQuote on first scan', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);  // no quoteType yet
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 100, h: 102, l: 99, c: 101, v: 8000 },
      { t: 2, o: 101, h: 105, l: 100, c: 104, v: 9000 },
      { t: 3, o: 104, h: 110, l: 103, c: 109, v: 5000 },
    ]},
    quote: { AAPL: { quoteType: 'EQUITY' } },
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_700_000_000_000 });
  assert.strictEqual(store.getQuoteType('AAPL'), 'EQUITY');
});

test('runScanCycle: dispatches PDH break alert when last intraday close > yesterday high', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'c1', 1);
  // Build intraday with close above yesterday high. uptrendCandles() ends ~120.
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 100, h: 105, l: 95,  c: 102, v: 8000 },
      { t: 2, o: 102, h: 119, l: 100, c: 117, v: 9000 },  // yesterday — high=119
      { t: 3, o: 117, h: 121, l: 116, c: 120, v: 5000 },  // today
    ]},
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_700_000_000_000 });
  const sentPDH = discord.sent.find(s => /PDH break/.test(s.content));
  assert.ok(sentPDH, 'expected PDH break alert');
});

// Helper: build a fiveDay fixture where the last yesterday bar's close is
// `prevSessionClose` and today's first bar (premarket) timestamp matches now.
// uptrendCandles uses numeric ticks (epoch + i ms) → ET-date '1969-12-31'.
// For the 5D fixture we use real "yesterday" timestamps so getDailyContext
// picks the right bar.
function fiveDayFixtureForGap(prevSessionClose) {
  const todayMidday = Date.now();
  const yesterdayMid = todayMidday - 24 * 60 * 60 * 1000;  // ~24h ago
  return [
    { t: yesterdayMid, o: prevSessionClose, h: prevSessionClose, l: prevSessionClose, c: prevSessionClose, v: 100 },
  ];
}

test('runScanCycle: routes gap alerts to gap_channel_id when configured', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'main-c', 1);
  store.setGapChannel('g1', 'gap-c', 1);
  // uptrendCandles[0].o = 100. Set prev_session_close = 90 → gap_up = +11%.
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 95,  h: 102, l: 94,  c: 100, v: 8000 },
      { t: 2, o: 100, h: 105, l: 99,  c: 100, v: 9000 },
      { t: 3, o: 110, h: 112, l: 109, c: 111, v: 5000 },
    ]},
    fiveDay: { AAPL: fiveDayFixtureForGap(90) },
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => Date.now() });
  const gapMsg  = discord.sent.find(s => /gap up/.test(s.content));
  const otherMsg = discord.sent.find(s => /uptrend/.test(s.content) && !/gap/.test(s.content));
  assert.ok(gapMsg, 'expected gap_up alert (intraday[0]=100 vs prev=90)');
  assert.strictEqual(gapMsg.channelId, 'gap-c', 'gap should route to gap channel');
  if (otherMsg) {
    assert.strictEqual(otherMsg.channelId, 'main-c', 'non-gap alerts stay on main channel');
  }
});

test('runScanCycle: gap fallback to main channel when no gap_channel_id set', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'main-c', 1);
  // gap-channel not set → gap alert goes to main-c
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 95,  h: 102, l: 94,  c: 100, v: 8000 },
      { t: 2, o: 100, h: 105, l: 99,  c: 100, v: 9000 },
      { t: 3, o: 110, h: 112, l: 109, c: 111, v: 5000 },
    ]},
    fiveDay: { AAPL: fiveDayFixtureForGap(90) },
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => Date.now() });
  const gapMsg = discord.sent.find(s => /gap up/.test(s.content));
  assert.ok(gapMsg);
  assert.strictEqual(gapMsg.channelId, 'main-c', 'gap falls back to main channel when no gap channel set');
});

test('runScanCycle: direction_disabled skips direction alerts but other events still fire', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'c1', 1);
  store.setDirectionDisabled('g1', true, 1);
  // uptrendCandles produces uptrend direction + breakout. Both should fire
  // normally, but direction is suppressed for this guild.
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 100, h: 105, l: 95,  c: 102, v: 8000 },
      { t: 2, o: 102, h: 119, l: 100, c: 117, v: 9000 },
      { t: 3, o: 117, h: 121, l: 116, c: 120, v: 5000 },
    ]},
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => Date.now() });
  const directionMsg = discord.sent.find(s => /Now: uptrend/.test(s.content));
  assert.strictEqual(directionMsg, undefined, 'direction alert should be suppressed');
  // State still tracked (direction transition happened in DB).
  assert.strictEqual(store.getState('AAPL').direction, 'uptrend');
  // Other events still go through (e.g., PDH break).
  const otherMsg = discord.sent.find(s => /PDH break/.test(s.content));
  assert.ok(otherMsg, 'non-direction events should still fire');
});

test('runScanCycle: direction_disabled false → direction alerts fire normally', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'c1', 1);
  // Default: not disabled.
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 100, h: 105, l: 95,  c: 102, v: 8000 },
      { t: 2, o: 102, h: 119, l: 100, c: 117, v: 9000 },
      { t: 3, o: 117, h: 121, l: 116, c: 120, v: 5000 },
    ]},
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => Date.now() });
  const directionMsg = discord.sent.find(s => /Now: uptrend/.test(s.content));
  assert.ok(directionMsg, 'direction alert should fire when not disabled');
});
