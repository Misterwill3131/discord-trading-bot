# Welcome Log Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate welcome-log entries from an in-memory ring buffer to a new `welcome_log` SQLite table so events survive bot restarts.

**Architecture:** A new SQLite table `welcome_log` (id auto-increment, ts, type, user_id, username, detail) is added to the schema bootstrap. Two new exports on `db/sqlite.js` — `insertWelcomeLog` and `getWelcomeLog` — handle the camelCase ↔ snake_case translation. Callers (`discord/welcome-listener.js` and `routes/welcome-log.js`) switch imports from `../state/welcome-log` to `../db/sqlite`. The orphaned `state/welcome-log.js` and its tests are deleted. No cap on storage.

**Tech Stack:** Node.js, `better-sqlite3`, `node:test`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-14-welcome-log-persistence-design.md](../specs/2026-05-14-welcome-log-persistence-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `db/sqlite.js` | Modify | Add `welcome_log` CREATE TABLE + index in the bootstrap block. Add prepared statements + 2 functions (`insertWelcomeLog`, `getWelcomeLog`). Add the new exports. |
| `db/welcome-log.test.js` | Create | DB-level tests: insert + getList round-trip, ordering, nullable fields, ts auto-fill. Cleans up `welcome_log` rows between tests. |
| `discord/welcome-listener.js` | Modify | Change import from `../state/welcome-log` to `../db/sqlite`. Rename call sites `appendWelcomeLog` → `insertWelcomeLog`. |
| `routes/welcome-log.js` | Modify | Change import from `../state/welcome-log` to `../db/sqlite`. |
| `pages/welcome-log.js` | Modify | Update the note block string: replace "100 derniers événements en mémoire — reset au restart" with the persistence message. |
| `state/welcome-log.js` | Delete | No longer used (callers point to db/sqlite). |
| `state/welcome-log.test.js` | Delete | Tested the deleted module. |

---

## Task 1: Schema + DB layer (TDD)

Add the new table to the schema bootstrap, add the prepared statements + functions, write a fresh test file. The new DB module lives alongside `insertNewsItem`/`getRecentNewsItems` (close pattern reference).

**Files:**
- Modify: `db/sqlite.js`
- Create: `db/welcome-log.test.js`

- [ ] **Step 1: Write the failing tests**

Create `db/welcome-log.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('./sqlite');

// Clear the table before each test so we don't accumulate state between runs.
// Uses the underlying raw db handle exposed by db/sqlite.js if available;
// otherwise falls back to a manual delete via setSetting (not viable here).
// db/sqlite.js exports `db` (the better-sqlite3 instance) — verified.
function resetTable() {
  db.db.exec('DELETE FROM welcome_log');
}

test('insertWelcomeLog + getWelcomeLog round-trip', () => {
  resetTable();
  db.insertWelcomeLog({ type: 'sent', userId: '111', username: 'Alice', detail: null });
  const log = db.getWelcomeLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].type, 'sent');
  assert.strictEqual(log[0].userId, '111');
  assert.strictEqual(log[0].username, 'Alice');
  assert.strictEqual(log[0].detail, null);
  assert.match(log[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ts should be auto-filled ISO');
});

test('getWelcomeLog returns rows in most-recent-first order (id DESC)', () => {
  resetTable();
  db.insertWelcomeLog({ type: 'sent', userId: '1', username: 'first',  detail: null });
  db.insertWelcomeLog({ type: 'sent', userId: '2', username: 'second', detail: null });
  db.insertWelcomeLog({ type: 'sent', userId: '3', username: 'third',  detail: null });
  const log = db.getWelcomeLog();
  assert.strictEqual(log.length, 3);
  assert.strictEqual(log[0].username, 'third',  'most recent first');
  assert.strictEqual(log[1].username, 'second');
  assert.strictEqual(log[2].username, 'first',  'oldest last');
});

test('insertWelcomeLog accepts null userId/username/detail (config-missing case)', () => {
  resetTable();
  db.insertWelcomeLog({ type: 'config-missing', userId: null, username: null, detail: 'TOB_WELCOME_GUILD_ID' });
  const log = db.getWelcomeLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].type, 'config-missing');
  assert.strictEqual(log[0].userId, null);
  assert.strictEqual(log[0].username, null);
  assert.strictEqual(log[0].detail, 'TOB_WELCOME_GUILD_ID');
});

test('insertWelcomeLog preserves explicit ts when provided', () => {
  resetTable();
  const explicit = '2026-05-14T12:00:00.000Z';
  db.insertWelcomeLog({ ts: explicit, type: 'sent', userId: '1', username: 'A', detail: null });
  assert.strictEqual(db.getWelcomeLog()[0].ts, explicit);
});

test('insertWelcomeLog coerces numeric userId to string', () => {
  // userId comes from Discord as a string snowflake, but better-sqlite3
  // throws on bound type mismatch — confirm the function defends with String().
  resetTable();
  db.insertWelcomeLog({ type: 'sent', userId: 12345, username: 'Bob', detail: null });
  const log = db.getWelcomeLog();
  assert.strictEqual(typeof log[0].userId, 'string');
  assert.strictEqual(log[0].userId, '12345');
});

test('cleanup: empty the table after this file', () => {
  resetTable();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test db/welcome-log.test.js`
Expected: FAIL — either `db.insertWelcomeLog is not a function` (the function doesn't exist yet) or `no such table: welcome_log` (the table isn't created yet).

- [ ] **Step 3: Add the table to the schema bootstrap**

Open `db/sqlite.js`. Find the schema bootstrap block — specifically the existing `CREATE TABLE IF NOT EXISTS news_items` declaration (around lines 112-123):

```javascript
  -- Items de news récents (max 50 en pratique, via cap à l'insertion).
  -- Persiste le fil affiché sur /news et dans !news pour qu'il survive
  -- aux restarts du bot (sinon le dashboard est vide pendant des heures).
  CREATE TABLE IF NOT EXISTS news_items (
    id     TEXT PRIMARY KEY,        -- "timestamp-rand" format
    ts     TEXT NOT NULL,
    title  TEXT NOT NULL,
    emoji  TEXT,
    source TEXT,
    link   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_news_items_ts ON news_items(ts);
```

Immediately AFTER this block (before the next CREATE TABLE), add:

```javascript

  -- Welcome events log : sent + error-channel + error-send + config-missing.
  -- Persiste les événements du welcome listener pour qu'ils survivent
  -- aux restarts. Pas de cap — la dashboard page /welcome-log render tout
  -- (à 1-2 events/jour, ~700 lignes/an, négligeable). Source : Task de
  -- la spec 2026-05-14-welcome-log-persistence-design.md.
  CREATE TABLE IF NOT EXISTS welcome_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    type     TEXT NOT NULL,
    user_id  TEXT,
    username TEXT,
    detail   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_welcome_log_ts ON welcome_log(ts);
```

- [ ] **Step 4: Add the prepared statements + functions**

In `db/sqlite.js`, find the section where `stmtNewsInsert` / `stmtNewsRecent` / `stmtNewsTrim` are declared (around lines 870-882). Immediately AFTER the `function purgeNewsOlderThan(...)` function (around line 917), add:

```javascript

// ═════════════════════════════════════════════════════════════════════
//  Welcome log — events persistés par discord/welcome-listener
// ═════════════════════════════════════════════════════════════════════

const stmtWelcomeLogInsert = db.prepare(`
  INSERT INTO welcome_log (ts, type, user_id, username, detail)
  VALUES (@ts, @type, @user_id, @username, @detail)
`);
const stmtWelcomeLogList = db.prepare(`
  SELECT id, ts, type, user_id AS userId, username, detail
  FROM welcome_log
  ORDER BY id DESC
`);

// Append a single welcome event. Accepts the camelCase shape used by the
// listener; this layer translates to snake_case columns. ts is auto-filled
// with the current ISO time if not provided. Nullables (userId, username,
// detail) are coerced to strings when present, kept as null when absent.
function insertWelcomeLog({ ts, type, userId, username, detail }) {
  stmtWelcomeLogInsert.run({
    ts:       ts || new Date().toISOString(),
    type,
    user_id:  userId != null ? String(userId) : null,
    username: username != null ? String(username) : null,
    detail:   detail != null ? String(detail) : null,
  });
}

// Return ALL entries, most recent first (id DESC). No LIMIT — the
// dashboard renders the full history. If volume ever grows past what
// the page can render comfortably, add an optional `limit` param.
function getWelcomeLog() {
  return stmtWelcomeLogList.all();
}
```

- [ ] **Step 5: Add the two functions to the exports list**

In `db/sqlite.js`, find the `module.exports = { ... }` block. Find the `news items` group (around line 1867-1871):

```javascript
  // news items
  insertNewsItem,
  getRecentNewsItems,
  trimNewsItems,
  purgeNewsOlderThan,
```

Immediately AFTER that group (still inside the exports object), add:

```javascript

  // welcome log
  insertWelcomeLog,
  getWelcomeLog,
```

- [ ] **Step 6: Confirm `db` itself is exported (used by the test for cleanup)**

The test calls `db.db.exec('DELETE FROM welcome_log')`. This requires `db/sqlite.js` to export its raw better-sqlite3 instance under the key `db`. Run:

```bash
node -e "const x = require('./db/sqlite'); console.log(typeof x.db, x.db && typeof x.db.exec);"
```

Expected: `object function` (the `db` instance is exported and has an `exec` method).

**If the output is `undefined undefined`** — the raw handle isn't exported. STOP and report BLOCKED. The test can't clean up between cases. A short-term fix is to use `setSetting`/`getSetting`-style helpers if a delete helper exists, but the right fix is to export the raw `db` handle. Don't try to fix this from inside the test.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test db/welcome-log.test.js`
Expected: All 6 tests PASS.

- [ ] **Step 8: Run the full test suite to confirm no regression**

Run: `node --test 2>&1 | tail -10`
Expected: pass count increases by 6 vs. previous baseline; the 2 known pre-existing failures (`services/llm-classify.test.js` Windows SQLite EBUSY race + `video/scripts/test-tts-voice.js` TTS diagnostic) remain. NO new failures.

Note: the old `state/welcome-log.test.js` still exists at this point and its 5 tests still pass — they test the in-memory buffer which is still untouched. They'll be deleted in Task 4.

- [ ] **Step 9: Commit**

```bash
git add db/sqlite.js db/welcome-log.test.js
git commit -m "feat(welcome-log): add welcome_log SQLite table + insert/list functions

CREATE TABLE IF NOT EXISTS at boot, prepared statements modeled on
news_items. Callers still on the in-memory module — switched in
follow-up tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Switch listener to use the DB layer

`discord/welcome-listener.js` currently imports `appendWelcomeLog` from `../state/welcome-log`. Switch it to `insertWelcomeLog` from `../db/sqlite`. The argument shape is unchanged.

**Files:**
- Modify: `discord/welcome-listener.js`

- [ ] **Step 1: Update the import**

Find the existing line near the top of the file:

```javascript
const { appendWelcomeLog } = require('../state/welcome-log');
```

Replace with:

```javascript
const { insertWelcomeLog } = require('../db/sqlite');
```

- [ ] **Step 2: Rename all call sites**

There are 4 call sites in the file (one per outcome branch). Find each `appendWelcomeLog(` and replace with `insertWelcomeLog(`. Do NOT change the argument shape.

Recommended approach: use a single find-and-replace on the whole file, replacing the exact string `appendWelcomeLog` with `insertWelcomeLog`. After the replace, no occurrence of `appendWelcomeLog` should remain in `discord/welcome-listener.js`.

Verify with:

```bash
grep -c "appendWelcomeLog" discord/welcome-listener.js
```

Expected: `0`.

And:

```bash
grep -c "insertWelcomeLog" discord/welcome-listener.js
```

Expected: `5` (1 import + 4 call sites).

- [ ] **Step 3: Run existing welcome-listener tests**

Run: `node --test discord/welcome-listener.test.js`
Expected: All 12 tests PASS. These tests cover pure functions + subscription mechanics — they don't exercise the storage call paths, so the rename has no impact.

- [ ] **Step 4: Run db/welcome-log tests (sanity)**

Run: `node --test db/welcome-log.test.js`
Expected: All 6 tests PASS.

- [ ] **Step 5: Run welcome-template tests too (sanity, since the listener imports from it)**

Run: `node --test discord/welcome-template.test.js`
Expected: All 20 tests PASS.

- [ ] **Step 6: Syntax check**

Run: `node --check discord/welcome-listener.js`
Expected: No output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add discord/welcome-listener.js
git commit -m "feat(welcome-log): listener writes events to DB instead of in-memory buffer

Renames appendWelcomeLog -> insertWelcomeLog. Same argument shape.
Events now survive bot restarts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Switch route to use the DB layer + update page note text

`routes/welcome-log.js` currently imports `getWelcomeLog` from `../state/welcome-log`. Switch the import. Same function name on both sides — no call-site rename needed.

Also update the user-facing note text on `pages/welcome-log.js` to mention persistence instead of the old "reset on restart" claim.

**Files:**
- Modify: `routes/welcome-log.js`
- Modify: `pages/welcome-log.js`

- [ ] **Step 1: Update the route's import**

Open `routes/welcome-log.js`. Find this line:

```javascript
const { getWelcomeLog } = require('../state/welcome-log');
```

Replace with:

```javascript
const { getWelcomeLog } = require('../db/sqlite');
```

No other change needed in the route file — the function name and return shape are identical.

- [ ] **Step 2: Update the note block in pages/welcome-log.js**

Open `pages/welcome-log.js`. Find the existing note block inside the page HTML (look for `<div class="note">` followed by `<strong>Rétention :</strong>`). The current text is:

```html
  <div class="note">
    <strong>Rétention :</strong> 100 derniers événements en mémoire — reset au restart du bot.
    Pour l'historique long terme, filtre Railway logs sur <code>[welcome]</code>.
    Types : <code>sent</code> = welcome posté, <code>error-channel</code> / <code>error-send</code> = échec Discord API, <code>config-missing</code> = vars d'env manquantes au boot.
  </div>
```

Replace those 5 lines (the entire `<div class="note">…</div>` block) with:

```html
  <div class="note">
    <strong>Rétention :</strong> tous les événements persistés en DB (table <code>welcome_log</code>).
    Pour l'historique long terme, filtre Railway logs sur <code>[welcome]</code> ou consulte le DB Viewer.
    Types : <code>sent</code> = welcome posté, <code>error-channel</code> / <code>error-send</code> = échec Discord API, <code>config-missing</code> = vars d'env manquantes au boot.
  </div>
```

(Two changes: "100 derniers événements en mémoire — reset au restart du bot" becomes "tous les événements persistés en DB (table `welcome_log`)", and "ou consulte le DB Viewer" is added at the end of the second sentence.)

- [ ] **Step 3: Syntax check both files**

Run: `node --check routes/welcome-log.js && node --check pages/welcome-log.js`
Expected: No output (exit 0).

- [ ] **Step 4: Run page tests to confirm no regression**

Run: `node --test pages/welcome-log.test.js`
Expected: All 9 tests PASS. (None of them assert the exact note text.)

- [ ] **Step 5: Commit**

```bash
git add routes/welcome-log.js pages/welcome-log.js
git commit -m "feat(welcome-log): route reads from DB; page note reflects persistence

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Delete the orphaned in-memory module

After Tasks 2 and 3, nothing in the codebase imports from `state/welcome-log`. Remove the module and its tests.

**Files:**
- Delete: `state/welcome-log.js`
- Delete: `state/welcome-log.test.js`

- [ ] **Step 1: Confirm no remaining references**

Run:

```bash
grep -rn "state/welcome-log" --include="*.js" .
```

Expected: NO matches. (If matches appear, fix those callers before deleting — they would otherwise break.)

- [ ] **Step 2: Delete the files**

```bash
git rm state/welcome-log.js state/welcome-log.test.js
```

- [ ] **Step 3: Run the full test suite**

Run: `node --test 2>&1 | tail -10`
Expected: pass count DECREASES by 5 vs. Task 3 (the 5 ring-buffer tests are gone), and INCREASES by 6 vs. before Task 1 (net delta from this whole feature: +1 because we add 6 DB tests and remove 5 in-memory tests). The 2 known pre-existing failures remain. NO new failures.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(welcome-log): remove orphaned in-memory module

state/welcome-log.js and its tests are no longer used — callers
migrated to db/sqlite.js in the previous commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(Note: `git rm` in Step 2 already staged the deletions, so this commit captures them.)

---

## Task 5: Final verification + user summary

- [ ] **Step 1: Full test suite green**

Run: `node --test 2>&1 | tail -10`
Expected: Same 2 pre-existing failures, no new ones. Net new tests vs. main baseline: +1 (the 6 from Task 1 minus the 5 deleted in Task 4).

- [ ] **Step 2: Syntax check on every touched file**

Run: `node --check db/sqlite.js && node --check discord/welcome-listener.js && node --check routes/welcome-log.js && node --check pages/welcome-log.js && echo "all-syntax-ok"`
Expected: `all-syntax-ok`.

- [ ] **Step 3: Quick query check (optional smoke)**

Run:

```bash
node -e "const db = require('./db/sqlite'); db.insertWelcomeLog({type:'sent',userId:'test',username:'smoke',detail:null}); console.log(db.getWelcomeLog()); db.db.exec('DELETE FROM welcome_log WHERE username=\"smoke\"');"
```

Expected: prints an array with one entry showing the smoke row, then deletes it (cleanup). If the SELECT shows entries from the actual production-style db (e.g., previous test artifacts), that's OK — the smoke just confirms the round-trip works end-to-end at the Node level.

- [ ] **Step 4: Print user-facing summary**

Print to the user:

```
✅ Welcome log persistence ready. After redeploy:

1. The new `welcome_log` table is created automatically on first boot (CREATE TABLE IF NOT EXISTS).
2. Every welcome event (sent + errors + config-missing at boot) writes a row.
3. The /welcome-log page now reads from the DB on each page load — all events visible across restarts.
4. The note block at the top of /welcome-log now reads "tous les événements persistés en DB (table welcome_log)".

No data backfill — events from before the deploy were never persisted. Going forward, nothing is lost.

To inspect raw rows: open the DB Viewer (`/db-viewer`) and `SELECT * FROM welcome_log ORDER BY id DESC LIMIT 100;`.
```

---

## Out of scope (per spec §11)

- Pagination of the page (no LIMIT, render all entries)
- Automatic purge of old entries (table grows unbounded by design)
- Additional indexes on `type` or `user_id`
- CSV/JSON export (DB Viewer covers this)
- Backfill of pre-deploy welcomes (impossible — never persisted)
- Concurrency / multi-writer handling (single-process bot, WAL already on)
