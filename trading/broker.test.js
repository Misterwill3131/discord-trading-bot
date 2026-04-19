const { test } = require('node:test');
const assert = require('node:assert');
const { PaperBroker } = require('./broker');

function fakeMarketData(lastPrice) {
  return {
    fetchCandles: async () => [{ t: 'x', o: lastPrice, h: lastPrice, l: lastPrice, c: lastPrice, v: 1 }],
  };
}

test('PaperBroker.getAccount returns configured equity', async () => {
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(100) });
  const acc = await b.getAccount();
  assert.strictEqual(acc.equity, 10000);
  assert.strictEqual(acc.cash, 10000);
});

test('PaperBroker.placeBracket market order fills immediately at last price', async () => {
  const events = [];
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(100) });
  b.on('orderStatus', (e) => events.push(e));
  const result = await b.placeBracket({
    ticker: 'TSLA', qty: 10, orderType: 'market',
    entryPrice: 100, tpPrice: 110, trailPct: 7,
  });
  assert.ok(result.parentId);
  assert.ok(result.tpId);
  assert.ok(result.slId);
  // Wait a tick for setImmediate to fire.
  await new Promise(resolve => setImmediate(resolve));
  const filled = events.find(e => e.orderId === result.parentId && e.status === 'Filled');
  assert.ok(filled, 'parent fill event must be emitted');
  assert.strictEqual(filled.avgFillPrice, 100);
});

test('PaperBroker limit order stays pending if current price above limit', async () => {
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(105) });
  const result = await b.placeBracket({
    ticker: 'TSLA', qty: 10, orderType: 'limit',
    entryPrice: 100, tpPrice: 110, trailPct: 7,
  });
  const pos = b.getOpenPositions().find(p => p.parentId === result.parentId);
  assert.ok(pos);
  assert.strictEqual(pos.status, 'pending');
});

test('PaperBroker.closePosition emits child-filled event for parent', async () => {
  const events = [];
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(100) });
  b.on('orderStatus', (e) => events.push(e));
  await b.placeBracket({
    ticker: 'TSLA', qty: 10, orderType: 'market',
    entryPrice: 100, tpPrice: 110, trailPct: 7,
  });
  await new Promise(resolve => setImmediate(resolve));
  events.length = 0;
  await b.closePosition('TSLA');
  await new Promise(resolve => setImmediate(resolve));
  const exit = events.find(e => e.kind === 'manual_exit');
  assert.ok(exit, 'manual_exit event must be emitted');
});
