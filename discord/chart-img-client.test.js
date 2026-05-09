const { test } = require('node:test');
const assert = require('node:assert');
const {
  createChartImgClient,
  mapRangeToChartImg,
  CHART_IMG_BASE,
} = require('./chart-img-client');

// Fake fetch — chaque URL → response fixe (PNG ok ou erreur HTTP).
// Records the last call options (headers) for header assertions.
function makeFakeFetch(routes) {
  let calls = 0;
  let lastOpts = null;
  return {
    get calls() { return calls; },
    get lastOpts() { return lastOpts; },
    fn(url, opts) {
      calls++;
      lastOpts = opts;
      const handler = routes[url];
      if (handler instanceof Error) return Promise.reject(handler);
      if (typeof handler === 'function') return Promise.resolve(handler());
      if (handler) return Promise.resolve(handler);
      return Promise.resolve({
        ok: false,
        status: 404,
        text: async () => 'no route',
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    },
  };
}

// Crée une fake response PNG (bytes arbitraires, contenu non vérifié).
function pngOk(bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
  const ab = new Uint8Array(bytes).buffer;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    arrayBuffer: async () => ab,
  };
}

test('mapRangeToChartImg returns interval+range for known inputs', () => {
  assert.deepStrictEqual(mapRangeToChartImg('1D'), { interval: '5m', range: '1D' });
  assert.deepStrictEqual(mapRangeToChartImg('5D'), { interval: '15m', range: '5D' });
  assert.deepStrictEqual(mapRangeToChartImg('1M'), { interval: '1D', range: '1M' });
  assert.deepStrictEqual(mapRangeToChartImg('1Y'), { interval: '1D', range: '1Y' });
  assert.deepStrictEqual(mapRangeToChartImg('1m'), { interval: '1m', range: '1D' });
  assert.deepStrictEqual(mapRangeToChartImg('4h'), { interval: '4h', range: '3M' });
});

test('mapRangeToChartImg distinguishes 1m (minute) from 1M (month)', () => {
  // Case-sensitive : sinon collision entre minute et mois.
  assert.notDeepStrictEqual(mapRangeToChartImg('1m'), mapRangeToChartImg('1M'));
});

test('mapRangeToChartImg returns null for invalid input', () => {
  assert.strictEqual(mapRangeToChartImg('42X'), null);
  assert.strictEqual(mapRangeToChartImg('10Y'), null);
  assert.strictEqual(mapRangeToChartImg(''), null);
  assert.strictEqual(mapRangeToChartImg(null), null);
});

test('createChartImgClient throws if apiKey missing', () => {
  assert.throws(() => createChartImgClient({}), /apiKey/);
});

test('createChartImgClient throws if fetchImpl missing and no global fetch', () => {
  // Force no fetchImpl + simulate absent global by passing null explicitly.
  assert.throws(
    () => createChartImgClient({ apiKey: 'KEY', fetchImpl: null }),
    /fetch/,
  );
});

test('getChart returns a PNG Buffer', async () => {
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({ [url]: pngOk() });
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const buf = await client.getChart('AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf), 'returns a Buffer');
  assert.ok(buf.length > 0, 'buffer is non-empty');
  // Vérifie la signature PNG dans le faux body.
  assert.strictEqual(buf[0], 0x89);
  assert.strictEqual(buf[1], 0x50);
});

test('getChart sends x-api-key header (not query string)', async () => {
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({ [url]: pngOk() });
  const client = createChartImgClient({ apiKey: 'SECRET', fetchImpl: fetcher.fn });
  await client.getChart('AAPL', '1D');
  assert.ok(fetcher.lastOpts && fetcher.lastOpts.headers, 'opts.headers is passed');
  assert.strictEqual(fetcher.lastOpts.headers['x-api-key'], 'SECRET');
  // La clé NE doit PAS apparaître dans l'URL.
  assert.ok(!url.includes('SECRET'), 'apiKey absent from URL');
});

test('getChart uppercases the ticker in the URL', async () => {
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({ [url]: pngOk() });
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  // Ticker en minuscules → URL avec uppercase.
  await client.getChart('aapl', '1D');
  assert.strictEqual(fetcher.calls, 1);
});

test('getChart maps 5D to 15m interval', async () => {
  const url = CHART_IMG_BASE + '?symbol=TSLA&interval=15m&range=5D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({ [url]: pngOk() });
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const buf = await client.getChart('TSLA', '5D');
  assert.ok(Buffer.isBuffer(buf));
});

test('getChart respects custom theme and dimensions', async () => {
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=light&width=1024&height=600';
  const fetcher = makeFakeFetch({ [url]: pngOk() });
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn,
    theme: 'light', width: 1024, height: 600,
  });
  await client.getChart('AAPL', '1D');
  assert.strictEqual(fetcher.calls, 1, 'route matched with custom params');
});

