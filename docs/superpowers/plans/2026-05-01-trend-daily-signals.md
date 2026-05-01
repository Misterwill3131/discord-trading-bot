# Trend daily-reference signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 new "today vs yesterday" event types to the trend module: PDH break, PDL break, gap up, gap down, and volume-above-prev-day, with per-day state machine for PDH/PDL re-entries and daily reset.

**Architecture:** Extend the existing pure detection engine with 4 new functions that take `state` and return `{ event, stateUpdate }` (delta, no mutation). Scanner fetches an additional daily-context chart per ticker, applies `stateUpdates` via a new generic `applyStateUpdates` accessor, dispatches new alerts on the existing channel pipeline. Daily reset uses ET-date sentinel column.

**Tech Stack:** Node.js, `discord.js` v14, `better-sqlite3`, `yahoo-finance2` (all already in deps). Tests via `node:test`.

---

## File Structure

**Modified files:**
- `db/sqlite.js` — 8 `ALTER TABLE` additions (idempotent via `IF NOT EXISTS` pattern not supported by SQLite for ALTER, so we wrap in PRAGMA `table_info` check).
- `db/trend-store.js` — `addToWatchlist` 4-arg signature, new accessors `setQuoteType`, `getQuoteType`, `resetDailyState`, `applyStateUpdates`.
- `db/trend-store.test.js` — tests for new accessors.
- `trading/trend-engine.js` — `detectPDHBreak`, `detectPDLBreak`, `detectGap`, `detectVolumeAbovePrevDay`, extended `detectAll` returning `stateUpdates`.
- `trading/trend-engine.test.js` — fixtures + tests for each new detector.
- `trading/trend-scanner.js` — `formatDateET`, `getDailyContext`, 4 new alert formatters, scanner loop integrates daily fetch + quote_type backfill + daily reset + applyStateUpdates.
- `trading/trend-scanner.test.js` — extended `fakeYahoo` accepting `{ intraday, daily, quote }`, daily reset test, dispatch test.
- `discord/trend-commands.js` — `!trend watch` captures `quote_type`, `!trend TICKER` shows daily events.
- `.env.example` — 4 new optional vars.

No new files.

---

## Task 1: DB schema — 8 new columns

**Files:**
- Modify: `db/sqlite.js` (add ALTER TABLE block after the existing trend tables in the `db.exec(\`...\`)` schema block).

- [ ] **Step 1: Locate the trend tables in the schema string**

Run: `grep -n "trend_state" db/sqlite.js`
Expected: a few lines around the `trend_state` table definition.

- [ ] **Step 2: Add the migration block after the trend tables, BEFORE the closing backtick of `db.exec(\`...\`)`**

SQLite's `ALTER TABLE ADD COLUMN` is not idempotent with `IF NOT EXISTS`. The pattern in this codebase relies on `CREATE TABLE IF NOT EXISTS`. For ALTER, we use a JS-level guard: check `PRAGMA table_info` and apply only if missing.

Add this BLOCK directly after the existing schema string but as a separate JS statement, NOT inside `db.exec(\`...\`)`. Place it between `db.exec(\`...\`)` and the prepared statements section.

```js
// ── Trend module: daily-reference signals — column migrations ─────────
// SQLite ne supporte pas ALTER TABLE IF NOT EXISTS, donc on inspecte
// table_info pour rester idempotent et safe au re-démarrage.
function addColumnIfMissing(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

addColumnIfMissing('trend_watchlist', 'quote_type', 'TEXT');
addColumnIfMissing('trend_state', 'daily_state_date',           'TEXT');
addColumnIfMissing('trend_state', 'pdh_alerts_today',           'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'pdh_below_since',            'INTEGER');
addColumnIfMissing('trend_state', 'pdl_alerts_today',           'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'pdl_above_since',            'INTEGER');
addColumnIfMissing('trend_state', 'gap_alerted_today',          'INTEGER DEFAULT 0');
addColumnIfMissing('trend_state', 'volume_above_alerted_today', 'INTEGER DEFAULT 0');
```

- [ ] **Step 3: Verify the migration applies cleanly**

Run: `node -e "require('./db/sqlite.js'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Verify columns exist via introspection**

Run:
```bash
node -e "const m = require('./db/sqlite.js'); const db = m.db || m; const cols = db.prepare(\"PRAGMA table_info(trend_state)\").all().map(c => c.name); console.log(cols.filter(c => c.includes('pdh') || c.includes('pdl') || c.includes('gap') || c.includes('volume_above') || c === 'daily_state_date'));"
```
Expected: array containing 7 entries (`daily_state_date`, `pdh_alerts_today`, `pdh_below_since`, `pdl_alerts_today`, `pdl_above_since`, `gap_alerted_today`, `volume_above_alerted_today`).

Run also:
```bash
node -e "const m = require('./db/sqlite.js'); const db = m.db || m; console.log(db.prepare(\"PRAGMA table_info(trend_watchlist)\").all().map(c => c.name));"
```
Expected: array containing `quote_type` among the columns.

- [ ] **Step 5: Run idempotency check (re-running should be a no-op)**

Run: `node -e "require('./db/sqlite.js'); require('./db/sqlite.js'); console.log('still ok')"`
Expected: prints `still ok` (no duplicate-column error).

- [ ] **Step 6: Commit**

```bash
git add db/sqlite.js
git commit -m "feat(db): trend module — daily-reference signal columns

8 colonnes pour le module trend daily-signals :
- trend_watchlist.quote_type (catégorisation gap stock vs index)
- trend_state.daily_state_date (sentinelle reset journalier)
- trend_state.pdh_alerts_today + pdh_below_since (state machine ré-entrée)
- trend_state.pdl_alerts_today + pdl_above_since (state machine ré-entrée)
- trend_state.gap_alerted_today + volume_above_alerted_today
"
```

---

## Task 2: Trend store extensions

**Files:**
- Modify: `db/trend-store.js`
- Modify: `db/trend-store.test.js`

- [ ] **Step 1: Append failing tests**

Append to `db/trend-store.test.js` (the existing `makeDb` helper needs the new columns — replace its definition first):

Replace the existing `makeDb()` function in `db/trend-store.test.js` with:

```js
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trend_watchlist (
      guild_id TEXT NOT NULL, ticker TEXT NOT NULL, added_at INTEGER NOT NULL,
      quote_type TEXT,
      PRIMARY KEY (guild_id, ticker)
    );
    CREATE TABLE trend_channel (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, set_at INTEGER NOT NULL
    );
    CREATE TABLE trend_state (
      ticker TEXT PRIMARY KEY,
      direction TEXT, direction_changed_at INTEGER,
      last_breakout_at INTEGER,
      last_bullish_reversal_at INTEGER,
      last_bearish_reversal_at INTEGER,
      last_scan_at INTEGER,
      daily_state_date TEXT,
      pdh_alerts_today INTEGER DEFAULT 0,
      pdh_below_since INTEGER,
      pdl_alerts_today INTEGER DEFAULT 0,
      pdl_above_since INTEGER,
      gap_alerted_today INTEGER DEFAULT 0,
      volume_above_alerted_today INTEGER DEFAULT 0
    );
  `);
  return db;
}
```

Append these new tests at the bottom:

