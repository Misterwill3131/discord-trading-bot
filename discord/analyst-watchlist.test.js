const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the DB for tests — must come BEFORE any import that touches sqlite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-wl-test-'));
process.env.DATA_DIR = tmpDir;

const { extractPrice } = require('./analyst-watchlist');

test('extractPrice extracts integer dollar amount', () => {
  assert.strictEqual(extractPrice('Watch $200 break'), 200);
});

test('extractPrice extracts decimal price', () => {
  assert.strictEqual(extractPrice('$AAPL @ $200.50'), 200.50);
});

test('extractPrice handles comma-separated thousands', () => {
  assert.strictEqual(extractPrice('BTC at $1,234.56'), 1234.56);
});

test('extractPrice returns first price when several present', () => {
  assert.strictEqual(extractPrice('Entry $200, target $300'), 200);
});

test('extractPrice rejects out-of-range values', () => {
  assert.strictEqual(extractPrice('$0'), null);
  assert.strictEqual(extractPrice('$200000'), null);
  assert.strictEqual(extractPrice('$1000000'), null);
});

test('extractPrice returns null when no $ amount', () => {
  assert.strictEqual(extractPrice('AAPL is bullish'), null);
  assert.strictEqual(extractPrice(''), null);
  assert.strictEqual(extractPrice(null), null);
  assert.strictEqual(extractPrice(undefined), null);
});

test('extractPrice ignores prices embedded in larger numbers', () => {
  // "$200000" → null per range check; "$200.00" → 200 (valid range)
  assert.strictEqual(extractPrice('$200.00'), 200);
});
