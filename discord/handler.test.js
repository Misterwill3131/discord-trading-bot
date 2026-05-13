const fs = require('fs');
const path = require('path');
const os = require('os');

// DB isolation — set BEFORE requiring anything that loads db/sqlite.js
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-render-test-'));
process.env.DATA_DIR = tmpDir;

// Now safe to require modules that load db/sqlite
const { test } = require('node:test');
const assert = require('node:assert');
const { formatAnalystEntryEmail, maybeEnqueueProofRender, findOriginalAlert } = require('./handler');
const { getPendingRenderJobs, insertMessage } = require('../db/sqlite');

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

const { maybeEnqueueRecap } = require('./handler');
const { getRecapByDate } = require('../db/sqlite');

const ZZ_RECAP = `RECAP:

$RXT 380% swing
$REPL 133% swing
$AIIO 71%

Plenty of chances to bank today. Our WL gave us 2 out of 3 runners.`;

test('maybeEnqueueRecap enqueue un job pour RECAP valide de ZZ', async () => {
  const before = getPendingRenderJobs().length;
  const result = await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-01T19:44:00Z'),
    messageId: 'msg-recap-1',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, true);
  const after = getPendingRenderJobs();
  assert.strictEqual(after.length, before + 1);
  const job = after[after.length - 1];
  assert.strictEqual(job.composition, 'BoomRecap');
  assert.ok(job.recap_data);
  const data = JSON.parse(job.recap_data);
  assert.strictEqual(data.tickers.length, 3);
});

test('maybeEnqueueRecap retourne enqueued=false si auteur hors whitelist', async () => {
  const result = await maybeEnqueueRecap({
    authorName: 'Random',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-02T19:44:00Z'),
    messageId: 'msg-recap-2',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, false);
  assert.strictEqual(result.reason, 'author_not_whitelisted');
});

test('maybeEnqueueRecap accepte raw Discord username si alias correspond au whitelist (display name)', async () => {
  // Whitelist = display name 'ZZ', author = raw Discord username 'traderzz1m'.
  // AUTHOR_ALIASES mappe traderzz1m → ZZ donc le check doit passer.
  // C'est le cas réel observé en prod : ZZ post avec username 'traderzz1m',
  // et l'utilisateur configure la whitelist avec 'ZZ' (display name).
  const result = await maybeEnqueueRecap({
    authorName: 'traderzz1m',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-02T20:00:00Z'),
    messageId: 'msg-recap-alias',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, true);
  assert.ok(result.jobId > 0);
});

test('maybeEnqueueRecap retourne enqueued=false si pas de RECAP: en début', async () => {
  const result = await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: '$RXT 380% swing\n$REPL 133% swing\n$AIIO 71%',
    messageCreatedAt: new Date('2026-06-03T19:44:00Z'),
    messageId: 'msg-recap-3',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, false);
  assert.strictEqual(result.reason, 'parse_failed');
});

test('maybeEnqueueRecap retourne enqueued=false si recap déjà fait aujourdhui', async () => {
  // First call : claims the date
  await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-04T19:44:00Z'),
    messageId: 'msg-recap-4a',
    authorWhitelist: ['ZZ'],
  });
  // Second call same date : should skip
  const result = await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-04T20:00:00Z'),
    messageId: 'msg-recap-4b',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, false);
  assert.strictEqual(result.reason, 'already_claimed');
});

test('maybeEnqueueRecap link render_job_id dans daily_recaps row', async () => {
  await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-05T19:44:00Z'),
    messageId: 'msg-recap-5',
    authorWhitelist: ['ZZ'],
  });
  const row = getRecapByDate('2026-06-05');
  assert.ok(row);
  assert.ok(row.render_job_id > 0);
  assert.strictEqual(row.message_id, 'msg-recap-5');
  assert.strictEqual(row.tickers_count, 3);
});

