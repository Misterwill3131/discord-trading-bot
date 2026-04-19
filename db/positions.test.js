const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate test DB before sqlite.js runs its schema creation.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'positions-'));
process.env.DATA_DIR = tmpDir;

const {
  insertPosition,
  updatePositionOrderIds,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  markPositionError,
  getOpenPositions,
  countOpenPositions,
  getPositionByTickerAndAuthor,
  getPositionHistory,
} = require('./sqlite');

function basePosition(overrides = {}) {
  return Object.assign({
    ticker: 'TSLA',
    author: 'alice',
    entry_price: 200,
    quantity: 10,
    sl_price: 186,
    tp_price: 220,
    ibkr_parent_id: null,
    ibkr_tp_id: null,
    ibkr_sl_id: null,
    raw_signal: JSON.stringify({ ticker: 'TSLA', entry_price: 200, target_price: 220 }),
  }, overrides);
}

test('insertPosition creates a pending row and returns its id', () => {
  const id = insertPosition(basePosition());
  assert.ok(Number.isInteger(id) && id > 0);
});

test('countOpenPositions counts pending + open', () => {
  const a = insertPosition(basePosition({ ticker: 'AAPL' }));
  insertPosition(basePosition({ ticker: 'MSFT' }));
  markPositionOpen(a, { fill_price: 195, opened_at: '2026-04-19T14:00:00Z' });
  const n = countOpenPositions();
  assert.ok(n >= 2, `expected >=2, got ${n}`);
});

test('updatePositionOrderIds + markPositionOpen + markPositionClosed lifecycle', () => {
  const id = insertPosition(basePosition({ ticker: 'NVDA' }));
  updatePositionOrderIds(id, { ibkr_parent_id: 'P1', ibkr_tp_id: 'T1', ibkr_sl_id: 'S1' });
  markPositionOpen(id, { fill_price: 199.5, opened_at: '2026-04-19T14:00:00Z' });
  markPositionClosed(id, {
    close_reason: 'tp',
    exit_price: 220,
    closed_at: '2026-04-19T15:00:00Z',
    pnl: 205.0,
  });
  const hist = getPositionHistory(50);
  const row = hist.find(r => r.id === id);
  assert.ok(row);
  assert.strictEqual(row.status, 'closed');
  assert.strictEqual(row.close_reason, 'tp');
  assert.strictEqual(row.exit_price, 220);
  assert.strictEqual(row.pnl, 205.0);
  assert.strictEqual(row.ibkr_parent_id, 'P1');
});

test('getPositionByTickerAndAuthor returns only open/pending match', () => {
  const id = insertPosition(basePosition({ ticker: 'AMD', author: 'bob' }));
  markPositionOpen(id, { fill_price: 100, opened_at: '2026-04-19T14:00:00Z' });
  const hit = getPositionByTickerAndAuthor('AMD', 'bob');
  assert.ok(hit);
  assert.strictEqual(hit.id, id);

  markPositionClosed(id, { close_reason: 'sl', exit_price: 93, closed_at: 'x', pnl: -70 });
  const miss = getPositionByTickerAndAuthor('AMD', 'bob');
  assert.strictEqual(miss, null, 'closed position must not match');
});

test('getOpenPositions returns pending and open only', () => {
  const a = insertPosition(basePosition({ ticker: 'GOOG' }));
  const b = insertPosition(basePosition({ ticker: 'META' }));
  markPositionOpen(a, { fill_price: 100, opened_at: 'x' });
  markPositionCancelled(b, { closed_at: 'x' });
  const open = getOpenPositions();
  const tickers = open.map(p => p.ticker);
  assert.ok(tickers.includes('GOOG'));
  assert.ok(!tickers.includes('META'), 'cancelled must be excluded');
});

test('markPositionError sets error status with message', () => {
  const id = insertPosition(basePosition({ ticker: 'COIN' }));
  markPositionError(id, 'connection lost');
  const open = getOpenPositions();
  assert.ok(!open.find(p => p.id === id), 'error status must exclude from open');
});
