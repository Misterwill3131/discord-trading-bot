const { test } = require('node:test');
const assert = require('node:assert');
const { parseRange } = require('./market-commands');

const FIXED_NOW = new Date('2026-04-24T15:00:00Z');

test('parseRange defaults to 1D when arg is missing', () => {
  const r = parseRange(undefined, FIXED_NOW);
  assert.strictEqual(r.interval, '5m');
  const diffMs = FIXED_NOW - r.period1;
  assert.ok(diffMs >= 86_400_000 - 1000 && diffMs <= 86_400_000 + 1000, 'period1 should be ~1 day ago');
});

test('parseRange 5D uses 15m interval and 5-day period', () => {
  const r = parseRange('5D', FIXED_NOW);
  assert.strictEqual(r.interval, '15m');
  const diffDays = (FIXED_NOW - r.period1) / 86_400_000;
  assert.ok(diffDays >= 4.99 && diffDays <= 5.01);
});

test('parseRange treats 1d and 1D as the same range', () => {
  const lower = parseRange('1d', FIXED_NOW);
  const upper = parseRange('1D', FIXED_NOW);
  assert.ok(lower, 'lowercase 1d should not return null');
  assert.strictEqual(lower.interval, '5m');
  assert.deepStrictEqual(lower, upper);
});

test('parseRange returns null for invalid input', () => {
  assert.strictEqual(parseRange('42X', FIXED_NOW), null);
  assert.strictEqual(parseRange('10Y', FIXED_NOW), null);
  // Wrong case for month/minute distinction
  assert.strictEqual(parseRange('2m', FIXED_NOW).interval, '2m', '2m should be 2-minute');
  assert.strictEqual(parseRange('2M', FIXED_NOW), null, '2M is not a valid month range');
});

test('parseRange covers 1M/3M/6M/1Y with 1d interval', () => {
  for (const r of ['1M', '3M', '6M', '1Y']) {
    const out = parseRange(r, FIXED_NOW);
    assert.strictEqual(out.interval, '1d', `${r} should use 1d interval`);
  }
});

test('parseRange supports minute and hour timeframes (lowercase)', () => {
  assert.strictEqual(parseRange('1m', FIXED_NOW).interval, '1m');
  assert.strictEqual(parseRange('2m', FIXED_NOW).interval, '2m');
  assert.strictEqual(parseRange('5m', FIXED_NOW).interval, '5m');
  assert.strictEqual(parseRange('15m', FIXED_NOW).interval, '15m');
  assert.strictEqual(parseRange('30m', FIXED_NOW).interval, '30m');
  assert.strictEqual(parseRange('1h', FIXED_NOW).interval, '1h');
});

test('parseRange 4h uses 1h interval with aggregateBy=4', () => {
  const r = parseRange('4h', FIXED_NOW);
  assert.strictEqual(r.interval, '1h', 'Yahoo ne supporte que 1h nativement');
  assert.strictEqual(r.aggregateBy, 4, '4 bars de 1h agrégés en 1 bar 4h');
});

test('parseRange default ranges have aggregateBy=1 (no aggregation)', () => {
  for (const k of ['1D', '5D', '1m', '1h', '1M']) {
    assert.strictEqual(parseRange(k, FIXED_NOW).aggregateBy, 1, k + ' should not aggregate');
  }
});

test('parseRange distinguishes 1M (month) from 1m (minute) by case', () => {
  assert.strictEqual(parseRange('1M', FIXED_NOW).interval, '1d', 'month → daily bars');
  assert.strictEqual(parseRange('1m', FIXED_NOW).interval, '1m', 'minute');
  // Ranges must also be different in duration
  const month = parseRange('1M', FIXED_NOW);
  const minute = parseRange('1m', FIXED_NOW);
  const monthDays = (FIXED_NOW - month.period1) / 86_400_000;
  const minuteDays = (FIXED_NOW - minute.period1) / 86_400_000;
  assert.ok(monthDays > 28);
  assert.ok(minuteDays < 2);
});

const { formatMarketCap } = require('./market-commands');

test('formatMarketCap renders trillions with T suffix', () => {
  assert.strictEqual(formatMarketCap(2_720_000_000_000), '$2.72T');
});

