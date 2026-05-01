# Trend detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an intraday trend-detection module: on-demand `!trend TICKER` command + auto-scanner over a per-guild watchlist that posts Discord alerts for direction transitions, breakouts, and reversals.

**Architecture:** Pure detection engine (no Discord/DB dependencies) reused by both the on-demand command and the scanner loop. Per-guild watchlist + alert channel persisted in SQLite. Global per-ticker state to dedupe alerts across guilds. Yahoo Finance via the existing `createYahooClient` factory exported from `discord/market-commands.js`.

**Tech Stack:** Node.js, `discord.js` v14, `better-sqlite3`, `yahoo-finance2` (all already in deps), `node:test` for unit tests.

---

## File Structure

**New files:**
- `trading/trend-engine.js` — pure detection (`detectDirection`, `detectBreakout`, `detectReversal`, `detectAll`)
- `trading/trend-engine.test.js` — unit tests on hand-built candle fixtures
- `trading/trend-scanner.js` — `isUSMarketOpen`, `runScanCycle`, `startTrendScanner`, alert formatting & dispatch
- `trading/trend-scanner.test.js` — unit tests with mocked yahoo + discord
- `discord/trend-commands.js` — `registerTrendCommands(client, deps)`, all `!trend ...` handlers
- `db/trend-store.js` — `createTrendStore(db)` factory, all DB accessors

**Modified files:**
- `db/sqlite.js` — add three `CREATE TABLE IF NOT EXISTS` statements
- `index.js` — share one `yahooClient`, register trend commands, start scanner
- `.env.example` — add 6 new optional env vars

**Existing reused:**
- `trading/indicators.js` — `calcEMA`, `calcEMASeries`, `calcRSI`
- `discord/market-commands.js` — `createYahooClient`, `formatPrice`, `formatVolume` (already exported)

---

## Task 1: DB tables for trend module

**Files:**
- Modify: `db/sqlite.js` (add 3 `CREATE TABLE IF NOT EXISTS` blocks at end of `db.exec(...)` schema section, before `module.exports`)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "module.exports" db/sqlite.js`
Expected: a line near the end exporting the db. Add the new tables to the existing `db.exec(\`...\`)` schema block (currently ending around line ~340).

- [ ] **Step 2: Add the trend tables to the schema string**

Inside the existing `db.exec(\`...\`)` call in `db/sqlite.js`, append these three table definitions before the closing backtick:

```sql
  -- Watchlist par guild Discord pour le module trend.
  -- (guild_id, ticker) unique. PK composite évite les doublons et
  -- les indexes utiles sont implicites (PK + ticker).
  CREATE TABLE IF NOT EXISTS trend_watchlist (
    guild_id  TEXT    NOT NULL,
    ticker    TEXT    NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, ticker)
  );
  CREATE INDEX IF NOT EXISTS idx_trend_watchlist_ticker ON trend_watchlist(ticker);

  -- Channel d'alerte par guild. 1 ligne / guild.
  CREATE TABLE IF NOT EXISTS trend_channel (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT    NOT NULL,
    set_at      INTEGER NOT NULL
  );

  -- État global par ticker (partagé entre toutes les guilds qui watch
  -- le même ticker). Sert à détecter les transitions de direction et
  -- à dédupliquer les events breakout/reversal.
  CREATE TABLE IF NOT EXISTS trend_state (
    ticker                       TEXT PRIMARY KEY,
    direction                    TEXT,                -- uptrend|downtrend|sideways|NULL
    direction_changed_at         INTEGER,
    last_breakout_at             INTEGER,
    last_bullish_reversal_at     INTEGER,
    last_bearish_reversal_at     INTEGER,
    last_scan_at                 INTEGER
  );
```

- [ ] **Step 3: Verify the schema applies cleanly**

Run: `node -e "require('./db/sqlite.js'); console.log('ok')"`
Expected: prints `ok`. The `IF NOT EXISTS` makes this idempotent — safe to run on the existing dev DB without dropping data.

- [ ] **Step 4: Confirm tables are created**

Run:
```bash
node -e "const {db} = require('./db/sqlite.js'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'trend_%'\").all());"
```
Expected: prints an array of 3 entries: `trend_watchlist`, `trend_channel`, `trend_state`.

> If `db` is not exported from `db/sqlite.js`, check the actual export name (likely `module.exports = db` or `module.exports = { db, ... }`) and adjust the require destructuring.

- [ ] **Step 5: Commit**

```bash
git add db/sqlite.js
git commit -m "feat(db): trend tables (watchlist, channel, state)

Trois tables pour le module trend-detection à venir :
- trend_watchlist (per-guild ticker list)
- trend_channel   (per-guild alert channel)
- trend_state     (global per-ticker state for dedup)
"
```

---

## Task 2: Trend store (DB accessors + tests)

**Files:**
- Create: `db/trend-store.js`
- Create: `db/trend-store.test.js`

- [ ] **Step 1: Write the failing test file**

Create `db/trend-store.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { createTrendStore } = require('./trend-store');

// Build a fresh in-memory DB with the trend schema.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trend_watchlist (
      guild_id TEXT NOT NULL, ticker TEXT NOT NULL, added_at INTEGER NOT NULL,
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
      last_scan_at INTEGER
    );
  `);
  return db;
}

test('addToWatchlist adds a row, ignores duplicates', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.addToWatchlist('g1', 'AAPL', 1000), true);
  assert.strictEqual(store.addToWatchlist('g1', 'AAPL', 2000), false); // already there
  assert.deepStrictEqual(store.getWatchlist('g1'), ['AAPL']);
});

test('removeFromWatchlist returns true if removed, false if absent', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  assert.strictEqual(store.removeFromWatchlist('g1', 'AAPL'), true);
  assert.strictEqual(store.removeFromWatchlist('g1', 'AAPL'), false);
  assert.deepStrictEqual(store.getWatchlist('g1'), []);
});

test('getWatchlist sorts tickers alphabetically', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'TSLA', 1000);
  store.addToWatchlist('g1', 'AAPL', 1001);
  store.addToWatchlist('g1', 'NVDA', 1002);
  assert.deepStrictEqual(store.getWatchlist('g1'), ['AAPL', 'NVDA', 'TSLA']);
});

test('getDistinctTickers across all guilds', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  store.addToWatchlist('g2', 'AAPL', 1000);
  store.addToWatchlist('g2', 'TSLA', 1000);
  assert.deepStrictEqual(store.getDistinctTickers().sort(), ['AAPL', 'TSLA']);
});

test('getGuildsWatching returns guilds for a ticker', () => {
  const store = createTrendStore(makeDb());
  store.addToWatchlist('g1', 'AAPL', 1000);
  store.addToWatchlist('g2', 'AAPL', 1000);
  store.addToWatchlist('g3', 'TSLA', 1000);
  assert.deepStrictEqual(store.getGuildsWatching('AAPL').sort(), ['g1', 'g2']);
  assert.deepStrictEqual(store.getGuildsWatching('TSLA'), ['g3']);
  assert.deepStrictEqual(store.getGuildsWatching('NVDA'), []);
});

test('setChannel + getChannel + deleteChannel', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.getChannel('g1'), null);
  store.setChannel('g1', 'c1', 1000);
  assert.strictEqual(store.getChannel('g1'), 'c1');
  store.setChannel('g1', 'c2', 2000); // overwrite
  assert.strictEqual(store.getChannel('g1'), 'c2');
  store.deleteChannel('g1');
  assert.strictEqual(store.getChannel('g1'), null);
});

test('getState returns null for unknown ticker', () => {
  const store = createTrendStore(makeDb());
  assert.strictEqual(store.getState('AAPL'), null);
});

test('updateDirection upserts and getState reads back', () => {
  const store = createTrendStore(makeDb());
  store.updateDirection('AAPL', 'uptrend', 1000);
  let s = store.getState('AAPL');
  assert.strictEqual(s.direction, 'uptrend');
  assert.strictEqual(s.direction_changed_at, 1000);
  store.updateDirection('AAPL', 'sideways', 2000);
  s = store.getState('AAPL');
  assert.strictEqual(s.direction, 'sideways');
  assert.strictEqual(s.direction_changed_at, 2000);
});

