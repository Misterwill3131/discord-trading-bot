# Analyst Watchlist + Milestone Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auto-watchlist seeded by non-bot ticker mentions in `#trading-floor`, with 30-minute RTH polling that fires Discord replies at cumulative gain milestones (default +20/50/100/200/300/500/1000%). Each milestone fires once per ticker; 1-hour cooldown between alerts; 30-day TTL soft-archive.

**Architecture:** Event-driven seeding via Discord `messageCreate` listener (`discord/analyst-watchlist.js`) writes to 3 new SQLite tables. A cron tick (`discord/milestone-checker.js`) wired into `discord/jobs.js` reads the watchlist, bulk-fetches FMP quotes, computes gain%, and replies under the original Discord message. Atomic dedup via `UNIQUE (ticker, milestone_pct)`.

**Tech Stack:** Node.js · discord.js v14 · better-sqlite3 · FMP REST API · node:test + node:assert (no test framework dep). Reuses `extractTicker` from `discord/screener-ingest.js` and `isRTH` from `discord/market-alerts.js`.

**Spec:** [docs/superpowers/specs/2026-05-14-analyst-watchlist-milestones-design.md](../specs/2026-05-14-analyst-watchlist-milestones-design.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `db/sqlite.js` | Modify | Add 3 tables (`tracked_messages`, `analyst_watchlist`, `milestone_alerts`) + 8 helpers + exports |
| `db/sqlite.test.js` | Modify | Add tests for the 3 new tables and their helpers |
| `discord/fmp-client.js` | Modify | Add `getQuotesBulk(tickers)` method on the client returned by `createFmpClient` |
| `discord/fmp-client.test.js` | Create | Test `getQuotesBulk` (mocked fetch) |
| `discord/analyst-watchlist.js` | Create | Listener: audit messages, extract ticker+price, seed watchlist (event-driven) |
| `discord/analyst-watchlist.test.js` | Create | Tests for `extractPrice`, `handleMessage` (audit + seeding paths) |
| `discord/milestone-checker.js` | Create | Cron tick: read watchlist, bulk-fetch quotes, compute milestones, reply Discord |
| `discord/milestone-checker.test.js` | Create | Tests for `nextMilestone`, `buildAlertMessage`, `tick` (with mocked client+fmp+db) |
| `discord/jobs.js` | Modify | Wire `milestoneChecker.tick(client, now)` into the existing `setInterval` loop |
| `index.js` | Modify | Register the analyst-watchlist listener (after `registerScreenerIngest`) |
| `.env.example` | Modify | Document 4 new optional env vars |

Each file has one clear responsibility; the listener and the cron checker stay decoupled and communicate only through the DB tables.

---

## Conventions used in this plan

- **Test runner:** `node --test <file>` (project uses native `node:test`; see `db/sqlite.test.js`)
- **Run from repo root:** all commands assume `cwd = repo root`
- **Commit per task:** end of each task; messages follow `<type>(<module>): <short>` convention used in `git log`
- **Date format in DB:** UNIX timestamp in **milliseconds** (matches `created_at` patterns used in `welcome_log` and `daily_recaps`)
- **String ID format:** Discord snowflakes stored as TEXT (matches existing `welcome_log`, `tracked_messages` field types in current schema)

---

## Phase 1 — Database schema and helpers

Lays the foundation. Three new tables, atomic dedup constraints. Each table gets its own task with TDD.

### Task 1: Create `tracked_messages` table + `insertTrackedMessage`

**Files:**
- Modify: `db/sqlite.js` — add CREATE TABLE block, prepared statement, helper, export
- Modify: `db/sqlite.test.js` — append a test block at the end

- [ ] **Step 1.1: Write the failing test**

Append to `db/sqlite.test.js`:

```js
// ── tracked_messages (analyst-watchlist module) ─────────────────────
const {
  insertTrackedMessage,
  getTrackedMessage,
} = require('./sqlite');

test('insertTrackedMessage stores a non-bot message with ticker+price', () => {
  insertTrackedMessage({
    messageId: 'msg-aw-1',
    channelId: 'chan-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    isBot: 0,
    content: 'Watch $AAPL @ $200',
    embedJson: null,
    extractedTicker: 'AAPL',
    extractedPrice: 200,
    createdAt: 1700000000000,
  });
  const row = getTrackedMessage('msg-aw-1');
  assert.strictEqual(row.author_username, 'alice');
  assert.strictEqual(row.is_bot, 0);
  assert.strictEqual(row.extracted_ticker, 'AAPL');
  assert.strictEqual(row.extracted_price, 200);
});

test('insertTrackedMessage is idempotent on message_id (INSERT OR IGNORE)', () => {
  insertTrackedMessage({
    messageId: 'msg-aw-2',
    channelId: 'c', authorId: 'u', authorUsername: 'a',
    isBot: 0, content: 'first', embedJson: null,
    extractedTicker: null, extractedPrice: null,
    createdAt: 1700000000000,
  });
  // Second call with same messageId should be a no-op (no throw)
  insertTrackedMessage({
    messageId: 'msg-aw-2',
    channelId: 'c', authorId: 'u', authorUsername: 'a',
    isBot: 0, content: 'second', embedJson: null,
    extractedTicker: null, extractedPrice: null,
    createdAt: 1700000000000,
  });
  const row = getTrackedMessage('msg-aw-2');
  assert.strictEqual(row.content, 'first');  // first write wins
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
node --test db/sqlite.test.js
```

Expected: FAIL with `TypeError: insertTrackedMessage is not a function` (or similar).

- [ ] **Step 1.3: Add the CREATE TABLE block**

In `db/sqlite.js`, locate the `db.exec(\`...\`)` block that contains the schema definitions (starts around line 43 with `CREATE TABLE IF NOT EXISTS messages`). Append the new table **inside the same `db.exec` template string** (after the last existing CREATE TABLE, before the closing backtick):

```js
  CREATE TABLE IF NOT EXISTS tracked_messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id        TEXT NOT NULL UNIQUE,
    channel_id        TEXT NOT NULL,
    author_id         TEXT NOT NULL,
    author_username   TEXT,
    is_bot            INTEGER NOT NULL DEFAULT 0,
    content           TEXT,
    embed_json        TEXT,
    extracted_ticker  TEXT,
    extracted_price   REAL,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracked_messages_ticker
    ON tracked_messages(extracted_ticker);
  CREATE INDEX IF NOT EXISTS idx_tracked_messages_created
    ON tracked_messages(created_at);
```

- [ ] **Step 1.4: Add prepared statements and helpers**

In `db/sqlite.js`, near the end of the file (before `module.exports`), add:

```js
// ── tracked_messages (analyst-watchlist audit) ──────────────────────
const stmtTrackedMessageInsert = db.prepare(`
  INSERT OR IGNORE INTO tracked_messages
    (message_id, channel_id, author_id, author_username, is_bot,
     content, embed_json, extracted_ticker, extracted_price, created_at)
  VALUES
    (@messageId, @channelId, @authorId, @authorUsername, @isBot,
     @content, @embedJson, @extractedTicker, @extractedPrice, @createdAt)
`);

const stmtTrackedMessageGet = db.prepare(`
  SELECT * FROM tracked_messages WHERE message_id = ?
`);

function insertTrackedMessage(entry) {
  stmtTrackedMessageInsert.run({
    messageId:       String(entry.messageId),
    channelId:       String(entry.channelId),
    authorId:        String(entry.authorId),
    authorUsername:  entry.authorUsername ?? null,
    isBot:           entry.isBot ? 1 : 0,
    content:         entry.content ?? null,
    embedJson:       entry.embedJson ?? null,
    extractedTicker: entry.extractedTicker ?? null,
    extractedPrice:  Number.isFinite(entry.extractedPrice) ? entry.extractedPrice : null,
    createdAt:       Number(entry.createdAt),
  });
}

function getTrackedMessage(messageId) {
  return stmtTrackedMessageGet.get(String(messageId)) || null;
}
```

- [ ] **Step 1.5: Add to module.exports**

In `db/sqlite.js`, in the `module.exports = { ... }` block at the bottom, add (preserve trailing comma style):

```js
  // analyst-watchlist audit
  insertTrackedMessage,
  getTrackedMessage,
```

- [ ] **Step 1.6: Run test to verify it passes**

```bash
node --test db/sqlite.test.js
```

Expected: all tests pass, including the 2 new ones.

- [ ] **Step 1.7: Commit**

```bash
git add db/sqlite.js db/sqlite.test.js
git commit -m "feat(db): add tracked_messages table for analyst-watchlist audit

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Create `analyst_watchlist` table + helpers

**Files:**
- Modify: `db/sqlite.js`
- Modify: `db/sqlite.test.js`

- [ ] **Step 2.1: Write the failing tests**

Append to `db/sqlite.test.js`:

```js
// ── analyst_watchlist (active tickers tracked for milestones) ───────
const {
  insertWatchlistEntry,
  getWatchlistEntry,
  getActiveWatchlist,
  updateWatchlistAfterAlert,
  archiveExpiredWatchlist,
} = require('./sqlite');

test('insertWatchlistEntry creates a new entry', () => {
  insertWatchlistEntry({
    ticker: 'AAPL',
    initialPrice: 200,
    initialPriceSource: 'message',
    sourceMessageId: 'msg-1',
    sourceChannelId: 'chan-1',
    mentionedByUserId: 'user-1',
    mentionedByUsername: 'alice',
    firstSeenAt: 1700000000000,
  });
  const row = getWatchlistEntry('AAPL');
  assert.strictEqual(row.initial_price, 200);
  assert.strictEqual(row.initial_price_source, 'message');
  assert.strictEqual(row.mentioned_by_username, 'alice');
  assert.strictEqual(row.last_milestone_pct, null);
  assert.strictEqual(row.last_alert_at, null);
  assert.strictEqual(row.archived_at, null);
});

test('insertWatchlistEntry on existing ticker is a no-op (first mention wins)', () => {
  insertWatchlistEntry({
    ticker: 'TSLA', initialPrice: 100, initialPriceSource: 'market',
    sourceMessageId: 'msg-a', sourceChannelId: 'c',
    mentionedByUserId: 'u1', mentionedByUsername: 'alice',
    firstSeenAt: 1700000000000,
  });
  insertWatchlistEntry({
    ticker: 'TSLA', initialPrice: 999, initialPriceSource: 'market',
    sourceMessageId: 'msg-b', sourceChannelId: 'c',
    mentionedByUserId: 'u2', mentionedByUsername: 'bob',
    firstSeenAt: 1700000999999,
  });
  const row = getWatchlistEntry('TSLA');
  assert.strictEqual(row.initial_price, 100);          // first wins
  assert.strictEqual(row.mentioned_by_username, 'alice');
});

test('getActiveWatchlist returns only non-archived entries', () => {
  insertWatchlistEntry({
    ticker: 'NVDA', initialPrice: 50, initialPriceSource: 'message',
    sourceMessageId: 'm1', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 1700000000000,
  });
  const active = getActiveWatchlist();
  const tickers = active.map(r => r.ticker);
  assert.ok(tickers.includes('NVDA'));
});

test('updateWatchlistAfterAlert sets last_milestone_pct + last_alert_at', () => {
  insertWatchlistEntry({
    ticker: 'MSFT', initialPrice: 300, initialPriceSource: 'market',
    sourceMessageId: 'm', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 1700000000000,
  });
  updateWatchlistAfterAlert({
    ticker: 'MSFT', lastMilestonePct: 20, lastAlertAt: 1700001000000,
  });
  const row = getWatchlistEntry('MSFT');
  assert.strictEqual(row.last_milestone_pct, 20);
  assert.strictEqual(row.last_alert_at, 1700001000000);
});

test('archiveExpiredWatchlist soft-archives entries older than cutoff', () => {
  insertWatchlistEntry({
    ticker: 'OLD', initialPrice: 10, initialPriceSource: 'market',
    sourceMessageId: 'm', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 1000,   // very old
  });
  insertWatchlistEntry({
    ticker: 'NEW', initialPrice: 10, initialPriceSource: 'market',
    sourceMessageId: 'm2', sourceChannelId: 'c',
    mentionedByUserId: 'u', mentionedByUsername: 'a',
    firstSeenAt: 9_999_999_999_999,  // very new
  });
  const archivedCount = archiveExpiredWatchlist(5000);  // cutoff: ts < 5000 → archive
  assert.ok(archivedCount >= 1);
  const oldRow = getWatchlistEntry('OLD');
  assert.ok(oldRow.archived_at != null);
  const newRow = getWatchlistEntry('NEW');
  assert.strictEqual(newRow.archived_at, null);
  // Active list excludes archived
  const active = getActiveWatchlist();
  assert.ok(!active.find(r => r.ticker === 'OLD'));
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
node --test db/sqlite.test.js
```

Expected: FAIL with `TypeError: insertWatchlistEntry is not a function`.

- [ ] **Step 2.3: Add the CREATE TABLE block**

In `db/sqlite.js`, in the same `db.exec(\`...\`)` schema block, append (after `tracked_messages`):

```js
  CREATE TABLE IF NOT EXISTS analyst_watchlist (
    ticker                  TEXT PRIMARY KEY,
    initial_price           REAL NOT NULL,
    initial_price_source    TEXT NOT NULL,
    source_message_id       TEXT NOT NULL,
    source_channel_id       TEXT NOT NULL,
    mentioned_by_user_id    TEXT NOT NULL,
    mentioned_by_username   TEXT,
    first_seen_at           INTEGER NOT NULL,
    last_milestone_pct      INTEGER,
    last_alert_at           INTEGER,
    archived_at             INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_watchlist_active
    ON analyst_watchlist(archived_at);
```

- [ ] **Step 2.4: Add prepared statements and helpers**

In `db/sqlite.js`, before `module.exports`, after the tracked_messages helpers, add:

```js
// ── analyst_watchlist (active tickers tracked for milestones) ───────
const stmtWatchlistInsert = db.prepare(`
  INSERT OR IGNORE INTO analyst_watchlist
    (ticker, initial_price, initial_price_source, source_message_id,
     source_channel_id, mentioned_by_user_id, mentioned_by_username,
     first_seen_at)
  VALUES
    (@ticker, @initialPrice, @initialPriceSource, @sourceMessageId,
     @sourceChannelId, @mentionedByUserId, @mentionedByUsername,
     @firstSeenAt)
`);

const stmtWatchlistGet = db.prepare(`
  SELECT * FROM analyst_watchlist WHERE ticker = ?
`);

const stmtWatchlistActive = db.prepare(`
  SELECT * FROM analyst_watchlist
  WHERE archived_at IS NULL
  ORDER BY first_seen_at ASC
`);

const stmtWatchlistUpdateAfterAlert = db.prepare(`
  UPDATE analyst_watchlist
  SET last_milestone_pct = @lastMilestonePct,
      last_alert_at      = @lastAlertAt
  WHERE ticker = @ticker
`);

const stmtWatchlistArchiveExpired = db.prepare(`
  UPDATE analyst_watchlist
  SET archived_at = @now
  WHERE archived_at IS NULL AND first_seen_at < @cutoff
`);

function insertWatchlistEntry(entry) {
  stmtWatchlistInsert.run({
    ticker:              String(entry.ticker).toUpperCase(),
    initialPrice:        Number(entry.initialPrice),
    initialPriceSource:  String(entry.initialPriceSource),
    sourceMessageId:     String(entry.sourceMessageId),
    sourceChannelId:     String(entry.sourceChannelId),
    mentionedByUserId:   String(entry.mentionedByUserId),
    mentionedByUsername: entry.mentionedByUsername ?? null,
    firstSeenAt:         Number(entry.firstSeenAt),
  });
}

function getWatchlistEntry(ticker) {
  return stmtWatchlistGet.get(String(ticker).toUpperCase()) || null;
}

function getActiveWatchlist() {
  return stmtWatchlistActive.all();
}

function updateWatchlistAfterAlert({ ticker, lastMilestonePct, lastAlertAt }) {
  stmtWatchlistUpdateAfterAlert.run({
    ticker:           String(ticker).toUpperCase(),
    lastMilestonePct: Number(lastMilestonePct),
    lastAlertAt:      Number(lastAlertAt),
  });
}

function archiveExpiredWatchlist(cutoffMs, nowMs = Date.now()) {
  const result = stmtWatchlistArchiveExpired.run({
    cutoff: Number(cutoffMs),
    now:    Number(nowMs),
  });
  return result.changes;
}
```

- [ ] **Step 2.5: Add to module.exports**

In `db/sqlite.js`, in `module.exports = { ... }`, add:

```js
  // analyst-watchlist module
  insertWatchlistEntry,
  getWatchlistEntry,
  getActiveWatchlist,
  updateWatchlistAfterAlert,
  archiveExpiredWatchlist,
```

- [ ] **Step 2.6: Run test to verify it passes**

```bash
node --test db/sqlite.test.js
```

Expected: all tests pass, including the 5 new ones.

- [ ] **Step 2.7: Commit**

```bash
git add db/sqlite.js db/sqlite.test.js
git commit -m "feat(db): add analyst_watchlist table with first-mention-wins semantics

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Create `milestone_alerts` table + atomic insert helper

**Files:**
- Modify: `db/sqlite.js`
- Modify: `db/sqlite.test.js`

- [ ] **Step 3.1: Write the failing tests**

Append to `db/sqlite.test.js`:

```js
// ── milestone_alerts (atomic dedup of fired milestones) ─────────────
const { insertMilestoneAlert } = require('./sqlite');

test('insertMilestoneAlert returns true on first insert', () => {
  const fired = insertMilestoneAlert({
    ticker: 'AAPL',
    milestonePct: 20,
    initialPrice: 200,
    currentPrice: 240,
    gainPct: 20,
    firedAt: 1700000000000,
  });
  assert.strictEqual(fired, true);
});

test('insertMilestoneAlert returns false on duplicate (ticker, milestone_pct)', () => {
  insertMilestoneAlert({
    ticker: 'NVDA', milestonePct: 50,
    initialPrice: 100, currentPrice: 150, gainPct: 50,
    firedAt: 1700000000000,
  });
  const secondFired = insertMilestoneAlert({
    ticker: 'NVDA', milestonePct: 50,
    initialPrice: 100, currentPrice: 155, gainPct: 55,
    firedAt: 1700000999999,
  });
  assert.strictEqual(secondFired, false);
});

test('insertMilestoneAlert allows same ticker for different milestone_pct', () => {
  insertMilestoneAlert({
    ticker: 'TSLA', milestonePct: 20,
    initialPrice: 100, currentPrice: 120, gainPct: 20,
    firedAt: 1700000000000,
  });
  const fired50 = insertMilestoneAlert({
    ticker: 'TSLA', milestonePct: 50,
    initialPrice: 100, currentPrice: 150, gainPct: 50,
    firedAt: 1700000999999,
  });
  assert.strictEqual(fired50, true);
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
node --test db/sqlite.test.js
```

Expected: FAIL with `TypeError: insertMilestoneAlert is not a function`.

- [ ] **Step 3.3: Add the CREATE TABLE block**

In `db/sqlite.js`, in the `db.exec(\`...\`)` schema block, append:

```js
  CREATE TABLE IF NOT EXISTS milestone_alerts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT NOT NULL,
    milestone_pct       INTEGER NOT NULL,
    initial_price       REAL NOT NULL,
    current_price       REAL NOT NULL,
    gain_pct            REAL NOT NULL,
    fired_at            INTEGER NOT NULL,
    discord_message_id  TEXT,
    UNIQUE (ticker, milestone_pct)
  );
```

- [ ] **Step 3.4: Add prepared statements and helper**

In `db/sqlite.js`, before `module.exports`, after the analyst_watchlist helpers, add:

```js
// ── milestone_alerts (atomic dedup via UNIQUE constraint) ───────────
const stmtMilestoneAlertInsert = db.prepare(`
  INSERT OR IGNORE INTO milestone_alerts
    (ticker, milestone_pct, initial_price, current_price,
     gain_pct, fired_at, discord_message_id)
  VALUES
    (@ticker, @milestonePct, @initialPrice, @currentPrice,
     @gainPct, @firedAt, @discordMessageId)
`);

// Returns true when the insert actually wrote (= this caller may post).
// Returns false when UNIQUE constraint blocked it (= already fired).
function insertMilestoneAlert(entry) {
  const result = stmtMilestoneAlertInsert.run({
    ticker:           String(entry.ticker).toUpperCase(),
    milestonePct:     Number(entry.milestonePct),
    initialPrice:     Number(entry.initialPrice),
    currentPrice:     Number(entry.currentPrice),
    gainPct:          Number(entry.gainPct),
    firedAt:          Number(entry.firedAt),
    discordMessageId: entry.discordMessageId ?? null,
  });
  return result.changes > 0;
}
```

- [ ] **Step 3.5: Add to module.exports**

In `db/sqlite.js`, in `module.exports = { ... }`, add:

```js
  // analyst-watchlist module — milestone dedup
  insertMilestoneAlert,
```

- [ ] **Step 3.6: Run test to verify it passes**

```bash
node --test db/sqlite.test.js
```

Expected: all tests pass.

- [ ] **Step 3.7: Smoke check that the schema bootstraps clean**

```bash
node -e "require('./db/sqlite'); console.log('sqlite schema ok')"
```

Expected output: `sqlite schema ok` (no SQL errors thrown).

- [ ] **Step 3.8: Commit**

```bash
git add db/sqlite.js db/sqlite.test.js
git commit -m "feat(db): add milestone_alerts with atomic UNIQUE-based dedup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — FMP bulk quote

Adds `getQuotesBulk(tickers)` to the FMP client so the cron tick uses a single API call per cycle.

### Task 4: Add `getQuotesBulk` to FMP client

**Files:**
- Modify: `discord/fmp-client.js`
- Create: `discord/fmp-client.test.js`

- [ ] **Step 4.1: Write the failing tests**

Create `discord/fmp-client.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createFmpClient } = require('./fmp-client');

function mockFetch(responseBody, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
}

test('getQuotesBulk fetches a single URL with comma-joined tickers', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ([
        { symbol: 'AAPL', price: 200.50, volume: 1000 },
        { symbol: 'TSLA', price: 250.75, volume: 2000 },
      ]),
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk(['AAPL', 'TSLA']);
  assert.ok(capturedUrl.includes('/quote/AAPL,TSLA'));
  assert.strictEqual(quotes.AAPL.price, 200.50);
  assert.strictEqual(quotes.TSLA.price, 250.75);
});

test('getQuotesBulk uppercases ticker symbols before request', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await client.getQuotesBulk(['aapl', 'Tsla']);
  assert.ok(capturedUrl.includes('AAPL,TSLA'));
});

test('getQuotesBulk dedups duplicate tickers in input', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await client.getQuotesBulk(['AAPL', 'aapl', 'AAPL']);
  // exactly one AAPL in the URL
  const matches = capturedUrl.match(/AAPL/g) || [];
  assert.strictEqual(matches.length, 1);
});

test('getQuotesBulk returns empty object for empty input', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch must NOT be called for empty input');
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk([]);
  assert.deepStrictEqual(quotes, {});
});

test('getQuotesBulk handles tickers missing from FMP response gracefully', async () => {
  const fetchImpl = mockFetch([
    { symbol: 'AAPL', price: 200, volume: 1 },
    // TSLA missing
  ]);
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk(['AAPL', 'TSLA']);
  assert.strictEqual(quotes.AAPL.price, 200);
  assert.strictEqual(quotes.TSLA, undefined);
});

test('getQuotesBulk skips rows with non-finite price', async () => {
  const fetchImpl = mockFetch([
    { symbol: 'AAPL', price: 200, volume: 1 },
    { symbol: 'BAD',  price: null, volume: 1 },
  ]);
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const quotes = await client.getQuotesBulk(['AAPL', 'BAD']);
  assert.strictEqual(quotes.AAPL.price, 200);
  assert.strictEqual(quotes.BAD, undefined);
});

test('getQuotesBulk throws on HTTP error', async () => {
  const fetchImpl = mockFetch({}, { ok: false, status: 500 });
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await assert.rejects(
    () => client.getQuotesBulk(['AAPL']),
    /fmp HTTP 500/,
  );
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
node --test discord/fmp-client.test.js
```

Expected: FAIL with `TypeError: client.getQuotesBulk is not a function`.

- [ ] **Step 4.3: Implement `getQuotesBulk`**

In `discord/fmp-client.js`, locate the `createFmpClient` function. Inside it (after `getDailyBars`, before the `return { getQuote, getDailyBars };` line), add:

```js
  // Bulk quote: FMP supports up to ~250 tickers per call via comma-joined
  // path (`/quote/AAPL,TSLA,NVDA`). Returns { TICKER: { price, volume }, ... }
  // keyed by upper-cased symbol. Tickers missing from the response simply
  // don't appear in the output map (no exception). Non-finite prices are
  // skipped — same sanity rule as getQuote.
  async function getQuotesBulk(tickers) {
    const list = Array.from(new Set(
      (Array.isArray(tickers) ? tickers : [])
        .map(t => String(t).toUpperCase())
        .filter(Boolean)
    ));
    if (list.length === 0) return {};
    const url = base + '/quote/' + encodeURIComponent(list.join(','))
      + '?apikey=' + encodeURIComponent(apiKey);
    const json = await httpJson(url);
    const rows = Array.isArray(json) ? json : [];
    const out = {};
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
      if (!sym) continue;
      const price = Number.isFinite(row.price) ? row.price : null;
      if (price == null) continue;
      out[sym] = {
        price,
        volume: Number.isFinite(row.volume) ? row.volume : 0,
      };
    }
    return out;
  }
```

Change the return statement from:

```js
  return { getQuote, getDailyBars };
```

To:

```js
  return { getQuote, getDailyBars, getQuotesBulk };
```

- [ ] **Step 4.4: Run test to verify it passes**

```bash
node --test discord/fmp-client.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add discord/fmp-client.js discord/fmp-client.test.js
git commit -m "feat(fmp): add getQuotesBulk for batched quote fetching

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Analyst-watchlist listener

Pure-logic functions first (testable in isolation), then the Discord glue.

### Task 5: Create `extractPrice` helper

**Files:**
- Create: `discord/analyst-watchlist.js`
- Create: `discord/analyst-watchlist.test.js`

- [ ] **Step 5.1: Write the failing tests**

Create `discord/analyst-watchlist.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the DB for tests — must come BEFORE any import that touches sqlite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-wl-test-'));
process.env.DATA_DIR = tmpDir;

const { extractPrice } = require('./analyst-watchlist');

test('extractPrice extracts integer dollar amount', () => {
  assert.strictEqual(extractPrice('Watch $200 break'), 200);
});

test('extractPrice extracts decimal price', () => {
  assert.strictEqual(extractPrice('$AAPL @ $200.50'), 200.50);
});

test('extractPrice handles comma-separated thousands', () => {
  assert.strictEqual(extractPrice('BTC at $1,234.56'), 1234.56);
});

test('extractPrice returns first price when several present', () => {
  assert.strictEqual(extractPrice('Entry $200, target $300'), 200);
});

test('extractPrice rejects out-of-range values', () => {
  assert.strictEqual(extractPrice('$0'), null);
  assert.strictEqual(extractPrice('$200000'), null);
  assert.strictEqual(extractPrice('$1000000'), null);
});

test('extractPrice returns null when no $ amount', () => {
  assert.strictEqual(extractPrice('AAPL is bullish'), null);
  assert.strictEqual(extractPrice(''), null);
  assert.strictEqual(extractPrice(null), null);
  assert.strictEqual(extractPrice(undefined), null);
});

test('extractPrice ignores prices embedded in larger numbers', () => {
  // "$200000" → null per range check; "$200.00" → 200 (valid range)
  assert.strictEqual(extractPrice('$200.00'), 200);
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: FAIL with `Cannot find module './analyst-watchlist'`.

- [ ] **Step 5.3: Create the module with `extractPrice`**

Create `discord/analyst-watchlist.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// discord/analyst-watchlist.js — Listener event-driven
// ─────────────────────────────────────────────────────────────────────
// Écoute le canal TRADING_CHANNEL et :
//  1. Stocke TOUS les messages (analystes + bots) dans tracked_messages
//     pour audit.
//  2. Si non-bot ET ticker détecté → seed analyst_watchlist avec le prix
//     mentionné dans le message (ou le prix marché FMP en fallback).
//
// La 1ère mention d'un ticker gagne (INSERT OR IGNORE sur PK ticker).
// Le module milestone-checker.js consomme cette table via le cron 30 min.
// ─────────────────────────────────────────────────────────────────────

// Regex prix : $XX, $XX.XX, $X,XXX.XX (avec virgules de milliers).
// Prend le PREMIER match — convention "prix d'entrée" si plage donnée.
const PRICE_REGEX = /\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)/;

function extractPrice(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = text.match(PRICE_REGEX);
  if (!m) return null;
  const price = parseFloat(m[1].replace(/,/g, ''));
  // Sanity range : 0.01 < prix < 100,000.
  // Filtre les faux positifs (codes ZIP, années en $, prix BTC pris pour stock).
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000) return null;
  return price;
}

module.exports = {
  extractPrice,
};
```

- [ ] **Step 5.4: Run test to verify it passes**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add discord/analyst-watchlist.js discord/analyst-watchlist.test.js
git commit -m "feat(analyst-watchlist): add extractPrice with sanity range

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Implement `handleMessage` — audit path

Stores every message in `tracked_messages`. Seeding logic comes in Task 7.

**Files:**
- Modify: `discord/analyst-watchlist.js`
- Modify: `discord/analyst-watchlist.test.js`

- [ ] **Step 6.1: Write the failing test**

Append to `discord/analyst-watchlist.test.js`:

```js
const db = require('../db/sqlite');
const watchlist = require('./analyst-watchlist');

function fakeMessage({
  id = 'm1',
  channelName = 'trading-floor',
  channelId = 'c1',
  authorId = 'u1',
  authorUsername = 'alice',
  bot = false,
  content = '',
  embeds = [],
  ts = 1700000000000,
} = {}) {
  return {
    id,
    channel: { id: channelId, name: channelName },
    author: { id: authorId, username: authorUsername, bot },
    content,
    embeds,
    createdTimestamp: ts,
  };
}

test('handleMessage audits a non-bot message in trading-floor', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'audit-1',
    content: 'just chatting',
  }));
  const row = db.getTrackedMessage('audit-1');
  assert.ok(row, 'tracked_messages row should exist');
  assert.strictEqual(row.author_username, 'alice');
  assert.strictEqual(row.is_bot, 0);
});