test('formatMarketCap renders billions with B suffix', () => {
  assert.strictEqual(formatMarketCap(45_300_000_000), '$45.30B');
});

test('formatMarketCap renders millions with M suffix', () => {
  assert.strictEqual(formatMarketCap(12_100_000), '$12.10M');
});

test('formatMarketCap returns N/A for falsy input', () => {
  assert.strictEqual(formatMarketCap(null), 'N/A');
  assert.strictEqual(formatMarketCap(undefined), 'N/A');
  assert.strictEqual(formatMarketCap(0), 'N/A');
});

test('formatMarketCap returns N/A for negative, Infinity, and NaN', () => {
  assert.strictEqual(formatMarketCap(-1), 'N/A', 'Yahoo -1 sentinel');
  assert.strictEqual(formatMarketCap(-2_700_000_000_000), 'N/A');
  assert.strictEqual(formatMarketCap(Infinity), 'N/A');
  assert.strictEqual(formatMarketCap(-Infinity), 'N/A');
  assert.strictEqual(formatMarketCap(NaN), 'N/A');
});

const { createYahooClient } = require('./market-commands');

function makeFakeYahoo({ quoteImpl, chartImpl } = {}) {
  const calls = { quote: 0, chart: 0 };
  return {
    calls,
    quote: async (t) => { calls.quote++; return quoteImpl ? quoteImpl(t) : { regularMarketPrice: 100 }; },
    chart: async (t, opts) => { calls.chart++; return chartImpl ? chartImpl(t, opts) : { quotes: [] }; },
  };
}

test('createYahooClient caches quote within TTL', async () => {
  const yahoo = makeFakeYahoo();
  let clock = 0;
  const client = createYahooClient({ yahoo, now: () => clock, ttlMs: 1000 });

  await client.getQuote('AAPL');
  clock = 500;
  await client.getQuote('AAPL');
  assert.strictEqual(yahoo.calls.quote, 1, 'second call within TTL should hit cache');

  clock = 1500;
  await client.getQuote('AAPL');
  assert.strictEqual(yahoo.calls.quote, 2, 'call after TTL should refetch');
});

test('createYahooClient cache key includes range for getChart', async () => {
  const yahoo = makeFakeYahoo();
  const client = createYahooClient({ yahoo, now: () => 0, ttlMs: 1000 });

  await client.getChart('AAPL', '1D');
  await client.getChart('AAPL', '5D');
  assert.strictEqual(yahoo.calls.chart, 2, 'different ranges should be cached separately');
});

test('createYahooClient aggregates bars when range has aggregateBy > 1', async () => {
  // 8 × 1h → 2 × 4h, avec O=first, H=max, L=min, C=last, V=sum
  const bars = [];
  for (let i = 0; i < 8; i++) {
    bars.push({ date: new Date(2026, 3, 24, i), open: 100 + i, high: 100 + i + 2, low: 100 + i - 1, close: 100 + i + 1, volume: 1000 });
  }
  const yahoo = {
    quote: async () => ({ regularMarketPrice: 100 }),
    chart: async () => ({ quotes: bars }),
  };
  const client = createYahooClient({ yahoo, now: () => 0 });
  const res = await client.getChart('AAPL', '4h');
  assert.strictEqual(res.quotes.length, 2, '8 bars / 4 = 2 aggregated bars');
  // Premier groupe : bars[0..3]
  assert.strictEqual(res.quotes[0].open, 100);          // first.open
  assert.strictEqual(res.quotes[0].close, 104);         // last.close (bars[3].close = 100+3+1)
  assert.strictEqual(res.quotes[0].high, 105);          // max(bars[0..3].high) = 100+3+2
  assert.strictEqual(res.quotes[0].low, 99);            // min(bars[0..3].low) = 100+0-1
  assert.strictEqual(res.quotes[0].volume, 4000);       // sum
});

test('createYahooClient passes includePrePost=true to Yahoo chart()', async () => {
  let capturedOpts = null;
  const yahoo = {
    quote: async () => ({ regularMarketPrice: 100 }),
    chart: async (t, opts) => { capturedOpts = opts; return { quotes: [] }; },
  };
  const client = createYahooClient({ yahoo, now: () => 0 });
  await client.getChart('AAPL', '1D');
  assert.strictEqual(capturedOpts.includePrePost, true,
    'intraday chart must include pre/post market hours');
});

