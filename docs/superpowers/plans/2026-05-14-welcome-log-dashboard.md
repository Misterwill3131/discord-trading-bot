# Welcome Log Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/welcome-log` dashboard page that mirrors recent events emitted by the welcome listener (sends, errors, boot-time config warnings) — separated from the general Railway log stream.

**Architecture:** Three new small modules — `state/welcome-log.js` (in-memory ring buffer, 100 entries), `pages/welcome-log.js` (HTML renderer), `routes/welcome-log.js` (auth-protected GET route) — plus producer calls from `discord/welcome-listener.js`. Reset on bot restart. Follows the existing `/backup-log` pattern exactly.

**Tech Stack:** Node.js, Express, no DB, no client-side JS. Tests via `node --test` (built-in `node:test`).

**Spec:** [docs/superpowers/specs/2026-05-14-welcome-log-dashboard-design.md](../specs/2026-05-14-welcome-log-dashboard-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `state/welcome-log.js` | Create | Ring buffer (max 100 entries), exposes `appendWelcomeLog`, `getWelcomeLog`, `MAX_ENTRIES`. No HTTP, no Discord, no DB — pure data. |
| `state/welcome-log.test.js` | Create | Unit tests: append behavior, FIFO eviction at MAX_ENTRIES, defensive copy. |
| `discord/welcome-listener.js` | Modify | Call `appendWelcomeLog` at each branch (config-missing, error-channel, error-send, sent). Add `console.log` for sent branch (parity with Railway). |
| `pages/welcome-log.js` | Create | `renderWelcomeLogPage(entries)` → HTML string. Same style as `pages/backup-log.js`. |
| `pages/welcome-log.test.js` | Create | Unit tests: empty state text, populated entries include `username` + `type`. |
| `routes/welcome-log.js` | Create | `registerWelcomeLogRoutes(app, requireAuth)` → wires `GET /welcome-log`. |
| `pages/common.js` | Modify | Add `/welcome-log` entry to `SIDEBAR_LINKS`. |
| `index.js` | Modify | `require` + `registerWelcomeLogRoutes` call next to `registerBackupLogRoutes`. |

---

## Task 1: Ring buffer state module (TDD)

Build the in-memory ring buffer first. Pure data, easy to test, no dependencies.

**Files:**
- Create: `state/welcome-log.js`
- Create: `state/welcome-log.test.js`

- [ ] **Step 1: Write the failing tests**

Create `state/welcome-log.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { appendWelcomeLog, getWelcomeLog, MAX_ENTRIES, _resetForTests } = require('./welcome-log');

test('MAX_ENTRIES is 100', () => {
  assert.strictEqual(MAX_ENTRIES, 100);
});

test('appendWelcomeLog stores entry and auto-fills ts when missing', () => {
  _resetForTests();
  appendWelcomeLog({ type: 'sent', userId: '111', username: 'Alice', detail: null });
  const log = getWelcomeLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].type, 'sent');
  assert.strictEqual(log[0].userId, '111');
  assert.strictEqual(log[0].username, 'Alice');
  assert.strictEqual(log[0].detail, null);
  assert.match(log[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ts should be auto-filled ISO');
});

test('appendWelcomeLog preserves explicit ts when provided', () => {
  _resetForTests();
  const explicit = '2026-05-14T12:00:00.000Z';
  appendWelcomeLog({ ts: explicit, type: 'sent', userId: '1', username: 'A', detail: null });
  assert.strictEqual(getWelcomeLog()[0].ts, explicit);
});

test('appendWelcomeLog evicts oldest when exceeding MAX_ENTRIES (FIFO)', () => {
  _resetForTests();
  for (let i = 0; i < 150; i++) {
    appendWelcomeLog({ type: 'sent', userId: String(i), username: 'u' + i, detail: null });
  }
  const log = getWelcomeLog();
  assert.strictEqual(log.length, 100, 'should cap at MAX_ENTRIES');
  assert.strictEqual(log[0].userId, '50', 'first 50 should be evicted');
  assert.strictEqual(log[99].userId, '149', 'last entry should be the most recent push');
});

test('getWelcomeLog returns a defensive copy (mutating return does not affect internal state)', () => {
  _resetForTests();
  appendWelcomeLog({ type: 'sent', userId: '1', username: 'A', detail: null });
  const copy = getWelcomeLog();
  copy.push({ type: 'sent', userId: '999', username: 'X', detail: null });
  assert.strictEqual(getWelcomeLog().length, 1, 'internal buffer unchanged');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test state/welcome-log.test.js`

Expected: FAIL with `Cannot find module './welcome-log'` (file doesn't exist yet).

- [ ] **Step 3: Create the state module**

Create `state/welcome-log.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// state/welcome-log.js — Ring buffer for welcome listener events
// ─────────────────────────────────────────────────────────────────────
// 100 dernières entries gardées en mémoire, reset au restart du bot.
// Produits par discord/welcome-listener.js, consommés par
// routes/welcome-log.js + pages/welcome-log.js.
//
// Spec : docs/superpowers/specs/2026-05-14-welcome-log-dashboard-design.md
// ─────────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 100;
let buffer = [];

function appendWelcomeLog(entry) {
  buffer.push({ ...entry, ts: entry.ts || new Date().toISOString() });
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
}

function getWelcomeLog() {
  return buffer.slice();
}

// Test-only helper to isolate tests that share the singleton.
function _resetForTests() {
  buffer = [];
}

module.exports = { appendWelcomeLog, getWelcomeLog, MAX_ENTRIES, _resetForTests };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test state/welcome-log.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add state/welcome-log.js state/welcome-log.test.js
git commit -m "feat(welcome-log): in-memory ring buffer (100 entries, FIFO)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire producer calls in `discord/welcome-listener.js`

Add `appendWelcomeLog` calls at the 4 outcome branches, and add a `console.log` for the sent branch so Railway has parity with the dashboard.

**Files:**
- Modify: `discord/welcome-listener.js`

- [ ] **Step 1: Add the require at the top of the module**

Open `discord/welcome-listener.js`. Find the existing header block (lines 1–13). Immediately AFTER the header comment block (after line 13), and BEFORE `function formatWelcomeMessage`, add:

```javascript
const { appendWelcomeLog } = require('../state/welcome-log');
```

- [ ] **Step 2: Add `appendWelcomeLog` call in the config-missing branch**

Find the `if (!guildId || !subscriberRoleId || ...)` block (around line 38–41). Replace it with:

```javascript
  if (!guildId || !subscriberRoleId || !welcomeChannelId || !startHereChannelId) {
    const missing = [
      !guildId            && 'TOB_WELCOME_GUILD_ID',
      !subscriberRoleId   && 'TOB_SUBSCRIBER_ROLE_ID',
      !welcomeChannelId   && 'TOB_WELCOME_CHANNEL_ID',
      !startHereChannelId && 'TOB_START_HERE_CHANNEL_ID',
    ].filter(Boolean).join(', ');
    console.warn('[welcome] missing config — disabled (need ' + missing + ')');
    appendWelcomeLog({ type: 'config-missing', userId: null, username: null, detail: missing });
    return;
  }
```

(The change: build a `missing` string listing only the empty fields, log it, append it to the dashboard buffer.)

- [ ] **Step 3: Add `appendWelcomeLog` calls inside the handler**

Find the `client.on('guildMemberUpdate', ...)` handler (around line 43–56). Replace the entire handler body with:

```javascript
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (!shouldWelcome(oldMember, newMember, { roleId: subscriberRoleId, guildId })) return;
    const userId = newMember.user.id;
    const username = newMember.user.tag || newMember.user.username || null;
    try {
      const ch = await client.channels.fetch(welcomeChannelId);
      if (!ch || !ch.isTextBased || !ch.isTextBased()) {
        const detail = 'channel ' + welcomeChannelId + ' not text-based or not found';
        console.error('[welcome] ' + detail);
        appendWelcomeLog({ type: 'error-channel', userId, username, detail });
        return;
      }
      const msg = formatWelcomeMessage(userId, startHereChannelId);
      await ch.send(msg);
      console.log('[welcome] sent to ' + userId);
      appendWelcomeLog({ type: 'sent', userId, username, detail: null });
    } catch (err) {
      console.error('[welcome] send failed:', err.message);
      appendWelcomeLog({ type: 'error-send', userId, username, detail: err.message });
    }
  });
