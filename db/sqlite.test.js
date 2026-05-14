const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the DB for tests by pointing DATA_DIR elsewhere
// before we require anything that touches db/sqlite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-test-'));
process.env.DATA_DIR = tmpDir;

const {
  enqueueRenderJob,
  getPendingRenderJobs,
  tryClaimRecapDate,
  setRecapRenderJobId,
  getRecapByDate,
} = require('./sqlite');

// ── daily_recaps : idempotence par date ─────────────────────────────
test('tryClaimRecapDate retourne true au premier appel pour une date', () => {
  const claimed = tryClaimRecapDate('2026-05-08', 'msg-123', 14);
  assert.strictEqual(claimed, true);
});

test('tryClaimRecapDate retourne false au deuxième appel même date', () => {
  tryClaimRecapDate('2026-05-09', 'msg-456', 10);
  const second = tryClaimRecapDate('2026-05-09', 'msg-789', 12);
  assert.strictEqual(second, false);
});

test('setRecapRenderJobId update render_job_id pour une date', () => {
  tryClaimRecapDate('2026-05-10', 'msg-aaa', 8);
  setRecapRenderJobId('2026-05-10', 999);
  const row = getRecapByDate('2026-05-10');
  assert.strictEqual(row.render_job_id, 999);
});

test('getRecapByDate retourne null pour date inconnue', () => {
  const row = getRecapByDate('1999-01-01');
  assert.strictEqual(row, null);
});

// ── render_jobs.recap_data colonne ──────────────────────────────────
test('enqueueRenderJob accepte recap_data optionnel', () => {
  const recapData = JSON.stringify({ tickers: [{ ticker: 'RXT', gainPct: 380 }] });
  const id = enqueueRenderJob({
    ticker: 'RECAP',
    entry_author: 'ZZ',
    entry_message: 'RECAP test',
    entry_ts: '2026-05-08T19:44:00Z',
    exit_author: 'ZZ',
    exit_message: 'RECAP test',
    exit_ts: '2026-05-08T19:44:00Z',
    pnl: '+0%',
    composition: 'BoomRecap',
    recap_data: recapData,
  });
  assert.ok(id > 0);
  // Verify roundtrip
  const jobs = getPendingRenderJobs(100);
  const job = jobs.find(j => j.id === id);
  assert.strictEqual(job.recap_data, recapData);
});

// ── tracked_messages (analyst-watchlist module) ─────────────────────
const {
  insertTrackedMessage,
  getTrackedMessage,
} = require('./sqlite');

test('insertTrackedMessage stores a non-bot message with ticker+price', () => {
  insertTrackedMessage({
    messageId: 'msg-aw-1',
    channelId: 'chan-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    isBot: 0,
    content: 'Watch $AAPL @ $200',
    embedJson: null,
    extractedTicker: 'AAPL',
    extractedPrice: 200,
    createdAt: 1700000000000,
  });
  const row = getTrackedMessage('msg-aw-1');
  assert.strictEqual(row.author_username, 'alice');
  assert.strictEqual(row.is_bot, 0);
  assert.strictEqual(row.extracted_ticker, 'AAPL');
  assert.strictEqual(row.extracted_price, 200);
});

test('insertTrackedMessage is idempotent on message_id (INSERT OR IGNORE)', () => {
  insertTrackedMessage({
    messageId: 'msg-aw-2',
    channelId: 'c', authorId: 'u', authorUsername: 'a',
    isBot: 0, content: 'first', embedJson: null,
    extractedTicker: null, extractedPrice: null,
    createdAt: 1700000000000,
  });
  // Second call with same messageId should be a no-op (no throw)
  insertTrackedMessage({
    messageId: 'msg-aw-2',
    channelId: 'c', authorId: 'u', authorUsername: 'a',
    isBot: 0, content: 'second', embedJson: null,
    extractedTicker: null, extractedPrice: null,
    createdAt: 1700000000000,
  });
  const row = getTrackedMessage('msg-aw-2');
  assert.strictEqual(row.content, 'first');  // first write wins
});

// ── analyst_watchlist (active tickers tracked for milestones) ───────
const {
  insertWatchlistEntry,
  getWatchlistEntry,
  getActiveWatchlist,
  updateWatchlistAfterAlert,
  archiveExpiredWatchlist,
} = require('./sqlite');

test('insertWatchlistEntry creates a new entry', () => {
  insertWatchlistEntry({
    ticker: 'AAPL',
    initialPrice: 200,
    initialPriceSource: 'message',
    sourceMessageId: 'msg-1',
    sourceChannelId: 'chan-1',
    mentionedByUserId: 'user-1',
    mentionedByUsername: 'alice',
    firstSeenAt: 1700000000000,
  });
  const row = getWatchlistEntry('AAPL');
  assert.strictEqual(row.initial_price, 200);
  assert.strictEqual(row.initial_price_source, 'message');
  assert.strictEqual(row.mentioned_by_username, 'alice');
  assert.strictEqual(row.last_milestone_pct, null);
  assert.strictEqual(row.last_alert_at, null);
  assert.strictEqual(row.archived_at, null);
});