```js
test('addToWatchlist accepts optional quoteType (4th arg)', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000, 'EQUITY');
  assert.strictEqual(store.getQuoteType('AAPL'), 'EQUITY');
});

test('addToWatchlist without quoteType leaves it null', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  assert.strictEqual(store.getQuoteType('AAPL'), null);
});

test('setQuoteType updates the value across all guild rows for the ticker', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  store.addToWatchlist('g2', 'AAPL', 1000);
  store.setQuoteType('AAPL', 'EQUITY');
  assert.strictEqual(store.getQuoteType('AAPL'), 'EQUITY');
});

test('getQuoteType returns null if no row for ticker', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.getQuoteType('NOPE'), null);
});

test('resetDailyState clears daily columns and sets date', () => {
  const store = createTrendStore(makeDb());
  store.applyStateUpdates('AAPL', {
    pdh_alerts_today: 2, pdh_below_since: 12345,
    pdl_alerts_today: 1, pdl_above_since: 67890,
    gap_alerted_today: 1, volume_above_alerted_today: 1,
  });
  store.resetDailyState('AAPL', '2026-05-02');
  const s = store.getState('AAPL');
  assert.strictEqual(s.daily_state_date, '2026-05-02');
  assert.strictEqual(s.pdh_alerts_today, 0);
  assert.strictEqual(s.pdh_below_since, null);
  assert.strictEqual(s.pdl_alerts_today, 0);
  assert.strictEqual(s.pdl_above_since, null);
  assert.strictEqual(s.gap_alerted_today, 0);
  assert.strictEqual(s.volume_above_alerted_today, 0);
});

test('applyStateUpdates upserts only whitelisted columns', () => {
  const store = createTrendStore(makeDb());
  store.applyStateUpdates('AAPL', { pdh_alerts_today: 1, pdh_below_since: null });
  let s = store.getState('AAPL');
  assert.strictEqual(s.pdh_alerts_today, 1);
  assert.strictEqual(s.pdh_below_since, null);
  // Update only one column — others preserved.
  store.applyStateUpdates('AAPL', { pdl_alerts_today: 1 });
  s = store.getState('AAPL');
  assert.strictEqual(s.pdh_alerts_today, 1);
  assert.strictEqual(s.pdl_alerts_today, 1);
});

test('applyStateUpdates ignores unknown columns silently', () => {
  const store = createTrendStore(makeDb());
  // 'malicious_col' should be filtered out — no SQL error, no insertion.
  assert.doesNotThrow(() =>
    store.applyStateUpdates('AAPL', { pdh_alerts_today: 1, malicious_col: 'X' })
  );
  const s = store.getState('AAPL');
  assert.strictEqual(s.pdh_alerts_today, 1);
});

test('applyStateUpdates with empty/all-unknown updates is a no-op', () => {
  const store = createTrendStore(makeDb());
  assert.doesNotThrow(() => store.applyStateUpdates('AAPL', {}));
  assert.doesNotThrow(() => store.applyStateUpdates('AAPL', { unknown: 1 }));
  assert.strictEqual(store.getState('AAPL'), null); // pas créé
});
```

- [ ] **Step 2: Run tests, see new ones fail**

Run: `node --test db/trend-store.test.js`
Expected: existing 10 pass; 8 new ones fail with `getQuoteType is not a function` (or similar).

- [ ] **Step 3: Update `db/trend-store.js` — append new accessors and update `addToWatchlist`**

Find the `insertWatch` prepared statement and replace it with the 4-arg version:

```js
const insertWatch = db.prepare(
  `INSERT OR IGNORE INTO trend_watchlist (guild_id, ticker, added_at, quote_type)
   VALUES (?, ?, ?, ?)`
);
```

Find the `addToWatchlist` method in the returned object and replace it with:

```js
addToWatchlist(guildId, ticker, nowMs, quoteType = null) {
  const res = insertWatch.run(guildId, ticker, nowMs, quoteType);
  return res.changes > 0;
},
```

In the prepared-statements section, add new statements:

```js
const updateQuoteType = db.prepare(
  `UPDATE trend_watchlist SET quote_type = ? WHERE ticker = ?`
);
const selectQuoteType = db.prepare(
  `SELECT quote_type FROM trend_watchlist WHERE ticker = ? AND quote_type IS NOT NULL LIMIT 1`
);

const RESET_DAILY_COLS = [
  'pdh_alerts_today', 'pdh_below_since',
  'pdl_alerts_today', 'pdl_above_since',
  'gap_alerted_today', 'volume_above_alerted_today',
];
const resetDailyStmt = db.prepare(
  `INSERT INTO trend_state (
     ticker, daily_state_date,
     pdh_alerts_today, pdh_below_since,
     pdl_alerts_today, pdl_above_since,
     gap_alerted_today, volume_above_alerted_today
   ) VALUES (?, ?, 0, NULL, 0, NULL, 0, 0)
   ON CONFLICT(ticker) DO UPDATE SET
     daily_state_date           = excluded.daily_state_date,
     pdh_alerts_today           = 0,
     pdh_below_since            = NULL,
     pdl_alerts_today           = 0,
     pdl_above_since            = NULL,
     gap_alerted_today          = 0,
     volume_above_alerted_today = 0`
);

const ALLOWED_STATE_COLUMNS = new Set([
  'direction', 'direction_changed_at',
  'last_breakout_at', 'last_bullish_reversal_at', 'last_bearish_reversal_at',
  'last_scan_at',
  'daily_state_date',
  'pdh_alerts_today', 'pdh_below_since',
  'pdl_alerts_today', 'pdl_above_since',
  'gap_alerted_today', 'volume_above_alerted_today',
]);
```

In the returned object, add these methods (alongside existing ones):

```js
setQuoteType(ticker, quoteType) {
  updateQuoteType.run(quoteType, ticker);
},
getQuoteType(ticker) {
  const row = selectQuoteType.get(ticker);
  return row ? row.quote_type : null;
},
resetDailyState(ticker, dateET) {
  resetDailyStmt.run(ticker, dateET);
},
applyStateUpdates(ticker, updates) {
  if (!updates || typeof updates !== 'object') return;
  const cols = Object.keys(updates).filter(c => ALLOWED_STATE_COLUMNS.has(c));
  if (cols.length === 0) return;
  // Build dynamically with whitelisted columns. No SQL injection risk.
  const placeholders = cols.map(() => '?').join(', ');
  const updateClause = cols.map(c => `${c} = excluded.${c}`).join(', ');
  const sql =
    `INSERT INTO trend_state (ticker, ${cols.join(', ')}) VALUES (?, ${placeholders}) ` +
    `ON CONFLICT(ticker) DO UPDATE SET ${updateClause}`;
  const stmt = db.prepare(sql);
  const values = cols.map(c => updates[c]);
  stmt.run(ticker, ...values);
},
```

- [ ] **Step 4: Run tests, see them pass**

Run: `node --test db/trend-store.test.js`
Expected: all 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add db/trend-store.js db/trend-store.test.js
git commit -m "feat(db/trend-store): quote_type + daily state accessors

- addToWatchlist: optional 4th arg quote_type
- setQuoteType / getQuoteType (ticker-scoped, all guild rows updated)
- resetDailyState (flush 6 daily cols, set date)
- applyStateUpdates (whitelist-guarded generic upsert)
"
```

---

## Task 3: `formatDateET` helper in scanner

**Files:**
- Modify: `trading/trend-scanner.js` (append helper)
- Modify: `trading/trend-scanner.test.js` (append tests)

- [ ] **Step 1: Append failing tests**

Append to `trading/trend-scanner.test.js`:

```js
const { formatDateET } = require('./trend-scanner');

test('formatDateET returns YYYY-MM-DD in NY timezone — EDT case', () => {
  // 2026-05-01 14:00 ET = 2026-05-01 18:00 UTC (EDT = UTC-4)
  const d = new Date(Date.UTC(2026, 4, 1, 18, 0, 0));
  assert.strictEqual(formatDateET(d), '2026-05-01');
});

test('formatDateET returns YYYY-MM-DD in NY timezone — EST case', () => {
  // 2026-12-15 10:00 ET = 2026-12-15 15:00 UTC (EST = UTC-5)
  const d = new Date(Date.UTC(2026, 11, 15, 15, 0, 0));
  assert.strictEqual(formatDateET(d), '2026-12-15');
});

test('formatDateET handles UTC-day-rollover correctly', () => {
  // 2026-05-01 23:30 ET = 2026-05-02 03:30 UTC
  // ET date is still 2026-05-01.
  const d = new Date(Date.UTC(2026, 4, 2, 3, 30, 0));
  assert.strictEqual(formatDateET(d), '2026-05-01');
});

