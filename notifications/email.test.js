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

function makeCapturingLogger() {
  const errors = [];
  return {
    errors,
    error: (...args) => errors.push(args),
    log: () => {},
    warn: () => {},
  };
}

test('createEmailNotifier logs and swallows network errors', async () => {
  const logger = makeCapturingLogger();
  const fetch = async () => { throw new Error('ECONNREFUSED'); };
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch, logger,
  });
  // Must not throw.
  await notifier('📥 **ENTRY** $AAPL');
  assert.strictEqual(logger.errors.length, 1);
  assert.ok(String(logger.errors[0]).includes('ECONNREFUSED'));
});

test('createEmailNotifier logs and swallows non-2xx responses', async () => {
  const logger = makeCapturingLogger();
  const fetch = makeMockFetch({ ok: false, status: 401, body: 'unauthorized' });
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch, logger,
  });
  await notifier('📥 **ENTRY** $AAPL');
  assert.strictEqual(logger.errors.length, 1);
  const logged = String(logger.errors[0]);
  assert.ok(logged.includes('401'));
  assert.ok(logged.includes('unauthorized'));
});

// ── Image attachment tests ───────────────────────────────────────────

test('createEmailNotifier with imageBuffer sends HTML body + inline attachment', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch,
  });
  // Fake PNG bytes (the bytes themselves don't matter for the test)
  const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  await notifier('📥 $AAPL entry 150 (alice)', { imageBuffer: buf });

  assert.strictEqual(fetch.calls.length, 1);
  const body = JSON.parse(fetch.calls[0].options.body);
  // Subject + plain text fallback still present
  assert.strictEqual(body.subject, '📥 $AAPL entry 150 (alice)');
  assert.strictEqual(body.text, '📥 $AAPL entry 150 (alice)');
  // HTML body references cid:alert-image
  assert.ok(body.html.includes('cid:alert-image'), 'html should reference cid');
  assert.ok(body.html.includes('<img'), 'html should contain <img>');
  // Attachment: base64 of the buffer, content_id matching the cid
  assert.strictEqual(body.attachments.length, 1);
  assert.strictEqual(body.attachments[0].content_id, 'alert-image');
  assert.strictEqual(body.attachments[0].filename, 'alert.png');
  assert.strictEqual(body.attachments[0].content_type, 'image/png');
  assert.strictEqual(body.attachments[0].content, buf.toString('base64'));
});

test('createEmailNotifier without options sends plain text only (no html, no attachments)', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch,
  });
  await notifier('📥 $AAPL entry 150 (alice)');

  const body = JSON.parse(fetch.calls[0].options.body);
  assert.strictEqual(body.text, '📥 $AAPL entry 150 (alice)');
  assert.strictEqual(body.html, undefined);
  assert.strictEqual(body.attachments, undefined);
});

test('createEmailNotifier honors custom imageMimeType and derives extension from it', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch,
  });
  const buf = Buffer.from([0xFF, 0xD8, 0xFF]);  // JPEG signature
  await notifier('📥 $X entry 1 (a)', { imageBuffer: buf, imageMimeType: 'image/jpeg' });

  const body = JSON.parse(fetch.calls[0].options.body);
  assert.strictEqual(body.attachments[0].filename, 'alert.jpeg');
  assert.strictEqual(body.attachments[0].content_type, 'image/jpeg');
});

test('createEmailNotifier escapes the subject when used as alt text in HTML', async () => {
  const fetch = makeMockFetch();
  const notifier = createEmailNotifier({
    apiKey: 'k', to: 't', from: 'f', fetch,
  });
  const buf = Buffer.from([0x89]);
  await notifier('📥 $X entry 1 (a<b>c)', { imageBuffer: buf });

  const body = JSON.parse(fetch.calls[0].options.body);
  // Subject contains <b> raw; the alt attribute must escape it
  assert.ok(body.html.includes('alt="📥 $X entry 1 (a&lt;b&gt;c)"'),
    'html alt text must escape <, >, and similar');
});