test('handleMessage audits a bot message in trading-floor', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'audit-bot-1',
    bot: true,
    authorUsername: 'TrendVisionWhale',
    content: 'AAPL volume spike',
  }));
  const row = db.getTrackedMessage('audit-bot-1');
  assert.ok(row);
  assert.strictEqual(row.is_bot, 1);
  assert.strictEqual(row.extracted_ticker, 'AAPL');
});

test('handleMessage skips entirely when channel does not match', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'skip-1',
    channelName: 'general',
    content: '$AAPL @ $200',
  }));
  const row = db.getTrackedMessage('skip-1');
  assert.strictEqual(row, null);
});
```

- [ ] **Step 6.2: Run test to verify it fails**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: FAIL with `TypeError: watchlist.handleMessage is not a function`.

- [ ] **Step 6.3: Implement `handleMessage` with the audit path**

Edit `discord/analyst-watchlist.js`. Add imports at top (after the comment header, before `PRICE_REGEX`):

```js
const db = require('../db/sqlite');
const { extractTicker } = require('./screener-ingest');
```

Below `extractPrice`, add the embed serializer and the handler. Replace the existing `module.exports` block with the expanded version below.

```js
// Sérialise les embeds Discord en JSON léger pour stockage. Mirror du
// pattern utilisé dans screener-ingest.js (même format, donc analyses
// cross-table possibles plus tard).
function serializeEmbeds(embeds) {
  if (!Array.isArray(embeds) || embeds.length === 0) return null;
  return embeds.map((e) => ({
    title:       e.title       || e.data?.title       || null,
    description: e.description || e.data?.description || null,
    url:         e.url         || e.data?.url         || null,
    color:       e.color       || e.data?.color       || null,
    image:       e.image?.url     || e.data?.image?.url     || null,
    thumbnail:   e.thumbnail?.url || e.data?.thumbnail?.url || null,
    fields: Array.isArray(e.fields || e.data?.fields)
      ? (e.fields || e.data.fields).map((f) => ({
          name:   f.name   || '',
          value:  f.value  || '',
          inline: !!f.inline,
        }))
      : [],
  }));
}

