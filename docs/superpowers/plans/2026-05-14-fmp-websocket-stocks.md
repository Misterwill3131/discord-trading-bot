# FMP WebSocket Stocks (B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the REST polling that drives `discord/market-alerts.js` with a persistent FMP WebSocket stream for stocks. Same alerts and same Discord output — just real-time data instead of 5-min polling. Feature-flagged via `FMP_WS_ENABLED`.

**Architecture:** Two new modules — `discord/fmp-ws-client.js` (raw WS protocol: login, subscribe, parse, reconnect) and `discord/fmp-ws-marketclient.js` (adapter implementing the existing `marketClient` contract, with in-memory cache + REST fallback). `market-alerts.js` is NOT modified.

**Tech Stack:** Node.js, new `ws` npm package, existing `node:test`, `better-sqlite3`. No native compilation.

**Spec:** [docs/superpowers/specs/2026-05-14-fmp-websocket-stocks-design.md](../specs/2026-05-14-fmp-websocket-stocks-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `ws` to dependencies. |
| `discord/fmp-ws-client.js` | Create | Raw WS client: login, subscribe/unsubscribe, parse trades, reconnect with backoff, emit `trade`/`connected`/`disconnected`/`error` events. |
| `discord/fmp-ws-client.test.js` | Create | Unit tests with injected `WebSocketImpl` (a fake constructor) and injected `setTimeoutImpl`/`clearTimeoutImpl` for deterministic backoff tests. |
| `discord/fmp-ws-marketclient.js` | Create | Adapter implementing `marketClient` contract (`getQuote`, `getDailyBars`). In-memory cache per ticker. Cumulative volume with pre-market skip + ET-date reset. REST fallback after repeated reconnect failures. |
| `discord/fmp-ws-marketclient.test.js` | Create | Unit tests with an injected wsClient (EventEmitter-like) and injected REST client. |
| `discord/jobs.js` | Modify | Read `FMP_WS_ENABLED`; if true, build the marketclient adapter and pass it to `createMarketAlertsScheduler`. Adjust evaluation cadence (`MARKET_ALERTS_EVAL_INTERVAL_SEC`). |
| `.env.example` | Modify | Document the new env vars under the existing market-alerts section. |

`discord/market-alerts.js` is NOT modified — it consumes whichever `marketClient` is given.

---

## Task 1: Add `ws` npm dependency

A new persistent WebSocket dependency. Use the `ws` package — it is the de-facto Node.js WebSocket client (~250 KB, pure JS, no native compilation, MIT licensed, used by socket.io and most Node WS code).

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

In `package.json`, the current `dependencies` block ends with `"yahoo-finance2": "^3.14.0"`. Insert a new entry for `ws` so the alphabetic ordering becomes:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.93.0",
    "@napi-rs/canvas": "^0.1.53",
    "@stoqey/ib": "^1.5.3",
    "better-sqlite3": "^12.9.0",
    "discord.js": "^14.14.1",
    "express": "^4.18.2",
    "multer": "^2.1.1",
    "node-fetch": "^2.7.0",
    "pg": "^8.20.0",
    "stripe": "^17.7.0",
    "ws": "^8.18.0",
    "yahoo-finance2": "^3.14.0"
  },
```

(The exact `^8.18.x` version pin is the latest stable as of 2026; if `npm install ws` resolves to a newer minor on this branch, accept whatever it writes — the package follows semver.)

- [ ] **Step 2: Install**

Run: `npm install ws`

Expected: `ws` added to `node_modules/`. `package.json` and `package-lock.json` updated.

- [ ] **Step 3: Verify**

Run: `node -e "const ws = require('ws'); console.log(typeof ws.WebSocket);"`

Expected: `function` (the `WebSocket` class is the named export).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add ws npm package for FMP WebSocket stocks (B1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: WS client — happy path (login, subscribe, parse trades)

Create `discord/fmp-ws-client.js` with the full public API surface, but only implement the happy path (no reconnect yet — that's Task 3). The API is shaped to support reconnect, so Task 3 is additive.

**Files:**
- Create: `discord/fmp-ws-client.js`
- Create: `discord/fmp-ws-client.test.js`

- [ ] **Step 1: Write failing tests**

Create `discord/fmp-ws-client.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createFmpWsClient } = require('./fmp-ws-client');

// Mock WebSocket: a fake constructor that returns a controllable socket.
// Each instance exposes `.sent` (array of payloads sent via .send()),
// `.url` (constructor argument), and methods `triggerOpen()`,
// `triggerMessage(data)`, `triggerClose(code, reason)`, `triggerError(err)`
// that the test calls to drive the WS state machine.
function makeMockWebSocketFactory() {
  const instances = [];
  function MockWebSocket(url) {
    const handlers = {};
    const sent = [];
    let closed = false;
    const sock = {
      url,
      sent,
      readyState: 0,           // 0 = CONNECTING, 1 = OPEN, 3 = CLOSED
      on(event, cb) { handlers[event] = cb; return this; },
      send(data) { sent.push(data); },
      close() { closed = true; sock.readyState = 3; if (handlers.close) handlers.close(1000, ''); },
      triggerOpen() { sock.readyState = 1; if (handlers.open) handlers.open(); },
      triggerMessage(data) { if (handlers.message) handlers.message(typeof data === 'string' ? data : JSON.stringify(data)); },
      triggerClose(code, reason) { sock.readyState = 3; if (handlers.close) handlers.close(code || 1006, reason || ''); },
      triggerError(err) { if (handlers.error) handlers.error(err); },
    };
    instances.push(sock);
    return sock;
  }
  MockWebSocket.instances = instances;
  MockWebSocket.last = () => instances[instances.length - 1];
  return MockWebSocket;
}

