# Email Entry Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send an email (via Resend) every time the trading engine emits an entry alert (message prefixed with `📥`), in addition to the existing Discord alert — without modifying the engine.

**Architecture:** A new module `notifications/email.js` exports `createEmailNotifier({ apiKey, to, from, logger?, fetch? })` returning an async function `(message) => void` that POSTs to `https://api.resend.com/emails` when the message starts with `📥`. In `index.js`, a wrapper `notifyAll` fans out every `engine.notify(msg)` call to both `sendTradingAlert` (Discord, unchanged) and `sendEmailAlert` (email, filtered). The module silently no-ops when any required env var is missing, logs without throwing on network/HTTP errors, and never blocks trading.

**Tech Stack:** Node.js (CommonJS), `node-fetch@2` (already in `package.json`), `node:test` for tests (style matches [trading/broker.test.js](../../../trading/broker.test.js)), Resend HTTP API.

**Spec:** [2026-04-22-email-entry-alerts-design.md](../specs/2026-04-22-email-entry-alerts-design.md)

---

## File Structure

- **Create:** `notifications/email.js` — email notifier factory, ~45 lines, one responsibility (send Resend email when message matches entry-alert prefix)
- **Create:** `notifications/email.test.js` — unit tests, ~120 lines, 6 scenarios (happy path, filter, missing env, network error, non-2xx, message type guard)
- **Modify:** `index.js` — add 1 require, 1 factory call, 1 wrapper function, change 1 line of the engine config

No changes to `package.json` (reuses `node-fetch@2`, already in deps).
No changes to `trading/engine.js`.

---

## Task 1: Create notifier module + happy-path test

**Files:**
- Create: `notifications/email.js`
- Create: `notifications/email.test.js`

- [ ] **Step 1: Write the failing happy-path test**

Create `notifications/email.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="createEmailNotifier POSTs"`
Expected: FAIL with `Cannot find module './email'` or equivalent.

- [ ] **Step 3: Write minimal implementation**

Create `notifications/email.js`:

```js
const nodeFetch = require('node-fetch');

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}

function createEmailNotifier({ apiKey, to, from, logger = console, fetch = nodeFetch }) {
  return async function sendEmailAlert(message) {
    const cleaned = stripBold(message);
    const subject = cleaned.split('\n')[0];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ from, to, subject, text: cleaned }),
    });
  };
}

module.exports = { createEmailNotifier };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="createEmailNotifier POSTs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add notifications/email.js notifications/email.test.js
git commit -m "Add email notifier module with Resend happy path"
```

---

## Task 2: Filter — only entry messages trigger fetch

**Files:**
- Modify: `notifications/email.js`
- Modify: `notifications/email.test.js`

- [ ] **Step 1: Add two filter tests**

Append to `notifications/email.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL (they will currently send to Resend because no filter exists).

- [ ] **Step 3: Add prefix guard to implementation**

In `notifications/email.js`, replace the `sendEmailAlert` function body. The file should now read:

```js
const nodeFetch = require('node-fetch');

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}

function createEmailNotifier({ apiKey, to, from, logger = console, fetch = nodeFetch }) {
  return async function sendEmailAlert(message) {
    if (typeof message !== 'string' || !message.startsWith('📥')) return;
    const cleaned = stripBold(message);
    const subject = cleaned.split('\n')[0];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ from, to, subject, text: cleaned }),
    });
  };
}

module.exports = { createEmailNotifier };
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test`
Expected: the 3 tests in `email.test.js` all PASS.

- [ ] **Step 5: Commit**

```bash
git add notifications/email.js notifications/email.test.js
git commit -m "Filter email notifier to entry-prefix (📥) only"
```

---

## Task 3: Missing env var → silent no-op

**Files:**
- Modify: `notifications/email.js`
- Modify: `notifications/email.test.js`

- [ ] **Step 1: Add missing-env-var tests**

Append to `notifications/email.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the 3 new tests FAIL — the current factory returns a function that tries to POST regardless of config.

- [ ] **Step 3: Add env-var guard**

In `notifications/email.js`, add an early-return at the top of the factory. Full file:

```js
const nodeFetch = require('node-fetch');

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}

function createEmailNotifier({ apiKey, to, from, logger = console, fetch = nodeFetch }) {
  if (!apiKey || !to || !from) {
    return async () => {};
  }
  return async function sendEmailAlert(message) {
    if (typeof message !== 'string' || !message.startsWith('📥')) return;
    const cleaned = stripBold(message);
    const subject = cleaned.split('\n')[0];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ from, to, subject, text: cleaned }),
    });
  };
}

module.exports = { createEmailNotifier };
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test`
Expected: all 6 tests in `email.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add notifications/email.js notifications/email.test.js
git commit -m "Silent no-op when Resend env vars are missing"
```

---

## Task 4: Error handling — network + non-2xx, never throw

**Files:**
- Modify: `notifications/email.js`
- Modify: `notifications/email.test.js`

