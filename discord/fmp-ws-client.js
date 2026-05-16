// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-client.js — Client WebSocket FMP (raw protocol)
// ─────────────────────────────────────────────────────────────────────
// Long-lived WebSocket connection to Financial Modeling Prep streaming
// API for real-time stock trades. Emits a typed 'trade' event for each
// last-trade message; ignores quote-update (Q) and trade-break (B)
// messages. Reconnect with exponential backoff handled in Task 3.
//
// Protocol (verified empirically 2026-05-16 from FMP dashboard internals) :
//   wss://socket.financialmodelingprep.com/?apikey={k}
//     (no path. Apex financialmodelingprep.com 301-redirects to site.;
//      `api.` rejects this route with 403; `socket.` is the real WS host.
//      Same FMP_API_KEY as REST — no "dedicated WS key" despite the FAQ
//      wording.)
//   Login:       { event: 'login',     data: { apiKey } }   (sent on open, legacy)
//   Subscribe:   { event: 'subscribe', data: { ticker: ['aapl', ...] } }   (lowercase)
//   Unsubscribe: { event: 'unsubscribe', data: { ticker: [...] } }
//   Trade msg:   { s: '<ticker>', t: <ms>, type: 'T', lp: <price>, ls: <size> }
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md
// ─────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('node:events');

const DEFAULT_ENDPOINT = 'wss://socket.financialmodelingprep.com/';

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
  let attemptCount = 0;
  let reconnectHandle = null;

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
    // Login response → flush queued subscriptions (legacy path).
    // Idempotent: the open handler already marks loggedIn=true and flushes,
    // so this only fires meaningfully if a server emits the response and
    // we hadn't already transitioned (e.g., if open-handler ordering
    // changes in the future).
    if (msg && msg.event === 'login') {
      if (msg.status && msg.status >= 400) {
        logger.error('[fmp-ws] login rejected:', msg.message || msg.status);
        events.emit('error', new Error('login rejected: ' + (msg.message || msg.status)));
        return;
      }
      if (!loggedIn) {
        loggedIn = true;
        attemptCount = 0;  // reset backoff on successful login
        events.emit('connected');
        if (subscribed.size > 0) sendSubscribe(Array.from(subscribed));
      }
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
    scheduleReconnect();
  }

  // Auth errors (401 = missing/invalid key, 403 = key valid but plan
  // lacks WS access) are not recoverable by reconnecting. Latch
  // `stopped` so further backoff attempts cease until the process
  // restarts with a fixed key or plan.
  function isAuthError(err) {
    const msg = err && err.message ? String(err.message) : '';
    return /\b(401|403)\b/.test(msg);
  }

  function handleError(err) {
    if (isAuthError(err)) {
      stopped = true;
      if (reconnectHandle) {
        clearTimeoutImpl(reconnectHandle);
        reconnectHandle = null;
      }
      logger.error('[fmp-ws] auth failure (' + err.message
        + ') — disabling reconnect. Check FMP_API_KEY (or FMP_WS_API_KEY override) '
        + 'and that your FMP plan includes WebSocket access.');
    }
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
    // Exponential backoff: min × 2^(attemptCount-1), capped at max.
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, attemptCount - 1));
    reconnectHandle = setTimeoutImpl(() => {
      reconnectHandle = null;
      connect();
    }, delay);
  }

  // /stable/ WS auth happens at HTTP-layer via ?apikey query param.
  // We append it to whatever endpoint URL we have (works for both the
  // default endpoint and any custom override passed by tests/callers).
  function buildAuthedUrl() {
    const sep = endpoint.includes('?') ? '&' : '?';
    return endpoint + sep + 'apikey=' + encodeURIComponent(apiKey);
  }

  function connect() {
    if (stopped || connecting) return;
    connecting = true;
    try {
      sock = new WebSocketImpl(buildAuthedUrl());
    } catch (err) {
      connecting = false;
      events.emit('error', err);
      return;
    }
    sock.on('open', () => {
      connecting = false;
      // Legacy compat: still send the login event in case the server
      // expects it. New /stable/ server already authed us at HTTP layer
      // via the URL apikey, so we ALSO mark loggedIn immediately and
      // flush any pending subscriptions — that way subscribe goes out
      // whether or not the server emits a login response message.
      sendLogin();
      if (!loggedIn) {
        loggedIn = true;
        attemptCount = 0;
        events.emit('connected');
        if (subscribed.size > 0) sendSubscribe(Array.from(subscribed));
      }
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
        attemptCount,
      };
    },
  };
}

module.exports = { createFmpWsClient, DEFAULT_ENDPOINT };
