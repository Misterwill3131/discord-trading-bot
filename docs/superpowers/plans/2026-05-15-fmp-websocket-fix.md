# FMP WebSocket Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `discord/fmp-ws-client.js` and `discord/fmp-ws-marketclient.js` with the correct FMP WebSocket protocol (endpoint `wss://socket.financialmodelingprep.com`, stream-based subscribe, full quote object parser), keeping the runtime toggle `MARKET_ALERTS_USE_WS` defaulted to `false` so no production behavior change occurs at merge.

**Architecture:** Two-layer split preserved. Layer 1 (raw protocol) handles connect/login/subscribe/heartbeat and emits a `'quote'` event with the full FMP quote object. Layer 2 (marketClient adapter) filters incoming quotes by a configured ticker set, caches the latest per-ticker, and exposes the existing `getQuote(ticker) → { price, volume }` contract used by `market-alerts.js`. Both files are completely rewritten; tests are rewritten from scratch.

**Tech Stack:** Node.js · `ws` (existing) · `EventEmitter` (node:events) · node:test + node:assert · better-sqlite3 (unaffected).

**Spec:** [docs/superpowers/specs/2026-05-15-fmp-websocket-fix-design.md](../specs/2026-05-15-fmp-websocket-fix-design.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `discord/fmp-ws-client.js` | Rewrite | Raw WS protocol — connect, login, subscribe streams, emit `quote`/`heartbeat`/`connected`/`disconnected`/`error` |
| `discord/fmp-ws-client.test.js` | Rewrite | Test the new protocol — mock `ws`, drive state machine, assert emitted events |
| `discord/fmp-ws-marketclient.js` | Rewrite | Adapter — filter by ticker, cache last quote, expose `getQuote`/`getDailyBars`, preserve REST fallback |
| `discord/fmp-ws-marketclient.test.js` | Rewrite | Test the adapter — fake wsClient, drive quote events, assert cache/fallback behavior |
| `discord/jobs.js` | Modify | Read `MARKET_ALERTS_USE_WS` (default `false`) + `FMP_WS_STREAMS` (default `fmp-us-equities-stream`); pass to `createFmpWsClient` |
| `.env.example` | Modify | Document new env vars + bandwidth warning |

---

## Conventions used in this plan

- **Test runner:** `node --test <file>` (project uses native `node:test`)
- **Working directory:** `C:\Users\willi\Documents\GitHub\discord-trading-bot\.claude\worktrees\fmp-ws-fix`
- **`ws` mock pattern:** the new tests reuse the `makeMockWebSocketFactory` shape from the existing `discord/fmp-ws-client.test.js`, adapted for stream-based subscribe
- **`MARKET_ALERTS_USE_WS`** replaces the previous `FMP_WS_ENABLED` env var; the prior var name is removed (no backward-compat alias — clean break)
- **Commit per task:** end of each task; messages follow `<type>(<module>): <short>` convention

---

## Task 1: Rewrite `discord/fmp-ws-client.js` (Layer 1)

Complete rewrite of the raw WS protocol module. Endpoint, payloads, message parser all changed.

**Files:**
- Rewrite: `discord/fmp-ws-client.js`
- Rewrite: `discord/fmp-ws-client.test.js`

### Step 1.1: Replace `discord/fmp-ws-client.test.js` with the new test suite

Overwrite the entire file with:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createFmpWsClient, DEFAULT_ENDPOINT } = require('./fmp-ws-client');

// Mock WebSocket: a fake constructor that returns a controllable socket.
// `triggerOpen`, `triggerMessage`, `triggerClose`, `triggerError` drive the
// state machine. `.sent` is the array of payloads passed to .send().
function makeMockWebSocketFactory() {
  const instances = [];
  function MockWebSocket(url) {
    const handlers = {};
    const sent = [];
    const sock = {
      url,
      sent,
      readyState: 0,           // 0 = CONNECTING, 1 = OPEN, 3 = CLOSED
      on(event, cb) { handlers[event] = cb; return this; },
      send(data) { sent.push(data); },
      close() { sock.readyState = 3; if (handlers.close) handlers.close(1000, ''); },
      triggerOpen() { sock.readyState = 1; if (handlers.open) handlers.open(); },
      triggerMessage(data) {
        if (handlers.message) handlers.message(typeof data === 'string' ? data : JSON.stringify(data));
      },
      triggerClose(code, reason) {
        sock.readyState = 3;
        if (handlers.close) handlers.close(code || 1006, reason || '');
      },
      triggerError(err) { if (handlers.error) handlers.error(err); },
    };
    instances.push(sock);
    return sock;
  }
  MockWebSocket.instances = instances;
  MockWebSocket.last = () => instances[instances.length - 1];
  return MockWebSocket;
}