// Combine content + textes d'embeds pour maximiser le hit rate du
// ticker/price extractor (les bots TrendVision postent souvent en embed).
function combinedSearchText(message) {
  const content = message.content || '';
  const embedJson = serializeEmbeds(message.embeds);
  const embedText = embedJson
    ? embedJson.map(e => (e.title || '') + ' ' + (e.description || '')).join(' ')
    : '';
  return { text: content + ' ' + embedText, embedJson };
}

// Le filtre channel utilise le même pattern que le bot trading existant
// (substring match) — donc pas de nouvelle env var de canal à gérer.
function channelMatches(channelName) {
  if (typeof channelName !== 'string' || channelName.length === 0) return false;
  const target = (process.env.TRADING_CHANNEL || 'trading-floor').toLowerCase();
  return channelName.toLowerCase().includes(target);
}

async function handleMessage(message) {
  if (!message || !message.channel || !message.author) return;
  if (!channelMatches(message.channel.name)) return;

  const { text, embedJson } = combinedSearchText(message);
  const content = (message.content || '').slice(0, 4000);
  const ticker = extractTicker(text);
  const messagePrice = extractPrice(text);

  // Audit : stocke TOUT, analystes + bots.
  db.insertTrackedMessage({
    messageId:       String(message.id),
    channelId:       String(message.channel.id),
    authorId:        String(message.author.id),
    authorUsername:  message.author.username || null,
    isBot:           message.author.bot ? 1 : 0,
    content,
    embedJson:       embedJson ? JSON.stringify(embedJson) : null,
    extractedTicker: ticker,
    extractedPrice:  messagePrice,
    createdAt:       Number(message.createdTimestamp) || Date.now(),
  });
}
```

Replace the bottom `module.exports` with:

```js
module.exports = {
  extractPrice,
  serializeEmbeds,
  handleMessage,
};
```

- [ ] **Step 6.4: Run test to verify it passes**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: all 10 tests pass (7 from Task 5 + 3 new).

- [ ] **Step 6.5: Commit**

```bash
git add discord/analyst-watchlist.js discord/analyst-watchlist.test.js
git commit -m "feat(analyst-watchlist): add handleMessage audit path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add watchlist seeding to `handleMessage`

