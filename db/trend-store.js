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
    `INSERT OR IGNORE INTO trend_watchlist (guild_id, ticker, added_at, quote_type)
     VALUES (?, ?, ?, ?)`
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

  // ── Quote Type & Daily State ──────────────────────────────────────
  const updateQuoteType = db.prepare(
    `UPDATE trend_watchlist SET quote_type = ? WHERE ticker = ?`
  );
  const selectQuoteType = db.prepare(
    `SELECT quote_type FROM trend_watchlist WHERE ticker = ? AND quote_type IS NOT NULL LIMIT 1`
  );

  const resetDailyStmt = db.prepare(
    `INSERT INTO trend_state (
       ticker, daily_state_date,
       pdh_alerts_today, pdh_below_since,
       pdl_alerts_today, pdl_above_since,
       gap_alerted_today, volume_above_alerted_today
     ) VALUES (?, ?, 0, NULL, 0, NULL, 0, 0)
     ON CONFLICT(ticker) DO UPDATE SET
       daily_state_date           = excluded.daily_state_date,
       pdh_alerts_today           = 0,
       pdh_below_since            = NULL,
       pdl_alerts_today           = 0,
       pdl_above_since            = NULL,
       gap_alerted_today          = 0,
       volume_above_alerted_today = 0`
  );

  const ALLOWED_STATE_COLUMNS = new Set([
    'direction', 'direction_changed_at',
    'last_breakout_at', 'last_bullish_reversal_at', 'last_bearish_reversal_at',
    'last_scan_at',
    'daily_state_date',
    'pdh_alerts_today', 'pdh_below_since',
    'pdl_alerts_today', 'pdl_above_since',
    'gap_alerted_today', 'volume_above_alerted_today',
  ]);

  return {
    addToWatchlist(guildId, ticker, nowMs, quoteType = null) {
      const res = insertWatch.run(guildId, ticker, nowMs, quoteType);
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

    setQuoteType(ticker, quoteType) {
      updateQuoteType.run(quoteType, ticker);
    },
    getQuoteType(ticker) {
      const row = selectQuoteType.get(ticker);
      return row ? row.quote_type : null;
    },
    resetDailyState(ticker, dateET) {
      resetDailyStmt.run(ticker, dateET);
    },
    applyStateUpdates(ticker, updates) {
      if (!updates || typeof updates !== 'object') return;
      const cols = Object.keys(updates).filter(c => ALLOWED_STATE_COLUMNS.has(c));
      if (cols.length === 0) return;
      // Build dynamically with whitelisted columns. No SQL injection risk.
      const placeholders = cols.map(() => '?').join(', ');
      const updateClause = cols.map(c => `${c} = excluded.${c}`).join(', ');
      const sql =
        `INSERT INTO trend_state (ticker, ${cols.join(', ')}) VALUES (?, ${placeholders}) ` +
        `ON CONFLICT(ticker) DO UPDATE SET ${updateClause}`;
      const stmt = db.prepare(sql);
      const values = cols.map(c => updates[c]);
      stmt.run(ticker, ...values);
    },
  };
}

module.exports = { createTrendStore };
