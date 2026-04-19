const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-engine-'));
process.env.DATA_DIR = tmpDir;

const { createEngine } = require('./engine');
const {
  getOpenPositions,
  getPositionHistory,
  markPositionOpen,
} = require('../db/sqlite');

function mockConfig(overrides = {}) {
  return Object.assign({
    tradingEnabled: true,
    mode: 'paper',
    riskPerTradePct: 1.0,
    tolerancePct: 2.0,
    trailingStopPct: 7.0,
    // High cap in tests so max_positions doesn't mask other assertions —
    // the production default is 5, tested explicitly elsewhere if needed.
    maxConcurrentPositions: 100,
    limitOrderTimeoutMin: 30,
    authorWhitelist: [],
    tfMinutes: 5,
  }, overrides);
}

function makeBarsWith({ lastPrice = 101, upward = true } = {}) {
  const bars = [];
  let p = lastPrice - (upward ? 10 : -10);
  for (let i = 0; i < 50; i++) {
    p += upward ? 0.2 : -0.2;
    bars.push({ t: String(i), o: p, h: p, l: p, c: p, v: 1000 });
  }
  bars[bars.length - 1].c = lastPrice;
  return bars;
}

function mockBroker({ equity = 10000, shouldReject = false } = {}) {
  const calls = { placeBracket: [], closePosition: [], cancelOrder: [] };
  const broker = new (require('events').EventEmitter)();
  broker.getAccount = async () => ({ equity, cash: equity });
  broker.placeBracket = async (args) => {
    calls.placeBracket.push(args);
    if (shouldReject) throw new Error('broker rejected');
    return { parentId: 'P1', tpId: 'T1', slId: 'S1' };
  };
  broker.closePosition = async (ticker, qty) => { calls.closePosition.push({ ticker, qty }); };
  broker.cancelOrder = async (id) => { calls.cancelOrder.push(id); };
  broker.getOpenPositions = async () => [];
  broker._calls = calls;
  return broker;
}

function setup({ config = mockConfig(), marketData = null, broker = mockBroker() } = {}) {
  const md = marketData || { fetchCandles: async () => makeBarsWith({ lastPrice: 101, upward: true }) };
  return {
    engine: createEngine({ config: () => config, marketData: md, broker, now: () => new Date('2026-04-19T14:00:00Z') }),
    config, marketData: md, broker,
  };
}

test('onEntry skips when tradingEnabled is false', async () => {
  const { engine, broker } = setup({ config: mockConfig({ tradingEnabled: false }) });
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  assert.strictEqual(out.skipped, 'disabled');
  assert.strictEqual(broker._calls.placeBracket.length, 0);
});

test('onEntry skips when author not in whitelist (if whitelist non-empty)', async () => {
  const { engine, broker } = setup({ config: mockConfig({ authorWhitelist: ['alice'] }) });
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'bob' });
  assert.strictEqual(out.skipped, 'not_whitelisted');
  assert.strictEqual(broker._calls.placeBracket.length, 0);
});

test('onEntry allows any author when whitelist is empty', async () => {
  const { engine } = setup();
  const out = await engine.onEntry({ ticker: 'TSLA1', entry_price: 100, target_price: 110, author: 'bob' });
  assert.notStrictEqual(out.skipped, 'not_whitelisted');
});

test('onEntry skips when RSI <= 50 (downtrend bars)', async () => {
  const bars = makeBarsWith({ lastPrice: 90, upward: false });
  const { engine } = setup({ marketData: { fetchCandles: async () => bars } });
  const out = await engine.onEntry({ ticker: 'TSLA2', entry_price: 90, target_price: 99, author: 'a' });
  assert.strictEqual(out.skipped, 'technical');
});

test('onEntry places MARKET bracket when current price within tolerance', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    config: mockConfig({ tolerancePct: 2.0 }),
  });
  const out = await engine.onEntry({ ticker: 'TSLA3', entry_price: 100, target_price: 110, author: 'a' });
  assert.ok(!out.skipped, `should not skip, got ${out.skipped}`);
  const call = broker._calls.placeBracket[0];
  assert.ok(call, 'placeBracket was called');
  assert.strictEqual(call.orderType, 'market');
  assert.strictEqual(call.ticker, 'TSLA3');
  assert.strictEqual(call.tpPrice, 110);
  assert.strictEqual(call.trailPct, 7);
});

test('onEntry places LIMIT bracket when current price above tolerance', async () => {
  const bars = makeBarsWith({ lastPrice: 105, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    config: mockConfig({ tolerancePct: 2.0 }),
  });
  const out = await engine.onEntry({ ticker: 'TSLA4', entry_price: 100, target_price: 110, author: 'a' });
  assert.ok(!out.skipped, `should not skip, got ${out.skipped}`);
  assert.strictEqual(broker._calls.placeBracket[0].orderType, 'limit');
  assert.strictEqual(broker._calls.placeBracket[0].entryPrice, 100);
});