test('start() opens the WS and sends login as the first message after open', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'KEY', tickers: [], WebSocketImpl: WS });
  client.start();
  assert.strictEqual(WS.instances.length, 1, 'should construct one WS');
  assert.strictEqual(WS.last().url, 'wss://websockets.financialmodelingprep.com');
  WS.last().triggerOpen();
  assert.strictEqual(WS.last().sent.length, 1, 'should have sent exactly one message after open');
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[0]),
    { event: 'login', data: { apiKey: 'KEY' } }
  );
});

test('endpoint can be overridden via the `endpoint` option', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: [], WebSocketImpl: WS,
    endpoint: 'wss://test.example/ws',
  });
  client.start();
  assert.strictEqual(WS.last().url, 'wss://test.example/ws');
});

test('subscribe is sent after login response confirms', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL', 'MSFT'], WebSocketImpl: WS });
  client.start();
  WS.last().triggerOpen();
  // Only login sent so far
  assert.strictEqual(WS.last().sent.length, 1);
  // FMP login response confirms with { event: 'login', status: 200, message: 'OK' }
  WS.last().triggerMessage({ event: 'login', status: 200, message: 'Welcome to FMP' });
  // Now the subscribe should fire
  assert.strictEqual(WS.last().sent.length, 2);
  const sub = JSON.parse(WS.last().sent[1]);
  assert.strictEqual(sub.event, 'subscribe');
  assert.deepStrictEqual(sub.data.ticker, ['aapl', 'msft'], 'tickers should be lowercased');
});

test('subscribe is NOT sent before login response', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS });
  client.start();
  WS.last().triggerOpen();
  // No login response yet — only the login should have been sent
  assert.strictEqual(WS.last().sent.length, 1);
});

test('incoming type=T message emits "trade" with uppercase ticker', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS });
  const trades = [];
  client.on('trade', t => trades.push(t));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200, message: 'ok' });
  WS.last().triggerMessage({ s: 'aapl', t: 1234567890, type: 'T', lp: 100.5, ls: 50 });
  assert.strictEqual(trades.length, 1);
  assert.deepStrictEqual(trades[0], { ticker: 'AAPL', price: 100.5, tradeSize: 50, ts: 1234567890 });
});

test('non-T messages (Q, B, unknown) are ignored', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS });
  const trades = [];
  client.on('trade', t => trades.push(t));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  WS.last().triggerMessage({ s: 'aapl', type: 'Q', ap: 100.5, bp: 100.4 });
  WS.last().triggerMessage({ s: 'aapl', type: 'B', lp: 100.5 });
  WS.last().triggerMessage({ s: 'aapl', lp: 100.5 });  // no type field
  assert.strictEqual(trades.length, 0);
});

test('malformed JSON message is silently dropped (logged), no crash', () => {
  const WS = makeMockWebSocketFactory();
  const logger = { log: () => {}, warn: () => {}, error: () => {} };
  const client = createFmpWsClient({ apiKey: 'K', tickers: [], WebSocketImpl: WS, logger });
  const trades = [];
  client.on('trade', t => trades.push(t));
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage('this is not json');  // raw string from triggerMessage above is unchanged
  // Should not throw
  assert.strictEqual(trades.length, 0);
});

test('subscribe(tickers) after running sends additional subscribe message', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  const sentBefore = WS.last().sent.length;
  client.subscribe(['NVDA']);
  assert.strictEqual(WS.last().sent.length, sentBefore + 1);
  const msg = JSON.parse(WS.last().sent[sentBefore]);
  assert.strictEqual(msg.event, 'subscribe');
  assert.deepStrictEqual(msg.data.ticker, ['nvda']);
});

test('unsubscribe(tickers) sends unsubscribe + removes from internal set', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL', 'NVDA'], WebSocketImpl: WS });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  const sentBefore = WS.last().sent.length;
  client.unsubscribe(['NVDA']);
  assert.strictEqual(WS.last().sent.length, sentBefore + 1);
  const msg = JSON.parse(WS.last().sent[sentBefore]);
  assert.strictEqual(msg.event, 'unsubscribe');
  assert.deepStrictEqual(msg.data.ticker, ['nvda']);
  assert.deepStrictEqual(client.getStatus().subscribedTickers, ['AAPL']);
});

test('getStatus returns connected=true after login response, false initially', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS });
  assert.strictEqual(client.getStatus().connected, false);
  client.start();
  WS.last().triggerOpen();
  assert.strictEqual(client.getStatus().connected, false, 'still false until login response');
  WS.last().triggerMessage({ event: 'login', status: 200 });
  assert.strictEqual(client.getStatus().connected, true);
});

test('"connected" event fires on login response', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: [], WebSocketImpl: WS });
  let connectedFired = 0;
  client.on('connected', () => connectedFired++);
  client.start();
  WS.last().triggerOpen();
  assert.strictEqual(connectedFired, 0);
  WS.last().triggerMessage({ event: 'login', status: 200 });
  assert.strictEqual(connectedFired, 1);
});