test('formatDateET defaults to current time when no arg', () => {
  const result = formatDateET();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Run tests, see them fail**

Run: `node --test trading/trend-scanner.test.js`
Expected: new tests fail with `formatDateET is not a function`.

- [ ] **Step 3: Add `formatDateET` to `trading/trend-scanner.js`**

Append to the file (anywhere before `module.exports`, near `isUSMarketOpen` since they're related timezone helpers):

```js
// Returns the calendar date in America/New_York as 'YYYY-MM-DD'. Used as
// sentinel for the daily reset of trend_state. Locale 'en-CA' is chosen
// because it natively formats as 'YYYY-MM-DD' (sortable, ISO-like).
function formatDateET(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
```

Update the `module.exports` to include `formatDateET`:

```js
module.exports = { isUSMarketOpen, formatDateET, runScanCycle, startTrendScanner };
```

- [ ] **Step 4: Run, see them pass**

Run: `node --test trading/trend-scanner.test.js`
Expected: all existing tests + new `formatDateET` tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-scanner.js trading/trend-scanner.test.js
git commit -m "feat(trend): formatDateET helper (YYYY-MM-DD in ET timezone)"
```

---

## Task 4: `detectPDHBreak` engine function

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

Append to `trading/trend-engine.test.js` (and update the top destructure to include `detectPDHBreak`):

```js
test('detectPDHBreak returns no event when not enough candles', () => {
  const { detectPDHBreak } = require('./trend-engine');
  assert.deepStrictEqual(
    detectPDHBreak([], 100, {}, 15 * 60_000, 0),
    { event: null, stateUpdate: null }
  );
});

test('detectPDHBreak: first break of the day fires alert and updates state', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const state = { pdh_alerts_today: 0, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pdh_break');
  assert.strictEqual(result.event.pdh, 100);
  assert.strictEqual(result.event.price, 100.5);
  assert.deepStrictEqual(result.stateUpdate, { pdh_alerts_today: 1, pdh_below_since: null });
});

test('detectPDHBreak: still above after first alert returns null/null', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const state = { pdh_alerts_today: 1, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectPDHBreak: drops below PDH sets pdh_below_since', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 99.5, v: 1000 }];
  const state = { pdh_alerts_today: 1, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pdh_below_since: 1_000_000 });
});

test('detectPDHBreak: still below (already in below phase) returns null/null', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 99.5, v: 1000 }];
  const state = { pdh_alerts_today: 1, pdh_below_since: 500_000 };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectPDHBreak: clean re-entry after >= reentryMs fires alert', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdh_alerts_today: 1, pdh_below_since: 1_000_000 };
  const now = 1_000_000 + reentryMs; // exactly at threshold
  const result = detectPDHBreak(candles, 100, state, reentryMs, now);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pdh_break');
  assert.deepStrictEqual(result.stateUpdate, { pdh_alerts_today: 2, pdh_below_since: null });
});

test('detectPDHBreak: quick recovery (< reentryMs) clears below_since but no alert', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdh_alerts_today: 1, pdh_below_since: 1_000_000 };
  const now = 1_000_000 + 5 * 60_000; // 5 min < 15
  const result = detectPDHBreak(candles, 100, state, reentryMs, now);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pdh_below_since: null });
});

test('detectPDHBreak: never broken yet (alerts=0 and close <= pdh) returns null/null', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 99.5, v: 1000 }];
  const state = { pdh_alerts_today: 0, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});
```

- [ ] **Step 2: Run, see new tests fail**

Run: `node --test trading/trend-engine.test.js`
Expected: existing 16 pass, 8 new ones fail with `detectPDHBreak is not a function`.

- [ ] **Step 3: Add `detectPDHBreak` to `trading/trend-engine.js`**

Append before `module.exports`:

```js
// PDH break : intraday close > yesterday's high. Pure function — retourne
// { event, stateUpdate } sans muter `state`. Le scanner applique le delta.
//
// Logique de ré-entrée (cohérence avec le state machine PDH) :
//   - premier break du jour       → alert + alerts_today=1, below_since=null
//   - toujours au-dessus (déjà alerted, below_since=null) → no-op
//   - retombé sous PDH après alert → set below_since=now
//   - re-cassure après >= reentryMs sous PDH → alert + alerts_today++, below_since=null
//   - re-cassure rapide (< reentryMs)         → clear below_since (no alert)
function detectPDHBreak(intraday, pdh, state, reentryMs, now = Date.now()) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(pdh)) {
    return { event: null, stateUpdate: null };
  }
  const last = intraday[intraday.length - 1];
  const close = last.c;
  if (!Number.isFinite(close)) {
    return { event: null, stateUpdate: null };
  }

  const alertsToday = (state && state.pdh_alerts_today) || 0;
  const belowSince  = state && state.pdh_below_since;

  if (close > pdh) {
    if (alertsToday === 0) {
      return {
        event: { type: 'pdh_break', pdh, price: close, volume: last.v },
        stateUpdate: { pdh_alerts_today: 1, pdh_below_since: null },
      };
    }
    if (belowSince == null) {
      // Already above and already alerted today.
      return { event: null, stateUpdate: null };
    }
    if ((now - belowSince) >= reentryMs) {
      return {
        event: { type: 'pdh_break', pdh, price: close, volume: last.v },
        stateUpdate: { pdh_alerts_today: alertsToday + 1, pdh_below_since: null },
      };
    }
    // Quick recovery — clear without alerting.
    return { event: null, stateUpdate: { pdh_below_since: null } };
  }

  // close <= pdh
  if (alertsToday > 0 && belowSince == null) {
    return { event: null, stateUpdate: { pdh_below_since: now } };
  }
  return { event: null, stateUpdate: null };
}
```

Update the export at the bottom:

```js
module.exports = { detectDirection, detectBreakout, detectReversal, detectAll, detectPDHBreak };
```

- [ ] **Step 4: Run, see all tests pass**

Run: `node --test trading/trend-engine.test.js`
Expected: 16 + 8 = 24 tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectPDHBreak with re-entry state machine"
```

---

## Task 5: `detectPDLBreak` engine function (symmetric)

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

Append to `trading/trend-engine.test.js`:

```js
test('detectPDLBreak: first break of the day fires alert', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 99.5, v: 1000 }];
  const state = { pdl_alerts_today: 0, pdl_above_since: null };
  const result = detectPDLBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pdl_break');
  assert.strictEqual(result.event.pdl, 100);
  assert.strictEqual(result.event.price, 99.5);
  assert.deepStrictEqual(result.stateUpdate, { pdl_alerts_today: 1, pdl_above_since: null });
});

test('detectPDLBreak: rebounds above PDL sets pdl_above_since', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 100.5, v: 1000 }];
  const state = { pdl_alerts_today: 1, pdl_above_since: null };
  const result = detectPDLBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result.stateUpdate, { pdl_above_since: 1_000_000 });
});

test('detectPDLBreak: clean re-break after >= reentryMs fires alert', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 99.2, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdl_alerts_today: 1, pdl_above_since: 1_000_000 };
  const now = 1_000_000 + reentryMs;
  const result = detectPDLBreak(candles, 100, state, reentryMs, now);
  assert.ok(result.event);
  assert.deepStrictEqual(result.stateUpdate, { pdl_alerts_today: 2, pdl_above_since: null });
});

test('detectPDLBreak: quick recovery clears above_since without alert', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 99.2, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdl_alerts_today: 1, pdl_above_since: 1_000_000 };
  const now = 1_000_000 + 5 * 60_000;
  const result = detectPDLBreak(candles, 100, state, reentryMs, now);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pdl_above_since: null });
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test trading/trend-engine.test.js`
Expected: 4 new tests fail with `detectPDLBreak is not a function`.

- [ ] **Step 3: Add `detectPDLBreak` to `trading/trend-engine.js`**

Append before `module.exports`:

```js
// PDL break : intraday close < yesterday's low. Symétrique de detectPDHBreak,
// avec inversion < / > et utilisation des colonnes pdl_*.
function detectPDLBreak(intraday, pdl, state, reentryMs, now = Date.now()) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(pdl)) {
    return { event: null, stateUpdate: null };
  }
  const last = intraday[intraday.length - 1];
  const close = last.c;
  if (!Number.isFinite(close)) {
    return { event: null, stateUpdate: null };
  }

  const alertsToday = (state && state.pdl_alerts_today) || 0;
  const aboveSince  = state && state.pdl_above_since;

  if (close < pdl) {
    if (alertsToday === 0) {
      return {
        event: { type: 'pdl_break', pdl, price: close, volume: last.v },
        stateUpdate: { pdl_alerts_today: 1, pdl_above_since: null },
      };
    }
    if (aboveSince == null) {
      return { event: null, stateUpdate: null };
    }
    if ((now - aboveSince) >= reentryMs) {
      return {
        event: { type: 'pdl_break', pdl, price: close, volume: last.v },
        stateUpdate: { pdl_alerts_today: alertsToday + 1, pdl_above_since: null },
      };
    }
    return { event: null, stateUpdate: { pdl_above_since: null } };
  }

  // close >= pdl
  if (alertsToday > 0 && aboveSince == null) {
    return { event: null, stateUpdate: { pdl_above_since: now } };
  }
  return { event: null, stateUpdate: null };
}
```

Update export:

```js
module.exports = { detectDirection, detectBreakout, detectReversal, detectAll, detectPDHBreak, detectPDLBreak };
```

- [ ] **Step 4: Run, see all tests pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all (16 + 8 + 4) tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectPDLBreak (symmetric to PDH)"
```

---

## Task 6: `detectGap` engine function

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

```js
test('detectGap: gap up above threshold fires gap_up', () => {
  const { detectGap } = require('./trend-engine');
  // todayOpen 102, prevClose 100 → +2.0%
  const candles = [{ t: 0, o: 102, h: 103, l: 101.5, c: 102.5, v: 1000 }];
  const state = { gap_alerted_today: 0 };
  const result = detectGap(candles, 100, 1.5, state);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'gap_up');
  assert.strictEqual(result.event.openPrice, 102);
  assert.strictEqual(result.event.prevClose, 100);
  assert.ok(Math.abs(result.event.gapPct - 2.0) < 0.001);
  assert.deepStrictEqual(result.stateUpdate, { gap_alerted_today: 1 });
});

test('detectGap: gap down below negative threshold fires gap_down', () => {
  const { detectGap } = require('./trend-engine');
  // todayOpen 98, prevClose 100 → -2.0%
  const candles = [{ t: 0, o: 98, h: 98.5, l: 97, c: 97.5, v: 1000 }];
  const result = detectGap(candles, 100, 1.5, { gap_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'gap_down');
  assert.ok(result.event.gapPct < 0);
});

test('detectGap: under threshold returns null', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 100.8, h: 101, l: 100, c: 100.5, v: 1000 }];
  const result = detectGap(candles, 100, 1.5, { gap_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectGap: index threshold (0.5) detects smaller gaps', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 100.8, h: 101, l: 100, c: 100.5, v: 1000 }];
  // 0.8% gap with 0.5 threshold → fires
  const result = detectGap(candles, 100, 0.5, { gap_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'gap_up');
});

test('detectGap: already alerted today returns null', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 102, h: 103, l: 101.5, c: 102.5, v: 1000 }];
  const result = detectGap(candles, 100, 1.5, { gap_alerted_today: 1 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectGap: missing prevClose returns null', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 102, h: 103, l: 101.5, c: 102.5, v: 1000 }];
  const result = detectGap(candles, 0, 1.5, { gap_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test trading/trend-engine.test.js`
Expected: 6 new tests fail.

- [ ] **Step 3: Add `detectGap` to `trading/trend-engine.js`**

```js
// Gap up/down at market open. Threshold en pourcentage (différent selon
// quote_type côté scanner). Une seule fois par jour : gap_alerted_today
// guard. Idempotent en cas de re-call dans la journée.
function detectGap(intraday, prevClose, gapThresholdPct, state) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    return { event: null, stateUpdate: null };
  }
  if (state && state.gap_alerted_today) {
    return { event: null, stateUpdate: null };
  }
  const todayOpen = intraday[0].o;
  if (!Number.isFinite(todayOpen)) {
    return { event: null, stateUpdate: null };
  }
  const gapPct = ((todayOpen - prevClose) / prevClose) * 100;
  if (gapPct >= gapThresholdPct) {
    return {
      event: { type: 'gap_up', openPrice: todayOpen, prevClose, gapPct },
      stateUpdate: { gap_alerted_today: 1 },
    };
  }
  if (gapPct <= -gapThresholdPct) {
    return {
      event: { type: 'gap_down', openPrice: todayOpen, prevClose, gapPct },
      stateUpdate: { gap_alerted_today: 1 },
    };
  }
  return { event: null, stateUpdate: null };
}
```

Update export:

```js
module.exports = { detectDirection, detectBreakout, detectReversal, detectAll, detectPDHBreak, detectPDLBreak, detectGap };
```

- [ ] **Step 4: Run, see all tests pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectGap (gap up/down at market open)"
```

---

## Task 7: `detectVolumeAbovePrevDay` engine function

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

```js
test('detectVolumeAbovePrevDay: cumulative > prev × multiplier fires alert', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  // 5 bars × 2200 = 11000 ; prev = 10000 ; 11000 > 10000 × 1.05 = 10500
  const candles = Array(5).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 2200 }));
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'volume_above_prev_day');
  assert.strictEqual(result.event.todayVolume, 11000);
  assert.strictEqual(result.event.prevDayVolume, 10000);
  assert.deepStrictEqual(result.stateUpdate, { volume_above_alerted_today: 1 });
});

test('detectVolumeAbovePrevDay: cumulative under threshold returns null', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = Array(5).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 2000 }));
  // 10000 not > 10000 * 1.05 = 10500
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: already alerted returns null', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = Array(5).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 5000 }));
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 1 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: prevDayVolume <= 0 returns null', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 5000 }];
  const result = detectVolumeAbovePrevDay(candles, 0, 1.05, { volume_above_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: handles NaN volumes (skips them)', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = [
    { t: 0, o: 100, h: 100, l: 100, c: 100, v: 5000 },
    { t: 1, o: 100, h: 100, l: 100, c: 100, v: NaN },
    { t: 2, o: 100, h: 100, l: 100, c: 100, v: 6000 },
  ];
  // sum = 11000 (NaN skipped) ; > 10000 * 1.05 = 10500 → fires
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.todayVolume, 11000);
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test trading/trend-engine.test.js`
Expected: 5 new tests fail.

- [ ] **Step 3: Add `detectVolumeAbovePrevDay` to `trading/trend-engine.js`**

```js
// Cumul du volume aujourd'hui > volume total d'hier × multiplier (default 1.05).
// Fire 1× / jour. NaN volumes ignorés (Yahoo peut renvoyer NaN sur des bars vides).
function detectVolumeAbovePrevDay(intraday, prevDayVolume, multiplier, state) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(prevDayVolume) || prevDayVolume <= 0) {
    return { event: null, stateUpdate: null };
  }
  if (state && state.volume_above_alerted_today) {
    return { event: null, stateUpdate: null };
  }
  let cumVolume = 0;
  for (const bar of intraday) {
    if (Number.isFinite(bar.v)) cumVolume += bar.v;
  }
  if (cumVolume > prevDayVolume * multiplier) {
    return {
      event: {
        type: 'volume_above_prev_day',
        todayVolume: cumVolume,
        prevDayVolume,
        ratio: cumVolume / prevDayVolume,
      },
      stateUpdate: { volume_above_alerted_today: 1 },
    };
  }
  return { event: null, stateUpdate: null };
}
```

Update export:

```js
module.exports = {
  detectDirection, detectBreakout, detectReversal, detectAll,
  detectPDHBreak, detectPDLBreak, detectGap, detectVolumeAbovePrevDay,
};
```

- [ ] **Step 4: Run, see them pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectVolumeAbovePrevDay (cumulative volume vs prev day)"
```

---

## Task 8: Extend `detectAll` to call new detectors

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

```js
test('detectAll: returns stateUpdates accumulated from new detectors', () => {
  const { detectAll } = require('./trend-engine');
  // Build a 40-bar uptrend so direction returns non-null. Last close = 119.5.
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  const intraday = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1000 }));
  // Daily context: yesterday high=119, low=100, close=118, volume=10000
  const dailyContext = { yesterday: { high: 119, low: 100, close: 118, volume: 10000 } };
  const state = {
    pdh_alerts_today: 0, pdh_below_since: null,
    pdl_alerts_today: 0, pdl_above_since: null,
    gap_alerted_today: 0, volume_above_alerted_today: 0,
  };
  const opts = { reentryMs: 15 * 60_000, gapThresholdPct: 1.5, volumeMultiplier: 1.05 };
  const result = detectAll(intraday, dailyContext, state, opts);
  assert.ok(result, 'should return non-null verdict');
  assert.strictEqual(result.direction, 'uptrend');
  assert.ok(Array.isArray(result.events));
  // PDH=119, last close=119.5 → pdh_break should fire
  assert.ok(result.events.some(e => e.type === 'pdh_break'));
  // stateUpdates contains pdh_alerts_today: 1 from PDH detector
  assert.ok(result.stateUpdates);
  assert.strictEqual(result.stateUpdates.pdh_alerts_today, 1);
});