test('DEFAULT_ENDPOINT is the correct FMP socket URL', () => {
  assert.strictEqual(DEFAULT_ENDPOINT, 'wss://socket.financialmodelingprep.com');
});

test('start() opens the WS and sends login as the first message', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'KEY', streams: [], WebSocketImpl: WS });
  client.start();
  assert.strictEqual(WS.instances.length, 1);
  assert.strictEqual(WS.last().url, 'wss://socket.financialmodelingprep.com');
  WS.last().triggerOpen();
  assert.strictEqual(WS.last().sent.length, 1);
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[0]),
    { event: 'login', data: { apiKey: 'KEY' } }
  );
});

test('endpoint can be overridden via the `endpoint` option', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K', streams: [], WebSocketImpl: WS, endpoint: 'wss://test.example/ws',
  });
  client.start();
  assert.strictEqual(WS.last().url, 'wss://test.example/ws');
});

test('subscribe is sent for each stream after login confirms (status 200)', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K',
    streams: ['fmp-us-equities-stream', 'fmp-us-otc-stream'],
    WebSocketImpl: WS,
  });
  client.start();
  WS.last().triggerOpen();
  assert.strictEqual(WS.last().sent.length, 1, 'only login sent before login response');
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  assert.strictEqual(WS.last().sent.length, 3, 'login + 2 subscribes');
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[1]),
    { event: 'subscribe', data: { stream: 'fmp-us-equities-stream' } }
  );
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[2]),
    { event: 'subscribe', data: { stream: 'fmp-us-otc-stream' } }
  );
});

test('subscribe is NOT sent before login response', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K', streams: ['fmp-us-equities-stream'], WebSocketImpl: WS,
  });
  client.start();
  WS.last().triggerOpen();
  assert.strictEqual(WS.last().sent.length, 1);
});

test('login response status 200 emits "connected"', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', streams: [], WebSocketImpl: WS });
  let connected = 0;
  client.on('connected', () => connected++);
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  assert.strictEqual(connected, 1);
});

test('login response status 401 emits "error" and does NOT emit "connected"', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', streams: [], WebSocketImpl: WS });
  let connected = 0;
  const errors = [];
  client.on('connected', () => connected++);
  client.on('error', (err) => errors.push(err));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({
    event: 'login',
    data: { status: 401, message: 'Unauthorized' },
  });
  assert.strictEqual(connected, 0);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /login rejected/i);
});

test('a message without an "event" field is emitted as "quote" with the full payload', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K', streams: ['fmp-us-equities-stream'], WebSocketImpl: WS,
  });
  const quotes = [];
  client.on('quote', (q) => quotes.push(q));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  WS.last().triggerMessage({
    symbol: 'AAPL', name: 'Apple Inc.', price: 198.42,
    changesPercentage: 1.23, change: 2.41,
    dayLow: 195.10, dayHigh: 199.85,
    yearHigh: 220.50, yearLow: 165.30,
    marketCap: 3000000000000,
    volume: 12345678, avgVolume: 50000000,
    open: 196.50, previousClose: 196.01,
    eps: 6.13, pe: 32.4,
    earningsAnnouncement: null, sharesOutstanding: 15000000000,
    timestamp: 1747473420,
    range: '195.10 - 199.85',
    type: 'stock',
    updatedAt: '2026-05-15T16:30:00.504Z',
  });
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].symbol, 'AAPL');
  assert.strictEqual(quotes[0].price, 198.42);
  assert.strictEqual(quotes[0].dayHigh, 199.85);
  assert.strictEqual(quotes[0].volume, 12345678);
});

test('a message with event: "heartbeat" emits "heartbeat" event', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', streams: [], WebSocketImpl: WS });
  const beats = [];
  client.on('heartbeat', (h) => beats.push(h));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  WS.last().triggerMessage({ event: 'heartbeat', timestamp: 1747473420002 });
  assert.strictEqual(beats.length, 1);
  assert.strictEqual(beats[0].timestamp, 1747473420002);
});

