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
    'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL&apikey=KEY':
      jsonOk([
        { symbol: 'AAPL', date: '2026-04-27', open: 100, high: 105, low: 99, close: 103, volume: 200 },
        { symbol: 'AAPL', date: '2026-04-24', open: 95,  high: 100, low: 94, close: 98,  volume: 180 },
        { symbol: 'AAPL', date: '2026-04-23', open: 92,  high: 96,  low: 91, close: 94,  volume: 170 },
      ]),
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
    'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=XXXX&apikey=KEY':
      jsonOk([]),
  });
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const bars = await client.getDailyBars('XXXX');
  assert.deepStrictEqual(bars, []);
});

test('getDailyBars caches within TTL', async () => {
  const fetcher = makeFakeFetch({
    'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL&apikey=KEY':
      jsonOk([{ symbol: 'AAPL', date: '2026-04-24', open: 1, high: 1, low: 1, close: 1, volume: 1 }]),
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

// ── getRatiosTtm ──────────────────────────────────────────────────────────────

test('getRatiosTtm returns parsed FMP TTM ratios object', async () => {
  const fetchImpl = mockFetch([
    { peRatioTTM: 32.4, netIncomePerShareTTM: 6.13, marketCapTTM: 3e12 },
  ]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getRatiosTtm('AAPL');
  assert.strictEqual(r.peRatioTTM, 32.4);
  assert.strictEqual(r.netIncomePerShareTTM, 6.13);
  assert.strictEqual(r.marketCapTTM, 3e12);
});

test('getRatiosTtm returns null when FMP returns empty array', async () => {
  const fetchImpl = mockFetch([]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getRatiosTtm('NOPE');
  assert.strictEqual(r, null);
});

// ── getPriceTargetSummary ─────────────────────────────────────────────────────

test('getPriceTargetSummary returns parsed FMP price target object', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => ({
        symbol: 'AAPL',
        lastMonth: 12, lastMonthAvgPriceTarget: 215.00,
        lastQuarter: 32, lastQuarterAvgPriceTarget: 210.50,
      }),
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const t = await client.getPriceTargetSummary('AAPL');
  assert.ok(capturedUrl.includes('/price-target-summary'));
  assert.ok(capturedUrl.includes('symbol=AAPL'));
  assert.strictEqual(t.lastMonthAvgPriceTarget, 215.00);
});

// ── getEarningsSurprises ──────────────────────────────────────────────────────

test('getEarningsSurprises returns array sorted most-recent first', async () => {
  const fetchImpl = mockFetch([
    { date: '2026-04-30', eps: 1.53, estimatedEps: 1.50 },
    { date: '2026-01-30', eps: 2.10, estimatedEps: 2.05 },
  ]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const e = await client.getEarningsSurprises('AAPL');
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].date, '2026-04-30');
  assert.strictEqual(e[0].eps, 1.53);
});

// ── getInsiderTrades ──────────────────────────────────────────────────────────

test('getInsiderTrades sends limit query param and returns array', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => [
        { filingDate: '2026-05-12', transactionType: 'S-Sale', reportingName: 'COOK TIMOTHY', securitiesTransacted: 10000, price: 198.00 },
      ],
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getInsiderTrades('AAPL', 5);
  assert.ok(capturedUrl.includes('/insider-trading'));
  assert.ok(capturedUrl.includes('symbol=AAPL'));
  assert.ok(capturedUrl.includes('limit=5'));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].reportingName, 'COOK TIMOTHY');
});

// ── getSenateTrades ───────────────────────────────────────────────────────────

test('getSenateTrades returns trimmed array of up to `limit` items', async () => {
  const fetchImpl = mockFetch([
    { transactionDate: '2026-05-10', senator: 'Pelosi', type: 'Purchase', amount: '$15,001 - $50,000' },
    { transactionDate: '2026-04-28', senator: 'Tuberville', type: 'Purchase', amount: '$50,001 - $100,000' },
    { transactionDate: '2026-04-15', senator: 'Hagerty', type: 'Sale', amount: '$15,001 - $50,000' },
    { transactionDate: '2026-04-01', senator: 'Cruz', type: 'Sale', amount: '$1,001 - $15,000' },
    { transactionDate: '2026-03-20', senator: 'Tillis', type: 'Purchase', amount: '$15,001 - $50,000' },
    { transactionDate: '2026-03-01', senator: 'Other', type: 'Sale', amount: '$1,001 - $15,000' },
  ]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getSenateTrades('AAPL', 5);
  assert.strictEqual(r.length, 5);
  assert.strictEqual(r[0].senator, 'Pelosi');
});

// ── getHouseTrades ────────────────────────────────────────────────────────────

test('getHouseTrades sends correct path and returns trimmed array', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => [
        { disclosureDate: '2026-05-05', representative: 'McCaul', type: 'Sale', amount: '$1,001 - $15,000' },
      ],
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getHouseTrades('AAPL', 5);
  assert.ok(capturedUrl.includes('/senate-disclosure'));
  assert.ok(capturedUrl.includes('symbol=AAPL'));
  assert.strictEqual(r.length, 1);
});
