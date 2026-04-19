const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketData } = require('./marketdata');

function makeFakeFetch(responseBody, status = 200) {
  let callCount = 0;
  const fn = async (_url, _opts) => {
    callCount++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  fn.getCallCount = () => callCount;
  return fn;
}

const sampleBars = {
  symbol: 'TSLA',
  bars: [
    { t: '2026-04-19T13:30:00Z', o: 200, h: 201, l: 199.5, c: 200.7, v: 10000 },
    { t: '2026-04-19T13:35:00Z', o: 200.7, h: 201.2, l: 200.3, c: 201.0, v: 12000 },
  ],
  next_page_token: null,
};

test('fetchCandles calls Alpaca with correct URL + headers', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => sampleBars };
  };
  const md = createMarketData({
    fetchFn: fakeFetch,
    keyId: 'KID',
    secretKey: 'SEC',
  });
  const bars = await md.fetchCandles('TSLA', '5Min', 50);
  assert.ok(capturedUrl.includes('/v2/stocks/TSLA/bars'));
  assert.ok(capturedUrl.includes('timeframe=5Min'));
  assert.ok(capturedUrl.includes('limit=50'));
  assert.strictEqual(capturedHeaders['APCA-API-KEY-ID'], 'KID');
  assert.strictEqual(capturedHeaders['APCA-API-SECRET-KEY'], 'SEC');
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[1].c, 201.0);
});

test('fetchCandles caches identical requests for 30s', async () => {
  const fakeFetch = makeFakeFetch(sampleBars);
  const md = createMarketData({
    fetchFn: fakeFetch,
    keyId: 'K',
    secretKey: 'S',
    cacheTtlMs: 30000,
    now: () => 1000,
  });
  await md.fetchCandles('TSLA', '5Min', 50);
  await md.fetchCandles('TSLA', '5Min', 50);
  assert.strictEqual(fakeFetch.getCallCount(), 1, 'second call should hit cache');
});

test('fetchCandles refetches after TTL expires', async () => {
  const fakeFetch = makeFakeFetch(sampleBars);
  let t = 1000;
  const md = createMarketData({
    fetchFn: fakeFetch,
    keyId: 'K',
    secretKey: 'S',
    cacheTtlMs: 30000,
    now: () => t,
  });
  await md.fetchCandles('TSLA', '5Min', 50);
  t = 1000 + 30001;
  await md.fetchCandles('TSLA', '5Min', 50);
  assert.strictEqual(fakeFetch.getCallCount(), 2);
});

test('fetchCandles throws on non-2xx', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    text: async () => 'forbidden',
    json: async () => ({}),
  });
  const md = createMarketData({ fetchFn: fakeFetch, keyId: 'K', secretKey: 'S' });
  await assert.rejects(
    md.fetchCandles('TSLA', '5Min', 50),
    /Alpaca 403/
  );
});