test('subscribe response status 401 emits "error" but does not crash', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K', streams: ['fmp-us-equities-stream'], WebSocketImpl: WS,
  });
  const errors = [];
  client.on('error', (err) => errors.push(err));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  WS.last().triggerMessage({
    event: 'subscribe', status: 401, message: 'Unauthorized',
  });
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /subscribe rejected/i);
});

test('close triggers "disconnected" then schedules reconnect', async () => {
  const WS = makeMockWebSocketFactory();
  let scheduledDelay = null;
  const fakeSetTimeout = (cb, delay) => { scheduledDelay = delay; return 1; };
  const client = createFmpWsClient({
    apiKey: 'K', streams: [], WebSocketImpl: WS,
    setTimeoutImpl: fakeSetTimeout, clearTimeoutImpl: () => {},
    reconnectMinMs: 1_000, reconnectMaxMs: 30_000,
  });
  const closes = [];
  client.on('disconnected', (e) => closes.push(e));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerClose(1006, 'abnormal');
  assert.strictEqual(closes.length, 1);
  assert.strictEqual(closes[0].code, 1006);
  assert.strictEqual(scheduledDelay, 1_000, 'first retry uses reconnectMinMs');
});

test('reconnect re-subscribes the original streams after re-login', () => {
  const WS = makeMockWebSocketFactory();
  let scheduledCb = null;
  const fakeSetTimeout = (cb) => { scheduledCb = cb; return 1; };
  const client = createFmpWsClient({
    apiKey: 'K',
    streams: ['fmp-us-equities-stream', 'fmp-index-stream'],
    WebSocketImpl: WS,
    setTimeoutImpl: fakeSetTimeout, clearTimeoutImpl: () => {},
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  // 1 login + 2 subscribes already sent
  assert.strictEqual(WS.last().sent.length, 3);
  WS.last().triggerClose(1006, 'lost');
  assert.ok(typeof scheduledCb === 'function');
  scheduledCb();   // fire the reconnect
  assert.strictEqual(WS.instances.length, 2, 'new WS instance was created');
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  // After re-login, the 2 subscribes are re-sent
  assert.strictEqual(WS.last().sent.length, 3);
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[1]),
    { event: 'subscribe', data: { stream: 'fmp-us-equities-stream' } }
  );
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[2]),
    { event: 'subscribe', data: { stream: 'fmp-index-stream' } }
  );
});

test('stop() sends unsubscribe for each subscribed stream then closes', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K',
    streams: ['fmp-us-equities-stream', 'fmp-index-stream'],
    WebSocketImpl: WS,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  assert.strictEqual(WS.last().sent.length, 3);
  client.stop();
  // 2 more unsubscribes appended before close
  assert.strictEqual(WS.last().sent.length, 5);
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[3]),
    { event: 'unsubscribe', data: { stream: 'fmp-us-equities-stream' } }
  );
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[4]),
    { event: 'unsubscribe', data: { stream: 'fmp-index-stream' } }
  );
  assert.strictEqual(WS.last().readyState, 3, 'socket closed');
});

test('getStatus() reports connected + subscribedStreams + attemptCount', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K',
    streams: ['fmp-us-equities-stream'],
    WebSocketImpl: WS,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', data: { status: 200, message: 'Authenticated' } });
  const s = client.getStatus();
  assert.strictEqual(s.connected, true);
  assert.deepStrictEqual(s.subscribedStreams, ['fmp-us-equities-stream']);
  assert.strictEqual(s.attemptCount, 0, 'reset to 0 on successful login');
});

