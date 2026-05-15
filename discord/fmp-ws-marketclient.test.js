const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createFmpWsMarketClient } = require('./fmp-ws-marketclient');

// A minimal wsClient mock — exposes the on/start/stop API and lets the
// test fire trade events.
function mockWsClient() {
  const events = new EventEmitter();
  const status = { connected: false, attemptCount: 0, subscribedTickers: [] };
  return {
    on: (e, cb) => events.on(e, cb),
    off: (e, cb) => events.off(e, cb),
    start: () => {},
    stop: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    getStatus: () => ({ ...status }),
    _fire: (event, payload) => events.emit(event, payload),
    _setStatus: (patch) => Object.assign(status, patch),
  };
}

function mockRestClient() {
  const calls = [];
  return {
    calls,
    getDailyBars: async (ticker) => {
      calls.push({ method: 'getDailyBars', ticker });
      return [{ date: new Date('2026-05-13'), open: 100, high: 110, low: 95, close: 105, volume: 1_000_000 }];
    },
    getQuote: async (ticker) => {
      calls.push({ method: 'getQuote', ticker });
      return { price: 100, volume: 500_000 };
    },
  };
}

// Build a fixed `now` clock for deterministic ET-date tests.
function makeFixedNow(iso) {
  let current = new Date(iso);
  return {
    now: () => current,
    advanceTo: (newIso) => { current = new Date(newIso); },
  };
}

test('getQuote returns null before any trade arrives', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date('2026-05-14T14:00:00Z'),  // 10:00 AM ET (RTH)
  });
  assert.strictEqual(await mc.getQuote('AAPL'), null);
});

test('getQuote returns last trade price and 0 volume from a single RTH trade', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  const clock = makeFixedNow('2026-05-14T14:00:00Z');  // 10:00 AM ET
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest, now: clock.now,
  });
  ws._fire('trade', { ticker: 'AAPL', price: 150.25, tradeSize: 100, ts: Date.now() });
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q.price, 150.25);
  assert.strictEqual(q.volume, 100);
});

test('getQuote accumulates volume across multiple RTH trades same day', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
  });
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 50, ts: nowMs });
  ws._fire('trade', { ticker: 'AAPL', price: 101, tradeSize: 30, ts: nowMs });
  ws._fire('trade', { ticker: 'AAPL', price: 102, tradeSize: 20, ts: nowMs });
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q.price, 102, 'price is the LAST trade');
  assert.strictEqual(q.volume, 100, 'volume sums all three');
});

test('cumulative volume resets when the ET-date changes', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  const clock = makeFixedNow('2026-05-14T14:00:00Z');  // Day 1, 10:00 AM ET
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest, now: clock.now,
  });
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 1000, ts: Date.parse('2026-05-14T14:00:00Z') });
  assert.strictEqual((await mc.getQuote('AAPL')).volume, 1000);
  // Advance to next ET-date (still within RTH)
  clock.advanceTo('2026-05-15T14:00:00Z');
  ws._fire('trade', { ticker: 'AAPL', price: 110, tradeSize: 50, ts: Date.parse('2026-05-15T14:00:00Z') });
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q.price, 110);
  assert.strictEqual(q.volume, 50, 'cumulative resets on ET-date change');
});

test('pre-market trade updates lastPrice but NOT cumulative volume', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  // 09:00 AM ET = 13:00 UTC (EDT, summer). Pre-market.
  const clock = makeFixedNow('2026-05-14T13:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest, now: clock.now,
  });
  ws._fire('trade', { ticker: 'AAPL', price: 99, tradeSize: 500, ts: Date.parse('2026-05-14T13:00:00Z') });
  const q1 = await mc.getQuote('AAPL');
  assert.strictEqual(q1.price, 99, 'pre-market price IS recorded');
  assert.strictEqual(q1.volume, 0, 'pre-market volume is NOT cumulated');
});

