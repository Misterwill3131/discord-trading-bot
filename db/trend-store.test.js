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
      quote_type TEXT,
      PRIMARY KEY (guild_id, ticker)
    );
    CREATE TABLE trend_channel (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, set_at INTEGER NOT NULL,
      gap_channel_id TEXT
    );
    CREATE TABLE trend_state (
      ticker TEXT PRIMARY KEY,
      direction TEXT, direction_changed_at INTEGER,
      last_breakout_at INTEGER,
      last_bullish_reversal_at INTEGER,
      last_bearish_reversal_at INTEGER,
      last_scan_at INTEGER,
      daily_state_date TEXT,
      pdh_alerts_today INTEGER DEFAULT 0,
      pdh_below_since INTEGER,
      pdl_alerts_today INTEGER DEFAULT 0,
      pdl_above_since INTEGER,
      gap_alerted_today INTEGER DEFAULT 0,
      volume_above_alerted_today INTEGER DEFAULT 0
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

test('setGapChannel returns false if no main channel row exists', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.setGapChannel('g1', 'gc1', 1000), false);
  assert.strictEqual(store.getGapChannel('g1'), null);
});

test('setGapChannel returns true and stores when main channel exists', () => {
  const store = createTrendStore(makeDb());
  store.setChannel('g1', 'c1', 1000);
  assert.strictEqual(store.setGapChannel('g1', 'gc1', 2000), true);
  assert.strictEqual(store.getGapChannel('g1'), 'gc1');
  // Main channel preserved.
  assert.strictEqual(store.getChannel('g1'), 'c1');
});

test('setChannel does not clobber an existing gap_channel_id', () => {
  const store = createTrendStore(makeDb());
  store.setChannel('g1', 'c1', 1000);
  store.setGapChannel('g1', 'gc1', 2000);
  // Update main channel.
  store.setChannel('g1', 'c2', 3000);
  assert.strictEqual(store.getChannel('g1'), 'c2');
  // Gap channel still set.
  assert.strictEqual(store.getGapChannel('g1'), 'gc1');
});

test('deleteGapChannel clears gap_channel_id without touching main channel', () => {
  const store = createTrendStore(makeDb());
  store.setChannel('g1', 'c1', 1000);
  store.setGapChannel('g1', 'gc1', 2000);
  store.deleteGapChannel('g1');
  assert.strictEqual(store.getGapChannel('g1'), null);
  assert.strictEqual(store.getChannel('g1'), 'c1');  // main intact
});

test('deleteChannel also removes the gap channel (whole row deleted)', () => {
  const store = createTrendStore(makeDb());
  store.setChannel('g1', 'c1', 1000);
  store.setGapChannel('g1', 'gc1', 2000);
  store.deleteChannel('g1');
  assert.strictEqual(store.getChannel('g1'), null);
  assert.strictEqual(store.getGapChannel('g1'), null);
});

test('getAllConfiguredGuilds returns empty when no channels set', () => {
  const store = createTrendStore(makeDb());
  assert.deepStrictEqual(store.getAllConfiguredGuilds(), []);
});

test('getAllConfiguredGuilds returns all rows ordered by guild_id', () => {
  const store = createTrendStore(makeDb());
  store.setChannel('g3', 'c3', 3000);
  store.setChannel('g1', 'c1', 1000);
  store.setChannel('g2', 'c2', 2000);
  store.setGapChannel('g2', 'gc2', 2500);
  const all = store.getAllConfiguredGuilds();
  assert.strictEqual(all.length, 3);
  // Sorted by guild_id ASC
  assert.strictEqual(all[0].guildId, 'g1');
  assert.strictEqual(all[0].channelId, 'c1');
  assert.strictEqual(all[0].gapChannelId, null);
  assert.strictEqual(all[1].guildId, 'g2');
  assert.strictEqual(all[1].gapChannelId, 'gc2');
  assert.strictEqual(all[2].guildId, 'g3');
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

test('addToWatchlist accepts optional quoteType (4th arg)', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000, 'EQUITY');
  assert.strictEqual(store.getQuoteType('AAPL'), 'EQUITY');
});

test('addToWatchlist without quoteType leaves it null', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  assert.strictEqual(store.getQuoteType('AAPL'), null);
});

test('setQuoteType updates the value across all guild rows for the ticker', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  store.addToWatchlist('g2', 'AAPL', 1000);
  store.setQuoteType('AAPL', 'EQUITY');
  assert.strictEqual(store.getQuoteType('AAPL'), 'EQUITY');
});

test('getQuoteType returns null if no row for ticker', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.getQuoteType('NOPE'), null);
});

test('resetDailyState clears daily columns and sets date', () => {
  const store = createTrendStore(makeDb());
  store.applyStateUpdates('AAPL', {
    pdh_alerts_today: 2, pdh_below_since: 12345,
    pdl_alerts_today: 1, pdl_above_since: 67890,
    gap_alerted_today: 1, volume_above_alerted_today: 1,
  });
  store.resetDailyState('AAPL', '2026-05-02');
  const s = store.getState('AAPL');
  assert.strictEqual(s.daily_state_date, '2026-05-02');
  assert.strictEqual(s.pdh_alerts_today, 0);
  assert.strictEqual(s.pdh_below_since, null);
  assert.strictEqual(s.pdl_alerts_today, 0);
  assert.strictEqual(s.pdl_above_since, null);
  assert.strictEqual(s.gap_alerted_today, 0);
  assert.strictEqual(s.volume_above_alerted_today, 0);
});

test('applyStateUpdates upserts only whitelisted columns', () => {
  const store = createTrendStore(makeDb());
  store.applyStateUpdates('AAPL', { pdh_alerts_today: 1, pdh_below_since: null });
  let s = store.getState('AAPL');
  assert.strictEqual(s.pdh_alerts_today, 1);
  assert.strictEqual(s.pdh_below_since, null);
  // Update only one column — others preserved.
  store.applyStateUpdates('AAPL', { pdl_alerts_today: 1 });
  s = store.getState('AAPL');
  assert.strictEqual(s.pdh_alerts_today, 1);
  assert.strictEqual(s.pdl_alerts_today, 1);
});

test('applyStateUpdates ignores unknown columns silently', () => {
  const store = createTrendStore(makeDb());
  // 'malicious_col' should be filtered out — no SQL error, no insertion.
  assert.doesNotThrow(() =>
    store.applyStateUpdates('AAPL', { pdh_alerts_today: 1, malicious_col: 'X' })
  );
  const s = store.getState('AAPL');
  assert.strictEqual(s.pdh_alerts_today, 1);
});

test('applyStateUpdates with empty/all-unknown updates is a no-op', () => {
  const store = createTrendStore(makeDb());
  assert.doesNotThrow(() => store.applyStateUpdates('AAPL', {}));
  assert.doesNotThrow(() => store.applyStateUpdates('AAPL', { unknown: 1 }));
  assert.strictEqual(store.getState('AAPL'), null); // pas créé
});