test('malformed JSON message is dropped without throwing', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', streams: [], WebSocketImpl: WS });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage('this is not JSON {{{');
  // No throw, no event emitted — test passes by not crashing.
  assert.ok(true);
});

test('an "error" event on the underlying socket is emitted as "error" on the client', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', streams: [], WebSocketImpl: WS });
  const errors = [];
  client.on('error', (err) => errors.push(err));
  client.start();
  WS.last().triggerError(new Error('TLS handshake failed'));
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].message, 'TLS handshake failed');
});
```

### Step 1.2: Run the new tests to verify they fail

```bash
node --test discord/fmp-ws-client.test.js
```

Expected: most tests fail (the current implementation uses the old protocol). Some may pass coincidentally (e.g., the malformed-JSON test). At least 10 failures expected.

### Step 1.3: Replace `discord/fmp-ws-client.js` with the new implementation

Overwrite the entire file with:

```js
// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-client.js — Client WebSocket FMP (raw protocol)
// ─────────────────────────────────────────────────────────────────────
// Long-lived WebSocket connection to FMP's Standard WebSocket API for
// real-time market data. Emits a typed 'quote' event for each full-quote
// message; emits 'heartbeat' for keepalive events; emits 'connected'
// once the login response confirms (status 200).
//
// Protocol (verified from FMP dashboard 2026-05-15) :
//   wss://socket.financialmodelingprep.com
//   Login:       { event: 'login',       data: { apiKey } }
//   Subscribe:   { event: 'subscribe',   data: { stream: '<stream-name>' } }
//   Unsubscribe: { event: 'unsubscribe', data: { stream: '<stream-name>' } }
//   Heartbeat:   { event: 'heartbeat', timestamp: <ms> }   (server-push)
//   Quote msg:   { symbol, name, price, dayHigh, dayLow, volume, ..., updatedAt }
//                (no `event` field — distinguishes from control messages)
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-websocket-fix-design.md
// ─────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('node:events');

const DEFAULT_ENDPOINT = 'wss://socket.financialmodelingprep.com';

function createFmpWsClient({
  apiKey,
  streams = [],
  endpoint = DEFAULT_ENDPOINT,
  WebSocketImpl,
  logger = console,
  reconnectMinMs = 1_000,
  reconnectMaxMs = 30_000,
  reconnectMaxAttempts = 0,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!apiKey) throw new Error('FMP apiKey required');
  if (!WebSocketImpl) {
    try {
      WebSocketImpl = require('ws').WebSocket;
    } catch (e) {
      throw new Error('ws module not available — install `ws` or pass WebSocketImpl');
    }
  }

  const events = new EventEmitter();
  const subscribedStreams = new Set(streams.map(s => String(s)));
  let sock = null;
  let loggedIn = false;
  let stopped = false;
  let connecting = false;
  let attemptCount = 0;
  let reconnectHandle = null;
  let lastHeartbeatAt = null;

  function send(obj) {
    if (!sock || sock.readyState !== 1) return false;
    try {
      sock.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      logger.error('[fmp-ws] send failed:', err.message);
      return false;
    }
  }

  function sendLogin() {
    send({ event: 'login', data: { apiKey } });
  }

  function sendSubscribeAll() {
    for (const stream of subscribedStreams) {
      send({ event: 'subscribe', data: { stream } });
    }
  }

  function sendUnsubscribeAll() {
    for (const stream of subscribedStreams) {
      send({ event: 'unsubscribe', data: { stream } });
    }
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (err) {
      logger.warn('[fmp-ws] malformed message dropped:', String(raw).slice(0, 100));
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Login response → flush queued subscriptions.
    if (msg.event === 'login') {
      const status = msg.data && Number.isFinite(msg.data.status) ? msg.data.status : 200;
      if (status >= 400) {
        const reason = (msg.data && msg.data.message) || ('status ' + status);
        logger.error('[fmp-ws] login rejected:', reason);
        events.emit('error', new Error('login rejected: ' + reason));
        return;
      }
      loggedIn = true;
      attemptCount = 0;
      events.emit('connected');
      sendSubscribeAll();
      return;
    }

    // Subscribe / unsubscribe responses.
    if (msg.event === 'subscribe' || msg.event === 'unsubscribe') {
      const status = Number.isFinite(msg.status) ? msg.status : 200;
      if (status >= 400) {
        const reason = msg.message || ('status ' + status);
        logger.error('[fmp-ws] ' + msg.event + ' rejected:', reason);
        events.emit('error', new Error(msg.event + ' rejected: ' + reason));
      }
      return;
    }

    // Heartbeat.
    if (msg.event === 'heartbeat') {
      lastHeartbeatAt = Number(msg.timestamp) || Date.now();
      events.emit('heartbeat', { timestamp: lastHeartbeatAt });
      return;
    }

    // Any other message without a recognized `event` field is treated
    // as a quote payload (full FMP quote object). FMP quotes have no
    // `event` key — they are identified by the absence of one.
    if (!msg.event) {
      events.emit('quote', msg);
      return;
    }

    // Unknown event → ignore silently.
  }

  function handleClose(code, reason) {
    loggedIn = false;
    events.emit('disconnected', { code, reason: String(reason || '') });
    if (stopped) return;
    scheduleReconnect();
  }

  function handleError(err) {
    events.emit('error', err);
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectMaxAttempts > 0 && attemptCount >= reconnectMaxAttempts) {
      logger.error('[fmp-ws] giving up — max reconnect attempts reached');
      events.emit('error', new Error('max reconnect attempts reached'));
      return;
    }
    attemptCount++;
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, attemptCount - 1));
    reconnectHandle = setTimeoutImpl(() => {
      reconnectHandle = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped || connecting) return;
    connecting = true;
    try {
      sock = new WebSocketImpl(endpoint);
    } catch (err) {
      connecting = false;
      events.emit('error', err);
      return;
    }
    sock.on('open', () => {
      connecting = false;
      sendLogin();
    });
    sock.on('message', handleMessage);
    sock.on('close', handleClose);
    sock.on('error', handleError);
  }

  return {
    on: (event, cb) => events.on(event, cb),
    off: (event, cb) => events.off(event, cb),

    start() {
      stopped = false;
      connect();
    },

    stop() {
      stopped = true;
      if (reconnectHandle) {
        clearTimeoutImpl(reconnectHandle);
        reconnectHandle = null;
      }
      if (sock && sock.readyState === 1) {
        sendUnsubscribeAll();
      }
      if (sock && sock.readyState !== 3) {
        try { sock.close(); } catch (_) { /* ignore */ }
      }
    },

    getStatus() {
      return {
        connected: loggedIn,
        subscribedStreams: Array.from(subscribedStreams),
        attemptCount,
        lastHeartbeatAt,
      };
    },
  };
}