test('stop() closes the WS and prevents further reconnects', () => {
  const WS = makeMockWebSocketFactory();
  const client = createFmpWsClient({ apiKey: 'K', tickers: [], WebSocketImpl: WS });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  const instancesBefore = WS.instances.length;
  client.stop();
  assert.strictEqual(WS.last().readyState, 3, 'socket should be closed');
  assert.strictEqual(WS.instances.length, instancesBefore, 'no new WS instances after stop');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/fmp-ws-client.test.js`

Expected: FAIL — `Cannot find module './fmp-ws-client'`.

- [ ] **Step 3: Create the client module (happy path only — reconnect comes in Task 3)**

Create `discord/fmp-ws-client.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-client.js — Client WebSocket FMP (raw protocol)
// ─────────────────────────────────────────────────────────────────────
// Long-lived WebSocket connection to Financial Modeling Prep streaming
// API for real-time stock trades. Emits a typed 'trade' event for each
// last-trade message; ignores quote-update (Q) and trade-break (B)
// messages. Reconnect with exponential backoff handled in Task 3.
//
// Protocol (verified from FMP docs):
//   wss://websockets.financialmodelingprep.com (stocks)
//   Login:       { event: 'login',     data: { apiKey } }
//   Subscribe:   { event: 'subscribe', data: { ticker: ['aapl', ...] } }   (lowercase)
//   Unsubscribe: { event: 'unsubscribe', data: { ticker: [...] } }
//   Trade msg:   { s: '<ticker>', t: <ms>, type: 'T', lp: <price>, ls: <size> }
//
// Spec : docs/superpowers/specs/2026-05-14-fmp-websocket-stocks-design.md
// ─────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('node:events');

const DEFAULT_ENDPOINT = 'wss://websockets.financialmodelingprep.com';

function createFmpWsClient({
  apiKey,
  tickers = [],
  endpoint = DEFAULT_ENDPOINT,
  WebSocketImpl,
  logger = console,
  // Reconnect fields are read in Task 3:
  reconnectMinMs = 1_000,
  reconnectMaxMs = 30_000,
  reconnectMaxAttempts = 0,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!apiKey) throw new Error('FMP apiKey required');
  if (!WebSocketImpl) {
    // Lazy-resolve the real `ws` package so tests can run without it.
    try {
      WebSocketImpl = require('ws').WebSocket;
    } catch (e) {
      throw new Error('ws module not available — install `ws` or pass WebSocketImpl');
    }
  }

  const events = new EventEmitter();
  const subscribed = new Set(tickers.map(t => String(t).toUpperCase()));
  let sock = null;
  let loggedIn = false;
  let stopped = false;
  let connecting = false;

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

  function sendSubscribe(list) {
    if (!list.length) return;
    send({ event: 'subscribe', data: { ticker: list.map(t => t.toLowerCase()) } });
  }

  function sendUnsubscribe(list) {
    if (!list.length) return;
    send({ event: 'unsubscribe', data: { ticker: list.map(t => t.toLowerCase()) } });
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (err) {
      logger.warn('[fmp-ws] malformed message dropped:', String(raw).slice(0, 100));
      return;
    }
    // Login response → flush queued subscriptions.
    if (msg && msg.event === 'login') {
      if (msg.status && msg.status >= 400) {
        logger.error('[fmp-ws] login rejected:', msg.message || msg.status);
        events.emit('error', new Error('login rejected: ' + (msg.message || msg.status)));
        return;
      }
      loggedIn = true;
      events.emit('connected');
      if (subscribed.size > 0) sendSubscribe(Array.from(subscribed));
      return;
    }
    // Trade tick.
    if (msg && msg.type === 'T' && typeof msg.s === 'string') {
      events.emit('trade', {
        ticker: msg.s.toUpperCase(),
        price: Number(msg.lp),
        tradeSize: Number(msg.ls),
        ts: Number(msg.t),
      });
      return;
    }
    // Q, B, or unknown → ignore.
  }

  function handleClose(code, reason) {
    loggedIn = false;
    events.emit('disconnected', { code, reason: String(reason || '') });
    if (stopped) return;
    // Reconnect logic added in Task 3.
  }

  function handleError(err) {
    events.emit('error', err);
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
      if (sock && sock.readyState !== 3) {
        try { sock.close(); } catch (_) { /* ignore */ }
      }
    },

    subscribe(list) {
      const norm = list.map(t => String(t).toUpperCase());
      for (const t of norm) subscribed.add(t);
      if (loggedIn) sendSubscribe(norm);
    },

    unsubscribe(list) {
      const norm = list.map(t => String(t).toUpperCase());
      for (const t of norm) subscribed.delete(t);
      if (loggedIn) sendUnsubscribe(norm);
    },

    getStatus() {
      return {
        connected: loggedIn,
        subscribedTickers: Array.from(subscribed),
        attemptCount: 0,  // wired in Task 3
      };
    },
  };
}

module.exports = { createFmpWsClient, DEFAULT_ENDPOINT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/fmp-ws-client.test.js`

Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add discord/fmp-ws-client.js discord/fmp-ws-client.test.js
git commit -m "feat(fmp-ws): WS client — happy path (login, subscribe, parse trades)

Raw protocol implementation: connect → login → subscribe →
parse type=T trades → emit 'trade' events. Reconnect logic
added in next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: WS client — reconnect with exponential backoff

Add automatic reconnection when the WS drops, with exponential backoff. On each reconnect, re-login and resubscribe to all previously subscribed tickers. Tests use injected `setTimeoutImpl` for deterministic timing.

**Files:**
- Modify: `discord/fmp-ws-client.js`
- Modify: `discord/fmp-ws-client.test.js`

- [ ] **Step 1: Append failing tests**

Append to `discord/fmp-ws-client.test.js`:

```javascript
// ── Reconnect tests (Task 3) ────────────────────────────────────────

// Fake scheduler: tests drive the clock by invoking captured callbacks.
function makeFakeScheduler() {
  const scheduled = [];
  function setTimeoutImpl(cb, ms) {
    const handle = { cb, ms, cancelled: false };
    scheduled.push(handle);
    return handle;
  }
  function clearTimeoutImpl(handle) {
    if (handle) handle.cancelled = true;
  }
  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    scheduled,
    runNext() {
      const next = scheduled.find(h => !h.cancelled);
      if (!next) throw new Error('no pending timeout to run');
      next.cancelled = true;
      next.cb();
    },
  };
}

test('on socket close, schedule reconnect at reconnectMinMs', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS,
    reconnectMinMs: 1000, reconnectMaxMs: 30000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  WS.last().triggerClose(1006, 'abnormal');
  assert.strictEqual(clock.scheduled.length, 1);
  assert.strictEqual(clock.scheduled[0].ms, 1000);
});