// ─── E2E : registerTradingHandler avec un message recap ─────────────
test('registerTradingHandler enqueue un BoomRecap quand ZZ post un RECAP:', async () => {
  // Mock minimal d'un Discord client + message
  const handlers = {};
  const fakeClient = {
    on: (event, fn) => { handlers[event] = fn; },
  };
  const fakeMessage = {
    content: ZZ_RECAP,
    author: { username: 'ZZ', bot: false },
    webhookId: null,
    channel: {
      name: 'trading-floor',
      messages: { fetch: async () => null },
      send: async () => ({ id: 'sent-123' }),
    },
    createdAt: new Date('2026-07-01T19:44:00Z'),
    id: 'e2e-msg-1',
    reference: null,
    reply: async () => {},
  };

  const { registerTradingHandler } = require('./handler');
  registerTradingHandler(fakeClient, {
    tradingChannel: 'trading-floor',
    railwayUrl: 'https://test.example',
    makeWebhookUrl: 'https://test.example/webhook',
    tradingEngine: null,
    sendEmailAlert: null,
  });

  // Set whitelist via env (note : process.env modifs entre tests OK ici)
  const prevWhitelist = process.env.RECAP_AUTHOR_WHITELIST;
  process.env.RECAP_AUTHOR_WHITELIST = 'ZZ';

  const before = getPendingRenderJobs().length;
  await handlers.messageCreate(fakeMessage);
  const after = getPendingRenderJobs();

  // Restore env
  if (prevWhitelist === undefined) delete process.env.RECAP_AUTHOR_WHITELIST;
  else process.env.RECAP_AUTHOR_WHITELIST = prevWhitelist;

  // Devrait avoir enqueued exactement 1 job BoomRecap
  const newJobs = after.slice(before);
  const recapJobs = newJobs.filter(j => j.composition === 'BoomRecap');
  assert.strictEqual(recapJobs.length, 1, 'should enqueue exactly one BoomRecap job');
  assert.ok(recapJobs[0].recap_data, 'recap_data should be populated');
});

// ── findOriginalAlert : reply branch propage parent ts + entry_price ──
test('findOriginalAlert (reply) uses parentCreatedAt as ts when no DB match', () => {
  const parentTs = new Date('2026-05-13T13:32:00-04:00');
  const result = findOriginalAlert({
    signalTicker: 'NEVER_SEEN',
    messageCreatedAt: new Date('2026-05-13T14:00:00-04:00'),
    isReply: true,
    parentContent: '$NEVER_SEEN 0.50 entry',
    parentAuthor: 'ZZ',
    parentCreatedAt: parentTs,
  });
  assert.ok(result);
  assert.strictEqual(result.author, 'ZZ');
  assert.strictEqual(result.ts, parentTs.toISOString());
  assert.strictEqual(result.entry_price, null);
});

test('findOriginalAlert (reply) enriches with DB entry_price when ticker+ts match', () => {
  // Seed DB avec une entry TDIC postée à parentTs.
  const parentTs = new Date('2026-05-13T13:32:00-04:00');
  insertMessage({
    id: 'reply-test-entry-1',
    ts: parentTs.toISOString(),
    author: 'ZZ',
    channel: 'trading-floor',
    content: '$TDIC 0.95 -11.18',
    preview: '$TDIC 0.95 -11.18',
    passed: true,
    type: 'entry',
    reason: 'Accepted',
    confidence: 90,
    ticker: 'TDIC',
    entry_price: 0.95,
    isReply: false,
  });

  const result = findOriginalAlert({
    signalTicker: 'TDIC',
    messageCreatedAt: new Date('2026-05-13T14:37:00-04:00'),
    isReply: true,
    parentContent: 'TDIC 0.95 -11.18 with a lot of handholding',
    parentAuthor: 'ZZ',
    parentCreatedAt: parentTs,
  });
  assert.ok(result);
  assert.strictEqual(result.author, 'ZZ');
  assert.strictEqual(result.ts, parentTs.toISOString());
  assert.strictEqual(result.entry_price, 0.95);
});

test('findOriginalAlert (reply without parentCreatedAt) returns ts=null (back-compat)', () => {
  // Si parentCreatedAt manque (parent fetch échoué), on tombe sur null
  // — meilleur que de planter, mais maybeEnqueueProofRender skippera.
  const result = findOriginalAlert({
    signalTicker: 'TDIC',
    messageCreatedAt: new Date('2026-05-13T14:00:00-04:00'),
    isReply: true,
    parentContent: 'TDIC 0.95',
    parentAuthor: 'ZZ',
    parentCreatedAt: null,
  });
  assert.ok(result);
  assert.strictEqual(result.ts, null);
});

test('maybeEnqueueProofRender accepts a reply-based originalAlert with parentCreatedAt-derived ts', async () => {
  // Régression : avant le fix, ts était toujours null pour les replies
  // → bail "skip replies sans parent ts" → aucune vidéo générée pour
  // les exits postés en mode reply (cas ZZ "TDIC 1018%").
  const before = getPendingRenderJobs().length;
  await maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'TDIC',
    pnl: '+1018%',
    originalAlert: {
      author: 'ZZ',
      content: 'TDIC 0.95 -11.18',
      ts: '2026-05-13T13:32:00-04:00',
      entry_price: 0.95,
    },
    authorName: 'ZZ',
    content: 'TDIC 1018% and you got at least 4 alerts',
    messageCreatedAt: new Date('2026-05-13T14:37:00-04:00'),
  });
  const after = getPendingRenderJobs();
  assert.strictEqual(after.length, before + 1);
  const job = after[after.length - 1];
  assert.strictEqual(job.ticker, 'TDIC');
  assert.strictEqual(job.pnl, '+1018%');
  assert.strictEqual(job.entry_price, 0.95);
});