Adds the seeding branch: non-bot + ticker detected → seed `analyst_watchlist` (with message price or FMP fallback).

**Files:**
- Modify: `discord/analyst-watchlist.js`
- Modify: `discord/analyst-watchlist.test.js`

- [ ] **Step 7.1: Write the failing tests**

Append to `discord/analyst-watchlist.test.js`:

```js
test('handleMessage seeds watchlist for non-bot + ticker + price in message', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'seed-1',
    authorId: 'analyst-1',
    authorUsername: 'alice',
    content: 'Watch $AAPL @ $200 break',
    ts: 1700000111111,
  }));
  const row = db.getWatchlistEntry('AAPL');
  assert.ok(row, 'watchlist entry should exist');
  assert.strictEqual(row.initial_price, 200);
  assert.strictEqual(row.initial_price_source, 'message');
  assert.strictEqual(row.mentioned_by_username, 'alice');
  assert.strictEqual(row.first_seen_at, 1700000111111);
});

test('handleMessage does NOT seed watchlist for bot messages', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'seed-bot-1',
    bot: true,
    content: '$TSLA volume spike at $300',
  }));
  // Audit OK, but no watchlist entry
  assert.ok(db.getTrackedMessage('seed-bot-1'));
  assert.strictEqual(db.getWatchlistEntry('TSLA'), null);
});

test('handleMessage seeds with market price fallback when message has no price', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  const stubMarket = {
    getQuote: async (t) => ({ price: 555.55, volume: 100 }),
  };
  await watchlist.handleMessage(
    fakeMessage({
      id: 'seed-fallback-1',
      content: 'NVDA is the move',
    }),
    { marketClient: stubMarket },
  );
  const row = db.getWatchlistEntry('NVDA');
  assert.ok(row);
  assert.strictEqual(row.initial_price, 555.55);
  assert.strictEqual(row.initial_price_source, 'market');
});

test('handleMessage skips seeding when message has no price AND market fetch fails', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  const failingMarket = {
    getQuote: async () => { throw new Error('FMP down'); },
  };
  await watchlist.handleMessage(
    fakeMessage({
      id: 'seed-fail-1',
      content: 'AMD looking strong',
    }),
    { marketClient: failingMarket },
  );
  // Audit still happens
  assert.ok(db.getTrackedMessage('seed-fail-1'));
  // But no seed
  assert.strictEqual(db.getWatchlistEntry('AMD'), null);
});

test('handleMessage skips seeding when no ticker detected', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'no-ticker',
    content: 'good morning everyone',
  }));
  assert.ok(db.getTrackedMessage('no-ticker'));
  // No watchlist entry created (we'd need to know what to query, just check nothing leaked)
  const active = db.getActiveWatchlist();
  assert.ok(!active.find(r => r.source_message_id === 'no-ticker'));
});

test('handleMessage second mention of same ticker keeps first entry', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  await watchlist.handleMessage(fakeMessage({
    id: 'first-mention',
    authorUsername: 'alice',
    content: '$HOOD @ $20',
    ts: 1700000000000,
  }));
  await watchlist.handleMessage(fakeMessage({
    id: 'second-mention',
    authorUsername: 'bob',
    content: '$HOOD @ $25',
    ts: 1700000999999,
  }));
  const row = db.getWatchlistEntry('HOOD');
  assert.strictEqual(row.initial_price, 20);
  assert.strictEqual(row.mentioned_by_username, 'alice');
  assert.strictEqual(row.source_message_id, 'first-mention');
});
```