test('first RTH trade starts cumulative volume from zero (pre-market not counted)', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  const clock = makeFixedNow('2026-05-14T13:00:00Z');  // 09:00 ET, pre-market
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest, now: clock.now,
  });
  ws._fire('trade', { ticker: 'AAPL', price: 99, tradeSize: 500, ts: Date.parse('2026-05-14T13:00:00Z') });
  clock.advanceTo('2026-05-14T14:00:00Z');  // 10:00 ET, RTH
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 30, ts: Date.parse('2026-05-14T14:00:00Z') });
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q.volume, 30, 'RTH cumulative starts at 0 + 30');
});

test('getDailyBars delegates to restClient', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date('2026-05-14T14:00:00Z'),
  });
  const bars = await mc.getDailyBars('AAPL');
  assert.ok(Array.isArray(bars));
  assert.strictEqual(rest.calls.length, 1);
  assert.deepStrictEqual(rest.calls[0], { method: 'getDailyBars', ticker: 'AAPL' });
});

test('start() calls wsClient.start; stop() calls wsClient.stop', () => {
  let started = 0, stopped = 0;
  const ws = mockWsClient();
  ws.start = () => started++;
  ws.stop = () => stopped++;
  const rest = mockRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date('2026-05-14T14:00:00Z'),
  });
  mc.start();
  assert.strictEqual(started, 1);
  mc.stop();
  assert.strictEqual(stopped, 1);
});

test('getStatus exposes ws status + data source', () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  ws._setStatus({ connected: true, attemptCount: 2, subscribedTickers: ['AAPL'] });
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date('2026-05-14T14:00:00Z'),
  });
  const s = mc.getStatus();
  assert.strictEqual(s.source, 'ws');
  assert.strictEqual(s.wsConnected, true);
  assert.strictEqual(s.wsAttemptCount, 2);
  assert.deepStrictEqual(s.subscribedTickers, ['AAPL']);
});

// ── Fallback tests (Task 5) ─────────────────────────────────────────

test('after N reconnect failures within window, getQuote uses restClient', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 3,
    fallbackFailureWindowMs: 60_000,
  });
  // Fire 3 disconnect events within 60s
  ws._fire('disconnected', { code: 1006, reason: 'abnormal' });
  nowMs += 10_000;
  ws._fire('disconnected', { code: 1006, reason: 'abnormal' });
  nowMs += 10_000;
  ws._fire('disconnected', { code: 1006, reason: 'abnormal' });
  // Now in fallback — getQuote calls REST
  await mc.getQuote('AAPL');
  assert.strictEqual(rest.calls.length, 1);
  assert.deepStrictEqual(rest.calls[0], { method: 'getQuote', ticker: 'AAPL' });
});

test('fallback flips back to ws on successful reconnect', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 2,
    fallbackFailureWindowMs: 60_000,
  });
  ws._fire('disconnected', { code: 1006 });
  nowMs += 10_000;
  ws._fire('disconnected', { code: 1006 });
  // In fallback — verify
  assert.strictEqual(mc.getStatus().source, 'rest-fallback');
  // WS reconnects
  ws._fire('connected');
  assert.strictEqual(mc.getStatus().source, 'ws');
});

test('disconnects spaced beyond the window do NOT trigger fallback', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 2,
    fallbackFailureWindowMs: 60_000,
  });
  ws._fire('disconnected', { code: 1006 });
  nowMs += 65_000;  // beyond the window
  ws._fire('disconnected', { code: 1006 });
  // Still ws (only one disconnect within the window)
  assert.strictEqual(mc.getStatus().source, 'ws');
});

test('in fallback, getQuote returns whatever restClient returns', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  rest.getQuote = async () => ({ price: 250, volume: 12345 });
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 1,
    fallbackFailureWindowMs: 60_000,
  });
  ws._fire('disconnected', { code: 1006 });
  const q = await mc.getQuote('AAPL');
  assert.deepStrictEqual(q, { price: 250, volume: 12345 });
});