test('updateEvent sets the right column per event type', () => {
  const store = createTrendStore(makeDb());
  store.updateEvent('AAPL', 'breakout', 1000);
  assert.strictEqual(store.getState('AAPL').last_breakout_at, 1000);
  store.updateEvent('AAPL', 'bullish_reversal', 2000);
  assert.strictEqual(store.getState('AAPL').last_bullish_reversal_at, 2000);
  store.updateEvent('AAPL', 'bearish_reversal', 3000);
  assert.strictEqual(store.getState('AAPL').last_bearish_reversal_at, 3000);
});

test('updateEvent rejects unknown event types', () => {
  const store = createTrendStore(makeDb());
  assert.throws(() => store.updateEvent('AAPL', 'foo', 1000), /unknown event type/i);
});
```

- [ ] **Step 2: Run the tests, see them fail**

Run: `node --test db/trend-store.test.js`
Expected: every test fails with `Cannot find module './trend-store'`.

- [ ] **Step 3: Implement `db/trend-store.js`**

```js
// ─────────────────────────────────────────────────────────────────────
// db/trend-store.js — Accesseurs SQLite pour le module trend
// ─────────────────────────────────────────────────────────────────────
// Factory `createTrendStore(db)` : retourne un objet d'accesseurs liés
// au `db` passé. Permet d'injecter une DB in-memory en tests sans
// toucher au singleton de db/sqlite.js.
// ─────────────────────────────────────────────────────────────────────

const EVENT_COLUMNS = {
  breakout:           'last_breakout_at',
  bullish_reversal:   'last_bullish_reversal_at',
  bearish_reversal:   'last_bearish_reversal_at',
};

function createTrendStore(db) {
  // ── Watchlist ────────────────────────────────────────────────────
  const insertWatch = db.prepare(
    `INSERT OR IGNORE INTO trend_watchlist (guild_id, ticker, added_at)
     VALUES (?, ?, ?)`
  );
  const deleteWatch = db.prepare(
    `DELETE FROM trend_watchlist WHERE guild_id = ? AND ticker = ?`
  );
  const selectWatchlist = db.prepare(
    `SELECT ticker FROM trend_watchlist WHERE guild_id = ? ORDER BY ticker ASC`
  );
  const selectDistinctTickers = db.prepare(
    `SELECT DISTINCT ticker FROM trend_watchlist`
  );
  const selectGuildsWatching = db.prepare(
    `SELECT guild_id FROM trend_watchlist WHERE ticker = ?`
  );

  // ── Channel ───────────────────────────────────────────────────────
  const upsertChannel = db.prepare(
    `INSERT INTO trend_channel (guild_id, channel_id, set_at) VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, set_at = excluded.set_at`
  );
  const selectChannel = db.prepare(
    `SELECT channel_id FROM trend_channel WHERE guild_id = ?`
  );
  const deleteChannelStmt = db.prepare(
    `DELETE FROM trend_channel WHERE guild_id = ?`
  );

  // ── State ─────────────────────────────────────────────────────────
  const selectState = db.prepare(
    `SELECT * FROM trend_state WHERE ticker = ?`
  );
  const upsertDirection = db.prepare(
    `INSERT INTO trend_state (ticker, direction, direction_changed_at) VALUES (?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET direction = excluded.direction,
                                       direction_changed_at = excluded.direction_changed_at`
  );

  return {
    addToWatchlist(guildId, ticker, nowMs) {
      const res = insertWatch.run(guildId, ticker, nowMs);
      return res.changes > 0;
    },
    removeFromWatchlist(guildId, ticker) {
      const res = deleteWatch.run(guildId, ticker);
      return res.changes > 0;
    },
    getWatchlist(guildId) {
      return selectWatchlist.all(guildId).map(r => r.ticker);
    },
    getDistinctTickers() {
      return selectDistinctTickers.all().map(r => r.ticker);
    },
    getGuildsWatching(ticker) {
      return selectGuildsWatching.all(ticker).map(r => r.guild_id);
    },

    setChannel(guildId, channelId, nowMs) {
      upsertChannel.run(guildId, channelId, nowMs);
    },
    getChannel(guildId) {
      const row = selectChannel.get(guildId);
      return row ? row.channel_id : null;
    },
    deleteChannel(guildId) {
      deleteChannelStmt.run(guildId);
    },

    getState(ticker) {
      return selectState.get(ticker) || null;
    },
    updateDirection(ticker, direction, nowMs) {
      upsertDirection.run(ticker, direction, nowMs);
    },
    updateEvent(ticker, eventType, nowMs) {
      const col = EVENT_COLUMNS[eventType];
      if (!col) throw new Error('unknown event type: ' + eventType);
      // Build statement dynamically per column. Columns are validated above
      // against EVENT_COLUMNS — no SQL injection risk.
      const stmt = db.prepare(
        `INSERT INTO trend_state (ticker, ${col}) VALUES (?, ?)
         ON CONFLICT(ticker) DO UPDATE SET ${col} = excluded.${col}`
      );
      stmt.run(ticker, nowMs);
    },
  };
}

module.exports = { createTrendStore };
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `node --test db/trend-store.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add db/trend-store.js db/trend-store.test.js
git commit -m "feat(db): trend-store accessors + tests"
```

---

## Task 3: Trend engine — `detectDirection`

**Files:**
- Create: `trading/trend-engine.js`
- Create: `trading/trend-engine.test.js`

- [ ] **Step 1: Write the failing test for `detectDirection`**

Create `trading/trend-engine.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { detectDirection } = require('./trend-engine');

// Helper: build N candles from a closes array. OHLC = close everywhere
// (the engine only cares about close for direction).
function bars(closes, vol = 1000) {
  return closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: vol }));
}

test('detectDirection returns null when fewer than 26 candles', () => {
  const closes = Array(25).fill(100);
  assert.strictEqual(detectDirection(bars(closes)), null);
});

test('detectDirection returns "uptrend" on a steadily rising series', () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  assert.strictEqual(detectDirection(bars(closes)), 'uptrend');
});

test('detectDirection returns "downtrend" on a steadily falling series', () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(120 - i * 0.5);
  assert.strictEqual(detectDirection(bars(closes)), 'downtrend');
});

test('detectDirection returns "sideways" on a flat series', () => {
  const closes = Array(40).fill(100);
  assert.strictEqual(detectDirection(bars(closes)), 'sideways');
});

test('detectDirection returns "sideways" when EMAs are not aligned', () => {
  // Choppy: alternating up/down small moves around 100.
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + (i % 2 ? 0.4 : -0.4));
  // EMAs end up close → not uptrend, not downtrend → sideways.
  assert.strictEqual(detectDirection(bars(closes)), 'sideways');
});
```

- [ ] **Step 2: Run, see it fail**

Run: `node --test trading/trend-engine.test.js`
Expected: `Cannot find module './trend-engine'`.

- [ ] **Step 3: Implement `detectDirection` in `trading/trend-engine.js`**

```js
// ─────────────────────────────────────────────────────────────────────
// trading/trend-engine.js — Pure trend detection
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures : in = candles { t, o, h, l, c, v }, out = verdict.
// Aucune dépendance Discord/DB. Réutilisable par !trend (à la demande)
// et par trend-scanner (auto).
// ─────────────────────────────────────────────────────────────────────

const { calcEMASeries, calcRSI } = require('./indicators');

const SLOPE_LOOKBACK = 6;       // EMA20 slope mesurée sur 6 bougies
const MIN_DIRECTION_BARS = 26;  // 20 (EMA20 seed) + 6 (slope window)

// Direction du marché basée sur prix vs EMA20, EMA9 vs EMA20, et pente d'EMA20.
function detectDirection(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_DIRECTION_BARS) return null;
  const closes = candles.map(c => c.c);
  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);
  const last = candles.length - 1;
  const price = closes[last];
  const ema9 = ema9Series[last];
  const ema20 = ema20Series[last];
  const ema20Past = ema20Series[last - SLOPE_LOOKBACK];
  if (ema9 == null || ema20 == null || ema20Past == null) return null;

  if (price > ema20 && ema9 > ema20 && ema20 > ema20Past) return 'uptrend';
  if (price < ema20 && ema9 < ema20 && ema20 < ema20Past) return 'downtrend';
  return 'sideways';
}

module.exports = { detectDirection };
```