test('reconnect creates a new WS and re-logs in', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: ['AAPL'], WebSocketImpl: WS,
    reconnectMinMs: 1000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  const firstInstance = WS.last();
  firstInstance.triggerClose(1006, '');
  // Fire the scheduled reconnect
  clock.runNext();
  assert.strictEqual(WS.instances.length, 2, 'should construct a 2nd WS');
  WS.last().triggerOpen();
  assert.strictEqual(WS.last().sent.length, 1);
  assert.deepStrictEqual(
    JSON.parse(WS.last().sent[0]),
    { event: 'login', data: { apiKey: 'K' } }
  );
});

test('reconnect resubscribes to all previously subscribed tickers', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: ['AAPL', 'MSFT'], WebSocketImpl: WS,
    reconnectMinMs: 1000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  WS.last().triggerClose(1006, '');
  clock.runNext();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  // Should have sent login + subscribe with both tickers
  assert.strictEqual(WS.last().sent.length, 2);
  const sub = JSON.parse(WS.last().sent[1]);
  assert.deepStrictEqual(sub.data.ticker.sort(), ['aapl', 'msft']);
});

test('reconnect backoff is exponential and capped at reconnectMaxMs', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: [], WebSocketImpl: WS,
    reconnectMinMs: 1000, reconnectMaxMs: 8000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  // Drop 5 times, observe the delays: 1000, 2000, 4000, 8000, 8000 (capped)
  const observed = [];
  for (let i = 0; i < 5; i++) {
    WS.last().triggerClose(1006, '');
    const last = clock.scheduled[clock.scheduled.length - 1];
    observed.push(last.ms);
    clock.runNext();
  }
  assert.deepStrictEqual(observed, [1000, 2000, 4000, 8000, 8000]);
});

test('stop() during reconnect prevents further reconnects', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: [], WebSocketImpl: WS,
    reconnectMinMs: 1000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  WS.last().triggerClose(1006, '');
  client.stop();
  // The scheduled reconnect should be cancelled
  assert.ok(clock.scheduled[0].cancelled, 'scheduled reconnect should be cancelled');
});

test('successful reconnect resets the backoff (next failure starts at min)', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: [], WebSocketImpl: WS,
    reconnectMinMs: 1000, reconnectMaxMs: 8000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  // 3 fast drops + reconnects, all failing to reach login
  for (let i = 0; i < 3; i++) {
    WS.last().triggerClose(1006, '');
    clock.runNext();
  }
  // Now succeed: open + login response → should reset
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  // Drop again → backoff should be at reconnectMinMs again
  WS.last().triggerClose(1006, '');
  const last = clock.scheduled[clock.scheduled.length - 1];
  assert.strictEqual(last.ms, 1000, 'backoff should reset after successful login');
});

test('getStatus().attemptCount tracks reconnect attempts', () => {
  const WS = makeMockWebSocketFactory();
  const clock = makeFakeScheduler();
  const client = createFmpWsClient({
    apiKey: 'K', tickers: [], WebSocketImpl: WS,
    reconnectMinMs: 1000,
    setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  client.start();
  WS.last().triggerOpen();
  WS.last().triggerMessage({ event: 'login', status: 200 });
  assert.strictEqual(client.getStatus().attemptCount, 0);
  WS.last().triggerClose(1006, '');
  assert.strictEqual(client.getStatus().attemptCount, 1);
  clock.runNext();
  WS.last().triggerClose(1006, '');
  assert.strictEqual(client.getStatus().attemptCount, 2);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test discord/fmp-ws-client.test.js`

Expected: 12 happy-path tests still pass. The 7 reconnect tests FAIL (no new WS instances created on close, attemptCount stays at 0, etc.).

- [ ] **Step 3: Implement reconnect logic**

In `discord/fmp-ws-client.js`, you need to:

(a) Track `attemptCount` and the scheduled reconnect handle in module-local state. Add these declarations immediately after the existing `let connecting = false;` line:

```javascript
  let attemptCount = 0;
  let reconnectHandle = null;
```

(b) Add a `scheduleReconnect()` helper. Insert it immediately AFTER the `handleError` function and BEFORE the `connect` function:

```javascript
  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectMaxAttempts > 0 && attemptCount >= reconnectMaxAttempts) {
      logger.error('[fmp-ws] giving up — max reconnect attempts reached');
      events.emit('error', new Error('max reconnect attempts reached'));
      return;
    }
    attemptCount++;
    // Exponential backoff: min × 2^(attemptCount-1), capped at max.
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, attemptCount - 1));
    reconnectHandle = setTimeoutImpl(() => {
      reconnectHandle = null;
      connect();
    }, delay);
  }
```

(c) Replace the existing `handleClose` function:

```javascript
  function handleClose(code, reason) {
    loggedIn = false;
    events.emit('disconnected', { code, reason: String(reason || '') });
    if (stopped) return;
    scheduleReconnect();
  }
