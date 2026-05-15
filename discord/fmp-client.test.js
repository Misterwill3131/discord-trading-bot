const { test } = require('node:test');
const assert = require('node:assert');
const { createFmpClient, parseFmpDate } = require('./fmp-client');

// Petit fake fetch — supporte chaque URL → response fixe.
function makeFakeFetch(routes) {
  let calls = 0;
  return {
    get calls() { return calls; },
    fn(url) {
      calls++;
      const handler = routes[url];
      if (handler instanceof Error) return Promise.reject(handler);
      if (typeof handler === 'function') return Promise.resolve(handler());
      if (handler) return Promise.resolve(handler);
      return Promise.resolve({
        ok: false,
        status: 404,
        text: async () => 'no route',
        json: async () => ({}),
      });
    },
  };
}

function jsonOk(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

test('parseFmpDate parses YYYY-MM-DD into a Date at 20:00 UTC (16:00 ET)', () => {
  const d = parseFmpDate('2026-04-27');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 3);  // April = 3 (0-indexed)
  assert.strictEqual(d.getUTCDate(), 27);
  assert.strictEqual(d.getUTCHours(), 20);
});

test('parseFmpDate returns null for invalid input', () => {
  assert.strictEqual(parseFmpDate(null), null);
  assert.strictEqual(parseFmpDate(''), null);
  assert.strictEqual(parseFmpDate('not-a-date'), null);
  assert.strictEqual(parseFmpDate(20260427), null);
});

test('createFmpClient throws if apiKey missing', () => {
  assert.throws(() => createFmpClient({}), /apiKey/);
});

test('getQuote returns { price, volume } from FMP quote endpoint', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=KEY':
      jsonOk([{ symbol: 'AAPL', price: 185.42, volume: 52_000_000, dayHigh: 186 }]),
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const q = await client.getQuote('AAPL');
  assert.deepStrictEqual(q, { price: 185.42, volume: 52_000_000 });
});

test('getQuote returns null for empty FMP response (unknown ticker)', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/stable/quote?symbol=XXXX&apikey=KEY': jsonOk([]),
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  assert.strictEqual(await client.getQuote('XXXX'), null);
});

test('getQuote caches within TTL', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=KEY':
      jsonOk([{ symbol: 'AAPL', price: 100, volume: 10 }]),
  });
  let nowMs = 1_000_000;
  const client = createFmpClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, now: () => nowMs, ttlMs: 30_000,
  });
  await client.getQuote('AAPL');
  await client.getQuote('AAPL');
  assert.strictEqual(fetcher.calls, 1, 'second call within TTL is cached');
  nowMs += 31_000;
  await client.getQuote('AAPL');
  assert.strictEqual(fetcher.calls, 2, 'after TTL the cache is bypassed');
});

test('getQuote dedupes concurrent in-flight calls', async () => {
  let resolveFn;
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=KEY':
      () => new Promise((r) => { resolveFn = () => r(jsonOk([{ price: 1, volume: 1 }])); }),
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const p1 = client.getQuote('AAPL');
  const p2 = client.getQuote('AAPL');
  resolveFn();
  await Promise.all([p1, p2]);
  assert.strictEqual(fetcher.calls, 1, 'only one HTTP fired for two parallel requests');
});

test('getQuote propagates HTTP errors', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=KEY': {
      ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}),
    },
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getQuote('AAPL'), /HTTP 429/);
});

test('getDailyBars returns chronological-ascending array with parsed dates', async () => {
  // FMP envoie newest-first.
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/api/v3/historical-price-full/AAPL?timeseries=10&apikey=KEY':
      jsonOk({
        symbol: 'AAPL',
        historical: [
          { date: '2026-04-27', open: 100, high: 105, low: 99, close: 103, volume: 200 },
          { date: '2026-04-24', open: 95,  high: 100, low: 94, close: 98,  volume: 180 },
          { date: '2026-04-23', open: 92,  high: 96,  low: 91, close: 94,  volume: 170 },
        ],
      }),
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const bars = await client.getDailyBars('AAPL');
  assert.strictEqual(bars.length, 3);
  // After reverse → oldest first.
  assert.strictEqual(bars[0].date.getUTCDate(), 23);
  assert.strictEqual(bars[1].date.getUTCDate(), 24);
  assert.strictEqual(bars[2].date.getUTCDate(), 27);
  assert.strictEqual(bars[2].high, 105);
  assert.strictEqual(bars[2].volume, 200);
});