module.exports = { createFmpWsClient, DEFAULT_ENDPOINT };
```

### Step 1.4: Run tests to verify they pass

```bash
node --test discord/fmp-ws-client.test.js
```

Expected: all tests pass (~15 tests). If any fails, fix the implementation (NOT the test) until green.

### Step 1.5: Commit Task 1

```bash
git add discord/fmp-ws-client.js discord/fmp-ws-client.test.js
git commit -m "feat(fmp-ws): rewrite Layer 1 with correct FMP protocol

Endpoint wss://socket.financialmodelingprep.com (was: websockets.* — bad).
Stream-based subscribe { event: 'subscribe', data: { stream } } (was:
per-ticker — bad). Full quote object passthrough via 'quote' event (was:
trade-tick parser — bad). Heartbeat event surfaced. Re-subscribe streams
on reconnect.

Spec: docs/superpowers/specs/2026-05-15-fmp-websocket-fix-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rewrite `discord/fmp-ws-marketclient.js` (Layer 2)

Adapter that filters incoming quotes by ticker set and exposes the existing `marketClient` contract.

**Files:**
- Rewrite: `discord/fmp-ws-marketclient.js`
- Rewrite: `discord/fmp-ws-marketclient.test.js`

### Step 2.1: Replace `discord/fmp-ws-marketclient.test.js` with the new test suite

Overwrite the entire file with:

```js
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
```

### Step 2.2: Run tests to verify they fail

```bash
node --test discord/fmp-ws-marketclient.test.js
```

Expected: at least 5 failures (the current impl listens to `'trade'` not `'quote'`, has different cache shape).

### Step 2.3: Replace `discord/fmp-ws-marketclient.js` with the new implementation

Overwrite the entire file with:

```js
// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-marketclient.js — Adapter marketClient via WS FMP
// ─────────────────────────────────────────────────────────────────────
// Implements the marketClient contract (getQuote, getDailyBars) expected
// by discord/market-alerts.js, sourcing live prices from a wsClient that
// streams full FMP quote objects, with automatic REST fallback when the
// WebSocket is unstable.
//
// FMP streams are subscribed at the EXCHANGE / SYNTHETIC level (e.g.
// fmp-us-equities-stream). Every quote for every symbol in that stream
// is delivered — we filter client-side against the configured tickers
// of interest and cache only the latest per-symbol.
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-websocket-fix-design.md
// ─────────────────────────────────────────────────────────────────────

function createFmpWsMarketClient({
  apiKey,
  tickers = [],
  wsClient,
  restClient,
  now = () => new Date(),
  logger = console,
  fallbackFailureThreshold = 10,
  fallbackFailureWindowMs = 5 * 60_000,
  maxStalenessMs = 15 * 60_000,
} = {}) {
  if (!wsClient)   throw new Error('wsClient required');
  if (!restClient) throw new Error('restClient required');

  // Cache: keyed by UPPERCASE symbol.
  const cache = new Map();

  // Tickers of interest — UPPERCASE for case-insensitive matching.
  const watchedTickers = new Set(
    tickers.map(t => String(t).toUpperCase()).filter(Boolean),
  );

  // Sliding window of disconnect timestamps; flip inFallback when count
  // within the window exceeds threshold.
  let disconnectTimes = [];
  let inFallback = false;

  function recordDisconnect() {
    const t = now().getTime();
    disconnectTimes = disconnectTimes.filter(x => (t - x) <= fallbackFailureWindowMs);
    disconnectTimes.push(t);
    if (!inFallback && disconnectTimes.length >= fallbackFailureThreshold) {
      inFallback = true;
      logger.warn('[fmp-ws-marketclient] WS unstable — flipping to REST fallback ('
        + disconnectTimes.length + ' disconnects in '
        + Math.round(fallbackFailureWindowMs / 1000) + 's window)');
    }
  }

  function clearFallback() {
    if (inFallback) {
      logger.log('[fmp-ws-marketclient] WS reconnected — leaving REST fallback');
      inFallback = false;
    }
    disconnectTimes = [];
  }

  function onQuote(q) {
    if (!q || typeof q !== 'object') return;
    const symbol = String(q.symbol || '').toUpperCase();
    if (!symbol || !watchedTickers.has(symbol)) return;

    const price = Number.isFinite(q.price) ? q.price : null;
    if (price == null) return;   // do not cache garbage

    cache.set(symbol, {
      price,
      volume:    Number.isFinite(q.volume) ? q.volume : 0,
      dayHigh:   Number.isFinite(q.dayHigh) ? q.dayHigh : null,
      dayLow:    Number.isFinite(q.dayLow)  ? q.dayLow  : null,
      timestamp: Number(q.timestamp) || 0,
      receivedAt: now().getTime(),
    });
  }

  wsClient.on('quote', onQuote);
  wsClient.on('disconnected', recordDisconnect);
  wsClient.on('connected', clearFallback);
  wsClient.on('error', (err) => {
    logger.error('[fmp-ws-marketclient] WS error: '
      + (err && err.message ? err.message : String(err)));
    recordDisconnect();
  });

  return {
    async getQuote(ticker) {
      if (inFallback) {
        return restClient.getQuote(ticker);
      }
      const key = String(ticker).toUpperCase();
      const entry = cache.get(key);
      if (!entry || entry.price == null) return null;
      if ((now().getTime() - entry.receivedAt) > maxStalenessMs) {
        return null;
      }
      return { price: entry.price, volume: entry.volume };
    },

    async getDailyBars(ticker) {
      return restClient.getDailyBars(ticker);
    },

    start() {
      if (typeof wsClient.start === 'function') wsClient.start();
    },

    stop() {
      if (typeof wsClient.stop === 'function') wsClient.stop();
    },

    getStatus() {
      const ws = typeof wsClient.getStatus === 'function' ? wsClient.getStatus() : {};
      return {
        source: inFallback ? 'rest-fallback' : 'ws',
        wsConnected: !!ws.connected,
        wsAttemptCount: ws.attemptCount || 0,
        subscribedStreams: Array.isArray(ws.subscribedStreams) ? ws.subscribedStreams : [],
        recentDisconnects: disconnectTimes.length,
      };
    },
  };
}

module.exports = { createFmpWsMarketClient };
```

### Step 2.4: Run tests to verify they pass

```bash
node --test discord/fmp-ws-marketclient.test.js
```

Expected: all tests pass (10 tests).

### Step 2.5: Commit Task 2