```

(d) Replace the existing `handleMessage` function's login-success branch. Find:

```javascript
      loggedIn = true;
      events.emit('connected');
      if (subscribed.size > 0) sendSubscribe(Array.from(subscribed));
      return;
```

Change to:

```javascript
      loggedIn = true;
      attemptCount = 0;  // reset backoff on successful login
      events.emit('connected');
      if (subscribed.size > 0) sendSubscribe(Array.from(subscribed));
      return;
```

(e) Replace the existing `stop()` method:

```javascript
    stop() {
      stopped = true;
      if (reconnectHandle) {
        clearTimeoutImpl(reconnectHandle);
        reconnectHandle = null;
      }
      if (sock && sock.readyState !== 3) {
        try { sock.close(); } catch (_) { /* ignore */ }
      }
    },
```

(f) Replace the `getStatus` method to return the real `attemptCount`:

```javascript
    getStatus() {
      return {
        connected: loggedIn,
        subscribedTickers: Array.from(subscribed),
        attemptCount,
      };
    },
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `node --test discord/fmp-ws-client.test.js`

Expected: All 19 tests PASS (12 happy-path + 7 reconnect).

- [ ] **Step 5: Commit**

```bash
git add discord/fmp-ws-client.js discord/fmp-ws-client.test.js
git commit -m "feat(fmp-ws): WS client reconnect with exponential backoff

On socket close: schedule reconnect (min × 2^attempt, capped at max).
On reconnect: re-login, resubscribe. On successful login: reset
backoff. stop() cancels any pending reconnect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Marketclient adapter — cache + cumulative volume

Build the adapter that implements the `marketClient` contract expected by `market-alerts.js`. In-memory cache per ticker, cumulative volume accumulation with pre-market skip and ET-date reset.

**Files:**
- Create: `discord/fmp-ws-marketclient.js`
- Create: `discord/fmp-ws-marketclient.test.js`

- [ ] **Step 1: Write failing tests**

Create `discord/fmp-ws-marketclient.test.js`:

```javascript
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
  const mc = createFmpWsMarketClient({
    apiKey: 'K', tickers: ['AAPL'], wsClient: ws, restClient: rest,
    now: () => new Date('2026-05-14T14:00:00Z'),
  });
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 50, ts: 1 });
  ws._fire('trade', { ticker: 'AAPL', price: 101, tradeSize: 30, ts: 2 });
  ws._fire('trade', { ticker: 'AAPL', price: 102, tradeSize: 20, ts: 3 });
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
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 1000, ts: 1 });
  assert.strictEqual((await mc.getQuote('AAPL')).volume, 1000);
  // Advance to next ET-date (still within RTH)
  clock.advanceTo('2026-05-15T14:00:00Z');
  ws._fire('trade', { ticker: 'AAPL', price: 110, tradeSize: 50, ts: 2 });
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
  ws._fire('trade', { ticker: 'AAPL', price: 99, tradeSize: 500, ts: 1 });
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
  ws._fire('trade', { ticker: 'AAPL', price: 99, tradeSize: 500, ts: 1 });
  clock.advanceTo('2026-05-14T14:00:00Z');  // 10:00 ET, RTH
  ws._fire('trade', { ticker: 'AAPL', price: 100, tradeSize: 30, ts: 2 });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/fmp-ws-marketclient.test.js`

Expected: FAIL — `Cannot find module './fmp-ws-marketclient'`.

- [ ] **Step 3: Create the adapter module**

Create `discord/fmp-ws-marketclient.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-marketclient.js — Adapter marketClient via WS FMP
// ─────────────────────────────────────────────────────────────────────
// Implémente le contrat marketClient (getQuote, getDailyBars) attendu
// par discord/market-alerts.js, en utilisant :
//   - un wsClient FMP qui stream les trades en temps réel
//   - un restClient FMP REST pour les daily bars (historique)
//
// État interne : Map<TICKER, { lastPrice, lastTs, cumulativeVolumeToday,
// etDateOfCumulative }>. Reset cumulé au changement d'ET-date et
// skip pre-market (avant 09:30 ET).
//
// Spec : docs/superpowers/specs/2026-05-14-fmp-websocket-stocks-design.md
// ─────────────────────────────────────────────────────────────────────

// Compute "YYYY-MM-DD" in America/New_York timezone.
function getETDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

// True if `date` falls within US regular trading hours (Mon-Fri 09:30-16:00 ET).
// Mirrors discord/market-alerts.js:isRTH for consistency.
function isRTH(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function createFmpWsMarketClient({
  apiKey,
  tickers = [],
  wsClient,
  restClient,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!wsClient)   throw new Error('wsClient required');
  if (!restClient) throw new Error('restClient required');

  // ticker (UPPERCASE) → { lastPrice, lastTs, cumulativeVolumeToday, etDateOfCumulative }
  const cache = new Map();

  function onTrade({ ticker, price, tradeSize, ts }) {
    const key = String(ticker).toUpperCase();
    const nowDate = now();
    const todayKey = getETDateKey(nowDate);
    const inRTH = isRTH(nowDate);

    let entry = cache.get(key);
    if (!entry) {
      entry = {
        lastPrice: null,
        lastTs: null,
        cumulativeVolumeToday: 0,
        etDateOfCumulative: todayKey,
      };
      cache.set(key, entry);
    }
    // Always update price (pre-market quotes are still useful context).
    entry.lastPrice = Number(price);
    entry.lastTs = Number(ts);
    // Volume: reset if ET-date changed, then only accumulate during RTH.
    if (entry.etDateOfCumulative !== todayKey) {
      entry.cumulativeVolumeToday = 0;
      entry.etDateOfCumulative = todayKey;
    }
    if (inRTH && Number.isFinite(tradeSize)) {
      entry.cumulativeVolumeToday += Number(tradeSize);
    }
  }

  wsClient.on('trade', onTrade);

  return {
    async getQuote(ticker) {
      const key = String(ticker).toUpperCase();
      const entry = cache.get(key);
      if (!entry || entry.lastPrice == null) return null;
      return {
        price: entry.lastPrice,
        volume: entry.cumulativeVolumeToday,
      };
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
        source: 'ws',
        wsConnected: !!ws.connected,
        wsAttemptCount: ws.attemptCount || 0,
        subscribedTickers: Array.isArray(ws.subscribedTickers) ? ws.subscribedTickers : [],
      };
    },
  };
}