test('insertWatchlistEntry on existing ticker is a no-op (first mention wins)', () => {
  insertWatchlistEntry({
    ticker: 'TSLA', initialPrice: 100, initialPriceSource: 'market',
    sourceMessageId: 'msg-a', sourceChannelId: 'c',
    mentionedByUserId: 'u1', mentionedByUsername: 'alice',
    firstSeenAt: 1700000000000,
  });
  insertWatchlistEntry({
    ticker: 'TSLA', initialPrice: 999, initialPriceSource: 'market',
    sourceMessageId: 'msg-b', sourceChannelId: 'c',
    mentionedByUserId: 'u2', mentionedByUsername: 'bob',
    firstSeenAt: 1700000999999,
  });
  const row = getWatchlistEntry('TSLA');
  assert.strictEqual(row.initial_price, 100);          // first wins
  assert.strictEqual(row.mentioned_by_username, 'alice');
});

test('getActiveWatchlist returns only non-archived entries', () => {
  insertWatchlistEntry({
    ticker: 'NVDA', initialPrice: 50, initialPriceSource: 'message',
    sourceMessageId: 'm1', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 1700000000000,
  });
  const active = getActiveWatchlist();
  const tickers = active.map(r => r.ticker);
  assert.ok(tickers.includes('NVDA'));
});

test('updateWatchlistAfterAlert sets last_milestone_pct + last_alert_at', () => {
  insertWatchlistEntry({
    ticker: 'MSFT', initialPrice: 300, initialPriceSource: 'market',
    sourceMessageId: 'm', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 1700000000000,
  });
  updateWatchlistAfterAlert({
    ticker: 'MSFT', lastMilestonePct: 20, lastAlertAt: 1700001000000,
  });
  const row = getWatchlistEntry('MSFT');
  assert.strictEqual(row.last_milestone_pct, 20);
  assert.strictEqual(row.last_alert_at, 1700001000000);
});

test('archiveExpiredWatchlist soft-archives entries older than cutoff', () => {
  insertWatchlistEntry({
    ticker: 'OLD', initialPrice: 10, initialPriceSource: 'market',
    sourceMessageId: 'm', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 1000,   // very old
  });
  insertWatchlistEntry({
    ticker: 'NEW', initialPrice: 10, initialPriceSource: 'market',
    sourceMessageId: 'm2', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 9_999_999_999_999,  // very new
  });
  const archivedCount = archiveExpiredWatchlist(5000);  // cutoff: ts < 5000 → archive
  assert.ok(archivedCount >= 1);
  const oldRow = getWatchlistEntry('OLD');
  assert.ok(oldRow.archived_at != null);
  const newRow = getWatchlistEntry('NEW');
  assert.strictEqual(newRow.archived_at, null);
  // Active list excludes archived
  const active = getActiveWatchlist();
  assert.ok(!active.find(r => r.ticker === 'OLD'));
});

// ── milestone_alerts (atomic dedup of fired milestones) ─────────────
const { insertMilestoneAlert } = require('./sqlite');

test('insertMilestoneAlert returns true on first insert', () => {
  const fired = insertMilestoneAlert({
    ticker: 'AAPL',
    milestonePct: 20,
    initialPrice: 200,
    currentPrice: 240,
    gainPct: 20,
    firedAt: 1700000000000,
  });
  assert.strictEqual(fired, true);
});

test('insertMilestoneAlert returns false on duplicate (ticker, milestone_pct)', () => {
  insertMilestoneAlert({
    ticker: 'NVDA', milestonePct: 50,
    initialPrice: 100, currentPrice: 150, gainPct: 50,
    firedAt: 1700000000000,
  });
  const secondFired = insertMilestoneAlert({
    ticker: 'NVDA', milestonePct: 50,
    initialPrice: 100, currentPrice: 155, gainPct: 55,
    firedAt: 1700000999999,
  });
  assert.strictEqual(secondFired, false);
});

test('insertMilestoneAlert allows same ticker for different milestone_pct', () => {
  insertMilestoneAlert({
    ticker: 'TSLA', milestonePct: 20,
    initialPrice: 100, currentPrice: 120, gainPct: 20,
    firedAt: 1700000000000,
  });
  const fired50 = insertMilestoneAlert({
    ticker: 'TSLA', milestonePct: 50,
    initialPrice: 100, currentPrice: 150, gainPct: 50,
    firedAt: 1700000999999,
  });
  assert.strictEqual(fired50, true);
});

// ── milestone_alerts.discord_message_id update ──────────────────────
const { setMilestoneAlertDiscordId } = require('./sqlite');

test('setMilestoneAlertDiscordId sets the discord_message_id on an existing row', () => {
  insertMilestoneAlert({
    ticker: 'GOOG', milestonePct: 100,
    initialPrice: 100, currentPrice: 200, gainPct: 100,
    firedAt: 1700000000000,
  });
  const updated = setMilestoneAlertDiscordId({
    ticker: 'GOOG', milestonePct: 100, discordMessageId: 'discord-reply-42',
  });
  assert.strictEqual(updated, true);
  // Verify via direct query (no getter helper, use raw db)
  const Database = require('better-sqlite3');
  const path = require('path');
  const dbPath = path.join(process.env.DATA_DIR, 'boom.db');
  const directDb = new Database(dbPath, { readonly: true });
  const row = directDb.prepare(
    'SELECT discord_message_id FROM milestone_alerts WHERE ticker = ? AND milestone_pct = ?'
  ).get('GOOG', 100);
  directDb.close();
  assert.strictEqual(row.discord_message_id, 'discord-reply-42');
});

test('setMilestoneAlertDiscordId returns false when no matching row', () => {
  const updated = setMilestoneAlertDiscordId({
    ticker: 'NOPE', milestonePct: 9999, discordMessageId: 'whatever',
  });
  assert.strictEqual(updated, false);
});