```

(Changes: capture `userId` and `username` once at the top of the handler, add `appendWelcomeLog` at each of the 3 handler outcomes, add `console.log` on success.)

- [ ] **Step 4: Run existing tests to confirm no regression**

The 12 existing tests in `discord/welcome-listener.test.js` cover the pure functions (`shouldWelcome`, `formatWelcomeMessage`) and `registerWelcomeListener`'s subscription mechanics. None of them exercise the handler's outcomes, so they should still pass without modification.

Run: `node --test discord/welcome-listener.test.js`

Expected: All 12 tests PASS.

- [ ] **Step 5: Run state/welcome-log tests too (sanity)**

Run: `node --test state/welcome-log.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 6: Verify `node --check` still passes**

Run: `node --check discord/welcome-listener.js`

Expected: No output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add discord/welcome-listener.js
git commit -m "feat(welcome-log): listener records each outcome in ring buffer

Adds appendWelcomeLog calls in all 4 branches (config-missing,
error-channel, error-send, sent) plus a [welcome] sent console.log
for Railway parity.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Page renderer `pages/welcome-log.js` (TDD)

Build the HTML renderer in isolation, with smoke tests for empty-state and populated-state.

**Files:**
- Create: `pages/welcome-log.js`
- Create: `pages/welcome-log.test.js`