- [ ] **Step 7.2: Run test to verify it fails**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: the 6 new tests fail (seeding branch not yet implemented; `marketClient` injection not yet a parameter).

- [ ] **Step 7.3: Implement the seeding branch**

In `discord/analyst-watchlist.js`, replace the `handleMessage` function with this expanded version. (Keep the imports, helpers, and `module.exports` as they are.)

```js
// Hook FMP injecté pour les tests (par défaut : aucun, le caller injectera
// via register()). Pas de require global du client réel ici — il a besoin
// d'une apiKey runtime.
async function handleMessage(message, { marketClient = null } = {}) {
  if (!message || !message.channel || !message.author) return;
  if (!channelMatches(message.channel.name)) return;

  const { text, embedJson } = combinedSearchText(message);
  const content = (message.content || '').slice(0, 4000);
  const ticker = extractTicker(text);
  const messagePrice = extractPrice(text);

  // Audit : stocke TOUT, analystes + bots.
  db.insertTrackedMessage({
    messageId:       String(message.id),
    channelId:       String(message.channel.id),
    authorId:        String(message.author.id),
    authorUsername:  message.author.username || null,
    isBot:           message.author.bot ? 1 : 0,
    content,
    embedJson:       embedJson ? JSON.stringify(embedJson) : null,
    extractedTicker: ticker,
    extractedPrice:  messagePrice,
    createdAt:       Number(message.createdTimestamp) || Date.now(),
  });

  // ── Seeding watchlist : non-bot ET ticker détecté ────────────────
  if (message.author.bot) return;
  if (!ticker) return;

  let initialPrice = messagePrice;
  let priceSource = 'message';
  if (initialPrice == null) {
    if (!marketClient || typeof marketClient.getQuote !== 'function') return;
    try {
      const quote = await marketClient.getQuote(ticker);
      initialPrice = (quote && Number.isFinite(quote.price)) ? quote.price : null;
      priceSource = 'market';
    } catch (err) {
      console.warn('[analyst-watchlist] market fetch failed for ' + ticker
        + ': ' + (err.message || err));
      return;
    }
  }
  if (initialPrice == null) return;

  db.insertWatchlistEntry({
    ticker,
    initialPrice,
    initialPriceSource:  priceSource,
    sourceMessageId:     String(message.id),
    sourceChannelId:     String(message.channel.id),
    mentionedByUserId:   String(message.author.id),
    mentionedByUsername: message.author.username || null,
    firstSeenAt:         Number(message.createdTimestamp) || Date.now(),
  });
}
```

- [ ] **Step 7.4: Run test to verify it passes**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: all 16 tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add discord/analyst-watchlist.js discord/analyst-watchlist.test.js
git commit -m "feat(analyst-watchlist): seed watchlist on non-bot ticker mention

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Add `register(client)` to wire the Discord listener

**Files:**
- Modify: `discord/analyst-watchlist.js`

- [ ] **Step 8.1: Append the `register` function**

In `discord/analyst-watchlist.js`, before `module.exports`, add:

```js
// Wire-up : enregistre le listener messageCreate. Le client FMP est créé
// ici (1 fois par process) à partir de FMP_API_KEY. Si la key est absente,
// on log et on continue sans fallback marché — l'extraction de prix
// depuis le message reste fonctionnelle.
function register(client) {
  if (!client || typeof client.on !== 'function') {
    console.warn('[analyst-watchlist] no client passed, listener not registered');
    return;
  }

  let marketClient = null;
  const apiKey = process.env.FMP_API_KEY || '';
  if (apiKey) {
    try {
      const { createFmpClient } = require('./fmp-client');
      marketClient = createFmpClient({ apiKey });
    } catch (err) {
      console.error('[analyst-watchlist] FMP init failed: ' + err.message);
    }
  } else {
    console.warn('[analyst-watchlist] FMP_API_KEY empty — message-price-only mode');
  }

  client.on('messageCreate', (msg) => {
    handleMessage(msg, { marketClient }).catch((err) =>
      console.error('[analyst-watchlist] handler error: ' + err.message)
    );
  });
  console.log('[analyst-watchlist] listener registered (channel substring: '
    + (process.env.TRADING_CHANNEL || 'trading-floor') + ')');
}
```

Update `module.exports` to include `register`:

```js
module.exports = {
  extractPrice,
  serializeEmbeds,
  handleMessage,
  register,
};
```

- [ ] **Step 8.2: Smoke test (module loads without error)**

```bash
node -e "const m = require('./discord/analyst-watchlist'); console.log(Object.keys(m).join(','))"
```

Expected output: `extractPrice,serializeEmbeds,handleMessage,register`.

- [ ] **Step 8.3: Verify existing tests still pass**

```bash
node --test discord/analyst-watchlist.test.js
```

Expected: 16 tests pass (no regressions).

- [ ] **Step 8.4: Commit**

```bash
git add discord/analyst-watchlist.js
git commit -m "feat(analyst-watchlist): add register(client) listener wire-up

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Milestone checker (cron)

Pure-logic functions first (`nextMilestone`, `buildAlertMessage`), then the orchestrating `tick`.

### Task 9: Create `nextMilestone`

**Files:**
- Create: `discord/milestone-checker.js`
- Create: `discord/milestone-checker.test.js`

- [ ] **Step 9.1: Write the failing tests**

Create `discord/milestone-checker.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate DB for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'milestone-test-'));
process.env.DATA_DIR = tmpDir;

