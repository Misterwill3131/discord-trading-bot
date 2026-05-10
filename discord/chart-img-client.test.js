const { test } = require('node:test');
const assert = require('node:assert');
const {
  createChartImgClient,
  resolveSymbol,
  mapRangeToChartImg,
  buildFibDrawing,
  buildRectangleDrawing,
  YAHOO_TO_TV_EXCHANGE,
  DEFAULT_STUDIES,
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
  // Pass studies:[] to assert the core body shape independently of the
  // default-studies payload (which has its own dedicated tests below).
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, studies: [],
  });
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

// ── DEFAULT_STUDIES + studies in body ──────────────────────────────
test('DEFAULT_STUDIES includes the 7 expected indicators with chart-img names', () => {
  // Sanity check — protège contre une régression sur les noms (la doc
  // chart-img exige "VWAP" et "Moving Average Exponential", pas les noms
  // TradingView humains).
  const sigs = DEFAULT_STUDIES.map(s =>
    s.name + (s.input ? ':' + s.input.length : ''));
  assert.ok(sigs.includes('VWAP'), 'VWAP (no input)');
  assert.ok(sigs.includes('Moving Average Exponential:9'));
  assert.ok(sigs.includes('Moving Average Exponential:20'));
  assert.ok(sigs.includes('Moving Average Exponential:50'));
  assert.ok(sigs.includes('Moving Average Exponential:200'));
  assert.ok(sigs.includes('Moving Average:50'));
  assert.ok(sigs.includes('Moving Average:325'));
  assert.strictEqual(DEFAULT_STUDIES.length, 7);
  // Verify input shape: length + source (NOT in_0/in_1)
  for (const s of DEFAULT_STUDIES) {
    if (!s.input) continue;
    assert.ok(Number.isFinite(s.input.length), s.name + ' must have numeric length');
    assert.strictEqual(s.input.source, 'close', s.name + ' must use close source');
  }
});

test('getChart sends DEFAULT_STUDIES in the body by default', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D');
  assert.deepStrictEqual(fetcher.lastBody.studies, DEFAULT_STUDIES);
});

test('getChart respects a custom studies override', async () => {
  const custom = [{ name: 'Relative Strength Index', input: { in_0: 14 } }];
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, studies: custom,
  });
  await client.getChart('AMEX:SPY', '1D');
  assert.deepStrictEqual(fetcher.lastBody.studies, custom);
});

test('getChart omits studies field when studies = []', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({
    apiKey: 'KEY', fetchImpl: fetcher.fn, studies: [],
  });
  await client.getChart('AMEX:SPY', '1D');
  assert.strictEqual(fetcher.lastBody.studies, undefined);
});

// ── buildFibDrawing ────────────────────────────────────────────────
const FIB_OK = {
  startDatetime: '2026-05-08T13:30:00.000Z',
  startPrice:    400,
  endDatetime:   '2026-05-08T20:00:00.000Z',
  endPrice:      450,
};

test('buildFibDrawing returns a valid Fib Retracement object', () => {
  const fib = buildFibDrawing(FIB_OK);
  assert.deepStrictEqual(fib, {
    name: 'Fib Retracement',
    input: {
      startDatetime: '2026-05-08T13:30:00.000Z',
      startPrice:    400,
      endDatetime:   '2026-05-08T20:00:00.000Z',
      endPrice:      450,
    },
  });
});

test('buildFibDrawing returns null for invalid inputs', () => {
  assert.strictEqual(buildFibDrawing(null), null);
  assert.strictEqual(buildFibDrawing(undefined), null);
  // Missing datetime
  assert.strictEqual(buildFibDrawing({ ...FIB_OK, startDatetime: undefined }), null);
  assert.strictEqual(buildFibDrawing({ ...FIB_OK, endDatetime: 12345 }), null,
    'datetime must be a string');
  // Missing or non-finite prices
  assert.strictEqual(buildFibDrawing({ ...FIB_OK, startPrice: NaN }), null);
  assert.strictEqual(buildFibDrawing({ ...FIB_OK, endPrice: undefined }), null);
  // Degenerate range
  assert.strictEqual(buildFibDrawing({ ...FIB_OK, endPrice: 400 }), null,
    'startPrice == endPrice → null');
});