- [ ] **Step 1: Write failing tests**

Create `pages/welcome-log.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { renderWelcomeLogPage } = require('./welcome-log');

test('renderWelcomeLogPage with empty array includes empty-state text', () => {
  const html = renderWelcomeLogPage([]);
  assert.ok(html.includes('Aucun événement'), 'should mention empty state in French');
  assert.ok(html.includes('<table'), 'should still include the table skeleton');
});

test('renderWelcomeLogPage includes username and type for each entry', () => {
  const entries = [
    { ts: '2026-05-14T12:00:00.000Z', type: 'sent', userId: '111', username: 'Alice#0001', detail: null },
    { ts: '2026-05-14T12:01:00.000Z', type: 'error-send', userId: '222', username: 'Bob#0002', detail: 'Missing Permissions' },
  ];
  const html = renderWelcomeLogPage(entries);
  assert.ok(html.includes('Alice#0001'), 'should include first username');
  assert.ok(html.includes('Bob#0002'), 'should include second username');
  assert.ok(html.includes('sent'), 'should include "sent" type');
  assert.ok(html.includes('error-send'), 'should include "error-send" type');
  assert.ok(html.includes('Missing Permissions'), 'should include error detail');
});

test('renderWelcomeLogPage escapes HTML in user-controlled fields', () => {
  const entries = [
    { ts: '2026-05-14T12:00:00.000Z', type: 'error-send', userId: '1', username: '<script>x</script>', detail: '<img src=x>' },
  ];
  const html = renderWelcomeLogPage(entries);
  assert.ok(!html.includes('<script>x</script>'), 'should not emit raw <script>');
  assert.ok(!html.includes('<img src=x>'), 'should not emit raw <img>');
  assert.ok(html.includes('&lt;script&gt;'), 'should HTML-escape <script>');
});

test('renderWelcomeLogPage handles null username gracefully (config-missing entries)', () => {
  const entries = [
    { ts: '2026-05-14T12:00:00.000Z', type: 'config-missing', userId: null, username: null, detail: 'TOB_WELCOME_GUILD_ID' },
  ];
  const html = renderWelcomeLogPage(entries);
  assert.ok(html.includes('config-missing'));
  assert.ok(html.includes('TOB_WELCOME_GUILD_ID'));
  // Should not throw, should produce a valid row
  assert.ok(html.includes('<tr'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pages/welcome-log.test.js`

Expected: FAIL — `Cannot find module './welcome-log'`.

- [ ] **Step 3: Create the renderer**