test('createYahooClient getChart throws on invalid range', async () => {
  const yahoo = makeFakeYahoo();
  const client = createYahooClient({ yahoo, now: () => 0 });
  await assert.rejects(() => client.getChart('AAPL', '10Y'), /Invalid range/);
});

test('createYahooClient wraps calls with timeout', async () => {
  const yahoo = {
    quote: () => new Promise(() => {}), // never resolves
    chart: () => new Promise(() => {}),
  };
  const client = createYahooClient({ yahoo, now: () => 0, timeoutMs: 20 });
  await assert.rejects(() => client.getQuote('AAPL'), /timeout/i);
});

test('createYahooClient dedupes concurrent getQuote calls for same ticker', async () => {
  const yahoo = {
    calls: { quote: 0, chart: 0 },
    quote(t) {
      this.calls.quote++;
      return new Promise((resolve) => setImmediate(() => resolve({ regularMarketPrice: 100, symbol: t })));
    },
    chart() { this.calls.chart++; return Promise.resolve({ quotes: [] }); },
  };
  const client = createYahooClient({ yahoo, now: () => 0, ttlMs: 1000 });

  const [a, b] = await Promise.all([
    client.getQuote('AAPL'),
    client.getQuote('AAPL'),
  ]);

  assert.strictEqual(yahoo.calls.quote, 1, 'concurrent calls must share one underlying request');
  assert.deepStrictEqual(a, b);
});

test('createYahooClient dedupes concurrent getChart calls for same ticker+range', async () => {
  const yahoo = {
    calls: { quote: 0, chart: 0 },
    quote() { this.calls.quote++; return Promise.resolve({ regularMarketPrice: 100 }); },
    chart(t, opts) {
      this.calls.chart++;
      return new Promise((resolve) => setImmediate(() => resolve({ quotes: [{ close: 1 }], symbol: t, opts })));
    },
  };
  const client = createYahooClient({ yahoo, now: () => 0, ttlMs: 1000 });

  const [a, b] = await Promise.all([
    client.getChart('AAPL', '1D'),
    client.getChart('AAPL', '1D'),
  ]);

  assert.strictEqual(yahoo.calls.chart, 1, 'concurrent calls must share one underlying request');
  assert.deepStrictEqual(a, b);
});

test('createYahooClient does not cache failed getQuote calls', async () => {
  let calls = 0;
  const yahoo = {
    quote: async () => {
      calls++;
      if (calls === 1) throw new Error('yahoo 500');
      return { regularMarketPrice: 100 };
    },
    chart: async () => ({ quotes: [] }),
  };
  const client = createYahooClient({ yahoo, now: () => 0, ttlMs: 1000 });

  await assert.rejects(() => client.getQuote('AAPL'), /yahoo 500/);
  const ok = await client.getQuote('AAPL');
  assert.strictEqual(ok.regularMarketPrice, 100);
  assert.strictEqual(calls, 2, 'failed call must not poison the cache');
});