// ── getChart with fibAnchors → drawings in body ────────────────────
test('getChart adds Fib Retracement to drawings when fibAnchors provided', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D', { fibAnchors: FIB_OK });
  assert.deepStrictEqual(fetcher.lastBody.drawings, [
    {
      name: 'Fib Retracement',
      input: {
        startDatetime: '2026-05-08T13:30:00.000Z',
        startPrice:    400,
        endDatetime:   '2026-05-08T20:00:00.000Z',
        endPrice:      450,
      },
    },
  ]);
});

test('getChart omits drawings when no fibAnchors', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D');
  assert.strictEqual(fetcher.lastBody.drawings, undefined);
});

test('getChart omits drawings when fibAnchors are invalid', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D', {
    fibAnchors: { ...FIB_OK, startPrice: NaN },
  });
  assert.strictEqual(fetcher.lastBody.drawings, undefined);
});

test('getChart cache key includes fib anchors (different anchors = different cache)', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D', { fibAnchors: FIB_OK });
  await client.getChart('AMEX:SPY', '1D', {
    fibAnchors: { ...FIB_OK, endPrice: 460 },
  });
  assert.strictEqual(fetcher.calls, 2, 'different anchors = bypass cache');
});

test('getChart cache HIT when same symbol + range + anchors', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '1D', { fibAnchors: FIB_OK });
  await client.getChart('AMEX:SPY', '1D', { fibAnchors: FIB_OK });
  assert.strictEqual(fetcher.calls, 1);
});

// ── buildRectangleDrawing ──────────────────────────────────────────
const RECT_OK = {
  startDatetime: '2026-05-07T20:00:00.000Z',
  startPrice:    731.43,
  endDatetime:   '2026-05-08T13:30:00.000Z',
  endPrice:      733.49,
};

test('buildRectangleDrawing returns minimal valid Rectangle (no override)', () => {
  const r = buildRectangleDrawing(RECT_OK);
  assert.deepStrictEqual(r, {
    name: 'Rectangle',
    input: RECT_OK,
    zOrder: 'top',  // default
  });
});

test('buildRectangleDrawing accepts text + style override', () => {
  const r = buildRectangleDrawing({
    ...RECT_OK,
    text:            'GAP +0.28%',
    lineColor:       'rgb(255,165,0)',
    backgroundColor: 'rgba(255,165,0,0.25)',
    lineWidth:       2,
  });
  assert.strictEqual(r.name, 'Rectangle');
  assert.strictEqual(r.input.text, 'GAP +0.28%');
  assert.strictEqual(r.zOrder, 'top');
  assert.deepStrictEqual(r.override, {
    lineColor:       'rgb(255,165,0)',
    backgroundColor: 'rgba(255,165,0,0.25)',
    lineWidth:       2,
    showLabel:       true,
    fontBold:        true,
    horzLabelAlign:  'center',
    vertLabelAlign:  'middle',
  });
});

test('buildRectangleDrawing zOrder bottom passes through', () => {
  const r = buildRectangleDrawing({ ...RECT_OK, zOrder: 'bottom' });
  assert.strictEqual(r.zOrder, 'bottom');
});

test('buildRectangleDrawing returns null for invalid inputs', () => {
  assert.strictEqual(buildRectangleDrawing(null), null);
  assert.strictEqual(buildRectangleDrawing(undefined), null);
  assert.strictEqual(buildRectangleDrawing({ ...RECT_OK, startDatetime: undefined }), null);
  assert.strictEqual(buildRectangleDrawing({ ...RECT_OK, endDatetime: 12345 }), null,
    'datetime must be a string');
  assert.strictEqual(buildRectangleDrawing({ ...RECT_OK, startPrice: NaN }), null);
  assert.strictEqual(buildRectangleDrawing({ ...RECT_OK, endPrice: undefined }), null);
});

