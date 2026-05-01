const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { createTrendStore } = require('./trend-store');

// Build a fresh in-memory DB with the trend schema.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trend_watchlist (
      guild_id TEXT NOT NULL, ticker TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, ticker)
    );
    CREATE TABLE trend_channel (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, set_at INTEGER NOT NULL
    );
    CREATE TABLE trend_state (
      ticker TEXT PRIMARY KEY,
      direction TEXT, direction_changed_at INTEGER,
      last_breakout_at INTEGER,
      last_bullish_reversal_at INTEGER,
      last_bearish_reversal_at INTEGER,
      last_scan_at INTEGER
    );
  `);
  return db;
}

test('addToWatchlist adds a row, ignores duplicates', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.addToWatchlist('g1', 'AAPL', 1000), true);
  assert.strictEqual(store.addToWatchlist('g1', 'AAPL', 2000), false); // already there
  assert.deepStrictEqual(store.getWatchlist('g1'), ['AAPL']);
});

test('removeFromWatchlist returns true if removed, false if absent', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  assert.strictEqual(store.removeFromWatchlist('g1', 'AAPL'), true);
  assert.strictEqual(store.removeFromWatchlist('g1', 'AAPL'), false);
  assert.deepStrictEqual(store.getWatchlist('g1'), []);
});

test('getWatchlist sorts tickers alphabetically', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'TSLA', 1000);
  store.addToWatchlist('g1', 'AAPL', 1001);
  store.addToWatchlist('g1', 'NVDA', 1002);
  assert.deepStrictEqual(store.getWatchlist('g1'), ['AAPL', 'NVDA', 'TSLA']);
});

test('getDistinctTickers across all guilds', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  store.addToWatchlist('g2', 'AAPL', 1000);
  store.addToWatchlist('g2', 'TSLA', 1000);
  assert.deepStrictEqual(store.getDistinctTickers().sort(), ['AAPL', 'TSLA']);
});

test('getGuildsWatching returns guilds for a ticker', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  store.addToWatchlist('g2', 'AAPL', 1000);
  store.addToWatchlist('g3', 'TSLA', 1000);
  assert.deepStrictEqual(store.getGuildsWatching('AAPL').sort(), ['g1', 'g2']);
  assert.deepStrictEqual(store.getGuildsWatching('TSLA'), ['g3']);
  assert.deepStrictEqual(store.getGuildsWatching('NVDA'), []);
});

test('setChannel + getChannel + deleteChannel', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.getChannel('g1'), null);
  store.setChannel('g1', 'c1', 1000);
  assert.strictEqual(store.getChannel('g1'), 'c1');
  store.setChannel('g1', 'c2', 2000); // overwrite
  assert.strictEqual(store.getChannel('g1'), 'c2');
  store.deleteChannel('g1');
  assert.strictEqual(store.getChannel('g1'), null);
});

test('getState returns null for unknown ticker', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.getState('AAPL'), null);
});

test('updateDirection upserts and getState reads back', () => {
  const store = createTrendStore(makeDb());
  store.updateDirection('AAPL', 'uptrend', 1000);
  let s = store.getState('AAPL');
  assert.strictEqual(s.direction, 'uptrend');
  assert.strictEqual(s.direction_changed_at, 1000);
  store.updateDirection('AAPL', 'sideways', 2000);
  s = store.getState('AAPL');
  assert.strictEqual(s.direction, 'sideways');
  assert.strictEqual(s.direction_changed_at, 2000);
});

test('updateEvent sets the right column per event type', () => {
  const store = createTrendStore(makeDb());
  store.updateEvent('AAPL', 'breakout', 1000);
  assert.strictEqual(store.getState('AAPL').last_breakout_at, 1000);
  store.updateEvent('AAPL', 'bullish_reversal', 2000);
  assert.strictEqual(store.getState('AAPL').last_bullish_reversal_at, 2000);
  store.updateEvent('AAPL', 'bearish_reversal', 3000);
  assert.strictEqual(store.getState('AAPL').last_bearish_reversal_at, 3000);
});

test('updateEvent rejects unknown event types', () => {
  const store = createTrendStore(makeDb());
  assert.throws(() => store.updateEvent('AAPL', 'foo', 1000), /unknown event type/i);
});