test('createYahooClient default instantiates yahoo-finance2 v3 correctly', async () => {
  // Régression : yahoo-finance2 v3 exporte une CLASSE (pas un singleton).
  // Sans `new YahooFinance()`, .quote() throw sync avec
  // "Call `const yahooFinance = new YahooFinance()` first."
  // On vérifie en appelant getQuote avec un timeout minimal : l'erreur
  // attendue est un timeout/network, PAS l'erreur de setup v3.
  const client = createYahooClient({ timeoutMs: 1 });
  await assert.rejects(
    () => client.getQuote('AAPL'),
    (err) => {
      const msg = String((err && err.message) || err);
      assert.doesNotMatch(msg, /Call\s+`?const\s+yahooFinance\s*=\s*new\s+YahooFinance/i,
        'regression: default path must instantiate the class, got: ' + msg);
      return true;
    },
  );
});

const { renderChartPng } = require('./market-commands');

function makeCandle(date, close, open = close, volume = 1000) {
  const spread = 0.5;
  return {
    date,
    open,
    high: Math.max(open, close) + spread,
    low: Math.min(open, close) - spread,
    close,
    volume,
  };
}

test('renderChartPng returns a non-empty PNG buffer', () => {
  const candles = [];
  let prev = 100;
  for (let i = 0; i < 50; i++) {
    const c = 100 + Math.sin(i / 5) * 3;
    candles.push(makeCandle(new Date(2026, 3, 24, 9, i * 6), c, prev, 10000 + i * 100));
    prev = c;
  }
  const buf = renderChartPng(candles, 'AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf), 'should return a Buffer');
  assert.ok(buf.length > 1000, 'PNG should be at least 1KB, got ' + buf.length);
  // PNG signature: 89 50 4E 47
  assert.strictEqual(buf[0], 0x89);
  assert.strictEqual(buf[1], 0x50);
  assert.strictEqual(buf[2], 0x4E);
  assert.strictEqual(buf[3], 0x47);
});

test('renderChartPng renders chart when bars are enough for close but not EMA20', () => {
  // 10 bars : assez pour tracer le close, assez pour EMA9 (9 bars seed),
  // mais PAS pour EMA20 (20 bars requis). La fonction doit skip EMA20
  // silencieusement et renvoyer un PNG valide.
  const candles = [];
  let prev = 100;
  for (let i = 0; i < 10; i++) {
    const c = 100 + i * 0.5;
    candles.push(makeCandle(new Date(2026, 3, 24, 9, i * 6), c, prev, 500));
    prev = c;
  }
  const buf = renderChartPng(candles, 'AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000);
});

test('renderChartPng skips bars without OHLC and falls back to placeholder when none remain', () => {
  // Bars sans open/high/low (juste close) → aucune n'est "valide" pour
  // candlesticks → placeholder "Not enough data".
  const candles = [
    { date: new Date(2026, 3, 24, 9, 0), close: 100 },
    { date: new Date(2026, 3, 24, 9, 5), close: 101 },
  ];
  const buf = renderChartPng(candles, 'AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf));
});

test('renderChartPng handles empty candles gracefully', () => {
  const buf = renderChartPng([], 'AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf));
});

const { formatQuoteMessage } = require('./market-commands');

test('formatQuoteMessage renders expected lines for a full quote', () => {
  const msg = formatQuoteMessage({
    symbol: 'AAPL',
    longName: 'Apple Inc.',
    regularMarketPrice: 174.23,
    regularMarketChangePercent: 1.24,
    regularMarketVolume: 52_340_120,
    regularMarketDayLow: 172.10,
    regularMarketDayHigh: 175.00,
    fiftyTwoWeekLow: 124.17,
    fiftyTwoWeekHigh: 199.62,
    marketCap: 2_720_000_000_000,
  });
  assert.match(msg, /\$AAPL — Apple Inc\./);
  assert.match(msg, /\$174\.23/);
  assert.match(msg, /\+1\.24%/);
  assert.match(msg, /52,340,120/);
  assert.match(msg, /\$172\.10 → \$175\.00/);
  assert.match(msg, /\$124\.17 → \$199\.62/);
  assert.match(msg, /\$2\.72T/);
});

test('formatQuoteMessage uses red arrow on negative change', () => {
  const msg = formatQuoteMessage({
    symbol: 'TSLA',
    longName: 'Tesla',
    regularMarketPrice: 200,
    regularMarketChangePercent: -2.5,
    regularMarketVolume: 1000,
    regularMarketDayLow: 195,
    regularMarketDayHigh: 205,
    fiftyTwoWeekLow: 100,
    fiftyTwoWeekHigh: 300,
    marketCap: 6e11,
  });
  assert.match(msg, /🔴/);
  assert.match(msg, /-2\.50%/);
});

test('formatQuoteMessage renders N/A change when changePercent is null', () => {
  // Cas courant en pre/post-market : Yahoo renvoie null sur le change%.
  const msg = formatQuoteMessage({
    symbol: 'AAPL',
    regularMarketPrice: 174.23,
    regularMarketChangePercent: null,
  });
  assert.match(msg, /\$174\.23/);
  assert.match(msg, /⚪/);
  assert.match(msg, /N\/A/);
  assert.doesNotMatch(msg, /NaN/);
});