Create `pages/welcome-log.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// pages/welcome-log.js — Page dashboard /welcome-log
// ─────────────────────────────────────────────────────────────────────
// Affiche les 100 derniers événements du welcome listener (sends + erreurs
// + config-missing au boot). Lit l'état mémoire depuis state/welcome-log.
// Reset au restart du bot — pour de l'historique long terme, regarder
// Railway logs filtré sur "[welcome]".
//
// Spec : docs/superpowers/specs/2026-05-14-welcome-log-dashboard-design.md
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('sv-SE', { timeZone: 'America/New_York', hour12: false });
}

function typeChip(type) {
  const cls = type === 'sent' ? 'chip-ok'
    : type === 'config-missing' ? 'chip-warn'
    : 'chip-err';
  return '<span class="chip ' + cls + '">' + escHtml(type) + '</span>';
}

function userCell(entry) {
  if (!entry.userId && !entry.username) return '<span class="empty">—</span>';
  const name = entry.username ? escHtml(entry.username) : '';
  const id = entry.userId ? '<span class="uid">' + escHtml(entry.userId) + '</span>' : '';
  return name + (name && id ? ' ' : '') + id;
}

function renderWelcomeLogPage(entries) {
  // Most recent first
  const reversed = entries.slice().reverse();
  const rows = !reversed.length
    ? '<tr><td colspan="4" class="empty">Aucun événement welcome depuis le démarrage du bot.</td></tr>'
    : reversed.map(e => (
        '<tr>'
        + '<td class="ts">' + fmtTs(e.ts) + '</td>'
        + '<td class="type">' + typeChip(e.type) + '</td>'
        + '<td class="user">' + userCell(e) + '</td>'
        + '<td class="detail">' + (e.detail ? escHtml(e.detail) : '<span class="empty">—</span>') + '</td>'
        + '</tr>'
      )).join('');

  const counts = reversed.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  const summary = reversed.length
    ? (counts['sent'] || 0) + ' sent / ' + ((counts['error-channel'] || 0) + (counts['error-send'] || 0)) + ' error(s) sur les ' + reversed.length + ' derniers événements'
    : '—';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Welcome Log</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 16px; max-width: 1200px; }
  .summary { font-size: 13px; color: #a0a0b0; }
  .summary strong { color: #fafafa; }
  .note { background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.2); color: #c7d2fe; border-radius: 8px; padding: 12px 16px; font-size: 12px; line-height: 1.5; }
  .note code { background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #e0e7ff; }
  table.welcome-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.welcome-table th { text-align: left; background: rgba(139,92,246,0.1); color: #c4b5fd; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  table.welcome-table td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  table.welcome-table td.ts { font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #e3e5e8; white-space: nowrap; }
  td.type { width: 130px; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .chip-ok   { background: rgba(59,165,93,0.15);  color: #6ee7b7; }
  .chip-err  { background: rgba(237,66,69,0.15);  color: #f87171; }
  .chip-warn { background: rgba(250,166,26,0.15); color: #fbbf24; }
  td.user .uid { color: #80848e; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 11px; }
  td.detail { color: #c5c8ce; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-word; }
  td.empty, .empty { color: #4f545c; }
  td.empty { text-align: center; font-style: italic; padding: 30px !important; }
</style>
</head>
<body>
${sidebarHTML('/welcome-log')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Welcome Log</h1>
  <span class="summary" style="margin-left:auto;">${summary}</span>
</div>
<div id="wrap">
  <div class="note">
    <strong>Rétention :</strong> 100 derniers événements en mémoire — reset au restart du bot.
    Pour l'historique long terme, filtre Railway logs sur <code>[welcome]</code>.
    Types : <code>sent</code> = welcome posté, <code>error-channel</code> / <code>error-send</code> = échec Discord API, <code>config-missing</code> = vars d'env manquantes au boot.
  </div>
  <div class="card" style="padding: 0;">
    <table class="welcome-table">
      <thead>
        <tr><th>Date (NY)</th><th>Type</th><th>User</th><th>Détail</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</div>
</div>
</body>
</html>`;
}

