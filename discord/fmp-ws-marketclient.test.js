const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createFmpWsMarketClient } = require('./fmp-ws-marketclient');

// Fake wsClient: an EventEmitter with start/stop/getStatus stubs.
function makeFakeWsClient() {
  const ee = new EventEmitter();
  return {
    on: (event, cb) => ee.on(event, cb),
    emit: (event, payload) => ee.emit(event, payload),  // exposed for tests
    start: () => { ee.started = true; },
    stop:  () => { ee.started = false; },
    getStatus: () => ({
      connected: !!ee.started,
      subscribedStreams: [],
      attemptCount: 0,
    }),
    _ee: ee,
  };
}

// Fake REST client matching the existing marketClient contract.
function makeFakeRestClient() {
  const calls = { getQuote: [], getDailyBars: [] };
  return {
    async getQuote(ticker) {
      calls.getQuote.push(ticker);
      return { price: 100, volume: 1000 };
    },
    async getDailyBars(ticker) {
      calls.getDailyBars.push(ticker);
      return [{ date: new Date('2026-05-14'), open: 1, high: 2, low: 1, close: 2, volume: 100 }];
    },
    _calls: calls,
  };
}

function makeFixedNow(ms) {
  return () => new Date(ms);
}

const BASE_TS = Date.UTC(2026, 4, 15, 14, 30, 0);

test('getQuote returns null before any quote is received', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: makeFixedNow(BASE_TS),
  });
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q, null);
});

test('quote for a watched ticker updates the cache; getQuote returns price+volume', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL', 'TSLA'], wsClient: ws, restClient: rest,
    now: makeFixedNow(BASE_TS),
  });
  ws.emit('quote', {
    symbol: 'AAPL', price: 198.42, volume: 12345678,
    dayHigh: 199.85, dayLow: 195.10, timestamp: 1747473420,
  });
  const q = await mc.getQuote('AAPL');
  assert.deepStrictEqual(q, { price: 198.42, volume: 12345678 });
});

test('quote for a ticker NOT in watchedTickers is discarded', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: makeFixedNow(BASE_TS),
  });
  ws.emit('quote', {
    symbol: 'NVDA', price: 800, volume: 1, timestamp: 1747473420,
  });
  const q = await mc.getQuote('NVDA');
  assert.strictEqual(q, null);
});

test('quote with a non-finite price is not cached', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: makeFixedNow(BASE_TS),
  });
  ws.emit('quote', { symbol: 'AAPL', price: null, volume: 100 });
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q, null);
});

test('getQuote returns null when the cached quote is older than maxStalenessMs', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  let nowMs = BASE_TS;
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    maxStalenessMs: 60_000,
  });
  ws.emit('quote', { symbol: 'AAPL', price: 100, volume: 1 });
  nowMs = BASE_TS + 30_000;
  assert.deepStrictEqual(await mc.getQuote('AAPL'), { price: 100, volume: 1 });
  nowMs = BASE_TS + 61_000;
  assert.strictEqual(await mc.getQuote('AAPL'), null);
});

test('getDailyBars delegates to restClient', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: makeFixedNow(BASE_TS),
  });
  const bars = await mc.getDailyBars('AAPL');
  assert.strictEqual(rest._calls.getDailyBars.length, 1);
  assert.strictEqual(rest._calls.getDailyBars[0], 'AAPL');
  assert.ok(Array.isArray(bars));
});

test('10 disconnects within the window flips inFallback to true', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  let nowMs = BASE_TS;
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 10,
    fallbackFailureWindowMs: 5 * 60_000,
  });
  for (let i = 0; i < 10; i++) {
    nowMs += 1_000;
    ws.emit('disconnected', { code: 1006, reason: '' });
  }
  // getQuote should now route to REST
  await mc.getQuote('AAPL');
  assert.strictEqual(rest._calls.getQuote.length, 1);
  assert.strictEqual(rest._calls.getQuote[0], 'AAPL');
  assert.strictEqual(mc.getStatus().source, 'rest-fallback');
});

test('connected event clears the fallback flag', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  let nowMs = BASE_TS;
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 3,
    fallbackFailureWindowMs: 5 * 60_000,
  });
  for (let i = 0; i < 3; i++) {
    nowMs += 1_000;
    ws.emit('disconnected', { code: 1006, reason: '' });
  }
  assert.strictEqual(mc.getStatus().source, 'rest-fallback');
  ws.emit('connected');
  assert.strictEqual(mc.getStatus().source, 'ws');
});

test('error event on wsClient is logged and counts as a disconnect (no crash)', async () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const logs = [];
  const fakeLogger = { log: () => {}, warn: () => {}, error: (m) => logs.push(String(m)) };
  let nowMs = BASE_TS;
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    logger: fakeLogger,
    fallbackFailureThreshold: 1,
    fallbackFailureWindowMs: 5 * 60_000,
  });
  ws.emit('error', new Error('TLS handshake failed'));
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /WS error/i);
  assert.strictEqual(mc.getStatus().source, 'rest-fallback');
});

test('start/stop delegate to wsClient', () => {
  const ws = makeFakeWsClient();
  const rest = makeFakeRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: [], wsClient: ws, restClient: rest,
  });
  mc.start();
  assert.strictEqual(ws._ee.started, true);
  mc.stop();
  assert.strictEqual(ws._ee.started, false);
});
