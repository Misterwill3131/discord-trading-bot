const { test } = require('node:test');
const assert = require('node:assert');
const { tickOnce } = require('./worker');

// Fake DB layer: in-memory job store, exposes the same helper API the
// real db/sqlite.js does. Each test creates a fresh fakeDb.
function makeFakeDb() {
  const jobs = [];
  let nextId = 1;
  return {
    jobs,
    insertSocialPostJob(job) {
      const id = nextId++;
      jobs.push({
        id, attempts: 0, status: 'pending', last_error: null,
        next_attempt_at: null, post_url: null, posted_at: null,
        ...job,
        cashtags_json: JSON.stringify(job.cashtags || []),
      });
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
    markSocialPostJobDone(id, postUrl) {
      const j = jobs.find(x => x.id === id);
      if (!j) return false;
      j.status = 'done';
      j.post_url = postUrl;
      return true;
    },
    markSocialPostJobRetryOrFailed(id, error, maxAttempts = 3) {
      const j = jobs.find(x => x.id === id);
      if (!j) return { status: null };
      if (j.attempts >= maxAttempts) {
        j.status = 'failed';
        j.last_error = error;
        return { status: 'failed', attempts: j.attempts };
      }
      j.status = 'pending';
      j.last_error = error;
      j.next_attempt_at = `+${j.attempts}s`;  // marker, not real timestamp
      return { status: 'pending', attempts: j.attempts };
    },
  };
}

function makeAdapterMap(result) {
  return {
    stocktwits: async () => result,
  };
}

test('tickOnce: success path → job marked done', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  await tickOnce({
    db,
    adapters: makeAdapterMap({ ok: true, postUrl: 'https://example.com/post/1' }),
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  });

  assert.strictEqual(db.jobs[0].status, 'done');
  assert.strictEqual(db.jobs[0].post_url, 'https://example.com/post/1');
  assert.strictEqual(notifyCalls.length, 0);
});

test('tickOnce: retriable failure → re-queued pending', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  await tickOnce({
    db,
    adapters: makeAdapterMap({ ok: false, retriable: true, error: 'HTTP 503' }),
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  });

  assert.strictEqual(db.jobs[0].status, 'pending');
  assert.strictEqual(db.jobs[0].attempts, 1);
  assert.strictEqual(db.jobs[0].last_error, 'HTTP 503');
  assert.strictEqual(notifyCalls.length, 0);
});

test('tickOnce: permanent failure → status=failed + notify admin', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  await tickOnce({
    db,
    adapters: makeAdapterMap({ ok: false, retriable: false, error: 'HTTP 400' }),
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  });

  assert.strictEqual(db.jobs[0].status, 'failed');
  assert.strictEqual(notifyCalls.length, 1);
  assert.match(notifyCalls[0], /Habs.*stocktwits.*HTTP 400/);
});

test('tickOnce: 3 retriable failures exhausts retries → failed + notify', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  const tickArgs = {
    db,
    adapters: makeAdapterMap({ ok: false, retriable: true, error: 'HTTP 503' }),
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  };

  await tickOnce(tickArgs);  // attempt 1
  assert.strictEqual(db.jobs[0].status, 'pending');
  await tickOnce(tickArgs);  // attempt 2
  assert.strictEqual(db.jobs[0].status, 'pending');
  await tickOnce(tickArgs);  // attempt 3 → exhausted
  assert.strictEqual(db.jobs[0].status, 'failed');
  assert.strictEqual(notifyCalls.length, 1);
});

test('tickOnce: missing webhook URL for platform → permanent failure', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  await tickOnce({
    db,
    adapters: makeAdapterMap({ ok: true }),  // adapter present but no URL
    webhookUrls: {},
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  });

  assert.strictEqual(db.jobs[0].status, 'failed');
  assert.strictEqual(notifyCalls.length, 1);
});

test('tickOnce: unknown platform → permanent failure', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'mystery', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  await tickOnce({
    db,
    adapters: makeAdapterMap({ ok: true }),
    webhookUrls: { mystery: 'https://x' },
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  });

  assert.strictEqual(db.jobs[0].status, 'failed');
  assert.match(db.jobs[0].last_error, /no adapter/);
});

test('tickOnce: payload includes caption + cashtags + stats', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits',
    caption: 'Trade journal — 2026-05-18',
    cashtags: ['AAPL', 'TSLA'],
    sourceMessageId: 'm1',
    ocrHash: 'h1',
  });

  let received = null;
  const adapter = async ({ payload }) => {
    received = payload;
    return { ok: true };
  };

  await tickOnce({
    db,
    adapters: { stocktwits: adapter },
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async () => {},
  });

  assert.ok(received);
  assert.strictEqual(received.body, 'Trade journal — 2026-05-18');
  assert.deepStrictEqual(received.cashtags, ['AAPL', 'TSLA']);
  assert.strictEqual(received.source, 'habs-recap');
});

test('tickOnce: adapter throws → treated as retriable network error', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });

  const notifyCalls = [];
  const throwingAdapter = async () => { throw new Error('connection reset'); };

  await tickOnce({
    db,
    adapters: { stocktwits: throwingAdapter },
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async (msg) => notifyCalls.push(msg),
  });

  // First attempt: adapter threw → retriable → status reverts to 'pending'
  assert.strictEqual(db.jobs[0].status, 'pending');
  assert.strictEqual(db.jobs[0].attempts, 1);
  assert.match(db.jobs[0].last_error, /connection reset/);
  assert.strictEqual(notifyCalls.length, 0);
});

test('tickOnce: notifyAdmin throwing does not abort the loop', async () => {
  const db = makeFakeDb();
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'x', sourceMessageId: 'm1', ocrHash: 'h1',
  });
  db.insertSocialPostJob({
    platform: 'stocktwits', caption: 'y', sourceMessageId: 'm2', ocrHash: 'h2',
  });

  // Both jobs fail permanently; admin notifier throws on each call. We expect
  // both jobs to still be marked 'failed' (i.e. the loop did not abort).
  await tickOnce({
    db,
    adapters: makeAdapterMap({ ok: false, retriable: false, error: 'HTTP 400' }),
    webhookUrls: { stocktwits: 'https://hooks.zapier.com/catch/x' },
    notifyAdmin: async () => { throw new Error('discord down'); },
  });

  assert.strictEqual(db.jobs[0].status, 'failed');
  assert.strictEqual(db.jobs[1].status, 'failed');
});