- [ ] **Step 1: Add error-handling tests**

Append to `notifications/email.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the network test FAILS with an uncaught `ECONNREFUSED`. The non-2xx test FAILS because the current code does not check `res.ok`.

- [ ] **Step 3: Add try/catch + status check**

In `notifications/email.js`, wrap the fetch call. Full file:

```js
const nodeFetch = require('node-fetch');

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}

function createEmailNotifier({ apiKey, to, from, logger = console, fetch = nodeFetch }) {
  if (!apiKey || !to || !from) {
    return async () => {};
  }
  return async function sendEmailAlert(message) {
    if (typeof message !== 'string' || !message.startsWith('📥')) return;
    const cleaned = stripBold(message);
    const subject = cleaned.split('\n')[0];
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ from, to, subject, text: cleaned }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.error('[email] resend non-2xx:', res.status, body);
      }
    } catch (err) {
      logger.error('[email] send failed:', err.message);
    }
  };
}

module.exports = { createEmailNotifier };
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test`
Expected: all 8 tests in `email.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add notifications/email.js notifications/email.test.js
git commit -m "Log and swallow Resend network/HTTP errors — never throw"
```

---

## Task 5: Wire the email notifier into index.js

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Read the current wiring**

Open `index.js`. The relevant block (around lines 54–64, 141–146) currently looks like:

```js
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
// ...
const TRADING_ALERTS_CHANNEL_ID = process.env.TRADING_ALERTS_CHANNEL_ID || '';
const PORT               = process.env.PORT || 3000;
// ...
const tradingEngine = createTradingEngine({
  config: loadTradingConfig,
  marketData: tradingMarketData,
  broker: tradingBroker,
  notifier: sendTradingAlert,
});
```

Confirm those blocks exist unchanged before proceeding.

- [ ] **Step 2: Add the require at the top of index.js**

Find the block of top-level `require(...)` statements in `index.js` (the ones that import project modules, e.g. `require('./trading/broker')`, `require('./routes/trading')`, `require('./profit/counter')`). Add this line alongside them:

```js
const { createEmailNotifier } = require('./notifications/email');
```

- [ ] **Step 3: Add the env vars near the other trading env vars**

Find the line:

```js
const TRADING_ALERTS_CHANNEL_ID = process.env.TRADING_ALERTS_CHANNEL_ID || '';
```

Add these three lines immediately after it:

```js
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_TO    = process.env.ALERT_EMAIL_TO || '';
const ALERT_EMAIL_FROM  = process.env.ALERT_EMAIL_FROM || '';
```

- [ ] **Step 4: Create the email notifier + `notifyAll` wrapper**

Find the existing `sendTradingAlert` function (around index.js:127). Right after it ends (after the closing `}` of `async function sendTradingAlert`), add:

```js
const sendEmailAlert = createEmailNotifier({
  apiKey: RESEND_API_KEY,
  to:     ALERT_EMAIL_TO,
  from:   ALERT_EMAIL_FROM,
});

async function notifyAll(message) {
  await sendTradingAlert(message);
  await sendEmailAlert(message);
}
```

- [ ] **Step 5: Change the engine's notifier to notifyAll**

Find:

```js
const tradingEngine = createTradingEngine({
  config: loadTradingConfig,     // function — re-read each call
  marketData: tradingMarketData,
  broker: tradingBroker,
  notifier: sendTradingAlert,
});
```

Change the last field only:

```js
const tradingEngine = createTradingEngine({
  config: loadTradingConfig,     // function — re-read each call
  marketData: tradingMarketData,
  broker: tradingBroker,
  notifier: notifyAll,
});
```

- [ ] **Step 6: Syntax check**

Run: `node --check index.js`
Expected: exits with no output (valid syntax).

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all tests pass (existing + the 8 new ones in `email.test.js`).

- [ ] **Step 8: Smoke-check boot**

Run (no env vars set — email notifier should no-op silently):

```bash
node -e "require('./notifications/email').createEmailNotifier({apiKey:'', to:'', from:''})('📥 test'); console.log('no-op ok')"
```

Expected output: `no-op ok` (no errors, no fetch attempt).

- [ ] **Step 9: Commit**

```bash
git add index.js
git commit -m "Wire email notifier into trading engine alongside Discord"
```

---

## Deployment (manual, user-side — not in this plan's scope)

After merging:
1. Create Resend account at [resend.com](https://resend.com) if not already done.
2. Generate an API key.
3. On Railway → Variables, add:
   - `RESEND_API_KEY=re_...`
   - `ALERT_EMAIL_TO=williammarchand2005@gmail.com`
   - `ALERT_EMAIL_FROM=onboarding@resend.dev`
4. Railway redeploys automatically.
5. Next entry signal → email arrives at the configured address.

If any of the three env vars is missing, the bot behaves exactly as today (Discord alert only, no email, no errors logged).