test('detectAll: missing dailyContext skips new detectors silently', () => {
  const { detectAll } = require('./trend-engine');
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  const intraday = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1000 }));
  const result = detectAll(intraday, null, {}, {});
  assert.ok(result);
  assert.strictEqual(result.direction, 'uptrend');
  // No PDH/PDL/gap/volume events
  for (const ev of result.events) {
    assert.ok(!['pdh_break', 'pdl_break', 'gap_up', 'gap_down', 'volume_above_prev_day'].includes(ev.type));
  }
  assert.deepStrictEqual(result.stateUpdates, {});
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test trading/trend-engine.test.js`
Expected: 2 new tests fail because `detectAll` does not yet accept dailyContext or return stateUpdates.

- [ ] **Step 3: Replace `detectAll` in `trading/trend-engine.js`**

Replace the existing `detectAll` function with:

```js
// Combines all detectors. Retourne `null` si pas assez de candles pour
// detectDirection (gating). Sinon retourne :
//   { direction, events: [...], snapshot: {...}, stateUpdates: {...} }
//
// dailyContext (optionnel) : { yesterday: { high, low, close, volume }, ... }
//   Si null → les 4 détecteurs PDH/PDL/gap/volume sont skippés (mais
//   direction/breakout/reversal continuent).
//
// state (optionnel) : la ligne trend_state actuelle, lue par les détecteurs
//   PDH/PDL/gap/volume pour décider de fire-or-not.
function detectAll(intraday, dailyContext = null, state = null, opts = {}) {
  const direction = detectDirection(intraday);
  if (direction === null) return null;

  const events = [];
  const stateUpdates = {};

  const breakout = detectBreakout(intraday, opts.breakoutLookback, opts.breakoutVolMult);
  if (breakout) events.push(breakout);

  const reversal = detectReversal(intraday, opts.rsiOverbought, opts.rsiOversold);
  if (reversal) events.push(reversal);

  if (dailyContext && dailyContext.yesterday) {
    const y = dailyContext.yesterday;
    const reentryMs = Number.isFinite(opts.reentryMs) ? opts.reentryMs : 15 * 60_000;
    const gapThresholdPct = Number.isFinite(opts.gapThresholdPct) ? opts.gapThresholdPct : 1.0;
    const volumeMultiplier = Number.isFinite(opts.volumeMultiplier) ? opts.volumeMultiplier : 1.05;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    const detectors = [
      () => detectPDHBreak(intraday, y.high, state, reentryMs, now),
      () => detectPDLBreak(intraday, y.low,  state, reentryMs, now),
      () => detectGap(intraday, y.close, gapThresholdPct, state),
      () => detectVolumeAbovePrevDay(intraday, y.volume, volumeMultiplier, state),
    ];
    for (const run of detectors) {
      const { event, stateUpdate } = run();
      if (event) events.push(event);
      if (stateUpdate) Object.assign(stateUpdates, stateUpdate);
    }
  }

  const closes = intraday.map(c => c.c);
  const snapshot = {
    price: closes[closes.length - 1],
    ema9:  calcEMA(closes, 9),
    ema20: calcEMA(closes, 20),
    rsi:   calcRSI(closes, 14),
  };

  return { direction, events, snapshot, stateUpdates };
}
```

- [ ] **Step 4: Run, see all tests pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all tests pass — including the existing `detectAll` tests, which should still work because the previous behavior is preserved when `dailyContext` is null. The previous `detectAll` test expected 4 specific keys (`direction, events, snapshot`) — now we add `stateUpdates`. Older tests using `assert.ok(out.snapshot)` still pass.

> **If a test fails because it asserts the exact shape `{ direction, events, snapshot }` strictly**, modify that test to allow the additional `stateUpdates` key. Don't weaken the assertions, just allow extra keys.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectAll calls new detectors and returns stateUpdates"
```

---

## Task 9: `getDailyContext` helper in scanner

**Files:**
- Modify: `trading/trend-scanner.js`
- Modify: `trading/trend-scanner.test.js`

- [ ] **Step 1: Append failing tests**

```js
const { getDailyContext } = require('./trend-scanner');

function makeFakeYahoo(quotesByRange) {
  return {
    getChart: async (ticker, range) => ({
      quotes: (quotesByRange[range] || []).map(b => ({
        date: new Date(b.t),
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      })),
    }),
  };
}

test('getDailyContext: extracts yesterday OHLCV and today open from 1M chart', async () => {
  const yahoo = makeFakeYahoo({
    '1M': [
      { t: 1, o: 100, h: 105, l: 99,  c: 104, v: 8000 },
      { t: 2, o: 104, h: 110, l: 102, c: 108, v: 9500 },  // yesterday (avant-dernière)
      { t: 3, o: 109, h: 112, l: 107, c: 111, v: 5000 },  // today (in progress)
    ],
  });
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.ok(ctx);
  assert.strictEqual(ctx.yesterday.high, 110);
  assert.strictEqual(ctx.yesterday.low, 102);
  assert.strictEqual(ctx.yesterday.close, 108);
  assert.strictEqual(ctx.yesterday.volume, 9500);
  assert.strictEqual(ctx.todayOpen, 109);
  assert.strictEqual(ctx.todayCumVolume, 5000);
});

test('getDailyContext: returns null with fewer than 2 quotes', async () => {
  const yahoo = makeFakeYahoo({ '1M': [{ t: 1, o: 100, h: 100, l: 100, c: 100, v: 1000 }] });
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.strictEqual(ctx, null);
});

test('getDailyContext: returns null on yahoo error', async () => {
  const yahoo = { getChart: async () => { throw new Error('not found'); } };
  const ctx = await getDailyContext(yahoo, 'AAPL');
  assert.strictEqual(ctx, null);
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test trading/trend-scanner.test.js`
Expected: new tests fail with `getDailyContext is not a function`.

- [ ] **Step 3: Add `getDailyContext` to `trading/trend-scanner.js`**

Append in the file (anywhere before `module.exports` — natural spot is near `adaptYahooBars`):

```js
// Fetch daily chart (~22 days) and extract yesterday's OHLCV + today's
// open + cumulative volume. Yahoo arrange les quotes par ordre
// chronologique ; "today" est le dernier (en cours), "yesterday" l'avant-dernier.
//
// Retourne null si erreur ou < 2 quotes (ticker très jeune / illiquide).
async function getDailyContext(yahoo, ticker) {
  let chart;
  try {
    chart = await yahoo.getChart(ticker, '1M');
  } catch (err) {
    console.warn(`[trend] getDailyContext failed for ${ticker}: ${err && err.message}`);
    return null;
  }
  const quotes = (chart && chart.quotes) || [];
  if (quotes.length < 2) return null;
  const today = quotes[quotes.length - 1];
  const yesterday = quotes[quotes.length - 2];
  return {
    yesterday: {
      high: yesterday.high,
      low: yesterday.low,
      close: yesterday.close,
      volume: yesterday.volume,
    },
    todayOpen: today.open,
    todayCumVolume: today.volume,
  };
}
```

Update `module.exports`:

```js
module.exports = { isUSMarketOpen, formatDateET, getDailyContext, runScanCycle, startTrendScanner };
```

- [ ] **Step 4: Run, see them pass**

Run: `node --test trading/trend-scanner.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-scanner.js trading/trend-scanner.test.js
git commit -m "feat(trend): getDailyContext helper (yesterday OHLCV + today open)"
```