test('onEntry computes qty using risk-based sizing', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
    config: mockConfig({ riskPerTradePct: 1.0, trailingStopPct: 7.0 }),
  });
  const out = await engine.onEntry({ ticker: 'TSLA5', entry_price: 100, target_price: 110, author: 'a' });
  assert.ok(!out.skipped);
  assert.strictEqual(broker._calls.placeBracket[0].qty, 14);
});

test('onEntry skips when computed qty < 1', async () => {
  const bars = makeBarsWith({ lastPrice: 1000, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 100 }),
    config: mockConfig({ riskPerTradePct: 1.0, trailingStopPct: 7.0 }),
  });
  const out = await engine.onEntry({ ticker: 'TSLA6', entry_price: 1000, target_price: 1100, author: 'a' });
  assert.strictEqual(out.skipped, 'qty_too_small');
});

test('onEntry skips if ticker+author already has an open position', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'TSLA7', entry_price: 100, target_price: 110, author: 'dup-author' });
  const second = await engine.onEntry({ ticker: 'TSLA7', entry_price: 100, target_price: 110, author: 'dup-author' });
  assert.strictEqual(second.skipped, 'already_held');
});

test('onEntry persists position row with pending status', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'NVDA', entry_price: 100, target_price: 110, author: 'a' });
  const open = getOpenPositions();
  assert.ok(open.find(p => p.ticker === 'NVDA'));
});

// ── onExit + event handling ──────────────────────────────────────────

test('onExit closes position when author matches entry', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'META', entry_price: 100, target_price: 110, author: 'carol' });
  const open = getOpenPositions().find(p => p.ticker === 'META' && p.author === 'carol');
  markPositionOpen(open.id, { fill_price: 100, opened_at: 't' });

  const out = await engine.onExit({ ticker: 'META', author: 'carol', content: 'cut $META' });
  assert.strictEqual(out.closed, true);
  assert.ok(broker._calls.closePosition.some(c => c.ticker === 'META'));
});

test('onExit does nothing when author does not match', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'CRM', entry_price: 100, target_price: 110, author: 'dave' });
  const open = getOpenPositions().find(p => p.ticker === 'CRM' && p.author === 'dave');
  markPositionOpen(open.id, { fill_price: 100, opened_at: 't' });

  const beforeClose = broker._calls.closePosition.length;
  const out = await engine.onExit({ ticker: 'CRM', author: 'someone-else', content: 'exit $CRM' });
  assert.strictEqual(out.skipped, 'no_matching_position');
  assert.strictEqual(broker._calls.closePosition.length, beforeClose);
});

test('handleOrderEvent on parent Filled marks position open', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  // Need a unique parentId for this test since mockBroker always returns P1.
  // Override broker.placeBracket for this test to return a unique id.
  let capturedPositionId = null;
  const captureBroker = mockBroker({ equity: 10000 });
  captureBroker.placeBracket = async (args) => ({ parentId: 'ORCL-P1', tpId: 'ORCL-T1', slId: 'ORCL-S1' });
  const engine2 = createEngine({
    config: () => mockConfig(),
    marketData: { fetchCandles: async () => bars },
    broker: captureBroker,
    now: () => new Date('2026-04-19T14:00:00Z'),
  });
  await engine2.onEntry({ ticker: 'ORCL', entry_price: 100, target_price: 110, author: 'eve' });
  engine2.handleOrderEvent({
    orderId: 'ORCL-P1', status: 'Filled', kind: 'parent',
    ticker: 'ORCL', qty: 14, avgFillPrice: 100.5,
  });
  const hist = getPositionHistory(50);
  const row = hist.find(r => r.ticker === 'ORCL' && r.author === 'eve');
  assert.strictEqual(row.status, 'open');
  assert.strictEqual(row.fill_price, 100.5);
});

test('handleOrderEvent on tp Filled marks position closed with pnl', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const captureBroker = mockBroker({ equity: 10000 });
  captureBroker.placeBracket = async () => ({ parentId: 'ADBE-P1', tpId: 'ADBE-T1', slId: 'ADBE-S1' });
  const engine2 = createEngine({
    config: () => mockConfig(),
    marketData: { fetchCandles: async () => bars },
    broker: captureBroker,
    now: () => new Date('2026-04-19T14:00:00Z'),
  });
  await engine2.onEntry({ ticker: 'ADBE', entry_price: 100, target_price: 110, author: 'fay' });
  engine2.handleOrderEvent({ orderId: 'ADBE-P1', status: 'Filled', kind: 'parent', ticker: 'ADBE', qty: 14, avgFillPrice: 100 });
  engine2.handleOrderEvent({ orderId: 'ADBE-T1', status: 'Filled', kind: 'tp', ticker: 'ADBE', qty: 14, avgFillPrice: 110 });
  const hist = getPositionHistory(50);
  const row = hist.find(r => r.ticker === 'ADBE' && r.author === 'fay');
  assert.strictEqual(row.status, 'closed');
  assert.strictEqual(row.close_reason, 'tp');
  assert.strictEqual(row.pnl, 140);
});
