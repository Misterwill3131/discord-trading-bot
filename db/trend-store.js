// ─────────────────────────────────────────────────────────────────────
// db/trend-store.js — Accesseurs SQLite pour le module trend
// ─────────────────────────────────────────────────────────────────────
// Factory `createTrendStore(db)` : retourne un objet d'accesseurs liés
// au `db` passé. Permet d'injecter une DB in-memory en tests sans
// toucher au singleton de db/sqlite.js.
// ─────────────────────────────────────────────────────────────────────

function createTrendStore(db) {
  // ── Watchlist ────────────────────────────────────────────────────
  const insertWatch = db.prepare(
    `INSERT OR IGNORE INTO trend_watchlist (guild_id, ticker, added_at)
     VALUES (?, ?, ?)`
  );
  const deleteWatch = db.prepare(
    `DELETE FROM trend_watchlist WHERE guild_id = ? AND ticker = ?`
  );
  const selectWatchlist = db.prepare(
    `SELECT ticker FROM trend_watchlist WHERE guild_id = ? ORDER BY ticker ASC`
  );
  const selectDistinctTickers = db.prepare(
    `SELECT DISTINCT ticker FROM trend_watchlist`
  );
  const selectGuildsWatching = db.prepare(
    `SELECT guild_id FROM trend_watchlist WHERE ticker = ?`
  );

  // ── Channel ───────────────────────────────────────────────────────
  const upsertChannel = db.prepare(
    `INSERT INTO trend_channel (guild_id, channel_id, set_at) VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, set_at = excluded.set_at`
  );
  const selectChannel = db.prepare(
    `SELECT channel_id FROM trend_channel WHERE guild_id = ?`
  );
  const deleteChannelStmt = db.prepare(
    `DELETE FROM trend_channel WHERE guild_id = ?`
  );

  // ── State ─────────────────────────────────────────────────────────
  const selectState = db.prepare(
    `SELECT * FROM trend_state WHERE ticker = ?`
  );
  const upsertDirection = db.prepare(
    `INSERT INTO trend_state (ticker, direction, direction_changed_at) VALUES (?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET direction = excluded.direction,
                                       direction_changed_at = excluded.direction_changed_at`
  );
  const updateBreakoutAt = db.prepare(
    `INSERT INTO trend_state (ticker, last_breakout_at) VALUES (?, ?)
     ON CONFLICT(ticker) DO UPDATE SET last_breakout_at = excluded.last_breakout_at`
  );
  const updateBullishReversalAt = db.prepare(
    `INSERT INTO trend_state (ticker, last_bullish_reversal_at) VALUES (?, ?)
     ON CONFLICT(ticker) DO UPDATE SET last_bullish_reversal_at = excluded.last_bullish_reversal_at`
  );
  const updateBearishReversalAt = db.prepare(
    `INSERT INTO trend_state (ticker, last_bearish_reversal_at) VALUES (?, ?)
     ON CONFLICT(ticker) DO UPDATE SET last_bearish_reversal_at = excluded.last_bearish_reversal_at`
  );

  const EVENT_STATEMENTS = {
    breakout:         updateBreakoutAt,
    bullish_reversal: updateBullishReversalAt,
    bearish_reversal: updateBearishReversalAt,
  };

  return {
    addToWatchlist(guildId, ticker, nowMs) {
      const res = insertWatch.run(guildId, ticker, nowMs);
      return res.changes > 0;
    },
    removeFromWatchlist(guildId, ticker) {
      const res = deleteWatch.run(guildId, ticker);
      return res.changes > 0;
    },
    getWatchlist(guildId) {
      return selectWatchlist.all(guildId).map(r => r.ticker);
    },
    getDistinctTickers() {
      return selectDistinctTickers.all().map(r => r.ticker);
    },
    getGuildsWatching(ticker) {
      return selectGuildsWatching.all(ticker).map(r => r.guild_id);
    },

    setChannel(guildId, channelId, nowMs) {
      upsertChannel.run(guildId, channelId, nowMs);
    },
    getChannel(guildId) {
      const row = selectChannel.get(guildId);
      return row ? row.channel_id : null;
    },
    deleteChannel(guildId) {
      deleteChannelStmt.run(guildId);
    },

    getState(ticker) {
      return selectState.get(ticker) || null;
    },
    updateDirection(ticker, direction, nowMs) {
      upsertDirection.run(ticker, direction, nowMs);
    },
    updateEvent(ticker, eventType, nowMs) {
      const stmt = EVENT_STATEMENTS[eventType];
      if (!stmt) throw new Error('unknown event type: ' + eventType);
      stmt.run(ticker, nowMs);
    },
  };
}

module.exports = { createTrendStore };