module.exports = { createFmpWsMarketClient, getETDateKey, isRTH };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/fmp-ws-marketclient.test.js`

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add discord/fmp-ws-marketclient.js discord/fmp-ws-marketclient.test.js
git commit -m "feat(fmp-ws): marketclient adapter — cache + cumulative volume

Implements the marketClient contract over the WS client + REST
fallback for daily bars. Cumulative volume skips pre-market and
resets at ET-date boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Marketclient — REST fallback after repeated reconnect failures

When the WS connection drops repeatedly (default: 10 reconnect attempts within 5 minutes), the adapter flips to using the REST client for `getQuote`. On the next successful WS reconnect, flips back.

**Files:**
- Modify: `discord/fmp-ws-marketclient.js`
- Modify: `discord/fmp-ws-marketclient.test.js`

- [ ] **Step 1: Append failing tests**

Append to `discord/fmp-ws-marketclient.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/fmp-ws-marketclient.test.js`

Expected: 9 existing tests still pass. The 4 new fallback tests FAIL (`mc.getStatus().source` is always `'ws'`; `getQuote` always reads from cache).

- [ ] **Step 3: Add the fallback logic**

In `discord/fmp-ws-marketclient.js`:

(a) Update the `createFmpWsMarketClient` signature to accept the two new options. Find:

```javascript
function createFmpWsMarketClient({
  apiKey,
  tickers = [],
  wsClient,
  restClient,
  now = () => new Date(),
  logger = console,
} = {}) {
```

Replace with:

```javascript
function createFmpWsMarketClient({
  apiKey,
  tickers = [],
  wsClient,
  restClient,
  now = () => new Date(),
  logger = console,
  fallbackFailureThreshold = 10,   // disconnects within window before flipping to REST
  fallbackFailureWindowMs = 5 * 60_000,
} = {}) {
```

(b) Add fallback-tracking state. Immediately AFTER the existing `const cache = new Map();` line, add:

```javascript

  // Track recent disconnect timestamps. When length within the rolling
  // window exceeds the threshold, flip `inFallback` true. The 'connected'
  // event resets fallback to false.
  let disconnectTimes = [];
  let inFallback = false;

  function recordDisconnect() {
    const t = now().getTime();
    // Drop events older than the window
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
```

(c) Wire the events. Immediately AFTER the existing `wsClient.on('trade', onTrade);` line, add:

```javascript
  wsClient.on('disconnected', recordDisconnect);
  wsClient.on('connected', clearFallback);
```

(d) Update `getQuote` to use REST when in fallback. Replace the existing `getQuote`:

```javascript
    async getQuote(ticker) {
      if (inFallback) {
        return restClient.getQuote(ticker);
      }
      const key = String(ticker).toUpperCase();
      const entry = cache.get(key);
      if (!entry || entry.lastPrice == null) return null;
      return {
        price: entry.lastPrice,
        volume: entry.cumulativeVolumeToday,
      };
    },
```

(e) Update `getStatus` to expose `source`. Replace the existing `getStatus`:

```javascript
    getStatus() {
      const ws = typeof wsClient.getStatus === 'function' ? wsClient.getStatus() : {};
      return {
        source: inFallback ? 'rest-fallback' : 'ws',
        wsConnected: !!ws.connected,
        wsAttemptCount: ws.attemptCount || 0,
        subscribedTickers: Array.isArray(ws.subscribedTickers) ? ws.subscribedTickers : [],
        recentDisconnects: disconnectTimes.length,
      };
    },
```

- [ ] **Step 4: Update the existing 9th test (getStatus) to handle the new `recentDisconnects` field**

The 9th test `'getStatus exposes ws status + data source'` already asserts `s.source === 'ws'`, which still holds. But it doesn't assert `recentDisconnects` — that's fine, no change needed.

However, the test must not break by accident. Re-run to confirm:

Run: `node --test discord/fmp-ws-marketclient.test.js`

Expected: All 13 tests PASS (9 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add discord/fmp-ws-marketclient.js discord/fmp-ws-marketclient.test.js
git commit -m "feat(fmp-ws): REST fallback after repeated WS disconnects

After 10 disconnects within a 5-min rolling window (configurable),
getQuote switches to restClient. On the next successful connect,
flips back to WS cache. /alertstatus exposes the current source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire into `jobs.js` + `.env.example`

Hook the WS-backed marketclient into the alerts scheduler when `FMP_WS_ENABLED=true`. Adjust the evaluation cadence to seconds instead of minutes when WS is on.

**Files:**
- Modify: `discord/jobs.js`
- Modify: `.env.example`

- [ ] **Step 1: Add the requires at the top of `jobs.js`**

Open `discord/jobs.js`. Find the existing line:

```javascript
const { createFmpClient } = require('./fmp-client');
```

Immediately AFTER it, add:

```javascript
const { createFmpWsClient } = require('./fmp-ws-client');
const { createFmpWsMarketClient } = require('./fmp-ws-marketclient');
```

- [ ] **Step 2: Update the market-alerts wiring block**

Find the existing block (around lines 200-236):

```javascript
    const tickers = (process.env.WATCHED_TICKERS || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const fmpKey = process.env.FMP_API_KEY || '';
    const intervalMin = Math.max(1, parseInt(
      process.env.MARKET_ALERTS_INTERVAL_MIN || '5', 10) || 5);
    let marketAlerts = null;
    if (tickers.length > 0 && fmpKey && typeof sendAlert === 'function') {
      try {
        const marketClient = createFmpClient({ apiKey: fmpKey });
        marketAlerts = createMarketAlertsScheduler({
          marketClient,
          sendAlert,
          tickers,
        });
        console.log('[market-alerts] watching ' + tickers.length + ' tickers (every '
          + intervalMin + ' min): ' + tickers.join(', '));
        // Free-tier guard : >3 tickers à cadence 5min sature les 250 req/jour.
        const dailyBudget = (390 / intervalMin) * tickers.length + tickers.length;
        if (dailyBudget > 250) {
          console.warn('[market-alerts] estimated ' + Math.round(dailyBudget)
            + ' FMP calls/day exceeds free-tier 250/day budget — consider raising '
            + 'MARKET_ALERTS_INTERVAL_MIN or upgrading FMP plan');
        }
      } catch (err) {
        console.error('[market-alerts] init failed:', err.message);
      }
    } else {
```

Replace it with:

```javascript
    const tickers = (process.env.WATCHED_TICKERS || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const fmpKey = process.env.FMP_API_KEY || '';
    const useWs = process.env.FMP_WS_ENABLED === 'true';
    const intervalMin = Math.max(1, parseInt(
      process.env.MARKET_ALERTS_INTERVAL_MIN || '5', 10) || 5);
    const evalIntervalSec = Math.max(1, parseInt(
      process.env.MARKET_ALERTS_EVAL_INTERVAL_SEC || (useWs ? '5' : String(intervalMin * 60)), 10) || 5);
    let marketAlerts = null;
    let marketClientRef = null;
    if (tickers.length > 0 && fmpKey && typeof sendAlert === 'function') {
      try {
        const restClient = createFmpClient({ apiKey: fmpKey });
        let marketClient;
        if (useWs) {
          const wsClient = createFmpWsClient({ apiKey: fmpKey, tickers });
          marketClient = createFmpWsMarketClient({
            apiKey: fmpKey, tickers, wsClient, restClient,
          });
          marketClient.start();
          console.log('[market-alerts] watching ' + tickers.length + ' tickers via WS (eval every '
            + evalIntervalSec + 's): ' + tickers.join(', '));
        } else {
          marketClient = restClient;
          console.log('[market-alerts] watching ' + tickers.length + ' tickers via REST (every '
            + intervalMin + ' min): ' + tickers.join(', '));
          // Free-tier guard : >3 tickers à cadence 5min sature les 250 req/jour.
          const dailyBudget = (390 / intervalMin) * tickers.length + tickers.length;
          if (dailyBudget > 250) {
            console.warn('[market-alerts] estimated ' + Math.round(dailyBudget)
              + ' FMP calls/day exceeds free-tier 250/day budget — consider raising '
              + 'MARKET_ALERTS_INTERVAL_MIN or upgrading FMP plan');
          }
        }
        marketClientRef = marketClient;
        marketAlerts = createMarketAlertsScheduler({
          marketClient,
          sendAlert,
          tickers,
        });
      } catch (err) {
        console.error('[market-alerts] init failed:', err.message);
      }
    } else {
```

- [ ] **Step 3: Update the tick scheduler cadence**

The existing code that drives `marketAlerts.tick(now)` lives around lines 287-295 of `jobs.js` inside the master `scheduler()` function that runs every 60s. Find this exact block:

```javascript
      // Market alerts — cadence configurable. Le tick lui-même filtre
      // sur RTH (no-op hors marché), donc fire-and-forget chaque
      // intervalle suffit. now.getMinutes() utilise local time, pas ET ;
      // pour notre besoin (cadence régulière) c'est équivalent — un
      // multiple de 5 minutes locale = un multiple en ET.
      if (marketAlerts && now.getMinutes() % intervalMin === 0) {
        marketAlerts.tick(now).catch(err =>
          console.error('[market-alerts] tick failed:', err.message));
      }
```

Replace it with:

```javascript
      // Market alerts — cadence configurable. Le tick lui-même filtre
      // sur RTH (no-op hors marché), donc fire-and-forget chaque
      // intervalle suffit. WS mode: tick driven by a separate fast
      // setInterval below (every evalIntervalSec seconds). REST mode:
      // continues at the original minute-aligned cadence.
      if (!useWs && marketAlerts && now.getMinutes() % intervalMin === 0) {
        marketAlerts.tick(now).catch(err =>
          console.error('[market-alerts] tick failed:', err.message));
      }
```

Then add the WS-mode fast-tick interval. Find the line right BEFORE the closing brace of the `client.once('ready', ...)` callback. The structure looks like:

```javascript
    setInterval(scheduler, 60_000);
    scheduler();
  });
}
```

(The `scheduler()` immediately-invoked call followed by the closing `});` of `client.once('ready')` and the closing `}` of `startScheduler`.)

Immediately BEFORE `setInterval(scheduler, 60_000);`, add:

```javascript
    // WS mode: drive market-alerts.tick at the configured sub-minute
    // cadence. Independent of the master 60s scheduler so we get
    // sub-minute reactivity without polluting the other jobs.
    if (useWs && marketAlerts) {
      setInterval(() => {
        marketAlerts.tick(new Date()).catch(err =>
          console.error('[market-alerts] tick failed:', err.message));
      }, evalIntervalSec * 1000);
      console.log('[market-alerts] fast-tick interval ' + evalIntervalSec + 's armed (WS mode)');
    }

```

- [ ] **Step 4: Syntax check**

Run: `node --check discord/jobs.js`

Expected: No output (exit 0).

- [ ] **Step 5: Run the full test suite**

Run: `node --test 2>&1 | tail -10`

Expected: pass count increased by 32 vs. baseline (12 happy-path + 7 reconnect from Task 2/3 + 9 + 4 from Task 4/5). Same 2 pre-existing failures. NO new failures.

- [ ] **Step 6: Update `.env.example`**

Open `.env.example`. Find the existing market-alerts section (search for `MARKET_ALERTS_INTERVAL_MIN`). Append immediately AFTER the `MARKET_ALERTS_INTERVAL_MIN=` documentation block:

```bash

# === FMP WEBSOCKET — sous-projet B1 (real-time stocks) ===============
# Active la source WS pour les alertes market-alerts (au lieu du polling
# REST). Nécessite un plan FMP payant (Premium ou Ultimate). Default false
# pour préserver le comportement actuel.
FMP_WS_ENABLED=false

# Override de l'endpoint WS. Utile pour tester (mock server) ou si FMP
# change l'URL. Default = wss://websockets.financialmodelingprep.com
# (vérifier en prod au premier déploy — l'endpoint stocks n'est pas
# documenté de façon stable, le crypto est confirmé à wss://crypto…).
# FMP_WS_ENDPOINT=

# Cadence d'évaluation des alertes. En mode WS, default 5s. En mode REST,
# default = MARKET_ALERTS_INTERVAL_MIN × 60. Ajuste si tu veux des alertes
# encore plus réactives (1) ou moins de charge SQLite (15).
# MARKET_ALERTS_EVAL_INTERVAL_SEC=5
```

- [ ] **Step 7: Commit**

```bash
git add discord/jobs.js .env.example
git commit -m "feat(fmp-ws): wire WS marketclient into jobs.js behind FMP_WS_ENABLED

When FMP_WS_ENABLED=true, jobs.js builds the WS marketclient and
drives market-alerts.tick() every 5s (configurable via
MARKET_ALERTS_EVAL_INTERVAL_SEC). REST mode unchanged for rollback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification + user-facing summary

- [ ] **Step 1: Full test suite green**

Run: `node --test 2>&1 | tail -10`

Expected: 32 new tests pass (12 + 7 + 9 + 4). Same 2 pre-existing failures.

- [ ] **Step 2: Syntax check on every touched file**

Run: `node --check discord/jobs.js && node --check discord/fmp-ws-client.js && node --check discord/fmp-ws-marketclient.js && echo "syntax-ok"`

Expected: `syntax-ok`.

- [ ] **Step 3: Smoke check the require chain**

Run: `node -e "const j = require('./discord/jobs'); const c = require('./discord/fmp-ws-client'); const m = require('./discord/fmp-ws-marketclient'); console.log(typeof j.startScheduler, typeof c.createFmpWsClient, typeof m.createFmpWsMarketClient);"`

Expected: `function function function`.

- [ ] **Step 4: Print user-facing summary**

Print to the user:

```
✅ FMP WebSocket (B1) ready. After Railway redeploy:

1. The feature is OFF by default (FMP_WS_ENABLED=false).
2. To enable: set FMP_WS_ENABLED=true on Railway and redeploy.
3. Verify boot logs:
   - "[market-alerts] watching N tickers via WS (eval every 5s)"
   - "[market-alerts] fast-tick interval 5s armed (WS mode)"
4. Use !alertstatus on Discord — it should report the data source
   ("ws" when healthy, "rest-fallback" if WS dropped >10× in 5 min).
5. To roll back: set FMP_WS_ENABLED=false (or remove the var) and redeploy.

If the WS endpoint URL is wrong (the stocks URL `wss://websockets.financialmodelingprep.com` is a best-guess from FMP docs), the boot will log connection errors and the fallback will kick in after 10 attempts. In that case, set FMP_WS_ENDPOINT to the correct URL from your FMP dashboard.

Smoke test plan:
- Pre-market (before 09:30 ET): boot the bot, watch logs for "[fmp-ws] connected" (need to add that emit if not already there) and no errors.
- Open (09:30 ET +): wait 30 seconds, then check whether the bot has cached price for each watched ticker. Trigger a small move on a thin watched ticker — alert should fire within 5 seconds (vs. 5 minutes in REST mode).
- Drop WS manually (block the FMP IP via Railway network panel, or just kill+restart the bot): observe the fallback chip in /alertstatus or in boot logs.

The new tests cover:
- 12 happy-path WS protocol tests
- 7 reconnect/backoff tests
- 9 marketclient adapter tests
- 4 REST fallback tests
Total: 32 new tests, all green.
```

---

## Out of scope (per spec §12)

- Crypto/forex WebSocket streams (deferred to B2)
- Live dashboard streaming via SSE (B3)
- Trade-level events for per-trade volume spike detection (B4)
- Pre-market alerts (stays gated to RTH only)
- Dynamic ticker management (add/remove without bot restart)
- Order book / level-2 data (type='Q' messages stay ignored)
- Multi-region failover between FMP endpoints