const { nextMilestone } = require('./milestone-checker');

const DEFAULT_MILESTONES = [20, 50, 100, 200, 300, 500, 1000];

test('nextMilestone returns null when gain below first milestone', () => {
  assert.strictEqual(nextMilestone(15, null, DEFAULT_MILESTONES), null);
});

test('nextMilestone returns first milestone when gain >= 20 and lastFired is null', () => {
  assert.strictEqual(nextMilestone(25, null, DEFAULT_MILESTONES), 20);
});

test('nextMilestone returns null when next milestone not yet reached', () => {
  assert.strictEqual(nextMilestone(25, 20, DEFAULT_MILESTONES), null);
});

test('nextMilestone returns 50 when gain=60 and lastFired=20', () => {
  assert.strictEqual(nextMilestone(60, 20, DEFAULT_MILESTONES), 50);
});

test('nextMilestone returns 200 when gain=250 and lastFired=100', () => {
  assert.strictEqual(nextMilestone(250, 100, DEFAULT_MILESTONES), 200);
});

test('nextMilestone returns highest reached milestone above lastFired', () => {
  // gain=350, lastFired=20 → next is 50 (not 300), to avoid skipping milestones
  assert.strictEqual(nextMilestone(350, 20, DEFAULT_MILESTONES), 50);
});

test('nextMilestone returns null when all milestones exhausted', () => {
  assert.strictEqual(nextMilestone(2000, 1000, DEFAULT_MILESTONES), null);
});

test('nextMilestone handles non-default thresholds', () => {
  assert.strictEqual(nextMilestone(15, null, [10, 30, 100]), 10);
  assert.strictEqual(nextMilestone(15, 10, [10, 30, 100]), null);
  assert.strictEqual(nextMilestone(35, 10, [10, 30, 100]), 30);
});
```

- [ ] **Step 9.2: Run test to verify it fails**

```bash
node --test discord/milestone-checker.test.js
```

Expected: FAIL with `Cannot find module './milestone-checker'`.

- [ ] **Step 9.3: Implement `nextMilestone`**

Create `discord/milestone-checker.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// discord/milestone-checker.js — Cron tick paliers de gain
// ─────────────────────────────────────────────────────────────────────
// Toutes les 30 min (pendant RTH US), lit analyst_watchlist, fetch les
// prix FMP en bulk, calcule le gain cumulé par ticker et déclenche une
// alerte Discord (reply sous le message d'origine) au prochain palier
// non-tiré, sous réserve d'un cooldown 1h depuis la dernière alerte du
// même ticker.
//
// Mark-then-send atomique : INSERT OR IGNORE dans milestone_alerts avant
// le reply Discord. Si l'insert échoue (UNIQUE constraint), un autre tick
// a déjà tiré ce palier → on skip. Si l'insert réussit mais le reply
// Discord échoue, on perd l'alerte plutôt que de spammer au tick suivant.
// ─────────────────────────────────────────────────────────────────────

// Trouve le prochain palier strictement > lastFired ET ≤ gainPct.
// Retour null = rien à tirer pour ce ticker à ce tick.
// Note : on retourne le PREMIER palier passé, pas le dernier — donc
// si gain=350 et lastFired=20, on tire 50 (pas 300). Évite de skip les
// paliers intermédiaires si le marché bouge vite entre 2 ticks.
function nextMilestone(gainPct, lastFiredPct, milestones) {
  if (!Number.isFinite(gainPct)) return null;
  const list = Array.isArray(milestones) ? milestones : [];
  const lower = (lastFiredPct == null) ? -Infinity : Number(lastFiredPct);
  for (const m of list) {
    if (m > lower && gainPct >= m) return m;
  }
  return null;
}

module.exports = {
  nextMilestone,
};
```

- [ ] **Step 9.4: Run test to verify it passes**

```bash
node --test discord/milestone-checker.test.js
```

Expected: all 8 tests pass.

- [ ] **Step 9.5: Commit**

```bash
git add discord/milestone-checker.js discord/milestone-checker.test.js
git commit -m "feat(milestone-checker): add nextMilestone pure helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Add `buildAlertMessage`

**Files:**
- Modify: `discord/milestone-checker.js`
- Modify: `discord/milestone-checker.test.js`

- [ ] **Step 10.1: Write the failing test**

Append to `discord/milestone-checker.test.js`:

```js
const { buildAlertMessage } = require('./milestone-checker');

test('buildAlertMessage produces the canonical English reply', () => {
  const msg = buildAlertMessage({
    ticker: 'AAPL',
    milestonePct: 20,
    initialPrice: 200,
    currentPrice: 240,
    gainPct: 20,
    mentionedByUsername: 'alice',
  });
  assert.strictEqual(
    msg,
    '🚀 **$AAPL** hit **+20%** milestone — now $240.00 (entry $200.00, gain +20.00%) — first flagged by @alice'
  );
});

test('buildAlertMessage uses fallback username when missing', () => {
  const msg = buildAlertMessage({
    ticker: 'TSLA',
    milestonePct: 100,
    initialPrice: 100,
    currentPrice: 200,
    gainPct: 100,
    mentionedByUsername: null,
  });
  assert.ok(msg.endsWith('first flagged by @analyst'));
});

test('buildAlertMessage formats decimal prices to 2 places', () => {
  const msg = buildAlertMessage({
    ticker: 'HOOD',
    milestonePct: 50,
    initialPrice: 12.345,
    currentPrice: 18.555,
    gainPct: 50.31,
    mentionedByUsername: 'bob',
  });
  assert.ok(msg.includes('$18.56'));
  assert.ok(msg.includes('entry $12.35'));
  assert.ok(msg.includes('gain +50.31%'));
});
```

- [ ] **Step 10.2: Run test to verify it fails**

```bash
node --test discord/milestone-checker.test.js
```

Expected: FAIL with `TypeError: buildAlertMessage is not a function`.

- [ ] **Step 10.3: Implement `buildAlertMessage`**

In `discord/milestone-checker.js`, before `module.exports`, add:

```js
// Format anglais (cf memory feedback : bot replies en EN).
// Mention `@username` en plain text — le caller met allowedMentions:[]
// pour empêcher Discord de ping l'utilisateur à chaque palier.
function buildAlertMessage({
  ticker, milestonePct, initialPrice, currentPrice, gainPct, mentionedByUsername,
}) {
  const name = mentionedByUsername || 'analyst';
  return '🚀 **$' + ticker + '** hit **+' + milestonePct + '%** milestone — '
    + 'now $' + Number(currentPrice).toFixed(2)
    + ' (entry $' + Number(initialPrice).toFixed(2)
    + ', gain +' + Number(gainPct).toFixed(2) + '%) — '
    + 'first flagged by @' + name;
}
```

Update `module.exports`:

```js
module.exports = {
  nextMilestone,
  buildAlertMessage,
};
```

- [ ] **Step 10.4: Run test to verify it passes**

```bash
node --test discord/milestone-checker.test.js
```

Expected: 11 tests pass.

- [ ] **Step 10.5: Commit**

```bash
git add discord/milestone-checker.js discord/milestone-checker.test.js
git commit -m "feat(milestone-checker): add buildAlertMessage (English plain text)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Implement `tick(client, now, deps)` orchestration

The full orchestration. Uses dependency injection (`deps`) so tests can stub `db`, `marketClient`, and `isRTH`.

**Files:**
- Modify: `discord/milestone-checker.js`
- Modify: `discord/milestone-checker.test.js`

- [ ] **Step 11.1: Write the failing tests**

Append to `discord/milestone-checker.test.js`:

```js
const { tick } = require('./milestone-checker');

// Tiny fake DB capturing calls and configurable state.
function makeFakeDb({ active = [], archiveReturns = 0 } = {}) {
  const calls = {
    insertMilestoneAlert: [],
    updateWatchlistAfterAlert: [],
    archiveExpiredWatchlist: [],
  };
  const fired = new Set();  // tracks (ticker, milestone) tuples
  return {
    archiveExpiredWatchlist(cutoff, now) {
      calls.archiveExpiredWatchlist.push({ cutoff, now });
      return archiveReturns;
    },
    getActiveWatchlist() { return active; },
    insertMilestoneAlert(entry) {
      const key = entry.ticker + '|' + entry.milestonePct;
      calls.insertMilestoneAlert.push(entry);
      if (fired.has(key)) return false;
      fired.add(key);
      return true;
    },
    updateWatchlistAfterAlert(entry) {
      calls.updateWatchlistAfterAlert.push(entry);
    },
    _calls: calls,
  };
}