---

## Task 10: Extend scanner — daily reset, quote_type backfill, daily fetch, applyStateUpdates

**Files:**
- Modify: `trading/trend-scanner.js`
- Modify: `trading/trend-scanner.test.js`

- [ ] **Step 1: Update `fakeYahoo` to support new shape (intraday + daily + quote)**

In `trading/trend-scanner.test.js`, replace the existing `fakeYahoo` function with this backwards-compatible version:

```js
function fakeYahoo(arg) {
  // Backwards-compat: fakeYahoo({ AAPL: [...] }) — old shape, used by existing tests.
  // New shape: fakeYahoo({ intraday: { AAPL: [...] }, daily: { AAPL: [...] }, quote: { AAPL: { quoteType: 'EQUITY' } } })
  const isNewShape = arg && (arg.intraday || arg.daily || arg.quote);
  const intradayMap = isNewShape ? (arg.intraday || {}) : (arg || {});
  const dailyMap    = isNewShape ? (arg.daily || {}) : {};
  const quoteMap    = isNewShape ? (arg.quote || {}) : {};

  return {
    getChart: async (ticker, range) => {
      const map = range === '1M' ? dailyMap : intradayMap;
      return {
        quotes: (map[ticker] || []).map(b => ({
          date: new Date(b.t),
          open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
        })),
      };
    },
    getQuote: async (ticker) => quoteMap[ticker] || {},
  };
}
```

- [ ] **Step 2: Append failing tests for daily reset + quote_type backfill + new alerts**

```js
test('runScanCycle: daily reset clears daily state when ET date changes', async () => {
  const { store, db } = makeStoreDb();
  // Simulate previous day state (PDH already alerted, gap already alerted, etc.)
  store.applyStateUpdates('AAPL', {
    daily_state_date: '2026-04-30',
    pdh_alerts_today: 1, pdh_below_since: 100,
    gap_alerted_today: 1, volume_above_alerted_today: 1,
  });
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'c1', 1);

  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: Date.UTC(2026, 4, 1, 13, 30), o: 110, h: 115, l: 105, c: 113, v: 8000 },  // 2 days ago
      { t: Date.UTC(2026, 4, 1, 13, 30), o: 113, h: 119, l: 108, c: 118, v: 9500 },  // yesterday
      { t: Date.UTC(2026, 4, 1, 13, 30), o: 118, h: 121, l: 117, c: 120, v: 5000 },  // today
    ]},
    quote: { AAPL: { quoteType: 'EQUITY' } },
  });
  const discord = fakeDiscordClient();
  // now = 2026-05-01 14:00 UTC = 10:00 ET on 2026-05-01 → date = '2026-05-01' (different)
  const now = () => Date.UTC(2026, 4, 1, 14, 0);
  await runScanCycle({ store, yahoo, discord, now });
  const s = store.getState('AAPL');
  // After scan: reset (date now = today), and possibly new flags from this scan
  assert.strictEqual(s.daily_state_date, '2026-05-01');
});

test('runScanCycle: backfills quote_type via yahoo.getQuote on first scan', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);  // no quoteType yet
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 100, h: 102, l: 99, c: 101, v: 8000 },
      { t: 2, o: 101, h: 105, l: 100, c: 104, v: 9000 },
      { t: 3, o: 104, h: 110, l: 103, c: 109, v: 5000 },
    ]},
    quote: { AAPL: { quoteType: 'EQUITY' } },
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_700_000_000_000 });
  assert.strictEqual(store.getQuoteType('AAPL'), 'EQUITY');
});

test('runScanCycle: dispatches PDH break alert when last intraday close > yesterday high', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1, 'EQUITY');
  store.setChannel('g1', 'c1', 1);
  // Build intraday with close above yesterday high. uptrendCandles() ends ~120.
  const yahoo = fakeYahoo({
    intraday: { AAPL: uptrendCandles() },
    daily: { AAPL: [
      { t: 1, o: 100, h: 105, l: 95,  c: 102, v: 8000 },
      { t: 2, o: 102, h: 119, l: 100, c: 117, v: 9000 },  // yesterday — high=119
      { t: 3, o: 117, h: 121, l: 116, c: 120, v: 5000 },  // today
    ]},
  });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_700_000_000_000 });
  const sentPDH = discord.sent.find(s => /PDH break/.test(s.content));
  assert.ok(sentPDH, 'expected PDH break alert');
});
```

- [ ] **Step 3: Run, see new tests fail**

Run: `node --test trading/trend-scanner.test.js`
Expected: new tests fail (state not properly reset / quote_type not backfilled / alerts missing).

- [ ] **Step 4: Update `runScanCycle` to integrate new behavior**

In `trading/trend-scanner.js`, find the existing `runScanCycle` function. We need to MODIFY the per-ticker loop body. Replace the entire `for (const ticker of tickers) { ... }` block with:

```js
  for (const ticker of tickers) {
    try {
      // 1. Daily reset if ET date has changed since last scan for this ticker
      const todayET = formatDateET(new Date(now()));
      const stateBefore = store.getState(ticker);
      if (!stateBefore || stateBefore.daily_state_date !== todayET) {
        store.resetDailyState(ticker, todayET);
      }

      // 2. Backfill quote_type if missing
      let quoteType = store.getQuoteType(ticker);
      if (quoteType == null && typeof yahoo.getQuote === 'function') {
        try {
          const q = await yahoo.getQuote(ticker);
          if (q && q.quoteType) {
            quoteType = q.quoteType;
            store.setQuoteType(ticker, quoteType);
          }
        } catch (err) {
          console.warn(`[trend] quote backfill failed for ${ticker}: ${err && err.message}`);
        }
      }

      // 3. Compute gap threshold from quote_type
      const isIndexLike = quoteType === 'ETF' || quoteType === 'INDEX' || quoteType === 'MUTUALFUND';
      const gapThresholdPct = isIndexLike
        ? (detectorOpts.gapThresholdIndexPct || 0.5)
        : (detectorOpts.gapThresholdStockPct || 1.5);

      // 4. Fetch intraday + daily context
      const chart = await yahoo.getChart(ticker, '1D');
      const candles = adaptYahooBars(chart && chart.quotes);
      const dailyContext = await getDailyContext(yahoo, ticker);

      // 5. Re-read state (after potential reset)
      const state = store.getState(ticker) || {};

      // 6. detectAll with the daily context + state
      const verdict = detectAll(candles, dailyContext, state, {
        breakoutLookback: detectorOpts.breakoutLookback,
        breakoutVolMult:  detectorOpts.breakoutVolMult,
        rsiOverbought:    detectorOpts.rsiOverbought,
        rsiOversold:      detectorOpts.rsiOversold,
        reentryMs:        detectorOpts.reentryMs,
        gapThresholdPct,
        volumeMultiplier: detectorOpts.volumeMultiplier,
        now:              now(),
      });
      if (!verdict) continue;

      // 7. Apply state updates from engine (new daily-event flags)
      if (verdict.stateUpdates && Object.keys(verdict.stateUpdates).length > 0) {
        store.applyStateUpdates(ticker, verdict.stateUpdates);
      }

      // 8. Direction transition (existing logic, unchanged)
      const tNow = now();
      const dedupMs = dedupMinutes * 60 * 1000;
      const messages = [];
      const prevDir = state.direction || null;
      if (verdict.direction !== prevDir) {
        messages.push({
          type: 'direction',
          content: formatDirectionAlert(ticker, prevDir, verdict.direction, verdict.snapshot),
        });
        store.updateDirection(ticker, verdict.direction, tNow);
      }

      // 9. Events: dispatch with appropriate dedup logic per type
      for (const ev of verdict.events) {
        let content = null;
        const lastTsCol =
          ev.type === 'breakout' ? 'last_breakout_at' :
          ev.type === 'bullish_reversal' ? 'last_bullish_reversal_at' :
          ev.type === 'bearish_reversal' ? 'last_bearish_reversal_at' : null;

        if (lastTsCol) {
          // Time-based dedup (existing logic)
          const lastTs = state[lastTsCol] || null;
          if (lastTs && (tNow - lastTs) < dedupMs) continue;
          content = ev.type === 'breakout'
            ? formatBreakoutAlert(ticker, ev, verdict.snapshot)
            : formatReversalAlert(ticker, ev, verdict.snapshot);
          store.updateEvent(ticker, ev.type, tNow);
        } else if (ev.type === 'pdh_break') {
          content = formatPDHBreakAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'pdl_break') {
          content = formatPDLBreakAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'gap_up' || ev.type === 'gap_down') {
          content = formatGapAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'volume_above_prev_day') {
          content = formatVolumeAboveAlert(ticker, ev, verdict.snapshot, now());
        }

        if (content) messages.push({ type: ev.type, content });
      }

      if (messages.length === 0) continue;

      const guilds = store.getGuildsWatching(ticker);
      for (const guildId of guilds) {
        const channelId = store.getChannel(guildId);
        if (!channelId) continue;
        for (const msg of messages) {
          const result = await postToChannel({ discord, store, guildId, channelId, content: msg.content });
          if (result.ok) alerts += 1;
          if (result.reason === 'unknown_channel') break;
        }
      }
    } catch (err) {
      errors += 1;
      console.error(`[trend] scan failed for ${ticker}: ${err && err.message}`);
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }
```