- [ ] **Step 4: Run, see them pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectDirection pure function + tests"
```

---

## Task 4: Trend engine — `detectBreakout`

**Files:**
- Modify: `trading/trend-engine.js` (add function + export)
- Modify: `trading/trend-engine.test.js` (append tests)

- [ ] **Step 1: Append failing tests to `trading/trend-engine.test.js`**

Add at the bottom of the test file (keep the existing imports — just expand the destructuring):

```js
// At top: change the import to include detectBreakout.
// const { detectDirection, detectBreakout } = require('./trend-engine');

test('detectBreakout returns null when not enough bars', () => {
  const { detectBreakout } = require('./trend-engine');
  const candles = bars(Array(20).fill(100));
  assert.strictEqual(detectBreakout(candles), null);
});

test('detectBreakout fires when last close > 20-bar high AND volume > 1.5x avg', () => {
  const { detectBreakout } = require('./trend-engine');
  // 20 bars at high=100/vol=1000, then 1 bar at close=101/vol=2000.
  const window = Array(20).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 20, o: 100, h: 102, l: 100, c: 101, v: 2000 };
  const r = detectBreakout([...window, last]);
  assert.ok(r, 'expected breakout');
  assert.strictEqual(r.type, 'breakout');
  assert.strictEqual(r.high, 100);
  assert.strictEqual(r.volume, 2000);
  assert.strictEqual(r.avgVolume, 1000);
});

test('detectBreakout rejects when close above high but volume too low', () => {
  const { detectBreakout } = require('./trend-engine');
  const window = Array(20).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 20, o: 100, h: 102, l: 100, c: 101, v: 1200 };  // 1.2x < 1.5x
  assert.strictEqual(detectBreakout([...window, last]), null);
});

test('detectBreakout rejects when volume high but close not above 20-bar high', () => {
  const { detectBreakout } = require('./trend-engine');
  const window = Array(20).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 20, o: 99, h: 100, l: 99, c: 99.99, v: 5000 };  // close ≤ high
  assert.strictEqual(detectBreakout([...window, last]), null);
});

test('detectBreakout custom thresholds', () => {
  const { detectBreakout } = require('./trend-engine');
  const window = Array(10).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 10, o: 100, h: 102, l: 100, c: 101, v: 1100 };  // 1.1x avg
  // lookback=10, multiplier=1.05 → fires
  const r = detectBreakout([...window, last], 10, 1.05);
  assert.ok(r);
  // multiplier=1.5 → does not fire
  assert.strictEqual(detectBreakout([...window, last], 10, 1.5), null);
});
```

Update the `require` at the top of the test file:

```js
const { detectDirection, detectBreakout } = require('./trend-engine');
```

(Remove the in-test `require` calls or keep them — both work. Keeping them inline scopes the import; updating the top is cleaner. Pick one and be consistent.)

- [ ] **Step 2: Run tests, see new ones fail**

Run: `node --test trading/trend-engine.test.js`
Expected: existing direction tests pass, new breakout tests fail with `detectBreakout is not a function` (or similar).

- [ ] **Step 3: Add `detectBreakout` to `trading/trend-engine.js`**

Append to the file (before `module.exports`):

```js
const DEFAULT_BREAKOUT_LOOKBACK = 20;
const DEFAULT_BREAKOUT_VOL_MULT = 1.5;

// Breakout : la dernière clôture casse le plus haut des `lookback` bougies
// précédentes ET le volume de la dernière bougie > `volMult` × moyenne des
// `lookback` volumes précédents. On utilise `c` (close) plutôt que `h` (high)
// pour exiger que le breakout "tienne" jusqu'à la fin de la bougie — évite
// les wicks.
function detectBreakout(candles, lookback = DEFAULT_BREAKOUT_LOOKBACK, volMult = DEFAULT_BREAKOUT_VOL_MULT) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const last = candles.length - 1;
  const lastBar = candles[last];
  const window = candles.slice(last - lookback, last); // exclut la dernière bougie
  let maxHigh = -Infinity;
  let sumVol = 0;
  for (const b of window) {
    if (Number.isFinite(b.h) && b.h > maxHigh) maxHigh = b.h;
    if (Number.isFinite(b.v)) sumVol += b.v;
  }
  if (!Number.isFinite(maxHigh)) return null;
  const avgVolume = sumVol / lookback;
  if (lastBar.c > maxHigh && lastBar.v > avgVolume * volMult) {
    return { type: 'breakout', high: maxHigh, volume: lastBar.v, avgVolume };
  }
  return null;
}
```

Update the export:

```js
module.exports = { detectDirection, detectBreakout };
```

- [ ] **Step 4: Run, see all tests pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all tests (direction + breakout) pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectBreakout pure function + tests"
```

---

## Task 5: Trend engine — `detectReversal`

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

Add to `trading/trend-engine.test.js` (and update the top destructure to include `detectReversal`):

```js
test('detectReversal returns null when not enough bars', () => {
  const { detectReversal } = require('./trend-engine');
  assert.strictEqual(detectReversal(bars(Array(20).fill(100))), null);
});

test('detectReversal fires bearish on RSI > 70 + EMA9 crosses below EMA20', () => {
  const { detectReversal } = require('./trend-engine');
  // Build closes: long up-run pushes RSI > 70 and EMA9 above EMA20,
  // then a sharp drop on the last bar to cross EMA9 below EMA20.
  const closes = [];
  for (let i = 0; i < 25; i++) closes.push(100 + i * 0.5);  // strong uptrend
  // Last 4 bars : steep drop. RSI stays high in the recent window because
  // it has memory; EMA9 reacts faster than EMA20 → crosses below.
  closes.push(110, 108, 104, 99);
  const r = detectReversal(bars(closes));
  assert.ok(r, 'expected bearish reversal');
  assert.strictEqual(r.type, 'bearish_reversal');
  assert.ok(r.peakRsi > 70);
});

test('detectReversal fires bullish on RSI < 30 + EMA9 crosses above EMA20', () => {
  const { detectReversal } = require('./trend-engine');
  const closes = [];
  for (let i = 0; i < 25; i++) closes.push(120 - i * 0.5);  // strong downtrend
  closes.push(108, 109, 113, 118);  // sharp recovery
  const r = detectReversal(bars(closes));
  assert.ok(r, 'expected bullish reversal');
  assert.strictEqual(r.type, 'bullish_reversal');
  assert.ok(r.troughRsi < 30);
});

test('detectReversal returns null when EMAs cross but RSI not extreme', () => {
  const { detectReversal } = require('./trend-engine');
  // Mild oscillation : EMAs may cross but RSI hovers around 50.
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100 + (i % 2 ? 0.3 : -0.3));
  closes.push(100.5, 99.7, 100.2, 99.9);
  assert.strictEqual(detectReversal(bars(closes)), null);
});
```

- [ ] **Step 2: Run, see new tests fail**

Run: `node --test trading/trend-engine.test.js`
Expected: reversal tests fail with `detectReversal is not a function`.

- [ ] **Step 3: Implement `detectReversal`**

Add to `trading/trend-engine.js` (before `module.exports`):

```js
const DEFAULT_RSI_OVERBOUGHT = 70;
const DEFAULT_RSI_OVERSOLD   = 30;
const REVERSAL_RSI_WINDOW    = 3;   // RSI doit avoir touché l'extrême sur les 3 dernières bougies
const MIN_REVERSAL_BARS      = 21;  // 14 (RSI seed) + 6 (room) + 1

// Reversal : EMA9 vient de croiser EMA20 ET RSI a touché un extrême récent.
//   bearish : croisement EMA9 sous EMA20 + max(RSI) > overbought sur les
//             3 dernières bougies (peak RSI récent, retournement à la
//             baisse).
//   bullish : croisement EMA9 au-dessus EMA20 + min(RSI) < oversold sur
//             les 3 dernières bougies.
function detectReversal(candles, rsiOverbought = DEFAULT_RSI_OVERBOUGHT, rsiOversold = DEFAULT_RSI_OVERSOLD) {
  if (!Array.isArray(candles) || candles.length < MIN_REVERSAL_BARS) return null;
  const closes = candles.map(c => c.c);
  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);
  const last = candles.length - 1;
  const ema9Now = ema9Series[last];
  const ema9Prev = ema9Series[last - 1];
  const ema20Now = ema20Series[last];
  const ema20Prev = ema20Series[last - 1];
  if (ema9Now == null || ema9Prev == null || ema20Now == null || ema20Prev == null) return null;

  const crossedDown = ema9Prev >= ema20Prev && ema9Now < ema20Now;
  const crossedUp   = ema9Prev <= ema20Prev && ema9Now > ema20Now;
  if (!crossedDown && !crossedUp) return null;

  // RSI sur les 3 dernières bougies : on calcule à 3 points distincts en
  // tronquant la série à chaque longueur.
  const rsiWindow = [];
  for (let i = REVERSAL_RSI_WINDOW; i >= 1; i--) {
    const rsi = calcRSI(closes.slice(0, last - i + 2), 14);
    if (rsi != null) rsiWindow.push(rsi);
  }
  if (rsiWindow.length === 0) return null;
  const lastRsi = rsiWindow[rsiWindow.length - 1];

  if (crossedDown) {
    const peakRsi = Math.max(...rsiWindow);
    if (peakRsi > rsiOverbought) {
      return { type: 'bearish_reversal', rsi: lastRsi, ema9: ema9Now, ema20: ema20Now, peakRsi };
    }
  }
  if (crossedUp) {
    const troughRsi = Math.min(...rsiWindow);
    if (troughRsi < rsiOversold) {
      return { type: 'bullish_reversal', rsi: lastRsi, ema9: ema9Now, ema20: ema20Now, troughRsi };
    }
  }
  return null;
}
```