```bash
git add discord/fmp-ws-marketclient.js discord/fmp-ws-marketclient.test.js
git commit -m "feat(fmp-ws): rewrite Layer 2 adapter to consume stream-quote events

Listen for 'quote' events emitted by the new fmp-ws-client and filter by
ticker set client-side. Cache shape now mirrors the FMP full-quote object
(price, volume, dayHigh, dayLow, timestamp, receivedAt). Drop the legacy
cumulativeVolumeToday accumulator — FMP sends day-cumulative volume
directly in each quote. REST fallback machinery preserved verbatim from
PR #66+#67.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update `discord/jobs.js` wiring

Three localized edits — toggle name, streams parsing, client construction.

**Files:**
- Modify: `discord/jobs.js`

### Step 3.1: Locate the existing block

In `discord/jobs.js`, find the lines around 209–225 (inside `startScheduler`). The current code reads:

```js
    const useWs = process.env.FMP_WS_ENABLED === 'true';
    // ...
    if (useWs) {
      const wsClient = createFmpWsClient({ apiKey: fmpKey, tickers });
      const maxStalenessMs = Math.max(0, parseInt(
        process.env.FMP_WS_MAX_STALENESS_MS || '900000', 10) || 900000);
      marketClient = createFmpWsMarketClient({
        apiKey: fmpKey, tickers, wsClient, restClient, maxStalenessMs,
      });
```

### Step 3.2: Apply the edits

Use Edit to change `const useWs = process.env.FMP_WS_ENABLED === 'true';` to:

```js
    const useWs = String(process.env.MARKET_ALERTS_USE_WS || 'false').toLowerCase() === 'true';
```

Then use Edit to change the block that creates `wsClient` and `marketClient`:

**Before:**
```js
      const wsClient = createFmpWsClient({ apiKey: fmpKey, tickers });
      const maxStalenessMs = Math.max(0, parseInt(
        process.env.FMP_WS_MAX_STALENESS_MS || '900000', 10) || 900000);
```

**After:**
```js
      const streamsCsv = process.env.FMP_WS_STREAMS || 'fmp-us-equities-stream';
      const streams = streamsCsv.split(',').map(s => s.trim()).filter(Boolean);
      const wsClient = createFmpWsClient({
        apiKey: fmpKey,
        streams,
        endpoint: process.env.FMP_WS_ENDPOINT || undefined,
      });
      const maxStalenessMs = Math.max(0, parseInt(
        process.env.FMP_WS_MAX_STALENESS_MS || '900000', 10) || 900000);
```

### Step 3.3: Smoke-check the require chain

```bash
node --check discord/jobs.js
```

Expected: no output (success).

```bash
node -e "require('./discord/jobs'); console.log('jobs.js loads ok')"
```

Expected output: `jobs.js loads ok`.

### Step 3.4: Run the full milestone-checker + market-alerts suites for regressions

```bash
node --test discord/milestone-checker.test.js discord/market-alerts.test.js
```

Expected: all tests pass. Neither suite imports the new WS modules at runtime (they use dependency injection), so a passing run confirms no integration regression.

### Step 3.5: Commit Task 3

```bash
git add discord/jobs.js
git commit -m "feat(jobs): wire new FMP WebSocket env vars (MARKET_ALERTS_USE_WS, FMP_WS_STREAMS)

Replace FMP_WS_ENABLED with MARKET_ALERTS_USE_WS (default false). Parse
FMP_WS_STREAMS as CSV (default fmp-us-equities-stream). Pass streams +
optional endpoint override to createFmpWsClient.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Update `.env.example`

Replace the legacy `FMP_WS_ENABLED` entry and document the new vars.

**Files:**
- Modify: `.env.example`

### Step 4.1: Find and replace the legacy WS section

Open `.env.example` and locate any existing `FMP_WS_ENABLED` or `FMP_WS_MAX_STALENESS_MS` lines (likely in a block added by PR #66). Replace the entire WS block (or append if absent) with:

```env

# === FMP WEBSOCKET (refactored 2026-05-15) ===========================
# OFF par défaut — REST suffit pour les ticks 5-30 min. Activer
# uniquement si tu as un use-case sub-seconde ET tu acceptes le coût
# bande passante (~120 GB/jour sur fmp-us-equities-stream — bien au-delà
# du quota 50 GB/mois du plan Premium).
#
# Architecture : le bot subscribe à des streams entiers (pas par ticker),
# filtre client-side par symbol. Le quota bandwidth se consomme sur les
# messages reçus AVANT le filtre.
#
# Doc officielle : ouvrir https://site.financialmodelingprep.com/developer/docs/dashboard?tab=userDeclarations
# → section "Quote Feed Connector (Websocket)" → bouton (i).

# Toggle global. false = bot tourne 100% REST (état actuel post PR #67).
MARKET_ALERTS_USE_WS=false

# Streams FMP à subscribe (CSV). Défaut: fmp-us-equities-stream (couvre
# NYSE+NASDAQ). Autres options : fmp-us-otc-stream, fmp-index-stream,
# nasdaq-basic-w-nls-plus, iex-tops, cboe-index-main, fmp-crypto-stream,
# fmp-commodity-stream, fmp-currency-stream, fmp-uk-equities-stream,
# fmp-ca-equities-stream. Ajouter "-delayed" pour delayed feeds.
FMP_WS_STREAMS=fmp-us-equities-stream

# Staleness max sur le cache WS (ms). Si le dernier quote pour un ticker
# date de > MAX_STALENESS_MS, getQuote() retourne null (fallback REST).
FMP_WS_MAX_STALENESS_MS=900000

# Endpoint override (rarement utile, par défaut wss://socket.financialmodelingprep.com).
# Pour tester sur un mock ou un endpoint custom.
FMP_WS_ENDPOINT=
```

If `FMP_WS_ENABLED` appears elsewhere (e.g. inside a comment block), remove or update it to reference `MARKET_ALERTS_USE_WS`.

### Step 4.2: Verify `.env.example` parses cleanly

```bash
node -e "const fs = require('fs'); const env = fs.readFileSync('.env.example', 'utf8'); const lines = env.split('\\n'); for (const l of lines) { if (l.trim() && !l.startsWith('#') && !l.includes('=')) { throw new Error('Malformed line: ' + l); } } console.log('env.example parses ok');"
```

Expected output: `env.example parses ok`.

### Step 4.3: Commit Task 4

```bash
git add .env.example
git commit -m "docs(env): document MARKET_ALERTS_USE_WS + FMP_WS_STREAMS

Replace legacy FMP_WS_ENABLED entry. Document bandwidth tradeoff
(~120 GB/day on fmp-us-equities-stream vs 50 GB/month Premium quota).
Default toggle false — no runtime change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification

VERIFICATION ONLY — no code changes.

### Step 5.1: Run the full test suite

```bash
npm test 2>&1 | tail -20
```

Expected: only the pre-existing failures (Windows EBUSY in llm-classify, ELEVENLABS_API_KEY missing in video). No new failures.

### Step 5.2: Module load smoke checks

```bash
node -e "require('./discord/fmp-ws-client'); console.log('fmp-ws-client ok')"
node -e "require('./discord/fmp-ws-marketclient'); console.log('fmp-ws-marketclient ok')"
node -e "require('./discord/jobs'); console.log('jobs ok')"
node --check index.js
```

Expected: all `ok` prints, no output for `--check`.

### Step 5.3: Confirm the runtime toggle truly defaults OFF

```bash
node -e "delete process.env.MARKET_ALERTS_USE_WS; const useWs = String(process.env.MARKET_ALERTS_USE_WS || 'false').toLowerCase() === 'true'; console.log('useWs default =', useWs);"
```

Expected output: `useWs default = false`.

### Step 5.4: Confirm git history

```bash
git log --oneline -6
```

Expected: 5 commits (spec + 4 task commits) on top of `a6860e2` (current main HEAD).

---

## Manual steps for the operator

None required at merge — the toggle defaults to OFF, no runtime behavior change.

**If the operator later wants to enable the WebSocket** (not recommended without monitoring bandwidth):

1. Verify FMP bandwidth quota — `fmp-us-equities-stream` ≈ 120 GB/day, Premium quota 50 GB/month.
2. Set `MARKET_ALERTS_USE_WS=true` on Railway → redeploy.
3. Watch logs for `[market-alerts] watching N tickers via WS` at boot.
4. If FMP `Maximum number of connections reached` errors appear → check `disconnect` count, REST fallback kicks in after 10 errors in 5 min.
5. To roll back: set `MARKET_ALERTS_USE_WS=false` → redeploy.
