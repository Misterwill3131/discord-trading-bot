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
