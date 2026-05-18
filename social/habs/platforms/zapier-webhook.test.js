const { test } = require('node:test');
const assert = require('node:assert');
const { publish, isRetriable } = require('./zapier-webhook');

function makeMockFetch(response) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body || '',
    };
  };
  fn.calls = calls;
  return fn;
}

test('publish POSTs JSON to webhook URL with correct payload shape', async () => {
  const fetch = makeMockFetch({ ok: true, status: 200, body: '{"status":"success"}' });
  const result = await publish({
    webhookUrl: 'https://hooks.zapier.com/catch/123/abc',
    payload: {
      body: 'Trade journal — test',
      source: 'habs-recap',
      job_id: 42,
      date_label: '2026-05-18',
      stats: { trade_count: 3, win_count: 2, loss_count: 1 },
    },
    fetchImpl: fetch,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.strictEqual(call.url, 'https://hooks.zapier.com/catch/123/abc');
  assert.strictEqual(call.options.method, 'POST');
  assert.strictEqual(call.options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(call.options.body);
  assert.strictEqual(body.body, 'Trade journal — test');
  assert.strictEqual(body.source, 'habs-recap');
  assert.strictEqual(body.job_id, 42);
});

test('publish returns ok=false retriable=true on 5xx', async () => {
  const fetch = makeMockFetch({ ok: false, status: 503, body: 'Service Unavailable' });
  const result = await publish({
    webhookUrl: 'https://hooks.zapier.com/catch/x/y',
    payload: { body: 'test' },
    fetchImpl: fetch,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.retriable, true);
  assert.match(result.error, /503/);
});

test('publish returns ok=false retriable=false on 4xx (except 408/429)', async () => {
  const fetch = makeMockFetch({ ok: false, status: 400, body: 'Bad webhook URL' });
  const result = await publish({
    webhookUrl: 'https://hooks.zapier.com/catch/x/y',
    payload: { body: 'test' },
    fetchImpl: fetch,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.retriable, false);
});

test('publish marks 429 as retriable', async () => {
  const fetch = makeMockFetch({ ok: false, status: 429, body: 'Rate limited' });
  const result = await publish({
    webhookUrl: 'https://hooks.zapier.com/catch/x/y',
    payload: { body: 'test' },
    fetchImpl: fetch,
  });
  assert.strictEqual(result.retriable, true);
});

test('publish marks 408 as retriable', async () => {
  const fetch = makeMockFetch({ ok: false, status: 408, body: 'Timeout' });
  const result = await publish({
    webhookUrl: 'https://hooks.zapier.com/catch/x/y',
    payload: { body: 'test' },
    fetchImpl: fetch,
  });
  assert.strictEqual(result.retriable, true);
});

test('publish treats network throw as retriable', async () => {
  const fetch = async () => { throw new Error('ECONNRESET'); };
  const result = await publish({
    webhookUrl: 'https://hooks.zapier.com/catch/x/y',
    payload: { body: 'test' },
    fetchImpl: fetch,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.retriable, true);
  assert.match(result.error, /ECONNRESET/);
});

test('isRetriable utility classifies status codes', () => {
  assert.strictEqual(isRetriable(500), true);
  assert.strictEqual(isRetriable(502), true);
  assert.strictEqual(isRetriable(408), true);
  assert.strictEqual(isRetriable(429), true);
  assert.strictEqual(isRetriable(400), false);
  assert.strictEqual(isRetriable(401), false);
  assert.strictEqual(isRetriable(404), false);
  assert.strictEqual(isRetriable(200), false);
});