// ── getChart with rectangles → drawings in body ────────────────────
test('getChart adds Rectangle to drawings when opts.rectangles provided', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', {
    rectangles: [{ ...RECT_OK, text: 'GAP', lineColor: 'rgb(255,165,0)' }],
  });
  assert.strictEqual(fetcher.lastBody.drawings.length, 1);
  assert.strictEqual(fetcher.lastBody.drawings[0].name, 'Rectangle');
  assert.strictEqual(fetcher.lastBody.drawings[0].input.text, 'GAP');
  assert.strictEqual(fetcher.lastBody.drawings[0].override.lineColor, 'rgb(255,165,0)');
});

test('getChart accepts BOTH fibAnchors and rectangles in same call', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', {
    fibAnchors: FIB_OK,
    rectangles: [RECT_OK],
  });
  assert.strictEqual(fetcher.lastBody.drawings.length, 2);
  assert.strictEqual(fetcher.lastBody.drawings[0].name, 'Fib Retracement');
  assert.strictEqual(fetcher.lastBody.drawings[1].name, 'Rectangle');
});

test('getChart silently filters invalid rectangles', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', {
    rectangles: [
      { ...RECT_OK, startPrice: NaN },  // invalid → filtered
      RECT_OK,                          // valid → kept
    ],
  });
  assert.strictEqual(fetcher.lastBody.drawings.length, 1);
});

test('getChart cache key includes rectangle anchors (change = bypass cache)', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', { rectangles: [RECT_OK] });
  await client.getChart('AMEX:SPY', '5D', {
    rectangles: [{ ...RECT_OK, endPrice: 740 }],
  });
  assert.strictEqual(fetcher.calls, 2);
});

test('getChart cache HIT when same rectangle anchors', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', { rectangles: [RECT_OK] });
  await client.getChart('AMEX:SPY', '5D', { rectangles: [RECT_OK] });
  assert.strictEqual(fetcher.calls, 1);
});

// ── opts.studies override (per-call replace of DEFAULT_STUDIES) ────
test('getChart opts.studies REPLACES the client-default studies', async () => {
  const fetcher = makeFakeFetch(pngOk());
  // Client has DEFAULT_STUDIES (VWAP + EMAs + MAs)
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  // Per-call: just Volume
  await client.getChart('AMEX:SPY', '5D', {
    studies: [{ name: 'Volume' }],
  });
  assert.deepStrictEqual(fetcher.lastBody.studies, [{ name: 'Volume' }]);
});

test('getChart opts.studies = [] omits studies entirely (override default)', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', { studies: [] });
  assert.strictEqual(fetcher.lastBody.studies, undefined);
});

test('getChart without opts.studies still uses client defaults', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D');
  // lastBody is re-parsed JSON → can't use strictEqual (reference)
  assert.deepStrictEqual(fetcher.lastBody.studies, DEFAULT_STUDIES);
});

test('getChart cache key bypasses on different studies override', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', { studies: [{ name: 'Volume' }] });
  await client.getChart('AMEX:SPY', '5D', { studies: [{ name: 'VWAP' }] });
  assert.strictEqual(fetcher.calls, 2, 'different studies = bypass cache');
});

test('getChart cache HIT when same studies override', async () => {
  const fetcher = makeFakeFetch(pngOk());
  const client = createChartImgClient({ apiKey: 'KEY', fetchImpl: fetcher.fn });
  await client.getChart('AMEX:SPY', '5D', { studies: [{ name: 'Volume' }] });
  await client.getChart('AMEX:SPY', '5D', { studies: [{ name: 'Volume' }] });
  assert.strictEqual(fetcher.calls, 1);
});