> **Note**: this references `formatPDHBreakAlert`, `formatPDLBreakAlert`, `formatGapAlert`, `formatVolumeAboveAlert` which we'll add in Task 11. The tests in this task that verify dispatch will fail until Task 11. That's acceptable — the daily-reset and quote_type tests above don't depend on the new formatters and should pass.

> **Important**: keep the existing `runScanCycle({ store, yahoo, discord, now, dedupMinutes, throttleMs, detectorOpts })` parameter signature. The `detectorOpts` now passes `reentryMs`, `gapThresholdIndexPct`, `gapThresholdStockPct`, `volumeMultiplier` (added in Task 14).

- [ ] **Step 5: Run scanner tests** (some still fail because formatters don't exist yet)

Run: `node --test trading/trend-scanner.test.js`
Expected:
- daily-reset test passes ✅
- quote_type backfill test passes ✅
- PDH break dispatch test FAILS with `formatPDHBreakAlert is not defined` (expected — Task 11)
- All other existing tests still pass

- [ ] **Step 6: Commit (partial — formatters wired in Task 11)**

```bash
git add trading/trend-scanner.js trading/trend-scanner.test.js
git commit -m "feat(trend): scanner — daily reset, quote_type backfill, applyStateUpdates wiring

Le formatter des nouvelles alertes (PDH/PDL/gap/volume) est wired mais
pas encore défini — sera complété dans la tâche suivante.
"
```

---

## Task 11: Alert formatters for new events + complete dispatch wiring

**Files:**
- Modify: `trading/trend-scanner.js`

- [ ] **Step 1: Add the 4 formatters**

In `trading/trend-scanner.js`, append (anywhere before `module.exports`, near the existing `formatBreakoutAlert` function):

```js
function fmtPct(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toFixed(1) + '%';
}

function formatPDHBreakAlert(ticker, ev, snap) {
  return [
    `🟢 **$${ticker}** — PDH break`,
    `Closed above yesterday's high ${fmtPrice(ev.pdh)}`,
    `Price: ${fmtPrice(ev.price)} · Volume: ${fmtVolume(ev.volume)}`,
  ].join('\n');
}

function formatPDLBreakAlert(ticker, ev, snap) {
  return [
    `🔴 **$${ticker}** — PDL break`,
    `Closed below yesterday's low ${fmtPrice(ev.pdl)}`,
    `Price: ${fmtPrice(ev.price)} · Volume: ${fmtVolume(ev.volume)}`,
  ].join('\n');
}

function formatGapAlert(ticker, ev, snap) {
  const arrow = ev.type === 'gap_up' ? '⬆️' : '⬇️';
  const label = ev.type === 'gap_up' ? 'gap up' : 'gap down';
  return [
    `${arrow} **$${ticker}** — ${label} ${fmtPct(ev.gapPct)}`,
    `Opened ${fmtPrice(ev.openPrice)} vs prev close ${fmtPrice(ev.prevClose)}`,
  ].join('\n');
}

function formatVolumeAboveAlert(ticker, ev, snap, nowMs) {
  const overPct = ((ev.ratio - 1) * 100);
  const time = new Date(nowMs).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return [
    `📊 **$${ticker}** — volume above prev day`,
    `Today: ${fmtVolume(ev.todayVolume)} (${fmtPct(overPct)}) · Yesterday: ${fmtVolume(ev.prevDayVolume)}`,
    `Time: ${time} ET`,
  ].join('\n');
}
```

- [ ] **Step 2: Run scanner tests, see them pass now**

Run: `node --test trading/trend-scanner.test.js`
Expected: all tests pass — including the PDH break dispatch test from Task 10.

- [ ] **Step 3: Commit**

```bash
git add trading/trend-scanner.js
git commit -m "feat(trend): alert formatters for PDH/PDL/gap/volume events"
```

---

## Task 12: `!trend watch` captures `quote_type`

**Files:**
- Modify: `discord/trend-commands.js`

- [ ] **Step 1: Update `handleWatch` to fetch quote and capture quoteType**

Find `handleWatch` in `discord/trend-commands.js`. The current validation calls `yahoo.getChart(ticker, '1D')`. We need to ALSO fetch `yahoo.getQuote(ticker)` to capture `quoteType`, and pass it to `addToWatchlist`.

Replace the validation block (the `try { const chart = ... } catch` block) with this version that does both calls and captures quoteType:

```js
  let quoteType = null;
  try {
    const chart = await yahoo.getChart(ticker, '1D');
    if (!chart || !Array.isArray(chart.quotes) || chart.quotes.length === 0) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    if (typeof yahoo.getQuote === 'function') {
      try {
        const quote = await yahoo.getQuote(ticker);
        if (quote && quote.quoteType) quoteType = quote.quoteType;
      } catch (qErr) {
        // Quote fetch is best-effort; chart already validated the ticker exists.
        console.warn(`[trend] quote fetch failed for ${ticker}: ${qErr && qErr.message}`);
      }
    }
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }

  const added = store.addToWatchlist(message.guildId, ticker, Date.now(), quoteType);
