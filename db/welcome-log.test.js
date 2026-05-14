const { test } = require('node:test');
const assert = require('node:assert');
const db = require('./sqlite');

// Clear the table before each test so we don't accumulate state between runs.
// db/sqlite.js exports `db` (the better-sqlite3 instance) — verified before.
function resetTable() {
  db.db.exec('DELETE FROM welcome_log');
}

test('insertWelcomeLog + getWelcomeLog round-trip', () => {
  resetTable();
  db.insertWelcomeLog({ type: 'sent', userId: '111', username: 'Alice', detail: null });
  const log = db.getWelcomeLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].type, 'sent');
  assert.strictEqual(log[0].userId, '111');
  assert.strictEqual(log[0].username, 'Alice');
  assert.strictEqual(log[0].detail, null);
  assert.match(log[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ts should be auto-filled ISO');
});

test('getWelcomeLog returns rows in most-recent-first order (id DESC)', () => {
  resetTable();
  db.insertWelcomeLog({ type: 'sent', userId: '1', username: 'first',  detail: null });
  db.insertWelcomeLog({ type: 'sent', userId: '2', username: 'second', detail: null });
  db.insertWelcomeLog({ type: 'sent', userId: '3', username: 'third',  detail: null });
  const log = db.getWelcomeLog();
  assert.strictEqual(log.length, 3);
  assert.strictEqual(log[0].username, 'third',  'most recent first');
  assert.strictEqual(log[1].username, 'second');
  assert.strictEqual(log[2].username, 'first',  'oldest last');
});

test('insertWelcomeLog accepts null userId/username/detail (config-missing case)', () => {
  resetTable();
  db.insertWelcomeLog({ type: 'config-missing', userId: null, username: null, detail: 'TOB_WELCOME_GUILD_ID' });
  const log = db.getWelcomeLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].type, 'config-missing');
  assert.strictEqual(log[0].userId, null);
  assert.strictEqual(log[0].username, null);
  assert.strictEqual(log[0].detail, 'TOB_WELCOME_GUILD_ID');
});

test('insertWelcomeLog preserves explicit ts when provided', () => {
  resetTable();
  const explicit = '2026-05-14T12:00:00.000Z';
  db.insertWelcomeLog({ ts: explicit, type: 'sent', userId: '1', username: 'A', detail: null });
  assert.strictEqual(db.getWelcomeLog()[0].ts, explicit);
});

test('insertWelcomeLog coerces numeric userId to string', () => {
  // userId comes from Discord as a string snowflake, but better-sqlite3
  // throws on bound type mismatch — confirm the function defends with String().
  resetTable();
  db.insertWelcomeLog({ type: 'sent', userId: 12345, username: 'Bob', detail: null });
  const log = db.getWelcomeLog();
  assert.strictEqual(typeof log[0].userId, 'string');
  assert.strictEqual(log[0].userId, '12345');
});

test('cleanup: empty the table after this file', () => {
  resetTable();
});