test('getChart throws "Invalid range" for unknown range', async () => {
  const fetcher = makeFakeFetch({});
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getChart('AAPL', '42X'), /Invalid range/);
  assert.strictEqual(fetcher.calls, 0, 'no HTTP fired for invalid range');
});

test('getChart caches within TTL (only one HTTP call)', async () => {
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({ [url]: pngOk() });
  let nowMs = 1_000_000;
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, now: () => nowMs, ttlMs: 30_000,
  });
  await client.getChart('AAPL', '1D');
  await client.getChart('AAPL', '1D');
  assert.strictEqual(fetcher.calls, 1, 'second call within TTL is cached');
  nowMs += 31_000;
  await client.getChart('AAPL', '1D');
  assert.strictEqual(fetcher.calls, 2, 'after TTL the cache is bypassed');
});

test('getChart distinguishes ranges in cache key (1m vs 1M)', async () => {
  const url1m = CHART_IMG_BASE + '?symbol=AAPL&interval=1m&range=1D&theme=dark&width=800&height=500';
  const url1M = CHART_IMG_BASE + '?symbol=AAPL&interval=1D&range=1M&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({ [url1m]: pngOk(), [url1M]: pngOk() });
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AAPL', '1m');
  await client.getChart('AAPL', '1M');
  // Deux appels distincts — pas de collision dans la cache.
  assert.strictEqual(fetcher.calls, 2);
});

test('getChart dedupes concurrent in-flight calls', async () => {
  let resolveFn;
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({
    [url]: () => new Promise((r) => { resolveFn = () => r(pngOk()); }),
  });
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  const p1 = client.getChart('AAPL', '1D');
  const p2 = client.getChart('AAPL', '1D');
  resolveFn();
  await Promise.all([p1, p2]);
  assert.strictEqual(fetcher.calls, 1, 'only one HTTP fired for two parallel requests');
});

test('getChart propagates HTTP errors with status code', async () => {
  const url = CHART_IMG_BASE + '?symbol=AAPL&interval=5m&range=1D&theme=dark&width=800&height=500';
  const fetcher = makeFakeFetch({
    [url]: { ok: false, status: 401, text: async () => 'invalid key', arrayBuffer: async () => new ArrayBuffer(0) },
  });
  const client = createChartImgClient({ apiKey: 'BAD', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getChart('AAPL', '1D'), /HTTP 401/);
});

test('getChart does NOT cache failures (next call retries)', async () => {
  let attempts = 0;
  const fetcher = {
    get calls() { return attempts; },
    fn(_url, _opts) {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('network down'));
      return Promise.resolve(pngOk());
    },
  };
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await assert.rejects(() => client.getChart('AAPL', '1D'), /network down/);
  const buf = await client.getChart('AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(attempts, 2, 'retry happened after the failure');
});

test('getChart times out after timeoutMs', async () => {
  const fetcher = {
    fn(_url, _opts) {
      return new Promise(() => { /* never resolves */ });
    },
  };
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, timeoutMs: 50,
  });
  await assert.rejects(() => client.getChart('AAPL', '1D'), /timeout/);
});