// ── Staleness tests ─────────────────────────────────────────────────

test('getQuote returns null when cached trade is older than maxStalenessMs', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    maxStalenessMs: 15 * 60 * 1000,  // 15 min
  });
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 50, ts: nowMs });
  assert.strictEqual((await mc.getQuote('AAPL')).price, 100, 'fresh trade returns price');
  // Advance clock by 16 minutes — beyond staleness
  nowMs += 16 * 60 * 1000;
  assert.strictEqual(await mc.getQuote('AAPL'), null, 'stale trade returns null');
});

test('getQuote still returns within the staleness window', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    maxStalenessMs: 15 * 60 * 1000,
  });
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 50, ts: nowMs });
  nowMs += 10 * 60 * 1000;  // 10 min later, within 15min window
  const q = await mc.getQuote('AAPL');
  assert.strictEqual(q.price, 100, 'still fresh enough');
});

test('staleness check uses the cached lastTs, not Date.now()', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    maxStalenessMs: 60_000,  // 1 min
  });
  // Trade with ts=10 minutes ago (already stale at fire time)
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 50, ts: nowMs - (10 * 60 * 1000) });
  assert.strictEqual(await mc.getQuote('AAPL'), null, 'should be stale immediately based on lastTs');
});

test('staleness check is bypassed during REST fallback (REST returns its own fresh quote)', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  rest.getQuote = async () => ({ price: 999, volume: 12345 });
  let nowMs = Date.parse('2026-05-14T14:00:00Z');
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date(nowMs),
    fallbackFailureThreshold: 1,
    fallbackFailureWindowMs: 60_000,
    maxStalenessMs: 60_000,
  });
  // Trigger fallback
  ws._fire('disconnected', { code: 1006 });
  // Even though no fresh WS trade, REST fallback returns its own data
  const q = await mc.getQuote('AAPL');
  assert.deepStrictEqual(q, { price: 999, volume: 12345 });
});

// ── Error handling tests (regression: prod crash from FMP login rejection) ─

test('wsClient error event engages REST fallback (no process crash)', async () => {
  const ws = mockWsClient();
  const rest = mockRestClient();
  rest.getQuote = async () => ({ price: 250, volume: 12345 });
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    logger: { error: () => {}, warn: () => {}, log: () => {} },
  });
  // Reproduce the prod crash trigger: FMP rejects the login.
  // BEFORE the fix: this would emit an unhandled 'error' on the wsClient
  // EventEmitter and crash the entire Node process. AFTER the fix: the
  // marketclient attaches its own 'error' listener that engages fallback.
  ws._fire('error', new Error('login rejected: Unauthorized'));
  // Subsequent getQuote must route through restClient.
  const q = await mc.getQuote('AAPL');
  assert.deepStrictEqual(q, { price: 250, volume: 12345 });
  assert.strictEqual(mc.getStatus().source, 'rest-fallback');
});

test('wsClient auth error (login rejected) stops the WS to prevent reconnect spam', async () => {
  const ws = mockWsClient();
  let stopCalls = 0;
  ws.stop = () => { stopCalls++; };
  const rest = mockRestClient();
  createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    logger: { error: () => {}, warn: () => {}, log: () => {} },
  });
  ws._fire('error', new Error('login rejected: Unauthorized'));
  assert.strictEqual(stopCalls, 1, 'auth errors should stop wsClient');
});

test('wsClient transient error engages fallback but does NOT stop WS', async () => {
  const ws = mockWsClient();
  let stopCalls = 0;
  ws.stop = () => { stopCalls++; };
  const rest = mockRestClient();
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    logger: { error: () => {}, warn: () => {}, log: () => {} },
  });
  ws._fire('error', new Error('ECONNRESET'));
  assert.strictEqual(mc.getStatus().source, 'rest-fallback', 'fallback engaged on transient error');
  assert.strictEqual(stopCalls, 0, 'transient errors should NOT stop wsClient (reconnect allowed)');
});