Update the export:

```js
module.exports = { detectDirection, detectBreakout, detectReversal };
```

- [ ] **Step 4: Run all tests, see them pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all direction + breakout + reversal tests pass.

> **If a reversal test fails because the synthetic fixture didn't actually push RSI above 70 / below 30**, increase the magnitude of the runup (e.g., `100 + i * 1.0` instead of `0.5`) until the assertion holds. The point of the test is to verify the function fires *when conditions are met*, not to validate a specific numeric setup.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectReversal pure function + tests"
```

---

## Task 6: Trend engine — `detectAll`

**Files:**
- Modify: `trading/trend-engine.js`
- Modify: `trading/trend-engine.test.js`

- [ ] **Step 1: Append failing tests**

Add at bottom of `trading/trend-engine.test.js`:

```js
test('detectAll returns { direction, events, snapshot }', () => {
  const { detectAll } = require('./trend-engine');
  // Steady uptrend → direction "uptrend", possibly a breakout if last
  // close is the new high (which it is in a monotonic series), no reversal.
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  const out = detectAll(bars(closes, 1500));
  assert.ok(out, 'expected non-null');
  assert.strictEqual(out.direction, 'uptrend');
  assert.ok(Array.isArray(out.events));
  assert.ok(out.snapshot);
  assert.ok(typeof out.snapshot.price === 'number');
  assert.ok(typeof out.snapshot.ema9 === 'number');
  assert.ok(typeof out.snapshot.ema20 === 'number');
  assert.ok(typeof out.snapshot.rsi === 'number');
});

test('detectAll returns null when not enough candles', () => {
  const { detectAll } = require('./trend-engine');
  assert.strictEqual(detectAll(bars(Array(10).fill(100))), null);
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test trading/trend-engine.test.js`
Expected: detectAll tests fail.

- [ ] **Step 3: Implement `detectAll`**

Add to `trading/trend-engine.js`:

```js
const { calcEMA } = require('./indicators');

// Combines all detectors. Retourne `null` si pas assez de candles.
// Les paramètres (lookback, volume mult, RSI seuils) acceptent des
// overrides — utiles pour les tests et pour l'env tuning au runtime.
function detectAll(candles, opts = {}) {
  const direction = detectDirection(candles);
  if (direction === null) return null;  // pas assez de bars

  const events = [];
  const breakout = detectBreakout(candles, opts.breakoutLookback, opts.breakoutVolMult);
  if (breakout) events.push(breakout);
  const reversal = detectReversal(candles, opts.rsiOverbought, opts.rsiOversold);
  if (reversal) events.push(reversal);

  const closes = candles.map(c => c.c);
  const snapshot = {
    price: closes[closes.length - 1],
    ema9:  calcEMA(closes, 9),
    ema20: calcEMA(closes, 20),
    rsi:   calcRSI(closes, 14),
  };

  return { direction, events, snapshot };
}
```

Update import at top of file:

```js
const { calcEMA, calcEMASeries, calcRSI } = require('./indicators');
```

(replacing the existing `require` line — `calcEMA` was missing before).

Update the export:

```js
module.exports = { detectDirection, detectBreakout, detectReversal, detectAll };
```

- [ ] **Step 4: Run, see all tests pass**

Run: `node --test trading/trend-engine.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-engine.js trading/trend-engine.test.js
git commit -m "feat(trend): detectAll combiner + snapshot output"
```

---

## Task 7: Market hours helper (`isUSMarketOpen`)

**Files:**
- Create: `trading/trend-scanner.js` (with first export = `isUSMarketOpen`)
- Create: `trading/trend-scanner.test.js`

- [ ] **Step 1: Write the failing test**

Create `trading/trend-scanner.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isUSMarketOpen } = require('./trend-scanner');

// Build a Date from a "wall-clock ET" specification by computing the
// corresponding UTC. The trick: hard-code the UTC offset for the case
// at hand (EST = -5, EDT = -4). Tests below use canonical examples.
//
// Helper: New York 2026-04-30 is in EDT (UTC-4).
// 2026-12-15 is in EST (UTC-5).
function utcFromET(yyyy, mm, dd, hh, mi, isDST) {
  const offset = isDST ? 4 : 5;
  return new Date(Date.UTC(yyyy, mm - 1, dd, hh + offset, mi, 0));
}

test('isUSMarketOpen: weekday 10:00 ET (EDT) is open', () => {
  const d = utcFromET(2026, 4, 30, 10, 0, true); // Thursday Apr 30, 2026
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 9:29 ET is closed (pre-open)', () => {
  const d = utcFromET(2026, 4, 30, 9, 29, true);
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 9:30 ET is open (boundary)', () => {
  const d = utcFromET(2026, 4, 30, 9, 30, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 16:00 ET is closed (boundary)', () => {
  const d = utcFromET(2026, 4, 30, 16, 0, true);
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 15:59 ET is open', () => {
  const d = utcFromET(2026, 4, 30, 15, 59, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: Saturday 12:00 ET is closed', () => {
  const d = utcFromET(2026, 5, 2, 12, 0, true); // Saturday May 2, 2026
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: Sunday 12:00 ET is closed', () => {
  const d = utcFromET(2026, 5, 3, 12, 0, true); // Sunday
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 10:00 ET in winter (EST) is open', () => {
  const d = utcFromET(2026, 12, 15, 10, 0, false); // Tuesday Dec 15, 2026 (EST)
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 10:00 ET on March DST switch day is open', () => {
  // 2026 DST starts Sunday March 8. Monday March 9 is EDT.
  const d = utcFromET(2026, 3, 9, 10, 0, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});
```

- [ ] **Step 2: Run, see failure**

Run: `node --test trading/trend-scanner.test.js`
Expected: `Cannot find module './trend-scanner'`.

- [ ] **Step 3: Implement `isUSMarketOpen` in `trading/trend-scanner.js`**

```js
// ─────────────────────────────────────────────────────────────────────
// trading/trend-scanner.js — Boucle de scan trend + dispatch alertes
// ─────────────────────────────────────────────────────────────────────
// Tick 60s ; déclenche un scan toutes les TREND_SCAN_INTERVAL_MIN min
// pendant les heures de marché US régulières (lun-ven, 9:30-16:00 ET).
// Pour chaque ticker watché par au moins une guild :
//   1. Fetch candles via Yahoo (cached).
//   2. detectAll → verdict.
//   3. Compare à trend_state, génère alertes (transitions + events).
//   4. Dispatch chaque alerte aux guilds qui watch le ticker.
// ─────────────────────────────────────────────────────────────────────

// Détermine si NYSE est ouverte à la date donnée (heures régulières).
// Gère DST automatiquement via Intl.DateTimeFormat timezone NY.
// Pas de gestion des jours fériés US — on accepte de scanner pour rien
// le 4 juillet (~10 jours/an, coût négligeable).
function isUSMarketOpen(date = new Date()) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  let weekday = '', hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour')    hour = parseInt(p.value, 10);
    else if (p.type === 'minute')  minute = parseInt(p.value, 10);
  }

  // Intl peut produire 'hour' = '24' à minuit (selon le runtime). Normalise.
  if (hour === 24) hour = 0;

  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

module.exports = { isUSMarketOpen };
```

- [ ] **Step 4: Run, see them pass**

Run: `node --test trading/trend-scanner.test.js`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/trend-scanner.js trading/trend-scanner.test.js
git commit -m "feat(trend): isUSMarketOpen with DST + boundary tests"
```

---

## Task 8: Scanner — `runScanCycle` (with mocks)

**Files:**
- Modify: `trading/trend-scanner.js` (add `runScanCycle` + helpers)
- Modify: `trading/trend-scanner.test.js` (append tests)

- [ ] **Step 1: Append failing tests**

Add at bottom of `trading/trend-scanner.test.js`:

```js
const Database = require('better-sqlite3');
const { createTrendStore } = require('../db/trend-store');
const { runScanCycle } = require('./trend-scanner');

function makeStoreDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trend_watchlist (
      guild_id TEXT NOT NULL, ticker TEXT NOT NULL, added_at INTEGER NOT NULL,
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
      last_scan_at INTEGER
    );
  `);
  return { db, store: createTrendStore(db) };
}

// Build candles representing a steady uptrend, suitable for triggering
// "uptrend" direction + a breakout on the last bar.
function uptrendCandles() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const c = 100 + i * 0.5;
    out.push({ t: i, o: c, h: c, l: c, c, v: 1000 });
  }
  // Last bar: above prev high + volume spike.
  const lastClose = out[out.length - 1].c + 0.5;
  out.push({ t: 40, o: out[out.length - 1].c, h: lastClose, l: out[out.length - 1].c, c: lastClose, v: 5000 });
  return out;
}