```

(Pass `quoteType` as the 4th arg of `addToWatchlist`.)

- [ ] **Step 2: Sanity-check parse**

Run: `node -e "require('./discord/trend-commands')"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add discord/trend-commands.js
git commit -m "feat(trend): !trend watch captures quote_type via yahoo.getQuote"
```

---

## Task 13: `!trend TICKER` shows daily events

**Files:**
- Modify: `discord/trend-commands.js`

- [ ] **Step 1: Extend `handleAnalyze` to fetch daily context and show events**

The existing `handleAnalyze` only fetches intraday and shows `Recent events`. We need to:
- Also fetch daily context (for the snapshot at the bottom and for displaying daily events)
- Pass dailyContext + state to `detectAll`
- Add a new "Today's daily-reference events" section before the existing "Recent intraday events" section
- Show today's volume vs yesterday at the bottom

Find `handleAnalyze` and replace its body with:

```js
async function handleAnalyze(message, ticker, { yahoo, store }) {
  let chart, dailyContext;
  try {
    chart = await yahoo.getChart(ticker, '1D');
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    console.error('[trend] yahoo error', err && err.message);
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }
  // Daily context: best-effort, omit sections if not available.
  try {
    const { getDailyContext } = require('../trading/trend-scanner');
    dailyContext = await getDailyContext(yahoo, ticker);
  } catch (e) {
    dailyContext = null;
  }

  const candles = adaptYahooBars(chart && chart.quotes);
  const state = store.getState(ticker) || {};
  const verdict = detectAll(candles, dailyContext, state, {});
  if (!verdict) {
    return message.reply(`❌ Not enough data for $${ticker}`).catch(() => {});
  }

  const sinceLine = state && state.direction_changed_at
    ? ` (since ${formatTime(state.direction_changed_at)})`
    : '';

  const lines = [
    `📊 **$${ticker}**`,
    `Direction: ${DIRECTION_EMOJI[verdict.direction] || ''} ${verdict.direction}${sinceLine}`,
    `Price: ${formatPrice(verdict.snapshot.price)} · EMA9 ${formatPrice(verdict.snapshot.ema9)} · EMA20 ${formatPrice(verdict.snapshot.ema20)} · RSI ${formatRsi(verdict.snapshot.rsi)}`,
  ];

  // Today's daily-reference events (only if we have state from this trading day)
  const dailyLines = [];
  if (state.pdh_alerts_today > 0 && dailyContext) {
    dailyLines.push(`• 🟢 PDH break (yesterday's high ${formatPrice(dailyContext.yesterday.high)})`);
  }
  if (state.pdl_alerts_today > 0 && dailyContext) {
    dailyLines.push(`• 🔴 PDL break (yesterday's low ${formatPrice(dailyContext.yesterday.low)})`);
  }
  if (state.gap_alerted_today && dailyContext) {
    const gapPct = ((dailyContext.todayOpen - dailyContext.yesterday.close) / dailyContext.yesterday.close) * 100;
    const arrow = gapPct >= 0 ? '⬆️' : '⬇️';
    const sign = gapPct >= 0 ? '+' : '';
    dailyLines.push(`• ${arrow} Gap ${sign}${gapPct.toFixed(1)}% at open`);
  }
  if (state.volume_above_alerted_today && dailyContext) {
    const ratio = dailyContext.todayCumVolume / dailyContext.yesterday.volume;
    const overPct = (ratio - 1) * 100;
    dailyLines.push(`• 📊 Volume above prev day (+${overPct.toFixed(1)}%)`);
  }
  if (dailyLines.length > 0) {
    lines.push('');
    lines.push("Today's daily-reference events:");
    lines.push(...dailyLines);
  }

  // Recent intraday events
  const intradayLines = [];
  if (state.last_breakout_at) {
    intradayLines.push(`• 🚀 Breakout at ${formatTime(state.last_breakout_at)}`);
  }
  if (state.last_bullish_reversal_at) {
    intradayLines.push(`• 🔄 Bullish reversal at ${formatTime(state.last_bullish_reversal_at)}`);
  }
  if (state.last_bearish_reversal_at) {
    intradayLines.push(`• 🔄 Bearish reversal at ${formatTime(state.last_bearish_reversal_at)}`);
  }
  lines.push('');
  lines.push('Recent intraday events:');
  if (intradayLines.length > 0) {
    lines.push(...intradayLines);
  } else {
    lines.push('• (no recent events tracked — add to watchlist for monitoring)');
  }

  // Today's volume vs yesterday (if we have daily context)
  if (dailyContext && dailyContext.yesterday.volume > 0) {
    const ratio = dailyContext.todayCumVolume / dailyContext.yesterday.volume;
    const overPct = (ratio - 1) * 100;
    const sign = overPct >= 0 ? '+' : '';
    const todayVolFmt = dailyContext.todayCumVolume >= 1e6
      ? (dailyContext.todayCumVolume / 1e6).toFixed(1) + 'M'
      : Math.round(dailyContext.todayCumVolume).toString();
    lines.push('');
    lines.push(`Today's volume: ${todayVolFmt} (${sign}${overPct.toFixed(1)}% vs yesterday)`);
  }

  return message.reply(lines.join('\n')).catch(e => console.error('[trend] reply', e.message));
}
```

- [ ] **Step 2: Sanity-check parse**

Run: `node -e "require('./discord/trend-commands')"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add discord/trend-commands.js
git commit -m "feat(trend): !trend TICKER shows daily-reference events + volume comparison"
```

---

## Task 14: Env vars + `readScannerConfig` extension

**Files:**
- Modify: `trading/trend-scanner.js`
- Modify: `.env.example`

- [ ] **Step 1: Append env vars to `.env.example`**

Append the following block at the end of `.env.example`:

```ini

# ─── Trend module — daily-reference signals (PDH/PDL/gap/volume) ──────
# All values are optional — defaults shown apply if unset.
# TREND_PDH_PDL_REENTRY_MIN=15
# TREND_GAP_THRESHOLD_INDEX_PCT=0.5
# TREND_GAP_THRESHOLD_STOCK_PCT=1.5
# TREND_VOLUME_VS_PREV_PCT=5
```

- [ ] **Step 2: Extend `readScannerConfig` and pass through to runScanCycle**

In `trading/trend-scanner.js`, find the `readScannerConfig` function and replace it with:

```js
function readScannerConfig() {
  const num = (k, d) => {
    const v = parseFloat(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    intervalMin:           num('TREND_SCAN_INTERVAL_MIN', 5),
    dedupMinutes:          num('TREND_DEDUP_MINUTES', 60),
    rsiOverbought:         num('TREND_RSI_OVERBOUGHT', 70),
    rsiOversold:           num('TREND_RSI_OVERSOLD', 30),
    breakoutLookback:      num('TREND_BREAKOUT_LOOKBACK_BARS', 20),
    breakoutVolMult:       num('TREND_BREAKOUT_VOLUME_MULT', 1.5),
    pdhPdlReentryMin:      num('TREND_PDH_PDL_REENTRY_MIN', 15),
    gapThresholdIndexPct:  num('TREND_GAP_THRESHOLD_INDEX_PCT', 0.5),
    gapThresholdStockPct:  num('TREND_GAP_THRESHOLD_STOCK_PCT', 1.5),
    volumeVsPrevPct:       num('TREND_VOLUME_VS_PREV_PCT', 5),
  };
}
```

In `startTrendScanner`, replace the `detectorOpts` build block with:

```js
  const detectorOpts = {
    breakoutLookback:     cfg.breakoutLookback,
    breakoutVolMult:      cfg.breakoutVolMult,
    rsiOverbought:        cfg.rsiOverbought,
    rsiOversold:          cfg.rsiOversold,
    reentryMs:            cfg.pdhPdlReentryMin * 60_000,
    gapThresholdIndexPct: cfg.gapThresholdIndexPct,
    gapThresholdStockPct: cfg.gapThresholdStockPct,
    volumeMultiplier:     1 + (cfg.volumeVsPrevPct / 100),
  };
```

- [ ] **Step 3: Run all tests once more end-to-end**

Run: `node --test trading/trend-engine.test.js trading/trend-scanner.test.js db/trend-store.test.js`
Expected: all tests pass (engine + scanner + store).

- [ ] **Step 4: Verify scanner module still loads cleanly**

Run: `node -e "require('./trading/trend-scanner')"`
Expected: no error.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-scanner.js .env.example
git commit -m "feat(trend): wire daily-signal env vars + .env.example doc

Defaults (all optional) :
- TREND_PDH_PDL_REENTRY_MIN = 15
- TREND_GAP_THRESHOLD_INDEX_PCT = 0.5
- TREND_GAP_THRESHOLD_STOCK_PCT = 1.5
- TREND_VOLUME_VS_PREV_PCT = 5
"
```

---

## Self-Review Notes (post-write)

- **Spec coverage:** All sections of the spec map to a task. DB schema → T1. Store → T2. formatDateET → T3. Engine functions (PDH/PDL/gap/volume) → T4-T7. detectAll extension → T8. getDailyContext → T9. Scanner integration → T10. Formatters → T11. !trend watch capture → T12. !trend TICKER extension → T13. Env vars → T14.
- **Type consistency:** `{ event, stateUpdate }` shape used identically across the 4 new detectors. `state` object shape (with `pdh_alerts_today`, `pdh_below_since`, etc.) consistent in tests, engine, store. `dailyContext.yesterday.{high,low,close,volume}` consistent.
- **Whitelisted columns** in `applyStateUpdates` — listed in store, mirrored in resetDailyState. New columns added to both.
- **No placeholders:** every code block is concrete and complete. The only "deferred" reference is in Task 10 step 5 where dispatch tests temporarily fail until Task 11 adds the formatters — this is explicit and resolves immediately in the next task.
- **Edge cases covered:** missing `dailyContext` (skips new detectors), `prev_volume <= 0` (skip volume), Yahoo error on `getQuote` (best-effort backfill, log + continue), DST (Intl handles it), cross-day reset (formatDateET ET-string match).
