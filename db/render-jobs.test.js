const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the DB for tests by pointing DATA_DIR elsewhere
// before we require anything that touches db/sqlite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-jobs-test-'));
process.env.DATA_DIR = tmpDir;

const {
  enqueueRenderJob,
  getPendingRenderJobs,
  markRenderJobDone,
  markRenderJobFailed,
} = require('./sqlite');

const samplePayload = {
  ticker: 'TSLA',
  entry_author: 'Z',
  entry_message: '$TSLA 150 entry long',
  entry_ts: '2026-04-25T13:32:00-04:00',
  exit_author: 'Z',
  exit_message: '$TSLA out +20%',
  exit_ts: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
};

test('enqueueRenderJob inserts a row and returns its id', () => {
  const id = enqueueRenderJob(samplePayload);
  assert.ok(typeof id === 'number' && id > 0, 'expected positive numeric id');
});

test('getPendingRenderJobs returns enqueued jobs', () => {
  enqueueRenderJob({ ...samplePayload, ticker: 'NVDA' });
  const pending = getPendingRenderJobs();
  assert.ok(pending.length >= 1);
  const last = pending.find(j => j.ticker === 'NVDA');
  assert.ok(last);
  assert.strictEqual(last.entry_author, 'Z');
  assert.strictEqual(last.status, 'pending');
});

test('markRenderJobDone updates status and discord_msg_id', () => {
  const id = enqueueRenderJob({ ...samplePayload, ticker: 'AMD' });
  markRenderJobDone(id, 'discord_msg_xyz');
  const pending = getPendingRenderJobs();
  assert.ok(!pending.find(j => j.id === id), 'expected job to be removed from pending list');
});

test('markRenderJobFailed updates status and error', () => {
  const id = enqueueRenderJob({ ...samplePayload, ticker: 'AAPL' });
  markRenderJobFailed(id, 'Render timeout');
  const pending = getPendingRenderJobs();
  assert.ok(!pending.find(j => j.id === id));
});

test('getPendingRenderJobs respects limit param', () => {
  for (let i = 0; i < 15; i++) {
    enqueueRenderJob({ ...samplePayload, ticker: 'BULK' + i });
  }
  const limited = getPendingRenderJobs(5);
  assert.ok(limited.length <= 5);
});
