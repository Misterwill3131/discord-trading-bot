const { test } = require('node:test');
const assert = require('node:assert');
const { appendWelcomeLog, getWelcomeLog, MAX_ENTRIES, _resetForTests } = require('./welcome-log');

test('MAX_ENTRIES is 100', () => {
  assert.strictEqual(MAX_ENTRIES, 100);
});

test('appendWelcomeLog stores entry and auto-fills ts when missing', () => {
  _resetForTests();
  appendWelcomeLog({ type: 'sent', userId: '111', username: 'Alice', detail: null });
  const log = getWelcomeLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].type, 'sent');
  assert.strictEqual(log[0].userId, '111');
  assert.strictEqual(log[0].username, 'Alice');
  assert.strictEqual(log[0].detail, null);
  assert.match(log[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ts should be auto-filled ISO');
});

test('appendWelcomeLog preserves explicit ts when provided', () => {
  _resetForTests();
  const explicit = '2026-05-14T12:00:00.000Z';
  appendWelcomeLog({ ts: explicit, type: 'sent', userId: '1', username: 'A', detail: null });
  assert.strictEqual(getWelcomeLog()[0].ts, explicit);
});

test('appendWelcomeLog evicts oldest when exceeding MAX_ENTRIES (FIFO)', () => {
  _resetForTests();
  for (let i = 0; i < 150; i++) {
    appendWelcomeLog({ type: 'sent', userId: String(i), username: 'u' + i, detail: null });
  }
  const log = getWelcomeLog();
  assert.strictEqual(log.length, 100, 'should cap at MAX_ENTRIES');
  assert.strictEqual(log[0].userId, '50', 'first 50 should be evicted');
  assert.strictEqual(log[99].userId, '149', 'last entry should be the most recent push');
});

test('getWelcomeLog returns a defensive copy (mutating return does not affect internal state)', () => {
  _resetForTests();
  appendWelcomeLog({ type: 'sent', userId: '1', username: 'A', detail: null });
  const copy = getWelcomeLog();
  copy.push({ type: 'sent', userId: '999', username: 'X', detail: null });
  assert.strictEqual(getWelcomeLog().length, 1, 'internal buffer unchanged');
});