test('getDailyBars returns [] when historical array is missing', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/api/v3/historical-price-full/XXXX?timeseries=10&apikey=KEY':
      jsonOk({ symbol: 'XXXX' }),
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const bars = await client.getDailyBars('XXXX');
  assert.deepStrictEqual(bars, []);
});

test('getDailyBars caches within TTL', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/api/v3/historical-price-full/AAPL?timeseries=10&apikey=KEY':
      jsonOk({ symbol: 'AAPL', historical: [{ date: '2026-04-24', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }),
  });
  let nowMs = 0;
  const client = createFmpClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, now: () => nowMs, ttlMs: 30_000,
  });
  await client.getDailyBars('AAPL');
  await client.getDailyBars('AAPL');
  assert.strictEqual(fetcher.calls, 1);
  nowMs += 31_000;
  await client.getDailyBars('AAPL');
  assert.strictEqual(fetcher.calls, 2);
});

test('getQuote does NOT cache failures (next call retries)', async () => {
  let attempts = 0;
  const fetcher = {
    get calls() { return attempts; },
    fn(_url) {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('network down'));
      return Promise.resolve(jsonOk([{ price: 50, volume: 1 }]));
    },
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getQuote('AAPL'), /network down/);
  const ok = await client.getQuote('AAPL');
  assert.deepStrictEqual(ok, { price: 50, volume: 1 });
  assert.strictEqual(attempts, 2);
});

// ── getQuotesBulk ────────────────────────────────────────────────────────────

function mockFetch(responseBody, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
}

test('getQuotesBulk fetches a single URL with comma-joined tickers', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ([
        { symbol: 'AAPL', price: 200.50, volume: 1000 },
        { symbol: 'TSLA', price: 250.75, volume: 2000 },
      ]),
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk(['AAPL', 'TSLA']);
  assert.ok(capturedUrl.includes('/batch-quote?symbols=AAPL,TSLA'));
  assert.strictEqual(quotes.AAPL.price, 200.50);
  assert.strictEqual(quotes.TSLA.price, 250.75);
});

test('getQuotesBulk uppercases ticker symbols before request', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await client.getQuotesBulk(['aapl', 'Tsla']);
  assert.ok(capturedUrl.includes('AAPL,TSLA'));
});

test('getQuotesBulk dedups duplicate tickers in input', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await client.getQuotesBulk(['AAPL', 'aapl', 'AAPL']);
  // exactly one AAPL in the URL
  const matches = capturedUrl.match(/AAPL/g) || [];
  assert.strictEqual(matches.length, 1);
});

test('getQuotesBulk returns empty object for empty input', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch must NOT be called for empty input');
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk([]);
  assert.deepStrictEqual(quotes, {});
});

test('getQuotesBulk handles tickers missing from FMP response gracefully', async () => {
  const fetchImpl = mockFetch([
    { symbol: 'AAPL', price: 200, volume: 1 },
    // TSLA missing
  ]);
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk(['AAPL', 'TSLA']);
  assert.strictEqual(quotes.AAPL.price, 200);
  assert.strictEqual(quotes.TSLA, undefined);
});

test('getQuotesBulk skips rows with non-finite price', async () => {
  const fetchImpl = mockFetch([
    { symbol: 'AAPL', price: 200, volume: 1 },
    { symbol: 'BAD',  price: null, volume: 1 },
  ]);
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk(['AAPL', 'BAD']);
  assert.strictEqual(quotes.AAPL.price, 200);
  assert.strictEqual(quotes.BAD, undefined);
});

test('getQuotesBulk throws on HTTP error', async () => {
  const fetchImpl = mockFetch({}, { ok: false, status: 500 });
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await assert.rejects(
    () => client.getQuotesBulk(['AAPL']),
    /fmp HTTP 500/,
  );
});
