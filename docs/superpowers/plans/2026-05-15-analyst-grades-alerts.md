# Wall Street Analyst Grade Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll FMP's analyst-grades RSS feed every 15 min during US market hours, evaluate each event against a two-tier filter (watchlist OR tier-1 firm with strong move), and post matching upgrades/downgrades/initiations to Discord with atomic dedup.

**Architecture:** New module `discord/analyst-grades-feed.js` exposes pure helpers (`gradeRank`, `deriveAction`, `eventId`, `evaluate`, `buildMessage`) plus a `createAnalystGradesPoller` with a `tick()` method. New `analyst_grade_alerts` SQLite table + 2 helpers in `db/sqlite.js`. New `getAnalystGradesFeed()` method on `discord/fmp-client.js`. Scheduler wired in `discord/jobs.js` behind `ANALYST_ALERTS_ENABLED`.

**Tech Stack:** Node.js, `better-sqlite3`, `node:test`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-15-analyst-grades-alerts-design.md](../specs/2026-05-15-analyst-grades-alerts-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `discord/fmp-client.js` | Modify | Add `getAnalystGradesFeed({ page })` method that queries `/api/v4/upgrades-downgrades-rss-feed`. |
| `discord/fmp-client.test.js` | Modify | Append 3 tests for the new method. |
| `db/sqlite.js` | Modify | Add `analyst_grade_alerts` table to schema bootstrap + 2 helpers (`markAnalystGradeFired`, `getAnalystWatchlistTickers`). |
| `db/sqlite.test.js` | Modify | Add tests for the 2 new helpers (if test file exists; otherwise create `db/analyst-grades.test.js`). |
| `discord/analyst-grades-feed.js` | Create | Pure helpers (`GRADE_RANK`, `gradeRank`, `deriveAction`, `eventId`, `evaluate`, `buildMessage`) + `createAnalystGradesPoller({...}).tick()`. |
| `discord/analyst-grades-feed.test.js` | Create | Unit tests covering all helpers + integration tick test with mocked dependencies. |
| `discord/jobs.js` | Modify | Wire the poller behind `ANALYST_ALERTS_ENABLED=true`. Tick every `ANALYST_ALERTS_INTERVAL_MIN` (default 15) during RTH + one 06:00 ET pre-market tick. |
| `.env.example` | Modify | Document `ANALYST_ALERTS_ENABLED`, `TIER_1_FIRMS`, `ANALYST_ALERTS_INTERVAL_MIN`. |

---

## Task 1: Add `getAnalystGradesFeed` to `discord/fmp-client.js`

The new method calls `https://financialmodelingprep.com/api/v4/upgrades-downgrades-rss-feed?apikey=KEY&page=0` and returns the parsed array of grade events. FMP base URL constant is `/api/v3`, so this method constructs the v4 URL by stripping the version segment.

**Files:**
- Modify: `discord/fmp-client.js`
- Modify: `discord/fmp-client.test.js`

- [ ] **Step 1: Write failing tests**

Append to `discord/fmp-client.test.js`:

```javascript
test('getAnalystGradesFeed hits v4 upgrades-downgrades-rss-feed with apikey + page', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => [
        { symbol: 'AAPL', publishedDate: '2026-05-15T12:00:00Z',
          gradingCompany: 'Morgan Stanley',
          newGrade: 'Buy', previousGrade: 'Hold',
          priceTarget: 200, priceWhenPosted: 180,
          newsURL: 'https://example.com/article-1', action: 'upgrade' },
      ],
    };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const rows = await client.getAnalystGradesFeed({ page: 0 });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /^https:\/\/financialmodelingprep\.com\/api\/v4\/upgrades-downgrades-rss-feed\?/);
  assert.match(calls[0], /apikey=TEST/);
  assert.match(calls[0], /page=0/);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].symbol, 'AAPL');
});

test('getAnalystGradesFeed defaults page to 0 when no argument passed', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [] };
  };
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  await client.getAnalystGradesFeed();
  assert.match(calls[0], /page=0/);
});

test('getAnalystGradesFeed returns [] on non-array response', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: 'whatever' }) });
  const client = createFmpClient({ apiKey: 'TEST', fetchImpl });
  const rows = await client.getAnalystGradesFeed();
  assert.deepStrictEqual(rows, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/fmp-client.test.js`
Expected: FAIL — `client.getAnalystGradesFeed is not a function`.

- [ ] **Step 3: Add the method in `discord/fmp-client.js`**

Find the existing `getQuotesBulk` function (around lines 174-198). Immediately AFTER `getQuotesBulk`'s closing brace and BEFORE the `return { getQuote, getDailyBars, getQuotesBulk };` line, add:

```javascript
  // FMP v4 endpoint — different base path. Returns the global feed of
  // recent analyst grade events (upgrades, downgrades, initiations,
  // reiterations) newest-first. Pagination via `page` (default 0 →
  // ~100 most recent events).
  async function getAnalystGradesFeed({ page = 0 } = {}) {
    const v4Base = base.replace(/\/v3\/?$/, '/v4');
    const url = v4Base + '/upgrades-downgrades-rss-feed?page=' + encodeURIComponent(page)
      + '&apikey=' + encodeURIComponent(apiKey);
    const json = await httpJson(url);
    return Array.isArray(json) ? json : [];
  }
```

Then update the return statement:

```javascript
  return { getQuote, getDailyBars, getQuotesBulk, getAnalystGradesFeed };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/fmp-client.test.js`
Expected: All previously-passing tests + 3 new tests = PASS.

- [ ] **Step 5: Commit**

```bash
git add discord/fmp-client.js discord/fmp-client.test.js
git commit -m "feat(fmp-client): add getAnalystGradesFeed (v4 RSS feed)

Wraps GET /api/v4/upgrades-downgrades-rss-feed?page=N for the
upcoming analyst grade alerts module.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add DB table + helpers in `db/sqlite.js`

Create the `analyst_grade_alerts` table for atomic dedup. Add `markAnalystGradeFired` (INSERT OR IGNORE returning bool) and `getAnalystWatchlistTickers` (reads existing `analyst_watchlist` table, returns active uppercase ticker set).

**Files:**
- Modify: `db/sqlite.js`
- Create: `db/analyst-grades.test.js`

- [ ] **Step 1: Write failing tests**

Create `db/analyst-grades.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const db = require('./sqlite');

function resetTable() {
  db.db.exec('DELETE FROM analyst_grade_alerts');
}

test('markAnalystGradeFired inserts on first call and returns true', () => {
  resetTable();
  const result = db.markAnalystGradeFired({
    event_id: 'evt-1', ticker: 'AAPL', ts: '2026-05-15T12:00:00Z',
    firm: 'Morgan Stanley', action: 'upgrade',
    new_grade: 'Buy', prev_grade: 'Hold',
    source: 'watchlist', fired_at: '2026-05-15T12:00:01Z',
  });
  assert.strictEqual(result, true);
});

test('markAnalystGradeFired returns false on duplicate event_id', () => {
  resetTable();
  const payload = {
    event_id: 'evt-dup', ticker: 'AAPL', ts: '2026-05-15T12:00:00Z',
    firm: 'Morgan Stanley', action: 'upgrade',
    new_grade: 'Buy', prev_grade: 'Hold',
    source: 'watchlist', fired_at: '2026-05-15T12:00:01Z',
  };
  db.markAnalystGradeFired(payload);
  const second = db.markAnalystGradeFired(payload);
  assert.strictEqual(second, false);
});

test('markAnalystGradeFired accepts null prev_grade (initiations)', () => {
  resetTable();
  const result = db.markAnalystGradeFired({
    event_id: 'evt-init', ticker: 'ARM', ts: '2026-05-15T12:00:00Z',
    firm: 'JPMorgan', action: 'initiate',
    new_grade: 'Overweight', prev_grade: null,
    source: 'tier1-global', fired_at: '2026-05-15T12:00:01Z',
  });
  assert.strictEqual(result, true);
});

test('getAnalystWatchlistTickers returns a Set of UPPERCASE strings', () => {
  // The analyst_watchlist table is populated by analyst-watchlist.js. Tests
  // here just verify the SHAPE of the return value: a Set, all UPPERCASE strings.
  const result = db.getAnalystWatchlistTickers();
  assert.ok(result instanceof Set, 'should return a Set');
  for (const t of result) {
    assert.strictEqual(typeof t, 'string');
    assert.strictEqual(t, t.toUpperCase(), 'tickers should be uppercase');
  }
});

test('cleanup: empty the analyst_grade_alerts table', () => {
  resetTable();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test db/analyst-grades.test.js`
Expected: FAIL — either `no such table: analyst_grade_alerts` (table missing) or `db.markAnalystGradeFired is not a function`.

- [ ] **Step 3: Add the table to the schema bootstrap**

Open `db/sqlite.js`. Find the existing `CREATE TABLE IF NOT EXISTS milestone_alerts` block (around line 460):

```javascript
  CREATE TABLE IF NOT EXISTS milestone_alerts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT NOT NULL,
    milestone_pct       INTEGER NOT NULL,
    ...
    UNIQUE (ticker, milestone_pct)
  );
```

Immediately AFTER the entire `milestone_alerts` block (look for its closing `);` and following blank line, before the next table), insert:

```sql

  -- Wall Street analyst grade alerts dedup table. Mirrors milestone_alerts
  -- pattern: INSERT OR IGNORE on event_id PK = atomic mark-then-send.
  CREATE TABLE IF NOT EXISTS analyst_grade_alerts (
    event_id    TEXT PRIMARY KEY,
    ticker      TEXT NOT NULL,
    ts          TEXT NOT NULL,
    firm        TEXT NOT NULL,
    action      TEXT NOT NULL,
    new_grade   TEXT,
    prev_grade  TEXT,
    source      TEXT NOT NULL,
    fired_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analyst_grade_alerts_ts ON analyst_grade_alerts(ts);
```

- [ ] **Step 4: Add the prepared statements + helpers**

In `db/sqlite.js`, find the existing `markAlertFired` function (around line 1500). Immediately AFTER its closing brace (and any blank line that follows), add:

```javascript

// ── analyst_grade_alerts (atomic dedup via PK event_id) ─────────────

const stmtAnalystGradeAlertInsert = db.prepare(`
  INSERT OR IGNORE INTO analyst_grade_alerts
    (event_id, ticker, ts, firm, action, new_grade, prev_grade, source, fired_at)
  VALUES
    (@event_id, @ticker, @ts, @firm, @action, @new_grade, @prev_grade, @source, @fired_at)
`);

// Atomic dedup: returns true if this is the first fire for `event_id`,
// false if the row already existed (= some other tick won the race).
function markAnalystGradeFired(payload) {
  const result = stmtAnalystGradeAlertInsert.run({
    event_id:   String(payload.event_id),
    ticker:     String(payload.ticker).toUpperCase(),
    ts:         String(payload.ts),
    firm:       String(payload.firm),
    action:     String(payload.action),
    new_grade:  payload.new_grade == null ? null : String(payload.new_grade),
    prev_grade: payload.prev_grade == null ? null : String(payload.prev_grade),
    source:     String(payload.source),
    fired_at:   String(payload.fired_at),
  });
  return result.changes === 1;
}

// Returns a Set of UPPERCASE tickers currently in the analyst_watchlist
// table (i.e. mentioned by a Discord analyst within the TTL window).
// Used by the analyst-grades poller to decide "always alert" tickers.
const stmtAnalystWatchlistTickers = db.prepare(`
  SELECT ticker FROM analyst_watchlist WHERE archived_at IS NULL
`);

function getAnalystWatchlistTickers() {
  const rows = stmtAnalystWatchlistTickers.all();
  const set = new Set();
  for (const row of rows) {
    if (row && typeof row.ticker === 'string') {
      set.add(row.ticker.toUpperCase());
    }
  }
  return set;
}
```

- [ ] **Step 5: Export the 2 new functions**

In `db/sqlite.js`, find the `module.exports = { ... }` block. Add the two new functions to the exports list (e.g., near the existing `markAlertFired`):

```javascript
  markAnalystGradeFired,
  getAnalystWatchlistTickers,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test db/analyst-grades.test.js`
Expected: All 5 tests PASS.

- [ ] **Step 7: Run full test suite to confirm no regression**

Run: `node --test 2>&1 | tail -10`
Expected: Pass count increased by 5. Same 2 pre-existing failures. No new failures.

- [ ] **Step 8: Commit**

```bash
git add db/sqlite.js db/analyst-grades.test.js
git commit -m "feat(db): analyst_grade_alerts table + markAnalystGradeFired + getAnalystWatchlistTickers

CREATE TABLE IF NOT EXISTS at boot, prepared statements modeled on
milestone_alerts. markAnalystGradeFired returns true on first insert
(mark-then-send pattern). getAnalystWatchlistTickers reads existing
analyst_watchlist table (archived_at IS NULL = still active).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure helpers in `discord/analyst-grades-feed.js` (TDD)

All the no-side-effect business logic: grade ranking, action derivation, event-ID synthesis, filter evaluation, message formatting.

**Files:**
- Create: `discord/analyst-grades-feed.js`
- Create: `discord/analyst-grades-feed.test.js`

- [ ] **Step 1: Write failing tests**

Create `discord/analyst-grades-feed.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const {
  GRADE_RANK,
  gradeRank,
  deriveAction,
  eventId,
  evaluate,
  buildMessage,
} = require('./analyst-grades-feed');

// ── gradeRank ───────────────────────────────────────────────────────

test('gradeRank returns the correct integer for canonical grades', () => {
  assert.strictEqual(gradeRank('Strong Sell'), 1);
  assert.strictEqual(gradeRank('Sell'), 2);
  assert.strictEqual(gradeRank('Hold'), 3);
  assert.strictEqual(gradeRank('Buy'), 4);
  assert.strictEqual(gradeRank('Strong Buy'), 5);
});

test('gradeRank is case-insensitive and trims whitespace', () => {
  assert.strictEqual(gradeRank('  buy '), 4);
  assert.strictEqual(gradeRank('OUTPERFORM'), 4);
  assert.strictEqual(gradeRank('overweight'), 4);
});

test('gradeRank treats Equal-Weight / Equal Weight / Inline / In-Line as Hold-tier', () => {
  assert.strictEqual(gradeRank('Equal-Weight'), 3);
  assert.strictEqual(gradeRank('Equal Weight'), 3);
  assert.strictEqual(gradeRank('In-Line'), 3);
  assert.strictEqual(gradeRank('Inline'), 3);
  assert.strictEqual(gradeRank('Market Perform'), 3);
});

test('gradeRank returns null for unknown grades, null, empty, non-string', () => {
  assert.strictEqual(gradeRank('Frobnicate'), null);
  assert.strictEqual(gradeRank(''), null);
  assert.strictEqual(gradeRank(null), null);
  assert.strictEqual(gradeRank(undefined), null);
  assert.strictEqual(gradeRank(42), null);
});

// ── deriveAction ────────────────────────────────────────────────────

test('deriveAction: upgrade when new rank > old rank', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Hold', newGrade: 'Buy' }), 'upgrade');
  assert.strictEqual(deriveAction({ prevGrade: 'Sell', newGrade: 'Strong Buy' }), 'upgrade');
});

test('deriveAction: downgrade when new rank < old rank', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Buy', newGrade: 'Hold' }), 'downgrade');
  assert.strictEqual(deriveAction({ prevGrade: 'Strong Buy', newGrade: 'Sell' }), 'downgrade');
});

test('deriveAction: initiate when prevGrade is empty/null but newGrade is known', () => {
  assert.strictEqual(deriveAction({ prevGrade: '', newGrade: 'Buy' }), 'initiate');
  assert.strictEqual(deriveAction({ prevGrade: null, newGrade: 'Overweight' }), 'initiate');
});

test('deriveAction: reiterate when both ranks match', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Hold', newGrade: 'Neutral' }), 'reiterate');
  assert.strictEqual(deriveAction({ prevGrade: 'Buy', newGrade: 'Buy' }), 'reiterate');
});

test('deriveAction: reiterate when one grade is unknown', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Buy', newGrade: 'Frobnicate' }), 'reiterate');
  assert.strictEqual(deriveAction({ prevGrade: 'Frobnicate', newGrade: 'Buy' }), 'reiterate');
});

// ── eventId ─────────────────────────────────────────────────────────

test('eventId prefers newsURL when present', () => {
  const e = { symbol: 'AAPL', gradingCompany: 'MS', publishedDate: '2026-01-01', newGrade: 'Buy', newsURL: 'https://example.com/x' };
  assert.strictEqual(eventId(e), 'https://example.com/x');
});

test('eventId falls back to composite key when newsURL is missing', () => {
  const e = { symbol: 'AAPL', gradingCompany: 'MS', publishedDate: '2026-01-01', newGrade: 'Buy' };
  assert.strictEqual(eventId(e), 'AAPL|MS|2026-01-01|Buy');
});

test('eventId falls back to composite when newsURL is empty string', () => {
  const e = { symbol: 'AAPL', gradingCompany: 'MS', publishedDate: '2026-01-01', newGrade: 'Buy', newsURL: '' };
  assert.strictEqual(eventId(e), 'AAPL|MS|2026-01-01|Buy');
});

// ── evaluate ────────────────────────────────────────────────────────

const TIER1 = new Set(['goldman sachs', 'morgan stanley', 'jpmorgan']);

function makeEvent(overrides = {}) {
  return {
    symbol: 'AAPL',
    publishedDate: '2026-05-15T12:00:00Z',
    gradingCompany: 'Goldman Sachs',
    newGrade: 'Buy',
    previousGrade: 'Hold',
    priceTarget: 200,
    priceWhenPosted: 180,
    newsURL: 'https://example.com/article',
    action: 'upgrade',
    ...overrides,
  };
}

test('evaluate: watchlist ticker always alerts (source=watchlist)', () => {
  const watchlist = new Set(['AAPL']);
  const e = makeEvent({ gradingCompany: 'Some Tiny Boutique', newGrade: 'Buy', previousGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'watchlist');
});

test('evaluate: non-watchlist + non-tier1 firm → no alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Tiny Boutique LLC' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, false);
  assert.strictEqual(r.source, null);
});

test('evaluate: tier1 firm + magnitude 2 (Hold→Buy) → alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Morgan Stanley', previousGrade: 'Hold', newGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
  assert.strictEqual(r.reason, 'magnitude2');
});

test('evaluate: tier1 firm + magnitude 1 (Buy→Strong Buy) → no alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Morgan Stanley', previousGrade: 'Buy', newGrade: 'Strong Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, false);
});

test('evaluate: tier1 firm + initiate with Buy → alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'JPMorgan', previousGrade: '', newGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
  assert.strictEqual(r.reason, 'initiation');
});

test('evaluate: tier1 firm + initiate with Hold → no alert (Hold initiation is not signal)', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'JPMorgan', previousGrade: '', newGrade: 'Hold' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, false);
});

test('evaluate: tier1 firm + downgrade magnitude 2 (Buy→Hold→err in spec: Buy is 4, Sell is 2) → alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Goldman Sachs', previousGrade: 'Buy', newGrade: 'Sell' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
});

test('evaluate: tier1 firm matched via substring (Goldman Sachs Securities → Goldman Sachs)', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Goldman Sachs Securities', previousGrade: 'Hold', newGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
});

test('evaluate: case-insensitive watchlist match', () => {
  const watchlist = new Set(['AAPL']);  // uppercase
  const e = makeEvent({ symbol: 'aapl' });  // lowercase from FMP
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'watchlist');
});

// ── buildMessage ────────────────────────────────────────────────────

test('buildMessage formats an upgrade with PT delta and URL', () => {
  const e = makeEvent({ previousGrade: 'Hold', newGrade: 'Buy',
    priceTarget: 240, priceWhenPosted: 180,
    /* Note: PT delta is computed from priceTarget vs an explicit
     * prevPriceTarget if FMP provides one. If only one PT, omit delta. */
  });
  // The implementer should also accept event.prevPriceTarget if FMP provides it.
  e.prevPriceTarget = 200;
  const msg = buildMessage(e, { action: 'upgrade' });
  assert.match(msg, /📈/);
  assert.match(msg, /\*\*\$AAPL\*\*/);
  assert.match(msg, /Goldman Sachs/);
  assert.match(msg, /Hold → Buy/);
  assert.match(msg, /\$200 → \$240/);
  assert.match(msg, /\+20\.0%/);
  assert.match(msg, /https:\/\/example\.com\/article/);
});

test('buildMessage formats a downgrade', () => {
  const e = makeEvent({ previousGrade: 'Buy', newGrade: 'Hold',
    priceTarget: 30, prevPriceTarget: 40 });
  const msg = buildMessage(e, { action: 'downgrade' });
  assert.match(msg, /📉/);
  assert.match(msg, /Buy → Hold/);
  assert.match(msg, /-25\.0%/);
});

test('buildMessage formats an initiation', () => {
  const e = makeEvent({ previousGrade: '', newGrade: 'Overweight',
    gradingCompany: 'JPMorgan', priceTarget: 150 });
  const msg = buildMessage(e, { action: 'initiate' });
  assert.match(msg, /🆕/);
  assert.match(msg, /initiated by JPMorgan/);
  assert.match(msg, /Overweight/);
  assert.match(msg, /\$150/);
});

test('buildMessage omits PT clause when priceTarget is missing', () => {
  const e = makeEvent({ priceTarget: null, prevPriceTarget: null });
  const msg = buildMessage(e, { action: 'upgrade' });
  assert.doesNotMatch(msg, /PT/);
  assert.doesNotMatch(msg, /\$\d+ → \$\d+/);
});

test('buildMessage omits URL when newsURL is missing', () => {
  const e = makeEvent({ newsURL: null });
  const msg = buildMessage(e, { action: 'upgrade' });
  assert.doesNotMatch(msg, /https/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/analyst-grades-feed.test.js`
Expected: FAIL — `Cannot find module './analyst-grades-feed'`.

- [ ] **Step 3: Create the module with pure helpers**

Create `discord/analyst-grades-feed.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// discord/analyst-grades-feed.js — Wall Street analyst upgrades/downgrades
// ─────────────────────────────────────────────────────────────────────
// Poll FMP /api/v4/upgrades-downgrades-rss-feed every Nmin during RTH.
// Two-tier filter:
//   1. If ticker ∈ watchlist (WATCHED_TICKERS ∪ analyst_watchlist) → alert.
//   2. Else if firm ∈ TIER_1_FIRMS AND (|magnitude| >= 2 OR initiation
//      with directional grade) → alert.
//   3. Else → skip.
// Dedup via analyst_grade_alerts.event_id PK (mark-then-send).
//
// Spec : docs/superpowers/specs/2026-05-15-analyst-grades-alerts-design.md
// ─────────────────────────────────────────────────────────────────────

// Grade vocabulary → integer rank (1=Strong Sell .. 5=Strong Buy).
// Different firms use different terms; we normalize them all.
const GRADE_RANK = {
  'strong sell':    1,
  'sell':           2,
  'underperform':   2,
  'underweight':    2,
  'hold':           3,
  'neutral':        3,
  'market perform': 3,
  'equal-weight':   3,
  'equal weight':   3,
  'in-line':        3,
  'inline':         3,
  'buy':            4,
  'outperform':     4,
  'overweight':     4,
  'accumulate':     4,
  'positive':       4,
  'strong buy':     5,
};

// Case-insensitive, whitespace-trimmed lookup. Returns 1..5 or null.
function gradeRank(grade) {
  if (typeof grade !== 'string') return null;
  const key = grade.trim().toLowerCase();
  if (!key) return null;
  const r = GRADE_RANK[key];
  return r == null ? null : r;
}

// Compute action from grade transition. Doesn't trust FMP's free-text `action`.
function deriveAction({ prevGrade, newGrade }) {
  const oldRank = gradeRank(prevGrade);
  const newRank = gradeRank(newGrade);
  if (oldRank == null && newRank != null) return 'initiate';
  if (oldRank == null || newRank == null) return 'reiterate';
  if (newRank > oldRank) return 'upgrade';
  if (newRank < oldRank) return 'downgrade';
  return 'reiterate';
}

// Synthesize a stable event ID for dedup. Prefer newsURL (unique per article)
// when present; fall back to composite key from salient fields.
function eventId(event) {
  if (event && typeof event.newsURL === 'string' && event.newsURL.length > 0) {
    return event.newsURL;
  }
  const parts = [
    event && (event.symbol || event.ticker),
    event && (event.gradingCompany || event.firm),
    event && (event.publishedDate || event.ts),
    event && event.newGrade,
  ];
  return parts.map(s => String(s == null ? '' : s)).join('|');
}

// Check if a firm name is in the tier-1 list (substring match, case-insensitive).
function isTier1Firm(firmName, tier1Firms) {
  if (typeof firmName !== 'string' || !tier1Firms) return false;
  const lower = firmName.toLowerCase();
  for (const tier1 of tier1Firms) {
    if (lower.includes(String(tier1).toLowerCase())) return true;
  }
  return false;
}

// Two-tier filter. Returns { shouldAlert, source, reason, action }.
function evaluate(event, { watchlist, tier1Firms } = {}) {
  if (!event) return { shouldAlert: false, source: null, reason: null, action: null };
  const action = deriveAction({ prevGrade: event.previousGrade, newGrade: event.newGrade });
  if (action === 'reiterate') {
    return { shouldAlert: false, source: null, reason: null, action };
  }

  const tickerUpper = String(event.symbol || event.ticker || '').toUpperCase();

  // Tier 1: watchlist always alerts.
  if (watchlist && watchlist.has && watchlist.has(tickerUpper)) {
    return { shouldAlert: true, source: 'watchlist', reason: 'in-watchlist', action };
  }

  // Tier 2: tier-1 firm + strong move.
  const firmName = event.gradingCompany || event.firm || '';
  if (!isTier1Firm(firmName, tier1Firms)) {
    return { shouldAlert: false, source: null, reason: null, action };
  }
  if (action === 'initiate') {
    const newRank = gradeRank(event.newGrade);
    // Directional initiation: Buy (4), Strong Buy (5), Sell (2), Strong Sell (1).
    if (newRank === 4 || newRank === 5 || newRank === 1 || newRank === 2) {
      return { shouldAlert: true, source: 'tier1-global', reason: 'initiation', action };
    }
    return { shouldAlert: false, source: null, reason: null, action };
  }
  // Upgrade or downgrade — check magnitude.
  const oldRank = gradeRank(event.previousGrade);
  const newRank = gradeRank(event.newGrade);
  const magnitude = Math.abs((newRank || 0) - (oldRank || 0));
  if (magnitude >= 2) {
    return { shouldAlert: true, source: 'tier1-global', reason: 'magnitude2', action };
  }
  return { shouldAlert: false, source: null, reason: null, action };
}

// Format price with 2 decimals + no trailing zeros (e.g. $200, $199.50, $1.05).
function fmtPrice(n) {
  if (!Number.isFinite(n)) return null;
  const s = (Math.round(n * 100) / 100).toString();
  return s;
}

// Compute % delta between two prices. Returns null if either is missing.
function pctDelta(prev, next) {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === 0) return null;
  return ((next - prev) / prev) * 100;
}

// Build the Discord message string for an alert.
function buildMessage(event, { action } = {}) {
  const ticker = String(event.symbol || event.ticker || '').toUpperCase();
  const firm = event.gradingCompany || event.firm || 'an analyst';
  const newGrade = event.newGrade || '';
  const prevGrade = event.previousGrade || '';
  const pt = Number(event.priceTarget);
  const prevPt = Number(event.prevPriceTarget);
  const url = (typeof event.newsURL === 'string' && event.newsURL.length > 0) ? event.newsURL : null;

  let icon = '📊';
  let action_phrase = '';
  let transition = '';
  if (action === 'upgrade') {
    icon = '📈';
    action_phrase = 'upgraded by ' + firm;
    transition = prevGrade + ' → ' + newGrade;
  } else if (action === 'downgrade') {
    icon = '📉';
    action_phrase = 'downgraded by ' + firm;
    transition = prevGrade + ' → ' + newGrade;
  } else if (action === 'initiate') {
    icon = '🆕';
    action_phrase = 'coverage initiated by ' + firm + ' with ' + newGrade;
    transition = '';
  } else {
    action_phrase = 'grade change from ' + firm;
    transition = prevGrade + ' → ' + newGrade;
  }

  // PT clause.
  let ptClause = '';
  if (Number.isFinite(pt)) {
    if (Number.isFinite(prevPt) && prevPt > 0 && action !== 'initiate') {
      const delta = pctDelta(prevPt, pt);
      const sign = delta >= 0 ? '+' : '';
      ptClause = ' (PT $' + fmtPrice(prevPt) + ' → $' + fmtPrice(pt) + ', ' + sign + delta.toFixed(1) + '%)';
    } else {
      ptClause = ' (PT $' + fmtPrice(pt) + ')';
    }
  }

  let msg = icon + ' **$' + ticker + '** ' + action_phrase;
  if (transition) msg += ' — ' + transition;
  msg += ptClause;
  if (url) msg += ' — ' + url;
  return msg;
}

module.exports = {
  GRADE_RANK,
  gradeRank,
  deriveAction,
  eventId,
  evaluate,
  buildMessage,
  isTier1Firm,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/analyst-grades-feed.test.js`
Expected: All tests PASS (29 tests across the 5 function groups).

- [ ] **Step 5: Commit**

```bash
git add discord/analyst-grades-feed.js discord/analyst-grades-feed.test.js
git commit -m "feat(analyst-grades): pure helpers (gradeRank, deriveAction, evaluate, buildMessage)

Five pure functions implementing the two-tier filter logic + grade
normalization + Discord message formatting. No DB, no HTTP — fully
unit-testable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `createAnalystGradesPoller` with `tick()` (integration)

Wire the pure helpers, FMP client, DB helpers, and Discord sender into a single poller object with a `tick()` method. Mirrors the existing milestone-checker pattern.

**Files:**
- Modify: `discord/analyst-grades-feed.js`
- Modify: `discord/analyst-grades-feed.test.js`

- [ ] **Step 1: Append failing tests**

Append to `discord/analyst-grades-feed.test.js`:

```javascript
// ── createAnalystGradesPoller (integration) ─────────────────────────

const { createAnalystGradesPoller } = require('./analyst-grades-feed');

function makeMocks() {
  const sent = [];
  const fired = [];  // event_ids passed to markAnalystGradeFired
  let nextMarkResult = true;
  return {
    fmpClient: {
      getAnalystGradesFeed: async () => [],
    },
    sendAlert: async (msg) => { sent.push(msg); },
    db: {
      markAnalystGradeFired: (payload) => { fired.push(payload); return nextMarkResult; },
      getAnalystWatchlistTickers: () => new Set(),
    },
    setFeedRows: function (rows) {
      this.fmpClient.getAnalystGradesFeed = async () => rows;
    },
    setNextMarkResult: function (b) { nextMarkResult = b; },
    sent,
    fired,
  };
}

test('tick: fires an alert on a watchlist event (single iteration)', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([{
    symbol: 'AAPL', gradingCompany: 'Tiny Firm',
    previousGrade: 'Hold', newGrade: 'Buy',
    priceTarget: 200, priceWhenPosted: 180,
    newsURL: 'https://example.com/x', publishedDate: '2026-05-15T12:00:00Z',
  }]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(),
    tier1Firms: new Set(['goldman sachs']),
    now: () => new Date('2026-05-15T14:00:00Z'),  // RTH (10:00 ET)
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(m.sent.length, 1);
  assert.match(m.sent[0], /\*\*\$AAPL\*\*/);
  assert.strictEqual(m.fired.length, 1);
  assert.strictEqual(m.fired[0].event_id, 'https://example.com/x');
  assert.strictEqual(m.fired[0].source, 'watchlist');
});

test('tick: skips events that don\'t match the filter', async () => {
  const m = makeMocks();
  m.setFeedRows([{
    symbol: 'XYZ', gradingCompany: 'Tiny Firm',
    previousGrade: 'Buy', newGrade: 'Strong Buy',  // magnitude 1, non-tier1
    publishedDate: '2026-05-15T12:00:00Z',
    newsURL: 'https://example.com/y',
  }]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(),
    tier1Firms: new Set(['goldman sachs']),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(m.sent.length, 0);
  assert.strictEqual(m.fired.length, 0);
});

test('tick: dedup — same event in feed twice fires only once', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([{
    symbol: 'AAPL', gradingCompany: 'Tiny Firm',
    previousGrade: 'Hold', newGrade: 'Buy',
    newsURL: 'https://example.com/dup', publishedDate: '2026-05-15T12:00:00Z',
  }]);
  let firstResult = true;
  m.db.markAnalystGradeFired = () => {
    const r = firstResult;
    firstResult = false;
    return r;
  };
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(),
    tier1Firms: new Set(),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  await poller.tick();
  assert.strictEqual(m.sent.length, 1, 'second tick should be deduped');
});

test('tick: hors RTH → early return, no FMP call', async () => {
  const m = makeMocks();
  let fetchCount = 0;
  m.fmpClient.getAnalystGradesFeed = async () => { fetchCount++; return []; };
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T03:00:00Z'),  // 23:00 ET previous day
    isRTH: () => false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(fetchCount, 0);
});

test('tick: FMP error is caught, no crash, no alerts', async () => {
  const m = makeMocks();
  m.fmpClient.getAnalystGradesFeed = async () => { throw new Error('FMP boom'); };
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();  // should not throw
  assert.strictEqual(m.sent.length, 0);
});

test('tick: respects forced ignoreRTH option (for pre-market 06:00 ET tick)', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([{
    symbol: 'AAPL', gradingCompany: 'Tiny Firm',
    previousGrade: 'Hold', newGrade: 'Buy',
    newsURL: 'https://example.com/x', publishedDate: '2026-05-15T12:00:00Z',
  }]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T10:00:00Z'),  // 06:00 ET = pre-market
    isRTH: () => false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick({ ignoreRTH: true });
  assert.strictEqual(m.sent.length, 1, 'pre-market tick should still fire');
});

test('getStats returns counters', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([
    { symbol: 'AAPL', gradingCompany: 'X', previousGrade: 'Hold', newGrade: 'Buy', newsURL: 'a', publishedDate: 't' },
    { symbol: 'AAPL', gradingCompany: 'Y', previousGrade: 'Hold', newGrade: 'Buy', newsURL: 'b', publishedDate: 't' },
    { symbol: 'XYZ',  gradingCompany: 'Z', previousGrade: 'Buy',  newGrade: 'Buy', newsURL: 'c', publishedDate: 't' },
  ]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  const stats = poller.getStats();
  assert.strictEqual(stats.eventsSeen, 3);
  assert.strictEqual(stats.alertsFired, 2);
  assert.strictEqual(typeof stats.lastPollTs, 'string');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/analyst-grades-feed.test.js`
Expected: New tests FAIL with `createAnalystGradesPoller is not a function`. Existing pure-helper tests still pass.

- [ ] **Step 3: Implement `createAnalystGradesPoller`**

In `discord/analyst-grades-feed.js`, BEFORE the `module.exports` block, add:

```javascript

// Creates a poller that, on each tick:
//   1. RTH-guards (unless overridden by `tick({ ignoreRTH: true })`)
//   2. Fetches the latest grades feed
//   3. For each event: evaluates, dedups, marks, sends Discord alert
//
// External deps are all injected so this is fully testable without
// touching real FMP / real DB / real Discord.
function createAnalystGradesPoller({
  fmpClient,
  sendAlert,
  db,
  watchedTickers = new Set(),   // Set<UPPERCASE> from WATCHED_TICKERS
  tier1Firms = new Set(),       // Set<lowercase>
  now = () => new Date(),
  isRTH,                        // (Date) → boolean, required at runtime
  logger = console,
} = {}) {
  if (!fmpClient || typeof fmpClient.getAnalystGradesFeed !== 'function') {
    throw new Error('fmpClient.getAnalystGradesFeed required');
  }
  if (typeof sendAlert !== 'function') throw new Error('sendAlert (function) required');
  if (!db || typeof db.markAnalystGradeFired !== 'function'
         || typeof db.getAnalystWatchlistTickers !== 'function') {
    throw new Error('db.{markAnalystGradeFired,getAnalystWatchlistTickers} required');
  }
  if (typeof isRTH !== 'function') throw new Error('isRTH (function) required');

  const stats = { eventsSeen: 0, alertsFired: 0, errors: 0, lastPollTs: null };

  async function tick({ ignoreRTH = false } = {}) {
    const nowDate = now();
    if (!ignoreRTH && !isRTH(nowDate)) return;

    let rows;
    try {
      rows = await fmpClient.getAnalystGradesFeed({ page: 0 });
    } catch (err) {
      logger.error('[analyst-grades] feed fetch failed:', err.message);
      stats.errors++;
      return;
    }
    if (!Array.isArray(rows)) return;

    stats.lastPollTs = nowDate.toISOString();
    stats.eventsSeen += rows.length;

    // Build the watchlist union once per tick.
    let watchlistFromDb;
    try {
      watchlistFromDb = db.getAnalystWatchlistTickers();
    } catch (err) {
      logger.error('[analyst-grades] getAnalystWatchlistTickers failed:', err.message);
      watchlistFromDb = new Set();
    }
    const watchlist = new Set([...watchedTickers, ...watchlistFromDb]);

    for (const event of rows) {
      if (!event || (!event.symbol && !event.ticker)) continue;
      const r = evaluate(event, { watchlist, tier1Firms });
      if (!r.shouldAlert) continue;

      const eid = eventId(event);
      const ticker = String(event.symbol || event.ticker || '').toUpperCase();
      const ts = String(event.publishedDate || event.ts || nowDate.toISOString());
      const firm = String(event.gradingCompany || event.firm || '');

      // Mark-then-send: claim the dedup slot before posting.
      const claimed = db.markAnalystGradeFired({
        event_id:   eid,
        ticker,
        ts,
        firm,
        action:     r.action,
        new_grade:  event.newGrade || null,
        prev_grade: event.previousGrade || null,
        source:     r.source,
        fired_at:   nowDate.toISOString(),
      });
      if (!claimed) continue;

      const message = buildMessage(event, { action: r.action });
      try {
        await sendAlert(message);
        stats.alertsFired++;
        logger.log('[analyst-grades] FIRED ' + r.action + ' ' + ticker + ' by ' + firm);
      } catch (err) {
        logger.error('[analyst-grades] sendAlert failed for ' + ticker + ': ' + err.message);
      }
    }
  }

  function getStats() {
    return { ...stats };
  }

  return { tick, getStats };
}
```

Update `module.exports` to include `createAnalystGradesPoller`:

```javascript
module.exports = {
  GRADE_RANK,
  gradeRank,
  deriveAction,
  eventId,
  evaluate,
  buildMessage,
  isTier1Firm,
  createAnalystGradesPoller,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/analyst-grades-feed.test.js`
Expected: All tests PASS (pure helpers + 7 integration tests).

- [ ] **Step 5: Commit**

```bash
git add discord/analyst-grades-feed.js discord/analyst-grades-feed.test.js
git commit -m "feat(analyst-grades): createAnalystGradesPoller wires helpers + tick()

Polls FMP feed, evaluates each event against the two-tier filter,
deduplicates via DB, sends Discord alerts. RTH-gated (overridable
via tick({ignoreRTH:true}) for the pre-market 06:00 ET case).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire into `discord/jobs.js` behind feature flag

Add the analyst-grades poller to the master scheduler. Two cadences:
1. Regular cadence (default 15 min) during RTH
2. One special tick at 06:00 ET pre-market each weekday

**Files:**
- Modify: `discord/jobs.js`

- [ ] **Step 1: Add the requires at the top of `jobs.js`**

Open `discord/jobs.js`. Find the existing line:
```javascript
const milestoneChecker = require('./milestone-checker');
```

Immediately AFTER it, add:
```javascript
const { createAnalystGradesPoller } = require('./analyst-grades-feed');
const dbForAnalyst = require('../db/sqlite');
```

(The `dbForAnalyst` aliases the db module to avoid a name clash if `db` is already locally bound — verify by searching for `const db` in the file; reuse the existing local binding if available.)

- [ ] **Step 2: Add throttle counters near `lastMilestoneTickMin`**

Find the existing line declaring milestone scheduling state (around line 44):
```javascript
// Used to throttle milestone-checker ticks to the configured cadence.
let lastMilestoneTickMin = -1;
```

Immediately AFTER, add:
```javascript
// Analyst-grades scheduling state. RTH ticks throttled by minute,
// pre-market 06:00 ET tick throttled by ET-date (one per day).
let lastAnalystTickMin = -1;
let lastAnalystPreMarketDay = null;
```

- [ ] **Step 3: Wire the analyst-grades poller in the master scheduler**

Inside the `startScheduler` body, find the milestone-checker block (around line 367-391 — the block starting with the comment `// Milestone checker — cadence configurable (défaut 30 min).`). Immediately AFTER its closing brace (and any blank line that follows), add:

```javascript

      // Analyst-grades alerts — cadence configurable (default 15 min).
      // Gated by ANALYST_ALERTS_ENABLED env var. Fires both during RTH
      // (every analystIntervalMin) AND once at 06:00 ET pre-market to
      // catch overnight downgrades. RTH gate lives in the tick() itself.
      const analystEnabled = process.env.ANALYST_ALERTS_ENABLED === 'true';
      if (analystEnabled) {
        const analystIntervalMin = Math.max(1, parseInt(
          process.env.ANALYST_ALERTS_INTERVAL_MIN || '15', 10) || 15);
        const analystMinuteKey = now.getHours() * 60 + now.getMinutes();
        const fmpKeyForAnalyst = process.env.FMP_API_KEY || '';

        // ── Helper to compute ET date+time parts ──
        const etParts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric', month: '2-digit', day: '2-digit',
          weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(now).reduce((acc, p) => {
          if (p.type !== 'literal') acc[p.type] = p.value;
          return acc;
        }, {});
        const etDate = etParts.year + '-' + etParts.month + '-' + etParts.day;
        const etHour = parseInt(etParts.hour, 10);
        const etMinute = parseInt(etParts.minute, 10);
        const etIsWeekday = etParts.weekday !== 'Sat' && etParts.weekday !== 'Sun';

        // ── Regular RTH cadence: every analystIntervalMin ──
        const isRegularTick = (
          now.getMinutes() % analystIntervalMin === 0
          && lastAnalystTickMin !== analystMinuteKey
        );

        // ── Pre-market 06:00 ET (Mon-Fri): fire once per ET-date ──
        const isPreMarketTick = (
          etIsWeekday
          && etHour === 6
          && etMinute === 0
          && lastAnalystPreMarketDay !== etDate
        );

        if ((isRegularTick || isPreMarketTick) && fmpKeyForAnalyst) {
          if (isRegularTick)    lastAnalystTickMin = analystMinuteKey;
          if (isPreMarketTick)  lastAnalystPreMarketDay = etDate;

          let analystFmp = null;
          try {
            analystFmp = createFmpClient({ apiKey: fmpKeyForAnalyst });
          } catch (err) {
            console.error('[analyst-grades] FMP init failed:', err.message);
          }
          if (analystFmp) {
            // tier1Firms from env or default.
            const tier1Csv = process.env.TIER_1_FIRMS
              || 'Goldman Sachs,JPMorgan,JP Morgan,Morgan Stanley,'
                 + 'BofA Securities,Bank of America,Wells Fargo,Citigroup,Citi,'
                 + 'Barclays,Deutsche Bank,UBS,Jefferies,Credit Suisse,'
                 + 'Evercore ISI,Cowen,Wedbush,Piper Sandler,RBC Capital,'
                 + 'Truist,Stifel,Raymond James,Oppenheimer';
            const tier1Firms = new Set(tier1Csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
            const watchedTickers = new Set((process.env.WATCHED_TICKERS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
            const { isRTH: isRTHFn } = require('./market-alerts');

            const analystPoller = createAnalystGradesPoller({
              fmpClient:  analystFmp,
              sendAlert,
              db:         dbForAnalyst,
              watchedTickers,
              tier1Firms,
              isRTH:      isRTHFn,
              now:        () => now,
              logger:     console,
            });
            analystPoller.tick({ ignoreRTH: isPreMarketTick }).catch(err =>
              console.error('[analyst-grades] tick failed:', err.message));
          }
        }
      }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check discord/jobs.js`
Expected: No output (exit 0).

- [ ] **Step 5: Run the full test suite**

Run: `node --test 2>&1 | tail -10`
Expected: Same pass count as after Task 4 (no new failures). The 2 known pre-existing failures remain.

- [ ] **Step 6: Commit**

```bash
git add discord/jobs.js
git commit -m "feat(analyst-grades): wire poller into scheduler behind ANALYST_ALERTS_ENABLED

Two cadences: every ANALYST_ALERTS_INTERVAL_MIN (default 15) during
RTH + one 06:00 ET pre-market tick (Mon-Fri, once per ET-date).
Reuses isRTH from market-alerts. TIER_1_FIRMS configurable via env
var with a sensible default of 23 firms.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Document env vars in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the new section**

Open `.env.example`. Append at the end of the file (or just after the existing market-alerts section if a logical home exists):

```bash

# === WALL STREET ANALYST GRADE ALERTS (FMP Premium) ==================
# Active la surveillance du feed FMP /upgrades-downgrades-rss-feed.
# Quand un analyste Wall Street upgrade/downgrade/initie une couverture
# sur un ticker de ta watchlist OU sur n'importe quel ticker par un firm
# tier-1 avec un strong move (magnitude ≥ 2 ou initiation directionnelle),
# une alerte est postée dans le TRADING_ALERTS_CHANNEL_ID.

# Feature flag : active la surveillance. Default false.
ANALYST_ALERTS_ENABLED=false

# Cadence du polling pendant les heures RTH (9:30-16:00 ET). Default 15 min.
# Plus un tick spécial à 06:00 ET pour rattraper les downgrades publiés
# pendant la nuit (toujours actif si ANALYST_ALERTS_ENABLED=true).
ANALYST_ALERTS_INTERVAL_MIN=15

# Liste des firms tier-1 (matching substring case-insensitive). Si vide,
# fallback sur la liste par défaut de 23 firms (Goldman Sachs, JPMorgan,
# Morgan Stanley, BofA, etc.). À adapter si tu veux ajouter Cantor,
# Wolfe Research, etc., ou retirer les firms européennes.
# TIER_1_FIRMS=Goldman Sachs,JPMorgan,Morgan Stanley,...
```

- [ ] **Step 2: Verify file is well-formed**

Run: `node -e "console.log(require('fs').readFileSync('.env.example', 'utf8').slice(-800))"`
Expected: output ends with the new section.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document ANALYST_ALERTS_* and TIER_1_FIRMS variables

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification + user-facing summary

- [ ] **Step 1: Full test suite green**

Run: `node --test 2>&1 | tail -10`
Expected: All previously-passing tests + new tests from Tasks 1-4 pass. Same 2 pre-existing failures (`services/llm-classify.test.js` Windows EBUSY + `video/scripts/test-tts-voice.js` TTS).

- [ ] **Step 2: Syntax check every touched file**

Run: `node --check discord/jobs.js && node --check discord/analyst-grades-feed.js && node --check discord/fmp-client.js && node --check db/sqlite.js && echo "all-syntax-ok"`
Expected: `all-syntax-ok`.

- [ ] **Step 3: Smoke check the require chain**

Run: `node -e "const m = require('./discord/analyst-grades-feed'); console.log(typeof m.createAnalystGradesPoller, typeof m.evaluate, typeof m.gradeRank);"`
Expected: `function function function`.

- [ ] **Step 4: Print user-facing summary**

Print to the user:

```
✅ Analyst grade alerts ready. After Railway redeploys:

1. The feature is OFF by default (ANALYST_ALERTS_ENABLED=false).
2. To enable: set ANALYST_ALERTS_ENABLED=true on Railway and redeploy.
3. Verify boot logs:
   - No errors related to analyst-grades
4. During RTH or at 06:00 ET, verify a log line every 15 min:
   - `[analyst-grades] FIRED upgrade NVDA by Morgan Stanley` (when an event matches)
5. Discord alerts will appear in your TRADING_ALERTS_CHANNEL_ID.

To roll back: set ANALYST_ALERTS_ENABLED=false (or unset) and redeploy.

Configurable:
- ANALYST_ALERTS_INTERVAL_MIN (default 15) — adjust polling cadence
- TIER_1_FIRMS — comma-separated list to override the default 23 firms

Smoke test plan after deploy:
- Wait for the next 15-min mark during RTH
- Confirm a feed fetch happens (check Railway logs for `[analyst-grades]`)
- If a watchlist ticker is in the feed with a grade change, alert fires within 5 sec of the tick
- Re-running the same tick should NOT re-fire (dedup via analyst_grade_alerts table)
```

---

## Out of scope (per spec §15)

- Price target changes WITHOUT grade changes
- Consensus grade tracking
- Dashboard page showing recent analyst alerts
- LLM sentiment analysis on analyst rationale
- Tier-2/tier-3 firms with different thresholds
- Sector or market-cap filtering
- Configurable alert format from the dashboard
- Webhooks beyond Discord
- Cooldown per ticker (we rely on event_id dedup)
- Pre-market alerts beyond the single 06:00 ET tick
- IBKR or other broker integration
- Non-US tickers
