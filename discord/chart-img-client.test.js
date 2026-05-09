const { test } = require('node:test');
const assert = require('node:assert');
const {
  createChartImgClient,
  resolveSymbol,
  mapRangeToChartImg,
  YAHOO_TO_TV_EXCHANGE,
  CHART_IMG_BASE,
} = require('./chart-img-client');

// Fake fetch — chart-img reçoit toujours la même URL (POST), donc on
// route sur l'URL et on capture le body + headers du dernier appel.
function makeFakeFetch(handler = null) {
  let calls = 0;
  let lastUrl = null;
  let lastOpts = null;
  return {
    get calls() { return calls; },
    get lastUrl() { return lastUrl; },
    get lastOpts() { return lastOpts; },
    get lastBody() {
      if (!lastOpts || typeof lastOpts.body !== 'string') return null;
      try { return JSON.parse(lastOpts.body); } catch { return null; }
    },
    fn(url, opts) {
      calls++;
      lastUrl = url;
      lastOpts = opts;
      if (handler instanceof Error) return Promise.reject(handler);
      if (typeof handler === 'function') return Promise.resolve(handler(url, opts));
      if (handler) return Promise.resolve(handler);
      return Promise.resolve(pngOk());
    },
  };
}

function pngOk(bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
  const ab = new Uint8Array(bytes).buffer;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    arrayBuffer: async () => ab,
  };
}

// ── mapRangeToChartImg ─────────────────────────────────────────────
test('mapRangeToChartImg returns interval+range for known inputs', () => {
  assert.deepStrictEqual(mapRangeToChartImg('1D'), { interval: '5m', range: '1D' });
  assert.deepStrictEqual(mapRangeToChartImg('5D'), { interval: '15m', range: '5D' });
  assert.deepStrictEqual(mapRangeToChartImg('1M'), { interval: '1D', range: '1M' });
  assert.deepStrictEqual(mapRangeToChartImg('1Y'), { interval: '1D', range: '1Y' });
  assert.deepStrictEqual(mapRangeToChartImg('1m'), { interval: '1m', range: '1D' });
  assert.deepStrictEqual(mapRangeToChartImg('4h'), { interval: '4h', range: '3M' });
});

test('mapRangeToChartImg distinguishes 1m (minute) from 1M (month)', () => {
  assert.notDeepStrictEqual(mapRangeToChartImg('1m'), mapRangeToChartImg('1M'));
});

test('mapRangeToChartImg returns null for invalid input', () => {
  assert.strictEqual(mapRangeToChartImg('42X'), null);
  assert.strictEqual(mapRangeToChartImg('10Y'), null);
  assert.strictEqual(mapRangeToChartImg(''), null);
  assert.strictEqual(mapRangeToChartImg(null), null);
});

// ── resolveSymbol ──────────────────────────────────────────────────
test('resolveSymbol prefixes ticker with TV exchange from Yahoo code', () => {
  assert.strictEqual(resolveSymbol('AAPL', 'NMS'), 'NASDAQ:AAPL');
  assert.strictEqual(resolveSymbol('SPY', 'PCX'),  'AMEX:SPY');
  assert.strictEqual(resolveSymbol('BABA', 'NYQ'), 'NYSE:BABA');
  assert.strictEqual(resolveSymbol('VOO', 'PCX'),  'AMEX:VOO');
});

test('resolveSymbol uppercases the ticker', () => {
  assert.strictEqual(resolveSymbol('spy', 'PCX'), 'AMEX:SPY');
  assert.strictEqual(resolveSymbol('aapl', 'NMS'), 'NASDAQ:AAPL');
});

test('resolveSymbol falls back to NASDAQ for unknown exchange code', () => {
  assert.strictEqual(resolveSymbol('XYZ', 'UNKNOWN'), 'NASDAQ:XYZ');
  assert.strictEqual(resolveSymbol('XYZ', null), 'NASDAQ:XYZ');
  assert.strictEqual(resolveSymbol('XYZ', ''), 'NASDAQ:XYZ');
  assert.strictEqual(resolveSymbol('XYZ', undefined), 'NASDAQ:XYZ');
});

test('YAHOO_TO_TV_EXCHANGE has the canonical Yahoo codes', () => {
  // Sanity check — empêche les régressions silencieuses si la map
  // perd un mapping critique.
  assert.strictEqual(YAHOO_TO_TV_EXCHANGE.NMS, 'NASDAQ');
  assert.strictEqual(YAHOO_TO_TV_EXCHANGE.NYQ, 'NYSE');
  assert.strictEqual(YAHOO_TO_TV_EXCHANGE.PCX, 'AMEX');
  assert.strictEqual(YAHOO_TO_TV_EXCHANGE.ASE, 'AMEX');
});

