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
