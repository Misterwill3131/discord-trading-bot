# Welcome Message Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the welcome message text editable from the `/welcome-log` dashboard, using a `{user}` / `{start_here}` placeholder template stored in the settings KV.

**Architecture:** A new `discord/welcome-template.js` module owns the default constant, the substitution function (`applyTemplate`), the validation rules, and the DB-backed get/set/reset. The listener calls `getEffectiveTemplate()` + `applyTemplate()` at send time. The route gets three new JSON endpoints (`GET/PUT/DELETE /api/welcome-message`). The page gets a "Template" card at the top with textarea + preview + Save/Reset buttons, wired to the API by a small inline script.

**Tech Stack:** Node.js, Express, SQLite (existing `settings` KV via `db.getSetting`/`setSetting`). Tests via `node:test`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-14-welcome-message-editor-design.md](../specs/2026-05-14-welcome-message-editor-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `discord/welcome-template.js` | Create | Sole owner of template logic: `DEFAULT_WELCOME_TEMPLATE`, `applyTemplate`, `validateTemplate`, `getEffectiveTemplate`, `setTemplate`, `resetTemplate`. No discord.js deps. |
| `discord/welcome-template.test.js` | Create | Unit tests for the 6 exports. Cleans up DB state with `setSetting(key, null)`. |
| `discord/welcome-listener.js` | Modify | Import from `welcome-template`. Rewrite `formatWelcomeMessage` as a thin wrapper. Replace inline message build in the handler with `applyTemplate(getEffectiveTemplate().template, ...)`. |
| `routes/welcome-log.js` | Modify | Add 3 JSON endpoints: `GET/PUT/DELETE /api/welcome-message`. Pass current template into the page renderer. |
| `pages/welcome-log.js` | Modify | Accept an optional `{ template, isDefault }` arg, render a Template card at the top with textarea + placeholders doc + static preview + Save/Reset buttons + inline `<script>` for client-side wiring. |
| `pages/welcome-log.test.js` | Modify | Extend with 2 new tests: textarea pre-fill, preview substitution. Existing 4 tests stay green. |

---

## Task 1: Pure helpers in `discord/welcome-template.js` (TDD)

Build the pure, no-DB functions first: the default constant, `applyTemplate`, and `validateTemplate`. These have no side effects and are trivially testable.

**Files:**
- Create: `discord/welcome-template.js`
- Create: `discord/welcome-template.test.js`

- [ ] **Step 1: Write failing tests**

Create `discord/welcome-template.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_WELCOME_TEMPLATE,
  applyTemplate,
  validateTemplate,
} = require('./welcome-template');

test('DEFAULT_WELCOME_TEMPLATE contains both placeholders', () => {
  assert.ok(DEFAULT_WELCOME_TEMPLATE.includes('{user}'));
  assert.ok(DEFAULT_WELCOME_TEMPLATE.includes('{start_here}'));
});

test('applyTemplate substitutes both placeholders', () => {
  const out = applyTemplate('{user} hi, see {start_here}', { userId: '1', startHereId: '2' });
  assert.strictEqual(out, '<@1> hi, see <#2>');
});

test('applyTemplate substitutes multiple occurrences of {user}', () => {
  const out = applyTemplate('{user} {user} {user}', { userId: '9', startHereId: '0' });
  assert.strictEqual(out, '<@9> <@9> <@9>');
});

test('applyTemplate leaves unknown {foo} placeholders unchanged', () => {
  const out = applyTemplate('{user} {foo} {bar}', { userId: '1', startHereId: '2' });
  assert.strictEqual(out, '<@1> {foo} {bar}');
});

test('applyTemplate on the default template produces today\'s exact wire format', () => {
  const out = applyTemplate(DEFAULT_WELCOME_TEMPLATE, { userId: '111', startHereId: '222' });
  assert.strictEqual(
    out,
    '<@111> welcome to TOB! Please start with <#222> and watch us for a week or so to get familiar with the discord.'
  );
});

test('validateTemplate accepts the default template', () => {
  assert.deepStrictEqual(validateTemplate(DEFAULT_WELCOME_TEMPLATE), { ok: true });
});

test('validateTemplate rejects empty string', () => {
  const r = validateTemplate('');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /empty|vide/i);
});

test('validateTemplate rejects whitespace-only string', () => {
  const r = validateTemplate('   \n\t  ');
  assert.strictEqual(r.ok, false);
});

test('validateTemplate rejects template without {user}', () => {
  const r = validateTemplate('Hello and welcome! See {start_here} for more.');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /\{user\}/);
});

test('validateTemplate accepts template without {start_here}', () => {
  assert.deepStrictEqual(validateTemplate('{user} hi there!'), { ok: true });
});

test('validateTemplate rejects text > 2000 chars', () => {
  const long = '{user} ' + 'x'.repeat(2000);
  const r = validateTemplate(long);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /2000/);
});

test('validateTemplate rejects non-string input', () => {
  assert.strictEqual(validateTemplate(null).ok, false);
  assert.strictEqual(validateTemplate(undefined).ok, false);
  assert.strictEqual(validateTemplate(42).ok, false);
  assert.strictEqual(validateTemplate({}).ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/welcome-template.test.js`
Expected: FAIL with `Cannot find module './welcome-template'`.

- [ ] **Step 3: Create the module with the 3 pure functions**

Create `discord/welcome-template.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// discord/welcome-template.js — Template du message de bienvenue
// ─────────────────────────────────────────────────────────────────────
// Single source of truth pour le template welcome :
//   - DEFAULT_WELCOME_TEMPLATE : valeur par défaut (fallback DB-absent)
//   - applyTemplate(text, vars) : substitution {user}/{start_here}
//   - validateTemplate(text)    : règles serveur-side avant set
//   - getEffectiveTemplate()    : lit la setting, fallback default
//   - setTemplate(text)         : valide puis écrit
//   - resetTemplate()           : efface l'override (retour au default)
//
// Aucune dépendance discord.js — le listener importe d'ici, pas
// l'inverse. La DB est touchée seulement par les 3 fonctions du bas.
//
// Spec : docs/superpowers/specs/2026-05-14-welcome-message-editor-design.md
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_WELCOME_TEMPLATE =
  '{user} welcome to TOB! Please start with {start_here} and watch us for a week or so to get familiar with the discord.';

// Pure: substitute all occurrences of {user} and {start_here}. Unknown
// placeholders pass through verbatim (Discord will render them as text).
function applyTemplate(template, { userId, startHereId }) {
  return String(template == null ? '' : template)
    .split('{user}').join('<@' + userId + '>')
    .split('{start_here}').join('<#' + startHereId + '>');
}

// Server-side validation. Returns { ok: true } or { ok: false, error }.
function validateTemplate(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Le template doit être une chaîne de caractères.' };
  if (!text.trim()) return { ok: false, error: 'Le template ne peut pas être vide.' };
  if (text.length > 2000) return { ok: false, error: 'Le template dépasse la limite Discord de 2000 caractères.' };
  if (!text.includes('{user}')) return { ok: false, error: 'Le template doit contenir {user} pour ping le nouveau membre.' };
  return { ok: true };
}

module.exports = {
  DEFAULT_WELCOME_TEMPLATE,
  applyTemplate,
  validateTemplate,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/welcome-template.test.js`
Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add discord/welcome-template.js discord/welcome-template.test.js
git commit -m "feat(welcome-template): pure helpers — default + applyTemplate + validateTemplate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: DB-backed get/set/reset (TDD)

Add the persistence layer in the SAME module. These functions touch `db.getSetting`/`setSetting`. The setting key is `'welcome_message_template'`.

**Files:**
- Modify: `discord/welcome-template.js`
- Modify: `discord/welcome-template.test.js`

- [ ] **Step 1: Append failing tests**

Append to `discord/welcome-template.test.js`:

```javascript
const { getEffectiveTemplate, setTemplate, resetTemplate, SETTING_KEY } = require('./welcome-template');
const db = require('../db/sqlite');

// Helper: reset state before each persistence test.
function resetSetting() {
  db.setSetting(SETTING_KEY, null);
}

test('SETTING_KEY is "welcome_message_template"', () => {
  assert.strictEqual(SETTING_KEY, 'welcome_message_template');
});

test('getEffectiveTemplate returns the default when setting is absent', () => {
  resetSetting();
  const r = getEffectiveTemplate();
  assert.strictEqual(r.template, DEFAULT_WELCOME_TEMPLATE);
  assert.strictEqual(r.isDefault, true);
});

test('setTemplate writes and getEffectiveTemplate reads it back as override', () => {
  resetSetting();
  setTemplate('{user} hello world!');
  const r = getEffectiveTemplate();
  assert.strictEqual(r.template, '{user} hello world!');
  assert.strictEqual(r.isDefault, false);
});

test('setTemplate throws on invalid input (missing {user})', () => {
  resetSetting();
  assert.throws(() => setTemplate('Bonjour sans placeholder'), /\{user\}/);
});

test('setTemplate throws on empty input', () => {
  resetSetting();
  assert.throws(() => setTemplate(''), /vide/i);
});

test('resetTemplate clears the override and getEffectiveTemplate returns the default again', () => {
  resetSetting();
  setTemplate('{user} override here');
  assert.strictEqual(getEffectiveTemplate().isDefault, false);
  resetTemplate();
  const r = getEffectiveTemplate();
  assert.strictEqual(r.template, DEFAULT_WELCOME_TEMPLATE);
  assert.strictEqual(r.isDefault, true);
});

test('getEffectiveTemplate treats null/empty stored value as missing (fallback to default)', () => {
  resetSetting();
  // Direct DB write of null and empty to simulate edge cases
  db.setSetting(SETTING_KEY, null);
  assert.strictEqual(getEffectiveTemplate().isDefault, true);
  db.setSetting(SETTING_KEY, '');
  assert.strictEqual(getEffectiveTemplate().isDefault, true);
});

// Cleanup after this file's tests so we don't leave state for other test files.
test('cleanup: reset setting', () => {
  resetSetting();
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test discord/welcome-template.test.js`
Expected: The 12 pure tests still pass. The 8 new tests FAIL — initially `getEffectiveTemplate`, `setTemplate`, `resetTemplate`, `SETTING_KEY` are `undefined` so the require destructure produces `undefined`, and calls error with `is not a function`.

- [ ] **Step 3: Implement the DB-backed functions**

In `discord/welcome-template.js`, BEFORE `module.exports`, add:

```javascript
const db = require('../db/sqlite');

const SETTING_KEY = 'welcome_message_template';

// Returns { template, isDefault }. Treats null, '', and missing all as
// "no override" (fallback to default).
function getEffectiveTemplate() {
  const stored = db.getSetting(SETTING_KEY, null);
  if (typeof stored !== 'string' || !stored.trim()) {
    return { template: DEFAULT_WELCOME_TEMPLATE, isDefault: true };
  }
  return { template: stored, isDefault: false };
}

// Validates then writes. Throws if validation fails. Caller is responsible
// for catching and surfacing the error message.
function setTemplate(text) {
  const v = validateTemplate(text);
  if (!v.ok) {
    const err = new Error(v.error);
    err.code = 'INVALID_TEMPLATE';
    throw err;
  }
  db.setSetting(SETTING_KEY, text);
}

// Clears the override. Future getEffectiveTemplate calls return the default.
function resetTemplate() {
  db.setSetting(SETTING_KEY, null);
}
```

And update the `module.exports` block at the bottom to:

```javascript
module.exports = {
  DEFAULT_WELCOME_TEMPLATE,
  SETTING_KEY,
  applyTemplate,
  validateTemplate,
  getEffectiveTemplate,
  setTemplate,
  resetTemplate,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/welcome-template.test.js`
Expected: All 20 tests PASS (12 pure + 8 DB-backed).

- [ ] **Step 5: Commit**

```bash
git add discord/welcome-template.js discord/welcome-template.test.js
git commit -m "feat(welcome-template): DB-backed get/set/reset via settings KV

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire `welcome-template` into `discord/welcome-listener.js`

Replace the hardcoded message string with a runtime call to `getEffectiveTemplate()` + `applyTemplate()`. Keep `formatWelcomeMessage` exported (the existing 12 tests depend on it).

**Files:**
- Modify: `discord/welcome-listener.js`

- [ ] **Step 1: Add the import**

At the top of `discord/welcome-listener.js`, after the existing `const { appendWelcomeLog } = require('../state/welcome-log');` line, add:

```javascript
const {
  DEFAULT_WELCOME_TEMPLATE,
  applyTemplate,
  getEffectiveTemplate,
} = require('./welcome-template');
```

- [ ] **Step 2: Rewrite `formatWelcomeMessage` as a thin wrapper**

The current `formatWelcomeMessage` is:

```javascript
function formatWelcomeMessage(userId, startHereChannelId) {
  return `<@${userId}> welcome to TOB! Please start with <#${startHereChannelId}> and watch us for a week or so to get familiar with the discord.`;
}
```

Replace it entirely with:

```javascript
function formatWelcomeMessage(userId, startHereChannelId) {
  return applyTemplate(DEFAULT_WELCOME_TEMPLATE, { userId, startHereId: startHereChannelId });
}
```

(The existing 12 tests pass because `applyTemplate(DEFAULT, ...)` produces the exact same string.)

- [ ] **Step 3: Use the effective template in the handler**

In the handler block, find this section:

```javascript
      const msg = formatWelcomeMessage(userId, startHereChannelId);
      await ch.send(msg);
      console.log('[welcome] sent to ' + userId);
      appendWelcomeLog({ type: 'sent', userId, username, detail: null });
```

Replace it with:

```javascript
      const { template } = getEffectiveTemplate();
      const msg = applyTemplate(template, { userId, startHereId: startHereChannelId });
      await ch.send(msg);
      console.log('[welcome] sent to ' + userId);
      appendWelcomeLog({ type: 'sent', userId, username, detail: null });
```

(The handler now reads the override at every send — operators see edits take effect on the very next welcome without a restart.)

- [ ] **Step 4: Run existing tests to confirm no regression**

Run: `node --test discord/welcome-listener.test.js`
Expected: All 12 tests PASS. The `formatWelcomeMessage` test passes because the default template produces the same string as the old hardcoded function.

- [ ] **Step 5: Run welcome-template tests too**

Run: `node --test discord/welcome-template.test.js`
Expected: All 20 tests PASS.

- [ ] **Step 6: Verify syntax**

Run: `node --check discord/welcome-listener.js`
Expected: No output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add discord/welcome-listener.js
git commit -m "feat(welcome-template): listener reads template from DB at send time

formatWelcomeMessage becomes a thin wrapper using DEFAULT_WELCOME_TEMPLATE,
preserving its existing wire output. The handler now calls
getEffectiveTemplate() per send so operator edits take effect immediately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add API endpoints in `routes/welcome-log.js`

Add three JSON endpoints (`GET/PUT/DELETE /api/welcome-message`) plus update `GET /welcome-log` to pass the effective template into the page renderer.

**Files:**
- Modify: `routes/welcome-log.js`

- [ ] **Step 1: Replace the module's contents with the extended version**

The current file (19 lines) is a simple wrapper. Replace it ENTIRELY with:

```javascript
// ─────────────────────────────────────────────────────────────────────
// routes/welcome-log.js — GET /welcome-log + API /api/welcome-message
// ─────────────────────────────────────────────────────────────────────
//   GET    /welcome-log              — page HTML (auth)
//   GET    /api/welcome-message      — { ok, template, default, isDefault } (auth)
//   PUT    /api/welcome-message      — body { template } → { ok } | { ok:false, error } (auth)
//   DELETE /api/welcome-message      — reset to default → { ok } (auth)
// ─────────────────────────────────────────────────────────────────────

const { renderWelcomeLogPage } = require('../pages/welcome-log');
const { getWelcomeLog } = require('../state/welcome-log');
const {
  DEFAULT_WELCOME_TEMPLATE,
  getEffectiveTemplate,
  setTemplate,
  resetTemplate,
} = require('../discord/welcome-template');

function registerWelcomeLogRoutes(app, requireAuth) {
  // Page HTML.
  app.get('/welcome-log', requireAuth, (_req, res) => {
    const tpl = getEffectiveTemplate();
    res.set('Content-Type', 'text/html');
    res.send(renderWelcomeLogPage(getWelcomeLog(), tpl));
  });

  // Read current template.
  app.get('/api/welcome-message', requireAuth, (_req, res) => {
    const tpl = getEffectiveTemplate();
    res.json({
      ok: true,
      template: tpl.template,
      default: DEFAULT_WELCOME_TEMPLATE,
      isDefault: tpl.isDefault,
    });
  });

  // Write a new template.
  app.put('/api/welcome-message', requireAuth, (req, res) => {
    const text = req.body && req.body.template;
    try {
      setTemplate(text);
      res.json({ ok: true });
    } catch (err) {
      // setTemplate throws Error with .code='INVALID_TEMPLATE' for validation failures.
      const status = err.code === 'INVALID_TEMPLATE' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // Reset to default.
  app.delete('/api/welcome-message', requireAuth, (_req, res) => {
    resetTemplate();
    res.json({ ok: true });
  });
}

module.exports = { registerWelcomeLogRoutes };
```

Note: `renderWelcomeLogPage` now receives a second argument `tpl` of shape `{ template, isDefault }`. The page module (Task 5) makes this argument optional with a sensible default so existing tests pass.

- [ ] **Step 2: Verify syntax**

Run: `node --check routes/welcome-log.js`
Expected: No output.

- [ ] **Step 3: Verify express.json middleware is mounted in index.js**

The PUT endpoint reads `req.body.template`, so `app.use(express.json())` must be active. It is — see `index.js` line ~123: `app.use(express.json());`. No changes needed in `index.js`.

- [ ] **Step 4: Commit**

```bash
git add routes/welcome-log.js
git commit -m "feat(welcome-template): API endpoints GET/PUT/DELETE /api/welcome-message

Auth-protected JSON endpoints to read, override, and reset the welcome
template from the dashboard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Template card UI in `pages/welcome-log.js`

Extend the page renderer to accept the current template, render a Template card at the top with textarea + placeholder doc + static preview + Save/Reset buttons, and ship an inline client-side script that wires the buttons to the API.

**Files:**
- Modify: `pages/welcome-log.js`
- Modify: `pages/welcome-log.test.js`

- [ ] **Step 1: Append new failing tests**

Append to `pages/welcome-log.test.js`:

```javascript
test('renderWelcomeLogPage pre-fills textarea with the provided template', () => {
  const tpl = { template: '{user} bonjour, voir {start_here}', isDefault: false };
  const html = renderWelcomeLogPage([], tpl);
  // Textarea content (between <textarea ...> and </textarea>)
  assert.ok(html.includes('{user} bonjour, voir {start_here}'),
    'should render the override template inside the textarea');
});

test('renderWelcomeLogPage renders a preview substituting @newuser and #🚩│start-here', () => {
  const tpl = { template: '{user} welcome! Read {start_here}.', isDefault: false };
  const html = renderWelcomeLogPage([], tpl);
  assert.ok(html.includes('@newuser welcome! Read #🚩│start-here.'),
    'preview should substitute both placeholders with example values');
});

test('renderWelcomeLogPage shows "default" badge when isDefault is true', () => {
  const tpl = { template: 'whatever', isDefault: true };
  const html = renderWelcomeLogPage([], tpl);
  assert.ok(html.toLowerCase().includes('default'),
    'should indicate the template is the default');
});

test('renderWelcomeLogPage HTML-escapes the template before injecting into textarea', () => {
  const tpl = { template: '{user} <script>alert(1)</script>', isDefault: false };
  const html = renderWelcomeLogPage([], tpl);
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'should not emit raw <script>');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'should HTML-escape the script tag in both textarea and preview');
});

test('renderWelcomeLogPage uses default template when called with no second arg (backward compat)', () => {
  // The existing 4 tests call renderWelcomeLogPage(entries) with one arg.
  // This case must not throw.
  const html = renderWelcomeLogPage([]);
  assert.ok(html.includes('<textarea'), 'textarea should still render');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test pages/welcome-log.test.js`
Expected: The existing 4 tests still pass. The 5 new tests FAIL (no `<textarea`, no preview substitution, etc.).

- [ ] **Step 3: Read the current `pages/welcome-log.js` end-to-end**

You need to add a "Template" card above the existing note block. Read the current file once to confirm where the markers are.

- [ ] **Step 4: Update the function signature and add the Template card**

In `pages/welcome-log.js`:

(4a) Just before the existing `module.exports` line (and ideally near the top alongside the other helpers, but the bottom is fine), require the default constant — add to the imports near `const { COMMON_CSS, sidebarHTML } = require('./common');`:

```javascript
const { DEFAULT_WELCOME_TEMPLATE } = require('../discord/welcome-template');
```

(4b) Change the function signature from `function renderWelcomeLogPage(entries) {` to:

```javascript
function renderWelcomeLogPage(entries, tpl) {
  // Default to the hardcoded template when called without the second arg
  // (existing callers + tests that pass only `entries`).
  const effective = tpl && typeof tpl.template === 'string'
    ? tpl
    : { template: DEFAULT_WELCOME_TEMPLATE, isDefault: true };
  const tplText = effective.template;
  const previewText = applyTemplatePreview(tplText);
```

(4c) Add this helper near the existing `escHtml`/`fmtTs` helpers (above `renderWelcomeLogPage`):

```javascript
// Static preview: render the template with example user/channel placeholders.
// Pure string operation; does NOT touch Discord or DB.
function applyTemplatePreview(template) {
  return String(template == null ? '' : template)
    .split('{user}').join('@newuser')
    .split('{start_here}').join('#🚩│start-here');
}
```

(4d) Add the Template card HTML INSIDE the `#wrap` div, BEFORE the existing `<div class="note">…</div>`. Find this line:

```javascript
<div id="wrap">
  <div class="note">
```

Replace those two lines with:

```javascript
<div id="wrap">
  <div class="template-card">
    <div class="template-card-header">
      <strong>Template du message de bienvenue</strong>
      ${effective.isDefault
        ? '<span class="chip chip-warn">default (hardcoded)</span>'
        : '<span class="chip chip-ok">override actif</span>'}
    </div>
    <textarea id="tpl-input" rows="4" maxlength="2000">${escHtml(tplText)}</textarea>
    <div class="template-help">
      Placeholders : <code>{user}</code> = ping du nouveau membre · <code>{start_here}</code> = lien vers <code>🚩│start-here</code>
    </div>
    <div class="template-preview">
      <span class="template-preview-label">Preview :</span>
      <span id="tpl-preview">${escHtml(previewText)}</span>
    </div>
    <div class="template-actions">
      <button id="tpl-save" type="button">Save</button>
      <button id="tpl-reset" type="button" class="secondary">Reset to default</button>
      <span id="tpl-status" class="template-status"></span>
    </div>
  </div>
  <div class="note">
```

(4e) Add the corresponding CSS inside the existing `<style>` block, just before the closing `</style>`. Append:

```css
  .template-card { background: rgba(99,102,241,0.04); border: 1px solid rgba(99,102,241,0.15); border-radius: 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
  .template-card-header { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #c4b5fd; }
  .template-card textarea { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: #e3e5e8; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; padding: 10px 12px; resize: vertical; min-height: 80px; line-height: 1.5; }
  .template-card textarea:focus { outline: none; border-color: rgba(139,92,246,0.5); }
  .template-help { font-size: 11px; color: #a0a0b0; }
  .template-help code { background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #c7d2fe; }
  .template-preview { font-size: 12px; color: #a0a0b0; }
  .template-preview-label { color: #80848e; margin-right: 6px; }
  #tpl-preview { color: #e3e5e8; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .template-actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .template-actions button { background: #6366f1; color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .template-actions button:hover { background: #4f46e5; }
  .template-actions button.secondary { background: transparent; color: #c4b5fd; border: 1px solid rgba(139,92,246,0.4); }
  .template-actions button.secondary:hover { background: rgba(139,92,246,0.1); }
  .template-status { font-size: 12px; }
  .template-status.ok { color: #6ee7b7; }
  .template-status.err { color: #f87171; }
```

(4f) Add the inline client-side script INSIDE `<body>`, just before the closing `</body>` tag. Append:

```html
<script>
(function () {
  var input = document.getElementById('tpl-input');
  var preview = document.getElementById('tpl-preview');
  var status = document.getElementById('tpl-status');
  var saveBtn = document.getElementById('tpl-save');
  var resetBtn = document.getElementById('tpl-reset');
  if (!input || !preview || !status || !saveBtn || !resetBtn) return;

  function previewOf(text) {
    return String(text == null ? '' : text)
      .split('{user}').join('@newuser')
      .split('{start_here}').join('#🚩│start-here');
  }
  function setStatus(kind, text) {
    status.className = 'template-status ' + kind;
    status.textContent = text;
  }
  input.addEventListener('input', function () {
    preview.textContent = previewOf(input.value);
    setStatus('', '');
  });
  saveBtn.addEventListener('click', function () {
    var body = JSON.stringify({ template: input.value });
    setStatus('', 'Saving…');
    fetch('/api/welcome-message', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      credentials: 'same-origin',
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.json.ok) {
          setStatus('ok', 'Saved ✓');
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          setStatus('err', res.json.error || 'Save failed');
        }
      })
      .catch(function (err) { setStatus('err', String(err)); });
  });
  resetBtn.addEventListener('click', function () {
    if (!window.confirm('Reset to the default template ?')) return;
    setStatus('', 'Resetting…');
    fetch('/api/welcome-message', {
      method: 'DELETE',
      credentials: 'same-origin',
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.json.ok) {
          setStatus('ok', 'Reset ✓');
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          setStatus('err', res.json.error || 'Reset failed');
        }
      })
      .catch(function (err) { setStatus('err', String(err)); });
  });
})();
</script>
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `node --test pages/welcome-log.test.js`
Expected: All 9 tests PASS (4 existing + 5 new).

- [ ] **Step 6: Run welcome-template + welcome-listener tests too (sanity)**

Run: `node --test discord/welcome-template.test.js && node --test discord/welcome-listener.test.js`
Expected: 20 + 12 = 32 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add pages/welcome-log.js pages/welcome-log.test.js
git commit -m "feat(welcome-template): Template card UI on /welcome-log

Textarea with current template, live client-side preview, Save/Reset
buttons wired to /api/welcome-message via inline vanilla JS. HTML
escapes the template before injection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Final verification + user-facing summary

- [ ] **Step 1: Full test suite green**

Run: `node --test 2>&1 | tail -10`
Expected: pass count increased by 20 + 5 = 25 vs. pre-Task-1 baseline (Task 3 adds no new tests; Task 4 adds no new tests; Tasks 1+2 add 20; Task 5 adds 5). Same 2 pre-existing failures (`services/llm-classify.test.js` Windows SQLite EBUSY race + `video/scripts/test-tts-voice.js` TTS diagnostic).

- [ ] **Step 2: Syntax check on the entrypoints**

Run: `node --check index.js && node --check discord/welcome-listener.js && node --check routes/welcome-log.js && node --check pages/welcome-log.js`
Expected: No output for any.

- [ ] **Step 3: Print user-facing summary**

Print to the user:

```
✅ Welcome message editor ready. After redeploy:

1. Visit /welcome-log on the dashboard
2. At the top you'll see a "Template du message de bienvenue" card with:
   - The current template in a textarea (default if you haven't overridden)
   - A live preview line ("@newuser welcome to TOB! ...") that updates as you type
   - Save / Reset to default buttons
3. Edit the template. Use {user} for the member ping and {start_here} for the start-here channel link.
4. Click Save. Next time someone is welcomed, the new template is used (no bot restart needed).
5. Click Reset to default to clear your override and return to the original wording.

Validation rules (server-side):
- Template must not be empty
- Template must be < 2000 chars (Discord message limit)
- Template MUST contain {user} (so new members get pinged)
- {start_here} is optional

Smoke test: edit the template, save, then attribute the subscriber role to a test account. The welcome message in Discord should use your new wording.
```

---

## Out of scope (per spec section 9)

- Multiple templates (per-plan, A/B test, scheduled)
- Additional placeholders (`{server}`, `{day}`, custom emoji helpers, etc.)
- Editing the channel/role/guild IDs from the dashboard — these stay env vars on Railway
- Version history of past templates
- WYSIWYG / rich-text editor
- Live preview against a real Discord rendering
- Approval/review workflow before save
- Localization of the template
