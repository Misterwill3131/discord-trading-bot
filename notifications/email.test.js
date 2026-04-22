const { test } = require('node:test');
const assert = require('node:assert');
const { createEmailNotifier } = require('./email');

function makeMockFetch(responseInit = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: responseInit.ok,
      status: responseInit.status,
      text: async () => responseInit.body || '',
    };
  };
  fn.calls = calls;
  return fn;
}

test('createEmailNotifier POSTs to Resend when message starts with entry prefix', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'test-key',
    to: 'alice@example.com',
    from: 'noreply@example.com',
    fetch,
  });

  await notifier('📥 **ENTRY** $AAPL\n• Qty: 10');

  assert.strictEqual(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.strictEqual(call.url, 'https://api.resend.com/emails');
  assert.strictEqual(call.options.method, 'POST');
  assert.strictEqual(call.options.headers['Authorization'], 'Bearer test-key');
  assert.strictEqual(call.options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(call.options.body);
  assert.strictEqual(body.from, 'noreply@example.com');
  assert.strictEqual(body.to, 'alice@example.com');
  assert.strictEqual(body.subject, '📥 ENTRY $AAPL');
  assert.strictEqual(body.text, '📥 ENTRY $AAPL\n• Qty: 10');
});

test('createEmailNotifier does NOT call fetch for fill messages', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch,
  });
  await notifier('✅ **FILLED** $AAPL 10 @ 150.0');
  assert.strictEqual(fetch.calls.length, 0);
});

test('createEmailNotifier does NOT call fetch for cancel messages', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch,
  });
  await notifier('❌ **CANCEL** $AAPL (limit timeout 30min)');
  assert.strictEqual(fetch.calls.length, 0);
});

test('createEmailNotifier no-ops when apiKey is missing', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: '', to: 't', from: 'f', fetch,
  });
  await notifier('📥 **ENTRY** $AAPL');
  assert.strictEqual(fetch.calls.length, 0);
});

test('createEmailNotifier no-ops when to is missing', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: undefined, from: 'f', fetch,
  });
  await notifier('📥 **ENTRY** $AAPL');
  assert.strictEqual(fetch.calls.length, 0);
});

test('createEmailNotifier no-ops when from is missing', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: null, fetch,
  });
  await notifier('📥 **ENTRY** $AAPL');
  assert.strictEqual(fetch.calls.length, 0);
});