function fakeYahoo(map) {
  return {
    getChart: async (ticker) => ({
      quotes: (map[ticker] || []).map(b => ({
        date: new Date(b.t),
        open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      })),
    }),
  };
}

function fakeDiscordClient() {
  const sent = [];
  return {
    sent,
    channels: {
      fetch: async (channelId) => ({
        send: async (content) => { sent.push({ channelId, content }); },
      }),
    },
  };
}

test('runScanCycle: no tickers → no alerts', async () => {
  const { store } = makeStoreDb();
  const yahoo = fakeYahoo({});
  const discord = fakeDiscordClient();
  const stats = await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  assert.strictEqual(stats.tickers, 0);
  assert.strictEqual(stats.alerts, 0);
  assert.strictEqual(discord.sent.length, 0);
});

test('runScanCycle: direction transition → alerts dispatched to all watching guilds', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.addToWatchlist('g2', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  store.setChannel('g2', 'c2', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // At least the direction transition (NULL → uptrend) fires.
  assert.ok(discord.sent.length >= 2, 'expected ≥2 messages (one per guild)');
  const channels = discord.sent.map(s => s.channelId);
  assert.ok(channels.includes('c1') && channels.includes('c2'));
  // State persisted.
  assert.strictEqual(store.getState('AAPL').direction, 'uptrend');
});

test('runScanCycle: re-running same state → no re-alert', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  const firstCount = discord.sent.length;
  // Run again — same candles, same state → no new alerts (within dedup window).
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 + 60_000 });
  assert.strictEqual(discord.sent.length, firstCount);
});

test('runScanCycle: guild without channel → no dispatch', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  // No setChannel('g1', ...)
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const discord = fakeDiscordClient();
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  assert.strictEqual(discord.sent.length, 0);
  // But state still updates globally.
  assert.strictEqual(store.getState('AAPL').direction, 'uptrend');
});

test('runScanCycle: yahoo error on a ticker is skipped, others continue', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.addToWatchlist('g1', 'BAD', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = {
    getChart: async (t) => {
      if (t === 'BAD') throw new Error('not found');
      return fakeYahoo({ AAPL: uptrendCandles() }).getChart(t);
    },
  };
  const discord = fakeDiscordClient();
  const stats = await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  // AAPL alerts go through; BAD is skipped.
  assert.ok(discord.sent.length >= 1);
  assert.strictEqual(stats.errors, 1);
});

test('runScanCycle: deleted channel → cleaned from DB', async () => {
  const { store } = makeStoreDb();
  store.addToWatchlist('g1', 'AAPL', 1);
  store.setChannel('g1', 'c1', 1);
  const yahoo = fakeYahoo({ AAPL: uptrendCandles() });
  const err = new Error('Unknown Channel');
  err.code = 10003;  // Discord.js DiscordAPIError.UnknownChannel
  const discord = {
    channels: {
      fetch: async () => { throw err; },
    },
  };
  await runScanCycle({ store, yahoo, discord, now: () => 1_000_000 });
  assert.strictEqual(store.getChannel('g1'), null, 'channel should be cleaned');
});
```

- [ ] **Step 2: Run, see new tests fail**

Run: `node --test trading/trend-scanner.test.js`
Expected: scanner tests fail with `runScanCycle is not a function`.

- [ ] **Step 3: Implement `runScanCycle` in `trading/trend-scanner.js`**

Append to the file (after `isUSMarketOpen`, before `module.exports`):

```js
const { detectAll } = require('./trend-engine');

// Discord error codes for channel-write failures we want to handle specifically.
const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_MISSING_ACCESS = 50001;
const DISCORD_MISSING_PERMISSIONS = 50013;

const DEFAULT_DEDUP_MINUTES = 60;
const DEFAULT_THROTTLE_MS = 200;

// Adapt Yahoo bars { date, open, high, low, close, volume } to the
// engine's internal shape { t, o, h, l, c, v }. Skip rows with NaN closes.
function adaptYahooBars(quotes) {
  if (!Array.isArray(quotes)) return [];
  return quotes
    .filter(q => Number.isFinite(q.close))
    .map(q => ({
      t: q.date instanceof Date ? q.date.getTime() : q.date,
      o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
    }));
}