module.exports = { renderWelcomeLogPage };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test pages/welcome-log.test.js`

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pages/welcome-log.js pages/welcome-log.test.js
git commit -m "feat(welcome-log): HTML renderer for /welcome-log dashboard page

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route `routes/welcome-log.js`

Trivial 1:1 with `routes/backup-log.js` — auth-gated GET that pipes the buffer to the renderer.

**Files:**
- Create: `routes/welcome-log.js`

- [ ] **Step 1: Create the route module**

Create `routes/welcome-log.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// routes/welcome-log.js — GET /welcome-log
// ─────────────────────────────────────────────────────────────────────
// Lit l'état mémoire du welcome listener (state/welcome-log) à chaque
// requête et rend un tableau HTML. Auth-protégé via requireAuth.
// ─────────────────────────────────────────────────────────────────────

const { renderWelcomeLogPage } = require('../pages/welcome-log');
const { getWelcomeLog } = require('../state/welcome-log');

function registerWelcomeLogRoutes(app, requireAuth) {
  app.get('/welcome-log', requireAuth, (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(renderWelcomeLogPage(getWelcomeLog()));
  });
}

module.exports = { registerWelcomeLogRoutes };
```

- [ ] **Step 2: Verify syntax**

Run: `node --check routes/welcome-log.js`

Expected: No output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add routes/welcome-log.js
git commit -m "feat(welcome-log): Express route GET /welcome-log (auth-protected)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire into `index.js` + sidebar link

Mount the route on the Express app and surface the page in the sidebar.

**Files:**
- Modify: `index.js`
- Modify: `pages/common.js`

- [ ] **Step 1: Add the require at the top of `index.js`**

Open `index.js`. Find the line:

```javascript
const { registerBackupLogRoutes } = require('./routes/backup-log');
```

Immediately AFTER it, add:

```javascript
const { registerWelcomeLogRoutes } = require('./routes/welcome-log');
```

- [ ] **Step 2: Add the register call in `index.js`**

Find the line:

```javascript
registerBackupLogRoutes(app, requireAuth);
```

Immediately AFTER it, add:

```javascript
registerWelcomeLogRoutes(app, requireAuth);
```

- [ ] **Step 3: Add sidebar link in `pages/common.js`**

Open `pages/common.js`. Find the `SIDEBAR_LINKS` array (around line 76–90). Find this line:

```javascript
  { href: '/backup-log',      icon: '💾', label: 'Backup Log' },
```

Immediately AFTER it (before the `Config` entry), add:

```javascript
  { href: '/welcome-log',     icon: '👋', label: 'Welcome Log' },
```

- [ ] **Step 4: Verify syntax on both files**

Run: `node --check index.js && node --check pages/common.js`

Expected: No output (exit 0).

- [ ] **Step 5: Run the full test suite**

Run: `node --test`

Expected: All previously-passing tests still pass. New welcome-log tests pass (9 total: 5 state + 4 page). Pre-existing failures in `services/llm-classify.test.js` and `video/scripts/test-tts-voice.js` are unrelated and unchanged.

- [ ] **Step 6: Commit**

```bash
git add index.js pages/common.js
git commit -m "feat(welcome-log): wire route + sidebar link

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full test suite green**

Run: `node --test 2>&1 | tail -10`

Expected: pass count increased by 9 (5 state + 4 page) vs. pre-Task-1 baseline. Same 2 pre-existing failures (`services/llm-classify.test.js` Windows SQLite EBUSY, `video/scripts/test-tts-voice.js`).

- [ ] **Step 2: Boot smoke check**

Run: `node --check index.js`

Expected: No output.

- [ ] **Step 3: Print user-facing summary**

Print to the user:

```
✅ /welcome-log dashboard ready. After redeploy:

- Visit https://<your-railway-domain>/welcome-log (auth-protected by DASHBOARD_PASSWORD)
- You'll see entries for every welcome posted + any errors + any boot-time config-missing
- Resets when the bot restarts; 100 most recent events kept
- Railway logs still get the same [welcome] prefixed lines for long-term history

Trigger a real entry by attributing the subscriber role to a test account in the TOB server.
```

---

## Out of scope (per spec section 9)

- Persistence (SQLite, file)
- Filters / search on the page
- Export (CSV, JSON)
- Pagination
- Clear-log button
- Notifications to Discord channel or email
- Custom auth model (reuses `requireAuth`)
