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
