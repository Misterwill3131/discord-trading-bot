# Welcome Log Dashboard — Design Spec

**Date:** 2026-05-14
**Status:** Approved
**Scope:** A dashboard page showing recent events from the welcome listener, separated from the rest of the bot logs.

---

## 1. Goal

Operator wants to see what the welcome listener is doing — successful welcomes and errors — without scrolling through Railway logs or filtering by prefix. The existing `[welcome] …` log lines stay in stdout for Railway, but a dedicated dashboard page mirrors them for at-a-glance ops.

Same pattern as the existing `/backup-log` page (`routes/backup-log.js` + `pages/backup-log.js` + in-memory ring buffer in `discord/jobs.js`). In-memory only, resets on bot restart, auth-protected.

## 2. Architecture

Three new units, each with one clear responsibility:

- `state/welcome-log.js` — in-memory ring buffer (max 100 entries) with `appendWelcomeLog` and `getWelcomeLog` exports. No Discord, no HTTP — pure data.
- `pages/welcome-log.js` — renders the HTML table. Pure function: takes the log array, returns a string.
- `routes/welcome-log.js` — wires `GET /welcome-log` (auth-protected) to the renderer.

Producer: `discord/welcome-listener.js` is the only writer. It calls `appendWelcomeLog` at each branch where today it logs to `console`.

## 3. Entry shape

Each entry stored in the ring buffer:

```js
{
  ts:       '2026-05-14T00:30:00.000Z',  // ISO string, captured at append time
  type:     'sent' | 'error-channel' | 'error-send' | 'config-missing',
  userId:   '123456789' | null,         // Discord snowflake of the welcomed user (null for config-missing)
  username: 'Bob#0001' | null,           // human-readable, captured from newMember.user.tag at fire time
  detail:   'channel 999 not text-based' | err.message | null,  // free-text context
}
```

`type` enum:
- `sent` — welcome message successfully posted. `userId` and `username` populated. `detail` is `null`.
- `error-channel` — `client.channels.fetch` returned null/non-text. `userId` populated (we know who we'd have welcomed). `detail` describes the channel issue.
- `error-send` — `ch.send` threw. `userId` populated. `detail` is `err.message`.
- `config-missing` — at boot, when `registerWelcomeListener` no-ops because env vars are missing. `userId`/`username` are `null`. `detail` lists which fields are missing.

Skipped role-transition events (wrong guild, bot member, role-not-added) are NOT logged — too noisy and uninteresting.

## 4. State module: `state/welcome-log.js`

```js
const MAX_ENTRIES = 100;
let buffer = [];

function appendWelcomeLog(entry) {
  buffer.push({ ...entry, ts: entry.ts || new Date().toISOString() });
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
}

function getWelcomeLog() {
  return buffer.slice();  // defensive copy — callers can't mutate internal state
}

module.exports = { appendWelcomeLog, getWelcomeLog, MAX_ENTRIES };
```

No mutation guarantees. `MAX_ENTRIES = 100` is exposed for tests.

## 5. Producer changes: `discord/welcome-listener.js`

The handler today has 4 distinct outcomes. After this change, each outcome ALSO calls `appendWelcomeLog`:

| Branch | Today | After |
|---|---|---|
| Config missing at boot | `console.warn('[welcome] missing config…')` | + `appendWelcomeLog({ type: 'config-missing', detail: '<list of missing fields>' })` |
| Channel fetch returns non-text | `console.error('[welcome] welcome channel not text-based or not found:', id)` | + `appendWelcomeLog({ type: 'error-channel', userId, username, detail: '…' })` |
| `ch.send` throws | `console.error('[welcome] send failed:', err.message)` | + `appendWelcomeLog({ type: 'error-send', userId, username, detail: err.message })` |
| `ch.send` succeeds | (no log today) | `console.log('[welcome] sent to', userId)` + `appendWelcomeLog({ type: 'sent', userId, username })` |

A new `console.log` line is added for the success case so Railway still has parity with the dashboard.

`shouldWelcome` returning false continues to silently skip — no log, no buffer entry.

## 6. Page: `pages/welcome-log.js`

Same style as `pages/backup-log.js`. HTML table, no JS, server-rendered. Columns:

| When | Type | User | Detail |
|---|---|---|---|
| 2026-05-14 00:30:00 UTC | sent | Bob#0001 (123…) | — |
| 2026-05-14 00:31:12 UTC | error-send | Alice#0002 (456…) | Missing Permissions |

- Most recent entry at top
- Type rendered as a colored chip (green=sent, red=error-*, gray=config-missing)
- Empty state: "No welcome events yet. The listener is registered if you see no `config-missing` row at boot."

## 7. Route: `routes/welcome-log.js`

Mirrors `routes/backup-log.js`:

```js
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

Wired in `index.js` next to `registerBackupLogRoutes(app, requireAuth);`.

## 8. Tests

`state/welcome-log.test.js`:
- `appendWelcomeLog` adds entries with `ts` auto-filled when not provided
- `appendWelcomeLog` respects `MAX_ENTRIES` (push 150, expect length 100, expect FIFO order — first 50 evicted)
- `getWelcomeLog` returns a defensive copy (mutating the returned array doesn't affect future reads)

`discord/welcome-listener.test.js`:
- Existing 12 tests untouched
- (No new behavioral test for the integration with `appendWelcomeLog` — manually verified via the dashboard page is sufficient; the writes are simple `push` calls and unit-testing them would require mocking `state/welcome-log.js`)

`pages/welcome-log.test.js`:
- `renderWelcomeLogPage([])` returns HTML containing the empty-state text
- `renderWelcomeLogPage([entry])` includes the entry's `username` and `type` in the output

## 9. Out of scope

- Persistence (SQLite, file) — restart = blank log, by design
- Filters / search on the page
- Export (CSV, JSON)
- Pagination — 100 entries fit on one screen
- Clear-log button — restart is the only reset
- Notifications (Discord channel, email)
- Auth model — reuses the existing dashboard `requireAuth`
