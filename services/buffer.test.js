const { test } = require('node:test');
const assert = require('node:assert');

// Helper : isole les env var modifications.
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === null) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('isConfigured returns false when BUFFER_ACCESS_TOKEN missing', () => {
  delete require.cache[require.resolve('./buffer')];
  withEnv({ BUFFER_ACCESS_TOKEN: null, BUFFER_PROFILE_IDS: null }, () => {
    const { isConfigured } = require('./buffer');
    assert.strictEqual(isConfigured(), false);
  });
});

test('isConfigured returns false when profile IDs missing', () => {
  delete require.cache[require.resolve('./buffer')];
  withEnv({ BUFFER_ACCESS_TOKEN: 'tk', BUFFER_PROFILE_IDS: '' }, () => {
    const { isConfigured } = require('./buffer');
    assert.strictEqual(isConfigured(), false);
  });
});

test('isConfigured returns true when both env vars set', () => {
  delete require.cache[require.resolve('./buffer')];
  withEnv({ BUFFER_ACCESS_TOKEN: 'tk', BUFFER_PROFILE_IDS: 'id1,id2' }, () => {
    const { isConfigured, getConfig } = require('./buffer');
    assert.strictEqual(isConfigured(), true);
    const cfg = getConfig();
    assert.deepStrictEqual(cfg.profileIds, ['id1', 'id2']);
  });
});

test('postToBuffer throws when token missing', async () => {
  delete require.cache[require.resolve('./buffer')];
  await withEnv({ BUFFER_ACCESS_TOKEN: null, BUFFER_PROFILE_IDS: null }, async () => {
    const { postToBuffer } = require('./buffer');
    await assert.rejects(
      () => postToBuffer({ text: 'hi', videoUrl: 'https://example.com/v.mp4' }),
      /BUFFER_ACCESS_TOKEN not set/,
    );
  });
});

test('postToBuffer throws when no profileIds available', async () => {
  delete require.cache[require.resolve('./buffer')];
  await withEnv({ BUFFER_ACCESS_TOKEN: 'tk', BUFFER_PROFILE_IDS: '' }, async () => {
    const { postToBuffer } = require('./buffer');
    await assert.rejects(
      () => postToBuffer({ text: 'hi', videoUrl: 'https://example.com/v.mp4' }),
      /BUFFER_PROFILE_IDS not set/,
    );
  });
});

test('postToBuffer succeeds and parses Buffer response', async () => {
  // Mock global.fetch pour ce test.
  const origFetch = global.fetch;
  let capturedUrl = null;
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = opts && opts.body;
    return {
      ok: true,
      json: async () => ({ success: true, buffer_count: 1, updates: [{ id: 'up_123' }, { id: 'up_456' }] }),
    };
  };
  try {
    delete require.cache[require.resolve('./buffer')];
    await withEnv({ BUFFER_ACCESS_TOKEN: 'tk-secret', BUFFER_PROFILE_IDS: 'p1,p2' }, async () => {
      const { postToBuffer } = require('./buffer');
      const r = await postToBuffer({ text: 'Trade recap 🚀', videoUrl: 'https://cdn.discordapp.com/v.mp4' });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.bufferUpdateIds, ['up_123', 'up_456']);
      assert.deepStrictEqual(r.profileIdsPosted, ['p1', 'p2']);
      assert.match(capturedUrl, /api\.bufferapp\.com\/1\/updates\/create\.json$/);
      // Body must contain access_token + profile_ids[] + text + media[video]
      assert.match(capturedBody, /access_token=tk-secret/);
      assert.match(capturedBody, /profile_ids%5B%5D=p1/);
      assert.match(capturedBody, /profile_ids%5B%5D=p2/);
      assert.match(capturedBody, /text=Trade\+recap/);
      assert.match(capturedBody, /media%5Bvideo%5D=https/);
    });
  } finally {
    global.fetch = origFetch;
  }
});

test('postToBuffer surfaces non-200 errors clearly', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  try {
    delete require.cache[require.resolve('./buffer')];
    await withEnv({ BUFFER_ACCESS_TOKEN: 'tk', BUFFER_PROFILE_IDS: 'p1' }, async () => {
      const { postToBuffer } = require('./buffer');
      await assert.rejects(
        () => postToBuffer({ text: 'x', videoUrl: 'https://example.com/v.mp4' }),
        /Buffer \/updates\/create 401/,
      );
    });
  } finally {
    global.fetch = origFetch;
  }
});

test('postToBuffer respects per-call profileIds override', async () => {
  let capturedBody = null;
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    capturedBody = opts.body;
    return { ok: true, json: async () => ({ success: true, updates: [] }) };
  };
  try {
    delete require.cache[require.resolve('./buffer')];
    await withEnv({ BUFFER_ACCESS_TOKEN: 'tk', BUFFER_PROFILE_IDS: 'env-p1,env-p2' }, async () => {
      const { postToBuffer } = require('./buffer');
      await postToBuffer({ text: 'x', videoUrl: 'https://example.com/v.mp4', profileIds: ['custom-p'] });
      assert.match(capturedBody, /profile_ids%5B%5D=custom-p/);
      assert.doesNotMatch(capturedBody, /profile_ids%5B%5D=env-p1/);
    });
  } finally {
    global.fetch = origFetch;
  }
});
