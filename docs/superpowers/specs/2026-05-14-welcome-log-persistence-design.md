# Welcome Log Persistence — Design Spec

**Date:** 2026-05-14
**Status:** Approved
**Scope:** Migrate welcome-log entries from an in-memory ring buffer to a SQLite table so events survive bot restarts. No cap on storage — the dashboard page renders the full history.

---

## 1. Goal

Today: every welcome event (sent / error-channel / error-send / config-missing) is recorded in the in-memory `state/welcome-log.js` ring buffer (max 100 entries) and wiped on every bot restart. Operator wants this data persisted indefinitely so deploy-induced restarts don't lose subscription history.

After this work: every event is persisted to a new `welcome_log` SQLite table at write time. The `/welcome-log` dashboard reads the full table (no LIMIT) on each page load.

## 2. Schema

New SQLite table, created by `CREATE TABLE IF NOT EXISTS` at boot (same migration pattern as `news_items`):

```sql
CREATE TABLE IF NOT EXISTS welcome_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  user_id   TEXT,
  username  TEXT,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_welcome_log_ts ON welcome_log(ts);
```

Column mapping:
- `ts` — ISO-8601 timestamp (string, lexicographically sortable)
- `type` — one of `'sent'`, `'error-channel'`, `'error-send'`, `'config-missing'`
- `user_id` — Discord snowflake (string); NULL for `config-missing` rows
- `username` — display name captured at fire time; NULL for `config-missing`
- `detail` — free-text context (error message, missing-vars list, etc.); NULL for `sent` rows

The `id`/`AUTOINCREMENT` is for stable ordering and FK-able primary key. The `idx_welcome_log_ts` keeps `ORDER BY ts DESC` cheap if we ever want it (today we use `ORDER BY id DESC` which is already fast — see §3).

## 3. DB layer (`db/sqlite.js`)

Two new prepared statements + two new exports, modeled on `insertNewsItem`/`getRecentNewsItems`:

```javascript
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
// listener and converts to snake_case columns. ts is auto-filled with
// the current ISO time if not provided.
function insertWelcomeLog({ ts, type, userId, username, detail }) {
  stmtWelcomeLogInsert.run({
    ts:       ts || new Date().toISOString(),
    type,
    user_id:  userId != null ? String(userId) : null,
    username: username != null ? String(username) : null,
    detail:   detail != null ? String(detail) : null,
  });
}

// Return all entries, most recent first. Today there is no LIMIT — the
// dashboard renders the full history. If volume ever grows past what the
// page can render comfortably, add an optional `limit` param.
function getWelcomeLog() {
  return stmtWelcomeLogList.all();
}
```

The `SELECT` aliases `user_id` back to `userId` so the page renderer (which expects `userId` from today's in-memory shape) keeps working unchanged.

Both functions exported from `db/sqlite.js` alongside the existing `insertNewsItem` family.

## 4. Caller updates

### `discord/welcome-listener.js`
Change:
```javascript
const { appendWelcomeLog } = require('../state/welcome-log');
```
To:
```javascript
const { insertWelcomeLog } = require('../db/sqlite');
```

And rename every `appendWelcomeLog(...)` call site to `insertWelcomeLog(...)`. The argument shape is unchanged (`{ type, userId, username, detail }`) — `ts` continues to be auto-filled by the DB layer.

### `routes/welcome-log.js`
Change:
```javascript
const { getWelcomeLog } = require('../state/welcome-log');
```
To:
```javascript
const { getWelcomeLog } = require('../db/sqlite');
```

No other change needed — the function name is identical, and the returned rows have the same `{ ts, type, userId, username, detail }` shape as before (the DB SELECT aliases `user_id` → `userId`).

## 5. Module deletion

After the callers are updated and tests confirm green:
- Delete `state/welcome-log.js`
- Delete `state/welcome-log.test.js`

No other file references this module (verified by `grep`). The deletion lands in the same commit as the caller updates.

## 6. Schema migration

The `db/sqlite.js` bootstrap section at the top of the file already runs `CREATE TABLE IF NOT EXISTS` statements for every table (see lines ~100-200 — `news_items`, `messages`, `profit_counts`, etc.). Add the `welcome_log` CREATE TABLE + index alongside them.

On deploy:
- Existing prod DBs auto-get the new table at first boot of the new code (idempotent CREATE IF NOT EXISTS).
- No data backfill needed — the in-memory entries that existed before deploy are lost, but that's already the behavior on every restart, so no regression.

## 7. Performance considerations

- **Write rate**: 1-2 welcome events per day in practice. A single INSERT per event is trivially fast (<1ms).
- **Read rate**: only the `/welcome-log` admin page reads, and only on page load.
- **Volume**: at 2 events/day, after 5 years that's ~3650 rows ≈ 350 KB on disk. SELECT * still returns in <10ms. Page renders ~3650 `<tr>` elements ≈ 500 KB HTML — fits comfortably in modern browsers but starts to feel sluggish.

For long-term safety, the spec leaves room to add an optional `limit` to `getWelcomeLog()` later. Today: no limit. Out of scope.

## 8. Tests

### Delete
- `state/welcome-log.test.js` — covered the in-memory ring buffer, no longer applicable

### Add
New file `db/welcome-log.test.js`:
- Cleanup helper: `db.exec('DELETE FROM welcome_log')` at the top of each test
- `insertWelcomeLog` followed by `getWelcomeLog` returns the inserted row
- Multiple inserts: `getWelcomeLog` returns them in most-recent-first order (id DESC)
- Nullable fields: insert with `userId: null`, `username: null`, `detail: null` (the config-missing case) round-trips correctly
- `ts` is auto-filled when not provided
- `ts` is preserved when explicitly provided
- Cleanup test at the end so other test files aren't polluted

### Unchanged
- `discord/welcome-listener.test.js` (12 tests) — does not exercise the storage layer
- `pages/welcome-log.test.js` (9 tests) — passes entries as direct function args, not through storage
- `discord/welcome-template.test.js` (20 tests) — unrelated

## 9. Data shape contract

The shape exchanged between the listener (producer), the DB layer, and the page renderer (consumer) is:

```javascript
{
  ts:       '2026-05-14T12:00:00.000Z',  // ISO string
  type:     'sent' | 'error-channel' | 'error-send' | 'config-missing',
  userId:   '123456789' | null,
  username: 'Alice#0001' | null,
  detail:   'Missing Permissions' | null,
}
```

This is identical to today's in-memory shape. The DB layer is the ONLY place that translates `userId` ↔ `user_id` for SQLite storage. Callers and the page renderer use camelCase exclusively.

## 10. UI note update

The current page note says "100 derniers événements en mémoire — reset au restart du bot." After this work that's no longer true. Update the note string in `pages/welcome-log.js` to:

```
Rétention : tous les événements persistés en DB (table welcome_log).
Pour l'historique long terme, filtre Railway logs sur [welcome] ou consulte le DB Viewer.
Types : sent = welcome posté, error-channel / error-send = échec Discord API, config-missing = vars d'env manquantes au boot.
```

## 11. Out of scope

- Pagination of the page (no LIMIT, render all entries)
- Automatic purge of old entries (table grows unbounded by design)
- Additional indexes on `type` or `user_id` (no current query needs them)
- CSV/JSON export (DB Viewer covers this need)
- Backfill of past welcomes (impossible — those events are gone)
- Concurrency / multi-writer handling (single-process bot, SQLite WAL already on)