// Minimal fake Discord client + channel + message that returns the reply.
function makeFakeDiscord({ replyId = 'reply-1', failFetch = false } = {}) {
  const replies = [];
  const channel = {
    messages: {
      fetch: async (id) => {
        if (failFetch) throw new Error('source message gone');
        return {
          reply: async ({ content }) => {
            replies.push({ messageId: id, content });
            return { id: replyId };
          },
        };
      },
    },
  };
  return {
    channels: { fetch: async () => channel },
    _replies: replies,
  };
}

const SAMPLE_ENTRY = {
  ticker: 'AAPL',
  initial_price: 200,
  source_message_id: 'src-1',
  source_channel_id: 'chan-1',
  mentioned_by_username: 'alice',
  first_seen_at: 1700000000000,
  last_milestone_pct: null,
  last_alert_at: null,
};

test('tick is a no-op outside RTH', async () => {
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => { throw new Error('should not call'); } };
  const fakeClient = makeFakeDiscord();
  await tick(fakeClient, 1700000000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => false,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 0);
  assert.strictEqual(fakeClient._replies.length, 0);
});

test('tick fires +20 milestone when gain reaches 25%', async () => {
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
  const fakeClient = makeFakeDiscord({ replyId: 'rep-aapl-20' });
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 1);
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert[0].milestonePct, 20);
  assert.strictEqual(fakeClient._replies.length, 1);
  assert.ok(fakeClient._replies[0].content.includes('+20%'));
  // updateWatchlistAfterAlert must have been called with the reply id
  assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
  assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert[0].lastMilestonePct, 20);
});

test('tick respects cooldown', async () => {
  const now = 1700001000000;
  const entry = { ...SAMPLE_ENTRY, last_milestone_pct: 20, last_alert_at: now - 1000 };
  const fakeDb = makeFakeDb({ active: [entry] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 300, volume: 1 } }) };
  const fakeClient = makeFakeDiscord();
  await tick(fakeClient, now, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 0);
  assert.strictEqual(fakeClient._replies.length, 0);
});

test('tick fires next milestone after cooldown', async () => {
  const now = 1700005000000;
  const entry = { ...SAMPLE_ENTRY, last_milestone_pct: 20, last_alert_at: now - 4_000_000 };
  const fakeDb = makeFakeDb({ active: [entry] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 300, volume: 1 } }) };
  const fakeClient = makeFakeDiscord({ replyId: 'rep-aapl-50' });
  await tick(fakeClient, now, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert[0].milestonePct, 50);
  assert.strictEqual(fakeClient._replies.length, 1);
});

test('tick handles FMP bulk failure without throwing', async () => {
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => { throw new Error('FMP down'); } };
  const fakeClient = makeFakeDiscord();
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 0);
  assert.strictEqual(fakeClient._replies.length, 0);
});

test('tick skips ticker missing from FMP response', async () => {
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => ({}) };  // empty
  const fakeClient = makeFakeDiscord();
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 0);
});

test('tick does not call FMP when watchlist is empty', async () => {
  const fakeDb = makeFakeDb({ active: [] });
  const fakeMarket = { getQuotesBulk: async () => { throw new Error('should not call'); } };
  const fakeClient = makeFakeDiscord();
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  // No throw, no insert.
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 0);
});

test('tick archives expired entries before polling', async () => {
  const now = 1700_000_000_000;
  const fakeDb = makeFakeDb({ active: [], archiveReturns: 3 });
  const fakeMarket = { getQuotesBulk: async () => ({}) };
  const fakeClient = makeFakeDiscord();
  const ttl = 30 * 86400_000;
  await tick(fakeClient, now, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: ttl,
  });
  assert.strictEqual(fakeDb._calls.archiveExpiredWatchlist.length, 1);
  assert.strictEqual(fakeDb._calls.archiveExpiredWatchlist[0].cutoff, now - ttl);
});

test('tick keeps milestone_alerts row even when Discord reply fails', async () => {
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
  const fakeClient = makeFakeDiscord({ failFetch: true });
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  // Mark-then-send: insert happened, but no reply and no watchlist update.
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 1);
  assert.strictEqual(fakeClient._replies.length, 0);
  assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 0);
});
```

- [ ] **Step 11.2: Run test to verify it fails**

```bash
node --test discord/milestone-checker.test.js
```

Expected: FAIL with `TypeError: tick is not a function`.

- [ ] **Step 11.3: Implement `tick`**

In `discord/milestone-checker.js`, before `module.exports`, add:

```js
// Parse les paliers depuis l'env var (CSV d'entiers positifs, trié).
function parseMilestones(raw, fallback) {
  const parsed = String(raw || '').split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : fallback;
}

// Lit la config depuis process.env avec des défauts sains. Exposé pour
// les tests qui peuvent override.
function readConfig() {
  return {
    milestones: parseMilestones(
      process.env.MILESTONE_THRESHOLDS,
      [20, 50, 100, 200, 300, 500, 1000],
    ),
    cooldownMs: Math.max(0, parseFloat(process.env.MILESTONE_COOLDOWN_HOURS || '1')) * 3600_000,
    ttlMs:      Math.max(1, parseInt(process.env.WATCHLIST_TTL_DAYS || '30', 10)) * 86400_000,
  };
}

async function tick(client, nowMs, deps = {}) {
  const db = deps.db || require('../db/sqlite');
  const isRTH = deps.isRTH || require('./market-alerts').isRTH;
  const marketClient = deps.marketClient;  // required at runtime
  const cfg = readConfig();
  const milestones = deps.milestones || cfg.milestones;
  const cooldownMs = (deps.cooldownMs != null) ? deps.cooldownMs : cfg.cooldownMs;
  const ttlMs      = (deps.ttlMs      != null) ? deps.ttlMs      : cfg.ttlMs;

  const now = Number(nowMs) || Date.now();

  // RTH guard — pas de poll hors marché US régulier.
  if (!isRTH(new Date(now))) return;

  // Archive les entrées trop anciennes AVANT de poll → pas de quota FMP gaspillé.
  try {
    db.archiveExpiredWatchlist(now - ttlMs, now);
  } catch (err) {
    console.error('[milestone-checker] archive failed: ' + err.message);
  }

  const entries = db.getActiveWatchlist();
  if (!Array.isArray(entries) || entries.length === 0) return;

  // Pas de marketClient = pas de poll possible.
  if (!marketClient || typeof marketClient.getQuotesBulk !== 'function') {
    console.warn('[milestone-checker] no marketClient available, skipping tick');
    return;
  }

  const tickers = [...new Set(entries.map(e => e.ticker))];
  let quotes;
  try {
    quotes = await marketClient.getQuotesBulk(tickers);
  } catch (err) {
    console.error('[milestone-checker] FMP bulk failed: ' + err.message);
    return;
  }

  for (const entry of entries) {
    const quote = quotes[entry.ticker];
    if (!quote || !Number.isFinite(quote.price)) continue;

    const gainPct = ((quote.price - entry.initial_price) / entry.initial_price) * 100;
    const target = nextMilestone(gainPct, entry.last_milestone_pct, milestones);
    if (target == null) continue;

    if (entry.last_alert_at != null && (now - entry.last_alert_at) < cooldownMs) continue;

    // Mark-then-send atomique : si UNIQUE bloque (palier déjà tiré),
    // insertMilestoneAlert renvoie false → on skip.
    const fired = db.insertMilestoneAlert({
      ticker: entry.ticker,
      milestonePct: target,
      initialPrice: entry.initial_price,
      currentPrice: quote.price,
      gainPct,
      firedAt: now,
      discordMessageId: null,
    });
    if (!fired) continue;

    // Reply Discord. Si fail (msg supprimé, perms), on garde l'insert :
    // perdre 1 alerte vaut mieux qu'en spammer au tick suivant.
    try {
      const channel = await client.channels.fetch(entry.source_channel_id);
      const sourceMsg = await channel.messages.fetch(entry.source_message_id);
      const text = buildAlertMessage({
        ticker: entry.ticker,
        milestonePct: target,
        initialPrice: entry.initial_price,
        currentPrice: quote.price,
        gainPct,
        mentionedByUsername: entry.mentioned_by_username,
      });
      const reply = await sourceMsg.reply({
        content: text,
        allowedMentions: { parse: [] },
      });
      db.updateWatchlistAfterAlert({
        ticker: entry.ticker,
        lastMilestonePct: target,
        lastAlertAt: now,
      });
    } catch (err) {
      console.error('[milestone-checker] reply failed for ' + entry.ticker
        + ': ' + err.message);
    }
  }
}
```

Update `module.exports`:

```js
module.exports = {
  nextMilestone,
  buildAlertMessage,
  tick,
  // exposed for tests
  parseMilestones,
  readConfig,
};
```

- [ ] **Step 11.4: Run test to verify it passes**

```bash
node --test discord/milestone-checker.test.js
```

Expected: 20 tests pass (8 + 3 + 9 new).

- [ ] **Step 11.5: Smoke test (module loads without error)**

```bash
node -e "const m = require('./discord/milestone-checker'); console.log(Object.keys(m).join(','))"
```

Expected output: `nextMilestone,buildAlertMessage,tick,parseMilestones,readConfig`.

- [ ] **Step 11.6: Commit**

```bash
git add discord/milestone-checker.js discord/milestone-checker.test.js
git commit -m "feat(milestone-checker): orchestrating tick with mark-then-send

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Wiring + config

