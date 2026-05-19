const { test } = require('node:test');
const assert = require('node:assert');
const habs = require('./index');

// In-memory DB shim mirroring db/sqlite.js Habs helpers.
function makeFakeDb() {
  const jobs = [];
  let nextId = 1;
  const api = {
    jobs,
    insertSocialPostJob(job) {
      const dup = jobs.find(x =>
        x.platform === job.platform &&
        x.source_message_id === String(job.sourceMessageId) &&
        x.ocr_hash === job.ocrHash
      );
      if (dup) return null;
      const id = nextId++;
      const row = {
        id, attempts: 0, status: 'pending', last_error: null,
        next_attempt_at: null, post_url: null, posted_at: null,
        platform: job.platform,
        asset_type: job.assetType || 'text',
        caption: job.caption,
        cashtags_json: JSON.stringify(job.cashtags || []),
        source_kind: job.sourceKind || 'recap',
        source_message_id: String(job.sourceMessageId),
        ocr_hash: job.ocrHash,
      };
      jobs.push(row);
      return id;
    },
    getPendingSocialPostJobs() {
      return jobs.filter(j => j.status === 'pending');
    },
    markSocialPostJobPosting(id) {
      const j = jobs.find(x => x.id === id);
      if (!j || j.status !== 'pending') return false;
      j.status = 'posting';
      j.attempts++;
      return true;
    },
    markSocialPostJobDone(id, url) {
      const j = jobs.find(x => x.id === id);
      if (!j) return false;
      j.status = 'done';
      j.post_url = url;
      return true;
    },
    markSocialPostJobRetryOrFailed(id, err, max = 3) {
      const j = jobs.find(x => x.id === id);
      if (!j) return { status: null };
      if (j.attempts >= max) {
        j.status = 'failed';
        j.last_error = err;
        return { status: 'failed' };
      }
      j.status = 'pending';
      j.last_error = err;
      return { status: 'pending' };
    },
  };
  return api;
}

const FIXTURE_OCR = {
  dateLabel: '2026-05-18',
  trades: [
    { ticker: 'AAPL', entryPrice: 100, hodPrice: 150 },
    { ticker: 'TSLA', entryPrice: 50, hodPrice: 60 },
  ],
};

test('end-to-end: enqueueRecap → worker tick → done', async () => {
  const db = makeFakeDb();
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, text: async () => '{"id":"https://example.com/p/1"}' };
  };

  const { enqueue, tick } = habs.createForTest({
    db,
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/x' },
    fetchImpl,
    notifyAdmin: async () => {},
  });

  const id = await enqueue({ ocrResult: FIXTURE_OCR, messageId: 'm1' });
  assert.strictEqual(id, 1);
  assert.strictEqual(db.jobs[0].status, 'pending');

  await tick();
  assert.strictEqual(fetchCalled, true);
  assert.strictEqual(db.jobs[0].status, 'done');
});

test('end-to-end: fail path → status=failed + admin notified', async () => {
  const db = makeFakeDb();
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad payload' });

  const notifyCalls = [];
  const { enqueue, tick } = habs.createForTest({
    db,
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/x' },
    fetchImpl,
    notifyAdmin: async (m) => notifyCalls.push(m),
  });

  await enqueue({ ocrResult: FIXTURE_OCR, messageId: 'm1' });
  await tick();
  assert.strictEqual(db.jobs[0].status, 'failed');
  assert.strictEqual(notifyCalls.length, 1);
});
