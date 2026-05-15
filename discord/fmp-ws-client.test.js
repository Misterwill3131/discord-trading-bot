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
