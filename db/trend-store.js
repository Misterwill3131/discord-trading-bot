// ─────────────────────────────────────────────────────────────────────
// db/trend-store.js — Accesseurs SQLite pour le module trend
// ─────────────────────────────────────────────────────────────────────
// Factory `createTrendStore(db)` : retourne un objet d'accesseurs liés
// au `db` passé. Permet d'injecter une DB in-memory en tests sans
// toucher au singleton de db/sqlite.js.
// ─────────────────────────────────────────────────────────────────────

const EVENT_COLUMNS = {
  breakout:           'last_breakout_at',
  bullish_reversal:   'last_bullish_reversal_at',
  bearish_reversal:   'last_bearish_reversal_at',
};

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
      const col = EVENT_COLUMNS[eventType];
      if (!col) throw new Error('unknown event type: ' + eventType);
      // Build statement dynamically per column. Columns are validated above
      // against EVENT_COLUMNS — no SQL injection risk.
      const stmt = db.prepare(
        `INSERT INTO trend_state (ticker, ${col}) VALUES (?, ?)
         ON CONFLICT(ticker) DO UPDATE SET ${col} = excluded.${col}`
      );
      stmt.run(ticker, nowMs);
    },
  };
}

module.exports = { createTrendStore };
