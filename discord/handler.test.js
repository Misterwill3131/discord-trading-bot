const fs = require('fs');
const path = require('path');
const os = require('os');

// DB isolation — set BEFORE requiring anything that loads db/sqlite.js
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-render-test-'));
process.env.DATA_DIR = tmpDir;

// Now safe to require modules that load db/sqlite
const { test } = require('node:test');
const assert = require('node:assert');
const { formatAnalystEntryEmail, maybeEnqueueProofRender } = require('./handler');
const { getPendingRenderJobs } = require('../db/sqlite');

// ── formatAnalystEntryEmail ──────────────────────────────────────────
// L'email est essentiellement une image inline (cf. notifications/email.js).
// Le message texte renvoyé ici sert de subject ET de fallback texte —
// donc une seule ligne suffit, identique pour tous les analystes.

test('formatAnalystEntryEmail returns one-line subject with entry price', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'AIHS',
    entryPx: 1.27,
  });
  assert.strictEqual(msg, '📥 $AIHS entry 1.27 (ZZ)');
});

test('formatAnalystEntryEmail uses em-dash when entryPx is null', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'AIHS',
    entryPx: null,
  });
  assert.strictEqual(msg, '📥 $AIHS entry — (ZZ)');
});

test('formatAnalystEntryEmail uppercases ticker', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'aihs',
    entryPx: 1.27,
  });
  assert.strictEqual(msg, '📥 $AIHS entry 1.27 (ZZ)');
});

test('formatAnalystEntryEmail always starts with 📥 (required by email filter)', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'anyone',
    signalTicker: 'ABC',
    entryPx: 1,
  });
  assert.ok(msg.startsWith('📥'));
});

test('maybeEnqueueProofRender enqueues job on winning exit with valid entry', async () => {
  const before = getPendingRenderJobs().length;
  await maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'TSLA',
    pnl: '+20%',
    originalAlert: {
      author: 'Z',
      content: '$TSLA 150 entry long',
      ts: '2026-04-25T13:32:00-04:00',
    },
    authorName: 'Z',
    content: '$TSLA out +20%',
    messageCreatedAt: new Date('2026-04-25T16:30:00-04:00'),
  });
  const after = getPendingRenderJobs();
  assert.strictEqual(after.length, before + 1);
  const job = after[after.length - 1];
  assert.strictEqual(job.ticker, 'TSLA');
  assert.strictEqual(job.pnl, '+20%');
});

test('maybeEnqueueProofRender skips losing exit', async () => {
  const before = getPendingRenderJobs().length;
  await maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'AAPL',
    pnl: '-5%',
    originalAlert: { author: 'Z', content: '...', ts: '2026-04-25T13:00:00-04:00' },
    authorName: 'Z',
    content: '$AAPL out -5%',
    messageCreatedAt: new Date('2026-04-25T15:00:00-04:00'),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});

test('maybeEnqueueProofRender skips when no originalAlert', async () => {
  const before = getPendingRenderJobs().length;
  await maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'NVDA',
    pnl: '+10%',
    originalAlert: null,
    authorName: 'Bora',
    content: '$NVDA out +10%',
    messageCreatedAt: new Date(),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});

test('maybeEnqueueProofRender skips when originalAlert.ts is null (reply case)', async () => {
  const before = getPendingRenderJobs().length;
  await maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'AMD',
    pnl: '+15%',
    originalAlert: { author: 'Viking', content: '...', ts: null },
    authorName: 'Viking',
    content: '$AMD out +15%',
    messageCreatedAt: new Date(),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});

test('maybeEnqueueProofRender skips entry signals (filterType=entry)', async () => {
  const before = getPendingRenderJobs().length;
  await maybeEnqueueProofRender({
    filterType: 'entry',
    signalTicker: 'TSLA',
    pnl: null,
    originalAlert: null,
    authorName: 'Z',
    content: '$TSLA 150 entry long',
    messageCreatedAt: new Date(),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});
