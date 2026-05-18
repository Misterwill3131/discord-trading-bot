const { test } = require('node:test');
const assert = require('node:assert');
const { enqueueRecap, computeOcrHash } = require('./queue');

function makeFakeDb() {
  const jobs = [];
  let nextId = 1;
  return {
    jobs,
    insertSocialPostJob(job) {
      // Simulate UNIQUE index on (platform, source_message_id, ocr_hash)
      const dup = jobs.find(j =>
        j.platform === job.platform &&
        j.sourceMessageId === job.sourceMessageId &&
        j.ocrHash === job.ocrHash
      );
      if (dup) return null;
      const id = nextId++;
      jobs.push({ id, ...job });
      return id;
    },
  };
}

const FIXTURE_OCR = {
  dateLabel: '2026-05-18',
  trades: [
    { ticker: 'AAPL', entryPrice: 100, hodPrice: 150 },
    { ticker: 'TSLA', entryPrice: 50, hodPrice: 60 },
    { ticker: 'NVDA', entryPrice: 200, hodPrice: 220 },
  ],
};

test('enqueueRecap inserts a job with caption + cashtags + ocr_hash', async () => {
  const db = makeFakeDb();
  const id = await enqueueRecap({
    db,
    ocrResult: FIXTURE_OCR,
    messageId: 'discord-msg-123',
    captionFn: async () => 'Trade journal — 2026-05-18\n3 closes',
  });
  assert.strictEqual(id, 1);
  assert.strictEqual(db.jobs.length, 1);
  assert.strictEqual(db.jobs[0].platform, 'stocktwits');
  assert.strictEqual(db.jobs[0].sourceMessageId, 'discord-msg-123');
  assert.strictEqual(db.jobs[0].caption, 'Trade journal — 2026-05-18\n3 closes');
  assert.deepStrictEqual(db.jobs[0].cashtags, ['AAPL', 'TSLA', 'NVDA']);
  assert.strictEqual(typeof db.jobs[0].ocrHash, 'string');
  assert.strictEqual(db.jobs[0].ocrHash.length, 64);  // sha256 hex
});

test('enqueueRecap is idempotent: same messageId + same OCR → null', async () => {
  const db = makeFakeDb();
  const id1 = await enqueueRecap({
    db,
    ocrResult: FIXTURE_OCR,
    messageId: 'msg-1',
    captionFn: async () => 'caption',
  });
  const id2 = await enqueueRecap({
    db,
    ocrResult: FIXTURE_OCR,
    messageId: 'msg-1',
    captionFn: async () => 'caption',
  });
  assert.strictEqual(id1, 1);
  assert.strictEqual(id2, null);
  assert.strictEqual(db.jobs.length, 1);
});

test('enqueueRecap with different OCR but same messageId → new job', async () => {
  const db = makeFakeDb();
  await enqueueRecap({
    db,
    ocrResult: FIXTURE_OCR,
    messageId: 'msg-1',
    captionFn: async () => 'caption',
  });
  const id2 = await enqueueRecap({
    db,
    ocrResult: { ...FIXTURE_OCR, trades: [{ ticker: 'X', entryPrice: 1, hodPrice: 2 }] },
    messageId: 'msg-1',
    captionFn: async () => 'caption',
  });
  assert.strictEqual(id2, 2);
  assert.strictEqual(db.jobs.length, 2);
});

test('enqueueRecap skips when trades array is empty', async () => {
  const db = makeFakeDb();
  const id = await enqueueRecap({
    db,
    ocrResult: { dateLabel: '2026-05-18', trades: [] },
    messageId: 'msg-1',
    captionFn: async () => 'caption',
  });
  assert.strictEqual(id, null);
  assert.strictEqual(db.jobs.length, 0);
});

test('computeOcrHash is stable and deterministic', () => {
  const h1 = computeOcrHash(FIXTURE_OCR.trades);
  const h2 = computeOcrHash(FIXTURE_OCR.trades);
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
});

test('computeOcrHash differs for different trades', () => {
  const h1 = computeOcrHash([{ ticker: 'A', entryPrice: 1, hodPrice: 2 }]);
  const h2 = computeOcrHash([{ ticker: 'B', entryPrice: 1, hodPrice: 2 }]);
  assert.notStrictEqual(h1, h2);
});