// ── createChartImgClient ───────────────────────────────────────────
test('createChartImgClient throws if apiKey missing', () => {
  assert.throws(() => createChartImgClient({}), /apiKey/);
});

test('createChartImgClient throws if fetchImpl missing and no global fetch', () => {
  assert.throws(
    () => createChartImgClient({ apiKey: 'KEY', fetchImpl: null }),
    /fetch/,
  );
});

// ── getChart : HTTP shape ──────────────────────────────────────────
test('getChart sends POST to the advanced-chart endpoint', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D');
  assert.strictEqual(fetcher.lastUrl, CHART_IMG_BASE);
  assert.strictEqual(fetcher.lastOpts.method, 'POST');
});

test('getChart sets x-api-key and Content-Type headers', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'SECRET', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D');
  const headers = fetcher.lastOpts.headers;
  assert.strictEqual(headers['x-api-key'], 'SECRET');
  assert.strictEqual(headers['Content-Type'], 'application/json');
});

test('getChart sends a JSON body with the resolved symbol', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D');
  const body = fetcher.lastBody;
  assert.deepStrictEqual(body, {
    symbol:   'AMEX:SPY',
    interval: '5m',
    range:    '1D',
    theme:    'dark',
    width:    800,
    height:   500,
  });
});

test('getChart maps 5D to 15m interval in the body', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('NASDAQ:TSLA', '5D');
  assert.strictEqual(fetcher.lastBody.interval, '15m');
  assert.strictEqual(fetcher.lastBody.range, '5D');
});

test('getChart respects custom theme and dimensions', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn,
    theme: 'light', width: 1024, height: 600,
  });
  await client.getChart('NASDAQ:AAPL', '1D');
  assert.strictEqual(fetcher.lastBody.theme, 'light');
  assert.strictEqual(fetcher.lastBody.width, 1024);
  assert.strictEqual(fetcher.lastBody.height, 600);
});

test('getChart returns a PNG Buffer', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const buf = await client.getChart('AMEX:SPY', '1D');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
  assert.strictEqual(buf[0], 0x89);  // PNG signature
  assert.strictEqual(buf[1], 0x50);
});

// ── getChart : caching, dedup, errors ──────────────────────────────
test('getChart throws "Invalid range" for unknown range without HTTP', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getChart('AMEX:SPY', '42X'), /Invalid range/);
  assert.strictEqual(fetcher.calls, 0);
});

test('getChart caches within TTL (only one HTTP call)', async () => {
  const fetcher = makeFakeFetch(pngOk());
  let nowMs = 1_000_000;
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, now: () => nowMs, ttlMs: 30_000,
  });
  await client.getChart('AMEX:SPY', '1D');
  await client.getChart('AMEX:SPY', '1D');
  assert.strictEqual(fetcher.calls, 1);
  nowMs += 31_000;
  await client.getChart('AMEX:SPY', '1D');
  assert.strictEqual(fetcher.calls, 2);
});

test('getChart distinguishes ranges in cache key (1m vs 1M)', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('NASDAQ:AAPL', '1m');
  await client.getChart('NASDAQ:AAPL', '1M');
  assert.strictEqual(fetcher.calls, 2);
});

test('getChart distinguishes symbols in cache key', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D');
  await client.getChart('NASDAQ:AAPL', '1D');
  assert.strictEqual(fetcher.calls, 2);
});

test('getChart dedupes concurrent in-flight calls', async () => {
  let resolveFn;
  const fetcher = makeFakeFetch((_url, _opts) =>
    new Promise((r) => { resolveFn = () => r(pngOk()); }));
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const p1 = client.getChart('AMEX:SPY', '1D');
  const p2 = client.getChart('AMEX:SPY', '1D');
  resolveFn();
  await Promise.all([p1, p2]);
  assert.strictEqual(fetcher.calls, 1);
});

test('getChart propagates HTTP errors with status code', async () => {
  const fetcher = makeFakeFetch({
    ok: false, status: 401,
    text: async () => 'invalid key',
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const client = createChartImgClient({ apiKey: 'BAD', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getChart('AMEX:SPY', '1D'), /HTTP 401/);
});

test('getChart does NOT cache failures (next call retries)', async () => {
  let attempts = 0;
  const fetcher = {
    fn(_url, _opts) {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('network down'));
      return Promise.resolve(pngOk());
    },
  };
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getChart('AMEX:SPY', '1D'), /network down/);
  const buf = await client.getChart('AMEX:SPY', '1D');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(attempts, 2);
});

test('getChart times out after timeoutMs', async () => {
  const fetcher = { fn() { return new Promise(() => {}); } };
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, timeoutMs: 50,
  });
  await assert.rejects(() => client.getChart('AMEX:SPY', '1D'), /timeout/);
});