Hook the listener into `index.js` and the cron tick into `discord/jobs.js`. Document new env vars.

### Task 12: Register the listener in `index.js`

**Files:**
- Modify: `index.js`

- [ ] **Step 12.1: Add the require at the top**

Open `index.js`. Locate the existing line (around line 73):

```js
const { register: registerScreenerIngest } = require('./discord/screener-ingest');
```

Below it, add:

```js
const { register: registerAnalystWatchlist } = require('./discord/analyst-watchlist');
```

- [ ] **Step 12.2: Call the registration after `registerScreenerIngest`**

Locate the existing line (around line 450):

```js
  registerScreenerIngest(client);
```

Immediately below it (inside the same scope), add:

```js
  // Watchlist auto-alimentée par les mentions analystes dans TRADING_CHANNEL.
  // Audit complet (analystes + bots) dans tracked_messages ; seed
  // analyst_watchlist seulement pour les non-bots avec ticker détecté.
  registerAnalystWatchlist(client);
```

- [ ] **Step 12.3: Smoke test the require chain**

```bash
node -e "require('./discord/analyst-watchlist'); console.log('analyst-watchlist loads ok')"
```

Expected output: `analyst-watchlist loads ok`.

Then check `index.js` parses without error:

```bash
node --check index.js
```

Expected: no output (success).

- [ ] **Step 12.4: Commit**

```bash
git add index.js
git commit -m "feat(index): register analyst-watchlist listener at client ready

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Wire the cron tick into `discord/jobs.js`

**Files:**
- Modify: `discord/jobs.js`

- [ ] **Step 13.1: Add the require near the top**

In `discord/jobs.js`, locate the imports (around line 33-34):

```js
const { createMarketAlertsScheduler, registerMarketAlertCommands } = require('./market-alerts');
const { createFmpClient } = require('./fmp-client');
```

Below them, add:

```js
const milestoneChecker = require('./milestone-checker');
```

- [ ] **Step 13.2: Add a module-level state flag**

Below the existing `let lastSummaryDate = null;` and `let lastBackupDate = null;` (around line 38-39), add:

```js
// Used to throttle milestone-checker ticks to the configured cadence.
let lastMilestoneTickMin = null;
```

- [ ] **Step 13.3: Add the tick dispatch inside the `setInterval` loop**

Locate the existing market-alerts dispatch inside the `setInterval` callback (around line 289-292):

```js
      if (marketAlerts && now.getMinutes() % intervalMin === 0) {
        marketAlerts.tick(now).catch(err =>
          console.error('[market-alerts] tick failed:', err.message));
      }
```

Immediately after that block (still inside the `setInterval` callback), add:

```js
      // Milestone checker — cadence configurable (défaut 30 min).
      // Le tick lui-même filtre RTH, donc fire-and-forget. On déduplique
      // par minute pour éviter de fire 2× dans la même minute cible.
      const milestoneIntervalMin = Math.max(1, parseInt(
        process.env.MILESTONE_POLL_INTERVAL_MIN || '30', 10) || 30);
      const minuteKey = now.getHours() * 60 + now.getMinutes();
      if (now.getMinutes() % milestoneIntervalMin === 0
          && lastMilestoneTickMin !== minuteKey) {
        lastMilestoneTickMin = minuteKey;
        const fmpKeyForMilestone = process.env.FMP_API_KEY || '';
        if (fmpKeyForMilestone) {
          let milestoneMarketClient = null;
          try {
            milestoneMarketClient = createFmpClient({ apiKey: fmpKeyForMilestone });
          } catch (err) {
            console.error('[milestone-checker] FMP init failed:', err.message);
          }
          if (milestoneMarketClient) {
            milestoneChecker.tick(client, now.getTime(), {
              marketClient: milestoneMarketClient,
            }).catch(err =>
              console.error('[milestone-checker] tick failed:', err.message));
          }
        }
      }
```

- [ ] **Step 13.4: Smoke test the require chain**

```bash
node --check discord/jobs.js
```

Expected: no output (success).

```bash
node -e "require('./discord/jobs'); console.log('jobs.js loads ok')"
```

Expected output: `jobs.js loads ok`.

- [ ] **Step 13.5: Verify the milestone-checker tests still pass**

```bash
node --test discord/milestone-checker.test.js
```

Expected: 20 tests pass.

- [ ] **Step 13.6: Commit**

```bash
git add discord/jobs.js
git commit -m "feat(jobs): wire milestone-checker tick into 30-min scheduler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Document new env vars in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 14.1: Append the new env block**

Open `.env.example` and append at the very bottom (after `TOB_START_HERE_CHANNEL_ID=`):

```env

# === ANALYST WATCHLIST + MILESTONE ALERTS ============================
# Watchlist auto-alimentée par les mentions de tickers d'analystes dans
# TRADING_CHANNEL. Polling marché 30 min (RTH only) — alerte Discord aux
# paliers de gain cumulé. Tous les messages (analystes + bots TrendVision)
# sont stockés dans la table tracked_messages pour audit ; seuls les
# messages non-bot seedent la watchlist active.
#
# Toutes les variables sont OPTIONNELLES — défauts sensés ci-dessous.
# Le module reste actif tant que TRADING_CHANNEL (déjà obligatoire) est
# défini. Le fallback prix marché nécessite FMP_API_KEY (déjà utilisé
# par market-alerts).

# Paliers de gain (% cumulé) qui déclenchent une alerte Discord. CSV
# d'entiers positifs strictement croissants. Défaut couvre les
# multibaggers classiques (1.2× → 11×). Chaque palier ne fire qu'une
# seule fois par ticker (dedup atomique via UNIQUE en DB).
MILESTONE_THRESHOLDS=20,50,100,200,300,500,1000

# Délai minimum (heures, float accepté) entre 2 alertes du même ticker,
# même si plusieurs paliers sont franchis pendant la fenêtre. Évite le
# spam sur les pumps intraday.
MILESTONE_COOLDOWN_HOURS=1

# TTL : après N jours sans nouveau palier, l'entrée est soft-archivée
# (archived_at set, ligne préservée pour audit). L'archive est faite
# au début de chaque tick.
WATCHLIST_TTL_DAYS=30

# Cadence du polling FMP (minutes). 30 = un tick toutes les 30 min.
# Le tick filtre lui-même les heures de marché US (RTH 09:30–16:00 ET).
MILESTONE_POLL_INTERVAL_MIN=30
```

- [ ] **Step 14.2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document analyst-watchlist and milestone env vars

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

### Task 15: Full smoke check

- [ ] **Step 15.1: Run the entire test suite**

```bash
npm test
```

Expected: all tests pass, including the new ones (no regressions in pre-existing tests).

- [ ] **Step 15.2: Verify the bot loads cleanly without crashing**

This is a syntax/require-graph smoke check only — does **not** connect to Discord (no `DISCORD_TOKEN`):

```bash
node --check index.js
```

Expected: no output.

```bash
node -e "process.env.DISCORD_TOKEN=''; const ix = require.resolve('./index.js'); console.log('require resolves at', ix)"
```

Expected: prints the resolved path (proves the module graph compiles).

- [ ] **Step 15.3: Confirm git log shows the 14-step trail**

```bash
git log --oneline -20
```

Expected: 14 new commits ahead of `ab2c6de` (the base), each tagged with its phase.

---

## Manual steps for the operator (call out explicitly)

These cannot be done by the implementing agent. Flag them in the final report.

1. **No Discord Developer Portal change required** — the `Message Content Intent` is already enabled for the existing `TRADING_CHANNEL` listener.
2. **Railway env vars** (optional — defaults are sensible):
   - `MILESTONE_THRESHOLDS=20,50,100,200,300,500,1000`
   - `MILESTONE_COOLDOWN_HOURS=1`
   - `WATCHLIST_TTL_DAYS=30`
   - `MILESTONE_POLL_INTERVAL_MIN=30`
3. **FMP quota check**: the milestone tick runs at most twice per hour during RTH (≈ 13 bulk calls/day, regardless of watchlist size up to 250 tickers). Free-tier (250 req/day) is plenty.
4. **First-run verification**: post a real ticker mention in `#trading-floor` and verify:
   - A row appears in `analyst_watchlist` (inspect via `db/sqlite.js` connect or a query script)
   - At the next `:00` or `:30` of an RTH minute, the cron logs `[milestone-checker] tick failed` (if anything wrong) or no log (if no milestone reached)
   - If the price moves +20%, the bot replies under the original message