function fmtPrice(v)  { return Number.isFinite(v) ? '$' + v.toFixed(2) : '—'; }
function fmtVolume(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

const DIRECTION_EMOJI = { uptrend: '📈', downtrend: '📉', sideways: '➡️' };

function formatDirectionAlert(ticker, fromDir, toDir, snap) {
  return [
    `${DIRECTION_EMOJI[toDir] || '📊'} **$${ticker}** — ${toDir}`,
    `Was: ${fromDir || 'unknown'} · Now: ${toDir}`,
    `Price: ${fmtPrice(snap.price)} · EMA9 ${fmtPrice(snap.ema9)} · EMA20 ${fmtPrice(snap.ema20)} · RSI ${snap.rsi != null ? snap.rsi.toFixed(0) : '—'}`,
  ].join('\n');
}

function formatBreakoutAlert(ticker, ev, snap) {
  const ratio = ev.avgVolume > 0 ? (ev.volume / ev.avgVolume).toFixed(1) : '—';
  return [
    `🚀 **$${ticker}** — breakout`,
    `Broke 20-bar high ${fmtPrice(ev.high)} on ${ratio}× volume`,
    `Price: ${fmtPrice(snap.price)} · Volume: ${fmtVolume(ev.volume)} (avg ${fmtVolume(ev.avgVolume)})`,
  ].join('\n');
}

function formatReversalAlert(ticker, ev, snap) {
  const isBullish = ev.type === 'bullish_reversal';
  const label = isBullish ? 'bullish reversal' : 'bearish reversal';
  const cause = isBullish
    ? `RSI was oversold (${ev.troughRsi.toFixed(0)}), EMA9 crossed above EMA20`
    : `RSI was overbought (${ev.peakRsi.toFixed(0)}), EMA9 crossed below EMA20`;
  return [
    `🔄 **$${ticker}** — ${label}`,
    cause,
    `Price: ${fmtPrice(snap.price)} · RSI ${ev.rsi != null ? ev.rsi.toFixed(0) : '—'} · EMA9 ${fmtPrice(ev.ema9)} · EMA20 ${fmtPrice(ev.ema20)}`,
  ].join('\n');
}

async function postToChannel({ discord, store, guildId, channelId, content }) {
  try {
    const channel = await discord.channels.fetch(channelId);
    await channel.send(content);
    return { ok: true };
  } catch (err) {
    if (err && err.code === DISCORD_UNKNOWN_CHANNEL) {
      console.warn(`[trend] channel ${channelId} unknown — clearing for guild ${guildId}`);
      store.deleteChannel(guildId);
      return { ok: false, reason: 'unknown_channel' };
    }
    if (err && (err.code === DISCORD_MISSING_PERMISSIONS || err.code === DISCORD_MISSING_ACCESS)) {
      console.warn(`[trend] missing permissions for channel ${channelId} (guild ${guildId})`);
      return { ok: false, reason: 'missing_permissions' };
    }
    console.error(`[trend] postToChannel failed: ${err && err.message}`);
    return { ok: false, reason: 'error' };
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Run one full scan cycle. Designed to be called every TREND_SCAN_INTERVAL_MIN
// minutes (gating logic lives in startTrendScanner).
async function runScanCycle({
  store,
  yahoo,
  discord,
  now = () => Date.now(),
  dedupMinutes = DEFAULT_DEDUP_MINUTES,
  throttleMs = DEFAULT_THROTTLE_MS,
  detectorOpts = {},
}) {
  const startedAt = now();
  const tickers = store.getDistinctTickers();
  let alerts = 0;
  let errors = 0;

  for (const ticker of tickers) {
    try {
      const chart = await yahoo.getChart(ticker, '1D');
      const candles = adaptYahooBars(chart && chart.quotes);
      const verdict = detectAll(candles, detectorOpts);
      if (!verdict) continue; // not enough bars

      const state = store.getState(ticker);
      const tNow = now();
      const dedupMs = dedupMinutes * 60 * 1000;
      const messages = [];

      // Direction transition.
      const prevDir = state ? state.direction : null;
      if (verdict.direction !== prevDir) {
        messages.push({
          type: 'direction',
          content: formatDirectionAlert(ticker, prevDir, verdict.direction, verdict.snapshot),
        });
        store.updateDirection(ticker, verdict.direction, tNow);
      }

      // Events with dedup.
      for (const ev of verdict.events) {
        const lastTsCol = ev.type === 'breakout' ? 'last_breakout_at'
                       : ev.type === 'bullish_reversal' ? 'last_bullish_reversal_at'
                       : ev.type === 'bearish_reversal' ? 'last_bearish_reversal_at'
                       : null;
        if (!lastTsCol) continue;
        const lastTs = state ? state[lastTsCol] : null;
        if (lastTs && (tNow - lastTs) < dedupMs) continue; // suppressed
        const content = ev.type === 'breakout'
          ? formatBreakoutAlert(ticker, ev, verdict.snapshot)
          : formatReversalAlert(ticker, ev, verdict.snapshot);
        messages.push({ type: ev.type, content });
        store.updateEvent(ticker, ev.type, tNow);
      }

      if (messages.length === 0) continue;

      const guilds = store.getGuildsWatching(ticker);
      for (const guildId of guilds) {
        const channelId = store.getChannel(guildId);
        if (!channelId) continue;
        for (const msg of messages) {
          await postToChannel({ discord, store, guildId, channelId, content: msg.content });
          alerts += 1;
        }
      }
    } catch (err) {
      errors += 1;
      console.error(`[trend] scan failed for ${ticker}: ${err && err.message}`);
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }

  const elapsed = now() - startedAt;
  console.log(`[trend] scan: ${tickers.length} tickers, ${alerts} alerts, ${errors} errors, ${elapsed} ms`);
  return { tickers: tickers.length, alerts, errors, elapsed };
}

module.exports = { isUSMarketOpen, runScanCycle };
```

- [ ] **Step 4: Run all scanner tests, see them pass**

Run: `node --test trading/trend-scanner.test.js`
Expected: all tests pass (market hours + scan cycle).

- [ ] **Step 5: Commit**

```bash
git add trading/trend-scanner.js trading/trend-scanner.test.js
git commit -m "feat(trend): runScanCycle with detection, dispatch, dedup, error handling"
```

---

## Task 9: Scanner — `startTrendScanner` (the interval driver)

**Files:**
- Modify: `trading/trend-scanner.js`

- [ ] **Step 1: Add `startTrendScanner` to `trading/trend-scanner.js`**

Append to the file (before `module.exports`):

```js
const TICK_MS = 60_000;

// Read env vars at start time. Defaults match the spec.
function readScannerConfig() {
  const num = (k, d) => {
    const v = parseFloat(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    intervalMin:    num('TREND_SCAN_INTERVAL_MIN', 5),
    dedupMinutes:   num('TREND_DEDUP_MINUTES', 60),
    rsiOverbought:  num('TREND_RSI_OVERBOUGHT', 70),
    rsiOversold:    num('TREND_RSI_OVERSOLD', 30),
    breakoutLookback: num('TREND_BREAKOUT_LOOKBACK_BARS', 20),
    breakoutVolMult:  num('TREND_BREAKOUT_VOLUME_MULT', 1.5),
  };
}

// Démarre le scanner. Appelé une fois après l'event Discord 'ready'.
// Retourne une fonction `stop()` pour arrêt propre (utile si un jour
// on veut redémarrer le module sans relancer le process).
function startTrendScanner({ client, store, yahoo, now = () => Date.now() }) {
  const cfg = readScannerConfig();
  const detectorOpts = {
    breakoutLookback: cfg.breakoutLookback,
    breakoutVolMult:  cfg.breakoutVolMult,
    rsiOverbought:    cfg.rsiOverbought,
    rsiOversold:      cfg.rsiOversold,
  };

  let running = false;

  async function tick() {
    if (running) return;            // skip si un cycle précédent est en cours
    const date = new Date(now());
    if (!isUSMarketOpen(date))      return;
    if (date.getMinutes() % cfg.intervalMin !== 0) return;

    running = true;
    try {
      await runScanCycle({
        store, yahoo,
        discord: client,
        now,
        dedupMinutes: cfg.dedupMinutes,
        detectorOpts,
      });
    } catch (err) {
      console.error('[trend] runScanCycle threw:', err && err.stack || err);
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, TICK_MS);
  if (handle.unref) handle.unref(); // ne pas bloquer le shutdown du process

  console.log(`[trend] scanner started (interval ${cfg.intervalMin}min, dedup ${cfg.dedupMinutes}min)`);

  return function stop() { clearInterval(handle); };
}
```

Update the export:

```js
module.exports = { isUSMarketOpen, runScanCycle, startTrendScanner };
```

- [ ] **Step 2: Sanity-check the file parses cleanly**

Run: `node -e "require('./trading/trend-scanner')"`
Expected: prints nothing (no error).

- [ ] **Step 3: Re-run all scanner tests (to make sure the addition didn't break anything)**

Run: `node --test trading/trend-scanner.test.js`
Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add trading/trend-scanner.js
git commit -m "feat(trend): startTrendScanner with interval gating + env config"
```

---

## Task 10: Discord command — `!trend TICKER` (read-only)

**Files:**
- Create: `discord/trend-commands.js`

- [ ] **Step 1: Implement the file with the read-only handler**

Create `discord/trend-commands.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// discord/trend-commands.js — Commandes !trend ...
// ─────────────────────────────────────────────────────────────────────
//   !trend TICKER          analyse à la demande (any user)
//   !trend watchlist       liste les tickers de la guild (any user)
//   !trend status          résumé config + scanner (any user)
//   !trend watch TICKER    ajoute (ManageGuild)
//   !trend unwatch TICKER  retire (ManageGuild)
//   !trend channel #salon  set salon d'alerte (ManageGuild)
// ─────────────────────────────────────────────────────────────────────

const { PermissionsBitField } = require('discord.js');
const { detectAll } = require('../trading/trend-engine');

function adaptYahooBars(quotes) {
  if (!Array.isArray(quotes)) return [];
  return quotes
    .filter(q => Number.isFinite(q.close))
    .map(q => ({
      t: q.date instanceof Date ? q.date.getTime() : q.date,
      o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
    }));
}

const DIRECTION_EMOJI = { uptrend: '📈', downtrend: '📉', sideways: '➡️' };

function formatPrice(v)  { return Number.isFinite(v) ? '$' + v.toFixed(2) : '—'; }
function formatRsi(v)    { return Number.isFinite(v) ? v.toFixed(0) : '—'; }
function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' ET';
}

function isUnknownTicker(err) {
  return err && (
    /not.*found/i.test(err.message || '') ||
    /no.*data/i.test(err.message || '') ||
    err.code === 'NOT_FOUND'
  );
}

// !trend TICKER → analyse complète
async function handleAnalyze(message, ticker, { yahoo, store }) {
  let chart;
  try {
    chart = await yahoo.getChart(ticker, '1D');
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    console.error('[trend] yahoo error', err && err.message);
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }
  const candles = adaptYahooBars(chart && chart.quotes);
  const verdict = detectAll(candles);
  if (!verdict) {
    return message.reply(`❌ Not enough data for $${ticker}`).catch(() => {});
  }

  const state = store.getState(ticker);
  const sinceLine = state && state.direction_changed_at
    ? ` (since ${formatTime(state.direction_changed_at)})`
    : '';

  const lines = [
    `📊 **$${ticker}**`,
    `Direction: ${DIRECTION_EMOJI[verdict.direction] || ''} ${verdict.direction}${sinceLine}`,
    `Price: ${formatPrice(verdict.snapshot.price)} · EMA9 ${formatPrice(verdict.snapshot.ema9)} · EMA20 ${formatPrice(verdict.snapshot.ema20)} · RSI ${formatRsi(verdict.snapshot.rsi)}`,
    '',
    'Recent events (last seen):',
  ];

  if (state) {
    if (state.last_breakout_at) {
      lines.push(`• 🚀 Breakout at ${formatTime(state.last_breakout_at)}`);
    }
    if (state.last_bullish_reversal_at) {
      lines.push(`• 🔄 Bullish reversal at ${formatTime(state.last_bullish_reversal_at)}`);
    }
    if (state.last_bearish_reversal_at) {
      lines.push(`• 🔄 Bearish reversal at ${formatTime(state.last_bearish_reversal_at)}`);
    }
    if (!state.last_breakout_at && !state.last_bullish_reversal_at && !state.last_bearish_reversal_at) {
      lines.push('• (no recent events tracked)');
    }
  } else {
    lines.push('• (no recent events tracked — add to watchlist for monitoring)');
  }

  return message.reply(lines.join('\n')).catch(e => console.error('[trend] reply', e.message));
}

function registerTrendCommands(client, { store, yahoo }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!trend')) return;

    const args = text.slice('!trend'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!trend <TICKER>` · `!trend watch <TICKER>` · `!trend watchlist` · `!trend status` · `!trend channel #channel`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    // First branch: analyze. Will be expanded in later tasks.
    if (!['watch', 'unwatch', 'watchlist', 'channel', 'status'].includes(sub)) {
      const ticker = args[0].replace(/\$/g, '').toUpperCase();
      return handleAnalyze(message, ticker, { yahoo, store });
    }

    // Other subcommands wired in subsequent tasks.
    return message.reply('Subcommand not implemented yet').catch(() => {});
  });
}

module.exports = { registerTrendCommands };
```

- [ ] **Step 2: Sanity-check the file parses**

Run: `node -e "require('./discord/trend-commands')"`
Expected: prints nothing (no error).

- [ ] **Step 3: Commit**

```bash
git add discord/trend-commands.js
git commit -m "feat(trend): !trend TICKER read-only on-demand analysis"
```

> No automated test for this handler — it's heavily tied to Discord client behavior. The detection logic underneath is already covered by `trend-engine.test.js`. Manual verification happens in Task 14 (full wiring + smoke test).

---

## Task 11: Discord commands — `!trend watchlist` and `!trend status`

**Files:**
- Modify: `discord/trend-commands.js`

- [ ] **Step 1: Add the two read handlers**

In `discord/trend-commands.js`, replace the catch-all `'Subcommand not implemented yet'` branch with proper subcommand routing. Add these helper functions before `registerTrendCommands` and update the dispatcher:

```js
async function handleWatchlist(message, { store, yahoo }) {
  const guildId = message.guildId;
  if (!guildId) return message.reply('Use this command in a server.').catch(() => {});
  const tickers = store.getWatchlist(guildId);
  if (tickers.length === 0) {
    return message.reply('Watchlist is empty. Add tickers with `!trend watch <TICKER>`.').catch(() => {});
  }

  const lines = [`Watchlist (${tickers.length} ticker${tickers.length === 1 ? '' : 's'}):`];
  for (const ticker of tickers) {
    const state = store.getState(ticker);
    const dir = state && state.direction;
    const emoji = DIRECTION_EMOJI[dir] || '·';
    const dirLabel = dir || 'unknown';
    lines.push(`${emoji} $${ticker} — ${dirLabel}`);
  }
  return message.reply(lines.join('\n')).catch(() => {});
}

async function handleStatus(message, { store, scannerConfig }) {
  const guildId = message.guildId;
  if (!guildId) return message.reply('Use this command in a server.').catch(() => {});
  const channelId = store.getChannel(guildId);
  const watchCount = store.getWatchlist(guildId).length;
  const channelLine = channelId ? `<#${channelId}> ✅` : '⚠️ not set (use `!trend channel #channel`)';
  const marketOpen = require('../trading/trend-scanner').isUSMarketOpen(new Date());
  const lines = [
    'Trend bot status (this server):',
    `• Alert channel: ${channelLine}`,
    `• Watchlist: ${watchCount} ticker${watchCount === 1 ? '' : 's'}`,
    `• Scanner: running (every ${scannerConfig?.intervalMin || 5} min)`,
    `• Market: ${marketOpen ? 'open' : 'closed'}`,
  ];
  return message.reply(lines.join('\n')).catch(() => {});
}
```

Update the `registerTrendCommands` function to dispatch:

```js
function registerTrendCommands(client, { store, yahoo, scannerConfig }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!trend')) return;

    const args = text.slice('!trend'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!trend <TICKER>` · `!trend watch <TICKER>` · `!trend unwatch <TICKER>` · `!trend watchlist` · `!trend status` · `!trend channel #channel`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    if (sub === 'watchlist') return handleWatchlist(message, { store, yahoo });
    if (sub === 'status')    return handleStatus(message, { store, scannerConfig });

    if (!['watch', 'unwatch', 'channel'].includes(sub)) {
      const ticker = args[0].replace(/\$/g, '').toUpperCase();
      return handleAnalyze(message, ticker, { yahoo, store });
    }

    return message.reply('Subcommand not implemented yet').catch(() => {});
  });
}
```

- [ ] **Step 2: Sanity-check parse**

Run: `node -e "require('./discord/trend-commands')"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add discord/trend-commands.js
git commit -m "feat(trend): !trend watchlist + !trend status read commands"
```

---

## Task 12: Discord commands — `!trend watch` and `!trend unwatch`

**Files:**
- Modify: `discord/trend-commands.js`

- [ ] **Step 1: Add the two write handlers**

In `discord/trend-commands.js`, add these helpers before `registerTrendCommands`:

```js
function requireManageGuild(message) {
  if (!message.guildId) {
    message.reply('Use this command in a server.').catch(() => {});
    return false;
  }
  if (!message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    message.reply('❌ You need Manage Server permission to use this command.').catch(() => {});
    return false;
  }
  return true;
}

async function handleWatch(message, args, { store, yahoo }) {
  if (!requireManageGuild(message)) return;
  if (args.length < 2) {
    return message.reply('Usage: `!trend watch <TICKER>`').catch(() => {});
  }
  const ticker = args[1].replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return message.reply('❌ Invalid ticker format').catch(() => {});
  }

  // Validate ticker against Yahoo before adding (a fetch test).
  try {
    const chart = await yahoo.getChart(ticker, '1D');
    if (!chart || !Array.isArray(chart.quotes) || chart.quotes.length === 0) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }

  const added = store.addToWatchlist(message.guildId, ticker, Date.now());
  if (!added) {
    return message.reply(`ℹ️ $${ticker} already in watchlist`).catch(() => {});
  }
  const total = store.getWatchlist(message.guildId).length;
  return message.reply(`✅ Added $${ticker} to watchlist (${total} ticker${total === 1 ? '' : 's'} total)`).catch(() => {});
}

async function handleUnwatch(message, args, { store }) {
  if (!requireManageGuild(message)) return;
  if (args.length < 2) {
    return message.reply('Usage: `!trend unwatch <TICKER>`').catch(() => {});
  }
  const ticker = args[1].replace(/\$/g, '').toUpperCase();
  const removed = store.removeFromWatchlist(message.guildId, ticker);
  if (!removed) {
    return message.reply(`ℹ️ $${ticker} not in watchlist`).catch(() => {});
  }
  return message.reply(`✅ Removed $${ticker}`).catch(() => {});
}
```

Update the dispatcher in `registerTrendCommands`:

```js
    if (sub === 'watch')     return handleWatch(message, args, { store, yahoo });
    if (sub === 'unwatch')   return handleUnwatch(message, args, { store });
    if (sub === 'watchlist') return handleWatchlist(message, { store, yahoo });
    if (sub === 'status')    return handleStatus(message, { store, scannerConfig });
```

(Place those four lines together, replacing the existing watchlist/status lines.)

- [ ] **Step 2: Sanity-check parse**

Run: `node -e "require('./discord/trend-commands')"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add discord/trend-commands.js
git commit -m "feat(trend): !trend watch + !trend unwatch (ManageGuild gated)"
```

---

## Task 13: Discord command — `!trend channel`

**Files:**
- Modify: `discord/trend-commands.js`

- [ ] **Step 1: Add the channel handler**

In `discord/trend-commands.js`, add this helper before `registerTrendCommands`:

```js
async function handleChannel(message, args, { store }) {
  if (!message.guildId) {
    return message.reply('Use this command in a server.').catch(() => {});
  }

  // No argument: show current configuration. Read access OK for any user.
  if (args.length < 2) {
    const channelId = store.getChannel(message.guildId);
    if (!channelId) {
      return message.reply('⚠️ No alert channel set. Use `!trend channel #channel` (Manage Server permission required).').catch(() => {});
    }
    return message.reply(`Trend alert channel: <#${channelId}>`).catch(() => {});
  }

  // Set: requires permissions.
  if (!requireManageGuild(message)) return;

  // Discord auto-expands #channel into <#ID>. Parse either form.
  const arg = args[1];
  let channelId = null;
  const tagMatch = arg.match(/^<#(\d+)>$/);
  if (tagMatch) channelId = tagMatch[1];
  else if (/^\d+$/.test(arg)) channelId = arg;
  if (!channelId) {
    return message.reply('Usage: `!trend channel #channel`').catch(() => {});
  }

  // Sanity-check: the channel must exist in this guild and be a text channel.
  let channel;
  try {
    channel = await message.client.channels.fetch(channelId);
  } catch {
    return message.reply('❌ That channel does not exist or I cannot access it.').catch(() => {});
  }
  if (!channel || channel.guildId !== message.guildId) {
    return message.reply('❌ That channel is not in this server.').catch(() => {});
  }
  if (typeof channel.send !== 'function') {
    return message.reply('❌ That channel cannot receive messages.').catch(() => {});
  }

  store.setChannel(message.guildId, channelId, Date.now());
  return message.reply(`✅ Trend alerts will be posted to <#${channelId}>`).catch(() => {});
}
```

Update the dispatcher:

```js
    if (sub === 'channel')   return handleChannel(message, args, { store });
```

(Add this line alongside the others.)

- [ ] **Step 2: Sanity-check parse**

Run: `node -e "require('./discord/trend-commands')"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add discord/trend-commands.js
git commit -m "feat(trend): !trend channel — view + set alert channel"
```

---

## Task 14: Wire everything into `index.js` and `.env.example`

**Files:**
- Modify: `index.js`
- Modify: `.env.example`

- [ ] **Step 1: Add `.env.example` entries**

Append to `.env.example`:

```ini

# ─── Trend module (intraday scan + !trend command) ────────────────────
# All values are optional — defaults shown apply if unset.
# TREND_SCAN_INTERVAL_MIN=5
# TREND_BREAKOUT_LOOKBACK_BARS=20
# TREND_BREAKOUT_VOLUME_MULT=1.5
# TREND_DEDUP_MINUTES=60
# TREND_RSI_OVERBOUGHT=70
# TREND_RSI_OVERSOLD=30
```

- [ ] **Step 2: Wire in `index.js`**

Find the line that imports market-commands:

```js
const { registerMarketCommands } = require('./discord/market-commands');
```

Just below it, add:

```js
const { createYahooClient } = require('./discord/market-commands');
const { createTrendStore } = require('./db/trend-store');
const { registerTrendCommands } = require('./discord/trend-commands');
const { startTrendScanner } = require('./trading/trend-scanner');
```

Find the SQLite db import. The pattern should be one of:
```js
const sqliteModule = require('./db/sqlite');     // returns the db directly
// or
const { db } = require('./db/sqlite');           // db destructured
```

Check the actual export by running:
```bash
node -e "console.log(Object.keys(require('./db/sqlite')))"
```

If `db` is the default export (single value): use `const db = require('./db/sqlite');`. If exported as `{ db }`, destructure it. **Add this require near the other db-related imports** if not already present.

Find where `registerMarketCommands(client)` is called (after Discord `ready`). Just before or after that line, add:

```js
// Shared yahooClient — same in-memory cache for !price/!chart/!indicator
// (market-commands), !trend (trend-commands), and the auto-scanner.
const sharedYahoo = createYahooClient();
```

Update the existing `registerMarketCommands(client)` call to pass the shared client:

```js
registerMarketCommands(client, { yahooClient: sharedYahoo });
```

After it, add the trend registration:

```js
const trendStore = createTrendStore(db);
registerTrendCommands(client, {
  store: trendStore,
  yahoo: sharedYahoo,
  scannerConfig: { intervalMin: parseInt(process.env.TREND_SCAN_INTERVAL_MIN, 10) || 5 },
});
startTrendScanner({ client, store: trendStore, yahoo: sharedYahoo });
```

- [ ] **Step 3: Verify the bot still boots**

Run: `node -e "require('./index.js')"`

> If env vars like `DISCORD_TOKEN` are missing locally, the import-time code may fail before the network connection. That's expected. What we want to verify is that **module loading and wiring don't throw a syntax/require error**. If you see `Error: Discord token missing` (or similar), it means modules loaded OK and the failure is in the runtime path — that's fine for this step.

If a require error or syntax error fires, fix it before continuing.

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: all existing + new tests pass (across all `*.test.js` files in the repo).

- [ ] **Step 5: Manual smoke test (deferred — done after deploy)**

> **Manual deploy / config steps for the user (NOT for the agent):**
>
> 1. Deploy the branch to Railway (or wherever the bot runs).
> 2. In a Discord server where the bot is admin, run `!trend status` — should show `Alert channel: ⚠️ not set`.
> 3. Run `!trend channel #some-channel` — should reply `✅ Trend alerts will be posted to #some-channel`.
> 4. Run `!trend watch SPY` — should reply `✅ Added $SPY to watchlist (1 ticker total)`.
> 5. Run `!trend SPY` — should reply with current direction + indicators.
> 6. Wait for the next 5-min mark during US market hours; check the log line `[trend] scan: N tickers, M alerts, X errors, Yms`.
> 7. The first scan after a fresh deploy will likely fire 1 direction-transition alert per ticker (NULL → current direction) — this is expected and only happens once per ticker.

The agent should not attempt to do steps 1-7 — they require live Discord/Railway access.

- [ ] **Step 6: Commit**

```bash
git add index.js .env.example
git commit -m "feat(trend): wire trend module into index.js + env template

Boot path:
- shared createYahooClient instance for market-commands, trend-commands, scanner
- registerTrendCommands(client, { store, yahoo, scannerConfig })
- startTrendScanner({ client, store, yahoo })

Module is gated only by store.getChannel(guildId) — guilds with no
alert channel set are silently skipped.
"
```

---

## Self-Review Notes (post-write)

- **Spec coverage:** All sections of the spec map to a task. DB schema → T1. Store → T2. Engine (direction/breakout/reversal/all) → T3-T6. Market hours → T7. Scanner cycle → T8. Scanner driver → T9. Commands (TICKER, watchlist, status, watch, unwatch, channel) → T10-T13. Wiring + env vars → T14.
- **Type consistency:** `detectAll` returns `{ direction, events, snapshot }`. `events[]` items have shape `{ type, ... }` with `type ∈ {breakout, bullish_reversal, bearish_reversal}`. All formatters and the scanner reference these fields consistently.
- **Event column names:** `last_breakout_at`, `last_bullish_reversal_at`, `last_bearish_reversal_at` — used identically in DB schema (T1), store accessors (T2), and `runScanCycle` (T8).
- **Yahoo bar shape:** `{ date, open, high, low, close, volume }` from yahoo-finance2 → adapted to `{ t, o, h, l, c, v }` in two places (`trend-scanner.adaptYahooBars`, `trend-commands.adaptYahooBars`). Duplicated intentionally — each module owns its adapter for clarity. If a third consumer appears, extract to a shared util.
- **No placeholders:** every code block is concrete and complete. The only deferred work is the manual smoke test in Task 14 Step 5, which is explicitly flagged as user-only.
