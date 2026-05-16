# FMP Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 Discord slash commands (`/analyze`, `/insider`, `/politicians`) powered by FMP REST endpoints with automatic Yahoo Finance fallback for the 4 methods that have an equivalent.

**Architecture:** Three new layers stacked on top of existing clients. (1) Extend `discord/fmp-client.js` with 6 new methods covering ratios, price targets, earnings surprises, insider trades, senate trades, house trades. (2) Extend `createYahooClient` in `discord/market-commands.js` with 4 new methods wrapping `yahoo-finance2.quoteSummary` for the corresponding Yahoo data. (3) Create `discord/market-data.js` orchestrator that calls FMP first, falls back to Yahoo if FMP returns null. (4) Create `discord/slash-commands.js` that registers the 3 commands with Discord, dispatches `interactionCreate` events, and builds ephemeral embeds.

**Tech Stack:** Node.js · discord.js v14 · yahoo-finance2 (existing) · node:test + node:assert · better-sqlite3 (unaffected).

**Spec:** [docs/superpowers/specs/2026-05-15-fmp-slash-commands-design.md](../specs/2026-05-15-fmp-slash-commands-design.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `discord/fmp-client.js` | Modify | Add 6 new REST methods (ratios, targets, earnings, insider, senate, house) to the object returned by `createFmpClient()`. |
| `discord/fmp-client.test.js` | Modify | Add 6 tests (1 per new method) using the existing `mockFetch` pattern. |
| `discord/market-commands.js` | Modify | Add 4 new methods to `createYahooClient` (raw `quoteSummary` passthrough + 3 convenience wrappers). |
| `discord/market-commands.test.js` | Modify | Add 4 tests for the new Yahoo methods (mock the `yahoo` instance). |
| `discord/market-data.js` | Create | Orchestrator: try-FMP-then-Yahoo for 5 methods with fallback; FMP-only for senate + house. Returns unified `{ source, ... }` shape. |
| `discord/market-data.test.js` | Create | ~15 tests covering FMP-OK / FMP-null-Yahoo-OK / both-null paths for each method. |
| `discord/slash-commands.js` | Create | Discord registration (global or guild-scoped) + `interactionCreate` dispatcher + 3 handlers + 3 embed builders. |
| `discord/slash-commands.test.js` | Create | ~6 tests covering registration paths + handler happy paths + error case. |
| `index.js` | Modify | Wire `createFmpClient`, `createMarketData`, `createSlashCommands` after the existing `sharedYahoo` declaration. |
| `.env.example` | Modify | Document `SLASH_COMMAND_GUILD_ID` (optional, default empty = global). |

Each task targets one file pair (impl + test) or a wiring change.

---

## Conventions

- **Test runner:** `node --test <file>`
- **Working directory:** `C:\Users\willi\Documents\GitHub\discord-trading-bot\.claude\worktrees\fmp-slash-commands`
- **Mock patterns:** `mockFetch(...)` for fmp-client tests (already established in the existing test file). Fake `yahoo` instance with stubbed `quoteSummary` method for yahoo wrapper tests. Fake `fmpClient` + `yahooClient` for market-data tests. Fake Discord `client` + `interaction` for slash-commands tests.
- **Cache TTL conventions:** 5 min for fundamentals (ratios, targets, earnings), 15 min for insider + politicians. Existing 30s default unchanged for `getQuote`.
- **Per-task commit:** end of each task; messages use `<type>(<scope>): <short>` convention.

---

## Task 1: Extend `discord/fmp-client.js` with 6 new methods

Add `getRatiosTtm`, `getPriceTargetSummary`, `getEarningsSurprises`, `getInsiderTrades`, `getSenateTrades`, `getHouseTrades` to the object returned by `createFmpClient()`. Each follows the existing cache + inflight + httpJson pattern. Each method has its own cache map and TTL.

**Files:**
- Modify: `discord/fmp-client.js`
- Modify: `discord/fmp-client.test.js`

### Step 1.1: Write the 6 failing tests

Append to `discord/fmp-client.test.js` (the existing `mockFetch` helper is reusable):

```js
test('getRatiosTtm returns parsed FMP TTM ratios object', async () => {
  const fetchImpl = mockFetch([
    { peRatioTTM: 32.4, netIncomePerShareTTM: 6.13, marketCapTTM: 3e12 },
  ]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getRatiosTtm('AAPL');
  assert.strictEqual(r.peRatioTTM, 32.4);
  assert.strictEqual(r.netIncomePerShareTTM, 6.13);
  assert.strictEqual(r.marketCapTTM, 3e12);
});

test('getRatiosTtm returns null when FMP returns empty array', async () => {
  const fetchImpl = mockFetch([]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getRatiosTtm('NOPE');
  assert.strictEqual(r, null);
});

test('getPriceTargetSummary returns parsed FMP price target object', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => ({
        symbol: 'AAPL',
        lastMonth: 12, lastMonthAvgPriceTarget: 215.00,
        lastQuarter: 32, lastQuarterAvgPriceTarget: 210.50,
      }),
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const t = await client.getPriceTargetSummary('AAPL');
  assert.ok(capturedUrl.includes('/price-target-summary'));
  assert.ok(capturedUrl.includes('symbol=AAPL'));
  assert.strictEqual(t.lastMonthAvgPriceTarget, 215.00);
});

test('getEarningsSurprises returns array sorted most-recent first', async () => {
  const fetchImpl = mockFetch([
    { date: '2026-04-30', eps: 1.53, estimatedEps: 1.50 },
    { date: '2026-01-30', eps: 2.10, estimatedEps: 2.05 },
  ]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const e = await client.getEarningsSurprises('AAPL');
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].date, '2026-04-30');
  assert.strictEqual(e[0].eps, 1.53);
});

test('getInsiderTrades sends limit query param and returns array', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => [
        { filingDate: '2026-05-12', transactionType: 'S-Sale', reportingName: 'COOK TIMOTHY', securitiesTransacted: 10000, price: 198.00 },
      ],
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getInsiderTrades('AAPL', 5);
  assert.ok(capturedUrl.includes('/insider-trading'));
  assert.ok(capturedUrl.includes('symbol=AAPL'));
  assert.ok(capturedUrl.includes('limit=5'));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].reportingName, 'COOK TIMOTHY');
});

test('getSenateTrades returns trimmed array of up to `limit` items', async () => {
  const fetchImpl = mockFetch([
    { transactionDate: '2026-05-10', senator: 'Pelosi', type: 'Purchase', amount: '$15,001 - $50,000' },
    { transactionDate: '2026-04-28', senator: 'Tuberville', type: 'Purchase', amount: '$50,001 - $100,000' },
    { transactionDate: '2026-04-15', senator: 'Hagerty', type: 'Sale', amount: '$15,001 - $50,000' },
    { transactionDate: '2026-04-01', senator: 'Cruz', type: 'Sale', amount: '$1,001 - $15,000' },
    { transactionDate: '2026-03-20', senator: 'Tillis', type: 'Purchase', amount: '$15,001 - $50,000' },
    { transactionDate: '2026-03-01', senator: 'Other', type: 'Sale', amount: '$1,001 - $15,000' },
  ]);
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getSenateTrades('AAPL', 5);
  assert.strictEqual(r.length, 5);
  assert.strictEqual(r[0].senator, 'Pelosi');
});

test('getHouseTrades sends correct path and returns trimmed array', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => [
        { disclosureDate: '2026-05-05', representative: 'McCaul', type: 'Sale', amount: '$1,001 - $15,000' },
      ],
      text: async () => '',
    };
  };
  const client = createFmpClient({ apiKey: 'KEY', fetchImpl });
  const r = await client.getHouseTrades('AAPL', 5);
  assert.ok(capturedUrl.includes('/senate-disclosure'));
  assert.ok(capturedUrl.includes('symbol=AAPL'));
  assert.strictEqual(r.length, 1);
});
```

### Step 1.2: Run tests to verify they fail

```bash
node --test discord/fmp-client.test.js
```

Expected: 7 failures with `TypeError: client.getRatiosTtm is not a function` (and similar for the other 5 methods).

### Step 1.3: Implement the 6 methods

In `discord/fmp-client.js`, inside `createFmpClient(...)`, after `getQuotesBulk` (the last existing method), add 6 new cache maps and 6 new methods. Final return value also needs updating.

Add the 6 cache maps near the existing `quoteCache` / `barsCache` declarations (around line 75):

```js
  const ratiosCache       = new Map();    // ticker → { ts, data } | { inflight }, TTL 5min
  const priceTargetCache  = new Map();    // TTL 5min
  const earningsCache     = new Map();    // TTL 5min
  const insiderCache      = new Map();    // TTL 15min
  const senateCache       = new Map();    // TTL 15min
  const houseCache        = new Map();    // TTL 15min
```

Add TTL constants near the top of `createFmpClient`:

```js
  const FUNDAMENTALS_TTL_MS = 5 * 60_000;   // 5 min
  const POLITICAL_TTL_MS    = 15 * 60_000;  // 15 min
```

Add the 6 methods after `getQuotesBulk` (before the `return` statement). Each follows the same pattern; for brevity here's the first one in full, plus the URLs for the others.

```js
  // ── Fundamentals : Ratios TTM ───────────────────────────────────
  async function getRatiosTtm(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = ratiosCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < FUNDAMENTALS_TTL_MS) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const url = base + '/ratios-ttm/' + encodeURIComponent(key)
      + '?apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      return Array.isArray(json) && json.length > 0 ? json[0] : null;
    })();
    ratiosCache.set(key, { inflight });
    try {
      const data = await inflight;
      ratiosCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      ratiosCache.delete(key);
      throw err;
    }
  }

  // ── Fundamentals : Price Target Summary ──────────────────────────
  async function getPriceTargetSummary(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = priceTargetCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < FUNDAMENTALS_TTL_MS) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    // FMP v4 endpoint: /price-target-summary?symbol=XXX
    // Note: FMP v4 base differs from v3 — replace /api/v3 with /api/v4 in the URL.
    const v4Base = base.replace('/api/v3', '/api/v4');
    const url = v4Base + '/price-target-summary?symbol=' + encodeURIComponent(key)
      + '&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      // v4 endpoint returns object directly (not array)
      return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
    })();
    priceTargetCache.set(key, { inflight });
    try {
      const data = await inflight;
      priceTargetCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      priceTargetCache.delete(key);
      throw err;
    }
  }

  // ── Fundamentals : Earnings Surprises ───────────────────────────
  async function getEarningsSurprises(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = earningsCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < FUNDAMENTALS_TTL_MS) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const url = base + '/earnings-surprises/' + encodeURIComponent(key)
      + '?apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      return Array.isArray(json) ? json : null;
    })();
    earningsCache.set(key, { inflight });
    try {
      const data = await inflight;
      earningsCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      earningsCache.delete(key);
      throw err;
    }
  }

  // ── Insider Trades (v4) ─────────────────────────────────────────
  async function getInsiderTrades(ticker, limit = 5) {
    const key = String(ticker).toUpperCase() + '|' + Number(limit);
    const hit = insiderCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < POLITICAL_TTL_MS) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const v4Base = base.replace('/api/v3', '/api/v4');
    const url = v4Base + '/insider-trading?symbol=' + encodeURIComponent(String(ticker).toUpperCase())
      + '&limit=' + encodeURIComponent(Number(limit))
      + '&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      return Array.isArray(json) ? json : null;
    })();
    insiderCache.set(key, { inflight });
    try {
      const data = await inflight;
      insiderCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      insiderCache.delete(key);
      throw err;
    }
  }

  // ── Senate Trades (v4) ──────────────────────────────────────────
  async function getSenateTrades(ticker, limit = 5) {
    const key = String(ticker).toUpperCase();
    const hit = senateCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < POLITICAL_TTL_MS) {
        return hit.data ? hit.data.slice(0, Number(limit)) : null;
      }
      if (hit.inflight) {
        const data = await hit.inflight;
        return data ? data.slice(0, Number(limit)) : null;
      }
    }
    const v4Base = base.replace('/api/v3', '/api/v4');
    const url = v4Base + '/senate-trading?symbol=' + encodeURIComponent(key)
      + '&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      return Array.isArray(json) ? json : null;
    })();
    senateCache.set(key, { inflight });
    try {
      const data = await inflight;
      senateCache.set(key, { ts: now(), data });
      return data ? data.slice(0, Number(limit)) : null;
    } catch (err) {
      senateCache.delete(key);
      throw err;
    }
  }

  // ── House Trades (v4) — endpoint is named /senate-disclosure  ──
  async function getHouseTrades(ticker, limit = 5) {
    const key = String(ticker).toUpperCase();
    const hit = houseCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < POLITICAL_TTL_MS) {
        return hit.data ? hit.data.slice(0, Number(limit)) : null;
      }
      if (hit.inflight) {
        const data = await hit.inflight;
        return data ? data.slice(0, Number(limit)) : null;
      }
    }
    const v4Base = base.replace('/api/v3', '/api/v4');
    const url = v4Base + '/senate-disclosure?symbol=' + encodeURIComponent(key)
      + '&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      return Array.isArray(json) ? json : null;
    })();
    houseCache.set(key, { inflight });
    try {
      const data = await inflight;
      houseCache.set(key, { ts: now(), data });
      return data ? data.slice(0, Number(limit)) : null;
    } catch (err) {
      houseCache.delete(key);
      throw err;
    }
  }
```

Update the `return` statement at the bottom of `createFmpClient` to include the new methods:

```js
  return {
    getQuote,
    getDailyBars,
    getQuotesBulk,
    getRatiosTtm,
    getPriceTargetSummary,
    getEarningsSurprises,
    getInsiderTrades,
    getSenateTrades,
    getHouseTrades,
  };
```

### Step 1.4: Run tests to verify they pass

```bash
node --test discord/fmp-client.test.js
```

Expected: all 7 new tests pass alongside the existing 7 — 14 tests total. If the URL assertions fail, check the `v4Base` construction is correct (`base.replace('/api/v3', '/api/v4')`).

### Step 1.5: Commit Task 1

```bash
git add discord/fmp-client.js discord/fmp-client.test.js
git commit -m "feat(fmp): add 6 REST methods for fundamentals + insider + politicians

Adds getRatiosTtm, getPriceTargetSummary, getEarningsSurprises,
getInsiderTrades, getSenateTrades, getHouseTrades. Each follows the
existing cache+inflight pattern. Fundamentals cache TTL 5min ;
insider/political cache TTL 15min.

v4 endpoints derive base from v3 via .replace('/api/v3', '/api/v4').

Spec: docs/superpowers/specs/2026-05-15-fmp-slash-commands-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extend `createYahooClient` in `discord/market-commands.js`

Add 4 new methods to the object returned by `createYahooClient(...)`. Each is a thin wrapper over `yahoo.quoteSummary(ticker, { modules: [...] })` with timeout + cache.

**Files:**
- Modify: `discord/market-commands.js`
- Modify: `discord/market-commands.test.js`

### Step 2.1: Write the 4 failing tests

Append to `discord/market-commands.test.js`:

```js
test('createYahooClient.getQuoteSummary passes modules through to yahoo.quoteSummary', async () => {
  const calls = [];
  const fakeYahoo = {
    quoteSummary: async (ticker, opts) => {
      calls.push({ ticker, opts });
      return { summaryDetail: { trailingPE: 32.4 }, defaultKeyStatistics: { trailingEps: 6.13 } };
    },
  };
  const yc = createYahooClient({ yahoo: fakeYahoo });
  const r = await yc.getQuoteSummary('AAPL', ['summaryDetail', 'defaultKeyStatistics']);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].ticker, 'AAPL');
  assert.deepStrictEqual(calls[0].opts.modules, ['summaryDetail', 'defaultKeyStatistics']);
  assert.strictEqual(r.summaryDetail.trailingPE, 32.4);
});

test('createYahooClient.getEarningsHistory returns earnings array from quoteSummary', async () => {
  const fakeYahoo = {
    quoteSummary: async (ticker, opts) => ({
      earningsHistory: {
        history: [
          { quarter: { fmt: '2026-04-30' }, epsActual: { raw: 1.53 }, epsEstimate: { raw: 1.50 } },
        ],
      },
    }),
  };
  const yc = createYahooClient({ yahoo: fakeYahoo });
  const r = await yc.getEarningsHistory('AAPL');
  assert.ok(Array.isArray(r));
  assert.strictEqual(r.length, 1);
});

test('createYahooClient.getInsiderTransactions returns insider transactions array', async () => {
  const fakeYahoo = {
    quoteSummary: async (ticker, opts) => ({
      insiderTransactions: {
        transactions: [
          { filerName: 'COOK TIMOTHY', transactionText: 'Sale', shares: { raw: 10000 }, value: { raw: 1980000 } },
        ],
      },
    }),
  };
  const yc = createYahooClient({ yahoo: fakeYahoo });
  const r = await yc.getInsiderTransactions('AAPL');
  assert.ok(Array.isArray(r));
  assert.strictEqual(r[0].filerName, 'COOK TIMOTHY');
});

test('createYahooClient.getFinancialData returns financial data object with analyst targets', async () => {
  const fakeYahoo = {
    quoteSummary: async (ticker, opts) => ({
      financialData: {
        targetMeanPrice: { raw: 215.00 },
        targetHighPrice: { raw: 250.00 },
        targetLowPrice:  { raw: 180.00 },
        numberOfAnalystOpinions: { raw: 12 },
      },
    }),
  };
  const yc = createYahooClient({ yahoo: fakeYahoo });
  const r = await yc.getFinancialData('AAPL');
  assert.strictEqual(r.targetMeanPrice.raw, 215.00);
  assert.strictEqual(r.numberOfAnalystOpinions.raw, 12);
});
```

### Step 2.2: Run tests to verify they fail

```bash
node --test discord/market-commands.test.js
```

Expected: 4 new failures with `TypeError: yc.getQuoteSummary is not a function` etc.

### Step 2.3: Implement the 4 methods

In `discord/market-commands.js`, inside `createYahooClient(...)`, after `getQuote` (the first existing method), add a separate cache map and the 4 methods.

First add a cache map alongside the existing `quoteCache` / `chartCache` (around line 105):

```js
  const summaryCache = new Map();   // key = ticker|modules.sorted.join(','), TTL 5min
  const SUMMARY_TTL_MS = 5 * 60_000;
```

Then add the 4 methods (after `getQuote`, before `getChart`):

```js
  // ── Yahoo Quote Summary (raw passthrough) ─────────────────────────
  // Used by market-data orchestrator as a fallback source for fundamentals,
  // earnings, insider transactions, and analyst targets.
  async function getQuoteSummary(ticker, modules) {
    const t = String(ticker).toUpperCase();
    const sortedMods = Array.from(modules).slice().sort();
    const key = t + '|' + sortedMods.join(',');
    const hit = summaryCache.get(key);
    if (hit) {
      if (hit.data !== undefined && (now() - hit.ts) < SUMMARY_TTL_MS) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const inflight = withTimeout(
      yahoo.quoteSummary(t, { modules: sortedMods }),
      timeoutMs,
    );
    summaryCache.set(key, { inflight });
    try {
      const data = await inflight;
      summaryCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      summaryCache.delete(key);
      throw err;
    }
  }

  // ── Yahoo Earnings History (convenience wrapper) ──────────────────
  async function getEarningsHistory(ticker) {
    const summary = await getQuoteSummary(ticker, ['earningsHistory']);
    const history = summary && summary.earningsHistory && summary.earningsHistory.history;
    return Array.isArray(history) ? history : null;
  }

  // ── Yahoo Insider Transactions (convenience wrapper) ──────────────
  async function getInsiderTransactions(ticker) {
    const summary = await getQuoteSummary(ticker, ['insiderTransactions']);
    const tx = summary && summary.insiderTransactions && summary.insiderTransactions.transactions;
    return Array.isArray(tx) ? tx : null;
  }

  // ── Yahoo Financial Data (analyst price targets) ──────────────────
  async function getFinancialData(ticker) {
    const summary = await getQuoteSummary(ticker, ['financialData']);
    return summary && summary.financialData ? summary.financialData : null;
  }
```

Update the `return` statement at the bottom of `createYahooClient` (around line 220) to include the 4 new methods:

```js
  return {
    getQuote,
    getChart,
    getChartCustom,
    getQuoteSummary,
    getEarningsHistory,
    getInsiderTransactions,
    getFinancialData,
  };
```

### Step 2.4: Run tests to verify they pass

```bash
node --test discord/market-commands.test.js
```

Expected: all 4 new tests pass. Existing tests in this file should also continue passing — verify zero regressions.

### Step 2.5: Commit Task 2

```bash
git add discord/market-commands.js discord/market-commands.test.js
git commit -m "feat(yahoo-client): add 4 quote-summary wrappers for fallback path

Adds getQuoteSummary (raw passthrough) + 3 convenience wrappers
(getEarningsHistory, getInsiderTransactions, getFinancialData) on
createYahooClient. Used by market-data orchestrator when FMP fails.

Cache TTL 5min, keyed by ticker + sorted modules list. Yahoo wrappers
use yahoo-finance2's quoteSummary(ticker, { modules: [...] }).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create `discord/market-data.js` orchestrator

Try-FMP-then-Yahoo for 5 methods with fallback (getQuote, getRatiosTtm, getPriceTargetSummary, getEarningsSurprises, getInsiderTrades). FMP-only for 2 (getSenateTrades, getHouseTrades). Returns unified `{ source, ... }` shape.

**Files:**
- Create: `discord/market-data.js`
- Create: `discord/market-data.test.js`

### Step 3.1: Write the failing tests

Create `discord/market-data.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketData } = require('./market-data');

function makeFakeFmp({ overrides = {} } = {}) {
  return {
    getQuote: async () => null,
    getRatiosTtm: async () => null,
    getPriceTargetSummary: async () => null,
    getEarningsSurprises: async () => null,
    getInsiderTrades: async () => null,
    getSenateTrades: async () => null,
    getHouseTrades: async () => null,
    ...overrides,
  };
}

function makeFakeYahoo({ overrides = {} } = {}) {
  return {
    getQuote: async () => null,
    getQuoteSummary: async () => null,
    getEarningsHistory: async () => null,
    getInsiderTransactions: async () => null,
    getFinancialData: async () => null,
    ...overrides,
  };
}

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

// ── getRatiosTtm ─────────────────────────────────────────────────
test('getRatiosTtm uses FMP when FMP returns data', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getRatiosTtm: async () => ({ peRatioTTM: 32.4, netIncomePerShareTTM: 6.13, marketCapTTM: 3e12 }),
  }});
  const yahooClient = makeFakeYahoo();
  const md = createMarketData({ fmpClient, yahooClient, logger: SILENT_LOGGER });
  const r = await md.getRatiosTtm('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.peRatio, 32.4);
  assert.strictEqual(r.eps, 6.13);
  assert.strictEqual(r.marketCap, 3e12);
});

test('getRatiosTtm falls back to Yahoo when FMP returns null', async () => {
  const fmpClient = makeFakeFmp();  // all null
  const yahooClient = makeFakeYahoo({ overrides: {
    getQuoteSummary: async () => ({
      summaryDetail: { trailingPE: 28.0, marketCap: 2.5e12 },
      defaultKeyStatistics: { trailingEps: 5.50 },
    }),
  }});
  const md = createMarketData({ fmpClient, yahooClient, logger: SILENT_LOGGER });
  const r = await md.getRatiosTtm('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.peRatio, 28.0);
  assert.strictEqual(r.eps, 5.50);
  assert.strictEqual(r.marketCap, 2.5e12);
});

test('getRatiosTtm returns null when both FMP and Yahoo fail', async () => {
  const md = createMarketData({
    fmpClient: makeFakeFmp(),
    yahooClient: makeFakeYahoo(),
    logger: SILENT_LOGGER,
  });
  assert.strictEqual(await md.getRatiosTtm('NOPE'), null);
});

// ── getPriceTargetSummary ────────────────────────────────────────
test('getPriceTargetSummary uses FMP when present', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getPriceTargetSummary: async () => ({
      lastMonthAvgPriceTarget: 215, lastQuarterAvgPriceTarget: 210, allTimeAvgPriceTarget: 200,
    }),
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getPriceTargetSummary('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.targetMean, 215);
});

test('getPriceTargetSummary falls back to Yahoo financialData', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getFinancialData: async () => ({
      targetMeanPrice: { raw: 215 }, targetHighPrice: { raw: 250 }, targetLowPrice: { raw: 180 },
      numberOfAnalystOpinions: { raw: 12 },
    }),
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getPriceTargetSummary('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.targetMean, 215);
  assert.strictEqual(r.targetHigh, 250);
  assert.strictEqual(r.numberOfAnalysts, 12);
});

// ── getEarningsSurprises ─────────────────────────────────────────
test('getEarningsSurprises uses FMP first result (most recent)', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getEarningsSurprises: async () => [
      { date: '2026-04-30', eps: 1.53, estimatedEps: 1.50 },
      { date: '2026-01-30', eps: 2.10, estimatedEps: 2.05 },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getEarningsSurprises('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.mostRecent.date, '2026-04-30');
  assert.strictEqual(r.mostRecent.epsActual, 1.53);
  assert.strictEqual(r.mostRecent.epsEstimate, 1.50);
  assert.strictEqual(r.mostRecent.beat, true);
});

test('getEarningsSurprises falls back to Yahoo earningsHistory', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getEarningsHistory: async () => [
      { quarter: { fmt: '2026-04-30' }, epsActual: { raw: 1.53 }, epsEstimate: { raw: 1.50 } },
    ],
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getEarningsSurprises('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.mostRecent.date, '2026-04-30');
  assert.strictEqual(r.mostRecent.beat, true);
});

// ── getInsiderTrades ─────────────────────────────────────────────
test('getInsiderTrades uses FMP and unifies shape', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getInsiderTrades: async () => [
      { filingDate: '2026-05-12', transactionType: 'S-Sale', reportingName: 'COOK TIMOTHY', securitiesTransacted: 10000, price: 198.00 },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getInsiderTrades('AAPL', 5);
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].name, 'COOK TIMOTHY');
  assert.strictEqual(r.trades[0].shares, 10000);
});

test('getInsiderTrades falls back to Yahoo insiderTransactions', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getInsiderTransactions: async () => [
      { filerName: 'COOK TIMOTHY', transactionText: 'Sale', shares: { raw: 10000 }, value: { raw: 1980000 }, startDate: { fmt: '2026-05-12' } },
    ],
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getInsiderTrades('AAPL', 5);
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.trades[0].name, 'COOK TIMOTHY');
});

// ── getSenateTrades / getHouseTrades (FMP-only) ──────────────────
test('getSenateTrades returns FMP data (no Yahoo fallback)', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getSenateTrades: async () => [
      { transactionDate: '2026-05-10', senator: 'Pelosi', type: 'Purchase', amount: '$15,001 - $50,000' },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getSenateTrades('AAPL', 5);
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].name, 'Pelosi');
});

test('getSenateTrades returns null when FMP returns null (no Yahoo fallback)', async () => {
  const md = createMarketData({
    fmpClient: makeFakeFmp(),
    yahooClient: makeFakeYahoo(),
    logger: SILENT_LOGGER,
  });
  assert.strictEqual(await md.getSenateTrades('NOPE', 5), null);
});

test('getHouseTrades returns FMP data with unified shape', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getHouseTrades: async () => [
      { disclosureDate: '2026-05-05', representative: 'McCaul', type: 'Sale', amount: '$1,001 - $15,000' },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getHouseTrades('AAPL', 5);
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.trades[0].name, 'McCaul');
});

// ── getQuote (FMP first, Yahoo fallback) ─────────────────────────
test('getQuote uses FMP when present', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getQuote: async () => ({ price: 198.42, volume: 12345678 }),
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getQuote('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.price, 198.42);
});

test('getQuote falls back to Yahoo when FMP returns null', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getQuote: async () => ({
      regularMarketPrice: 198.42, regularMarketVolume: 12345678,
      regularMarketDayHigh: 199.85, regularMarketDayLow: 195.10,
      regularMarketChangePercent: 1.23, longName: 'Apple Inc.',
    }),
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getQuote('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.price, 198.42);
  assert.strictEqual(r.name, 'Apple Inc.');
});

// ── FMP throws → fallback to Yahoo ───────────────────────────────
test('FMP throwing an error triggers Yahoo fallback (does not propagate)', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getRatiosTtm: async () => { throw new Error('FMP unavailable'); },
  }});
  const yahooClient = makeFakeYahoo({ overrides: {
    getQuoteSummary: async () => ({
      summaryDetail: { trailingPE: 28.0 }, defaultKeyStatistics: { trailingEps: 5.50 },
    }),
  }});
  const md = createMarketData({ fmpClient, yahooClient, logger: SILENT_LOGGER });
  const r = await md.getRatiosTtm('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.peRatio, 28.0);
});
```

### Step 3.2: Run tests to verify they fail

```bash
node --test discord/market-data.test.js
```

Expected: all 15 tests fail with `Cannot find module './market-data'`.

### Step 3.3: Implement `discord/market-data.js`

Create the file with the orchestrator. Pattern: try FMP, catch errors / null → try Yahoo (for 5 methods); FMP-only for 2.

```js
// ─────────────────────────────────────────────────────────────────────
// discord/market-data.js — Orchestrator FMP-first, Yahoo-fallback
// ─────────────────────────────────────────────────────────────────────
// Wraps fmpClient (REST FMP) and yahooClient (yahoo-finance2) to provide
// a unified market-data interface for slash commands. Each method tries
// FMP first ; if FMP returns null or throws, falls back to Yahoo. The
// returned shape includes `source: 'fmp' | 'yahoo'` so the caller can
// display attribution in the embed footer.
//
// 5 methods have a Yahoo fallback path :
//   getQuote, getRatiosTtm, getPriceTargetSummary, getEarningsSurprises,
//   getInsiderTrades.
//
// 2 methods are FMP-only (Yahoo has no equivalent) :
//   getSenateTrades, getHouseTrades.
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-slash-commands-design.md
// ─────────────────────────────────────────────────────────────────────

function num(x) { return Number.isFinite(x) ? x : null; }

function fromYahooRaw(node) {
  // yahoo-finance2 sometimes wraps values in { raw: <number>, fmt: <string> }
  if (node == null) return null;
  if (typeof node === 'number') return Number.isFinite(node) ? node : null;
  if (typeof node === 'object' && 'raw' in node) return num(node.raw);
  return null;
}

function fromYahooDate(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && 'fmt' in node) return node.fmt;
  return null;
}

function createMarketData({ fmpClient, yahooClient, logger = console } = {}) {
  if (!fmpClient)   throw new Error('fmpClient required');
  if (!yahooClient) throw new Error('yahooClient required');

  async function getQuote(ticker) {
    try {
      const f = await fmpClient.getQuote(ticker);
      if (f && Number.isFinite(f.price)) {
        return { source: 'fmp', price: f.price, volume: num(f.volume), change: null, changePct: null, dayHigh: null, dayLow: null, name: null };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getQuote failed for ' + ticker + ': ' + err.message);
    }
    try {
      const y = await yahooClient.getQuote(ticker);
      if (y && Number.isFinite(y.regularMarketPrice)) {
        return {
          source: 'yahoo',
          price: y.regularMarketPrice,
          volume: num(y.regularMarketVolume),
          change: num(y.regularMarketChange),
          changePct: num(y.regularMarketChangePercent),
          dayHigh: num(y.regularMarketDayHigh),
          dayLow: num(y.regularMarketDayLow),
          name: y.longName || y.shortName || null,
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getQuote failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getRatiosTtm(ticker) {
    try {
      const f = await fmpClient.getRatiosTtm(ticker);
      if (f && f.peRatioTTM != null) {
        return {
          source: 'fmp',
          peRatio: num(f.peRatioTTM),
          eps: num(f.netIncomePerShareTTM),
          marketCap: num(f.marketCapTTM),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getRatiosTtm failed for ' + ticker + ': ' + err.message);
    }
    try {
      const y = await yahooClient.getQuoteSummary(ticker, ['summaryDetail', 'defaultKeyStatistics']);
      if (y) {
        const pe = y.summaryDetail && (typeof y.summaryDetail.trailingPE === 'number' ? y.summaryDetail.trailingPE : fromYahooRaw(y.summaryDetail.trailingPE));
        const eps = y.defaultKeyStatistics && (typeof y.defaultKeyStatistics.trailingEps === 'number' ? y.defaultKeyStatistics.trailingEps : fromYahooRaw(y.defaultKeyStatistics.trailingEps));
        const mc = y.summaryDetail && (typeof y.summaryDetail.marketCap === 'number' ? y.summaryDetail.marketCap : fromYahooRaw(y.summaryDetail.marketCap));
        if (pe != null || eps != null || mc != null) {
          return { source: 'yahoo', peRatio: pe, eps: eps, marketCap: mc };
        }
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getRatiosTtm failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getPriceTargetSummary(ticker) {
    try {
      const f = await fmpClient.getPriceTargetSummary(ticker);
      if (f && (f.lastMonthAvgPriceTarget != null || f.lastQuarterAvgPriceTarget != null || f.allTimeAvgPriceTarget != null)) {
        const targetMean = num(f.lastMonthAvgPriceTarget) || num(f.lastQuarterAvgPriceTarget) || num(f.allTimeAvgPriceTarget);
        return {
          source: 'fmp',
          targetMean,
          targetHigh: null,
          targetLow: null,
          numberOfAnalysts: num(f.lastMonth) || num(f.lastQuarter) || null,
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getPriceTargetSummary failed for ' + ticker + ': ' + err.message);
    }
    try {
      const fin = await yahooClient.getFinancialData(ticker);
      if (fin) {
        return {
          source: 'yahoo',
          targetMean: fromYahooRaw(fin.targetMeanPrice),
          targetHigh: fromYahooRaw(fin.targetHighPrice),
          targetLow:  fromYahooRaw(fin.targetLowPrice),
          numberOfAnalysts: fromYahooRaw(fin.numberOfAnalystOpinions),
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getPriceTargetSummary failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getEarningsSurprises(ticker) {
    try {
      const f = await fmpClient.getEarningsSurprises(ticker);
      if (Array.isArray(f) && f.length > 0) {
        const row = f[0];
        const actual = num(row.eps);
        const est = num(row.estimatedEps);
        return {
          source: 'fmp',
          mostRecent: {
            date: row.date || null,
            epsActual: actual,
            epsEstimate: est,
            beat: (actual != null && est != null) ? actual >= est : null,
            surprisePct: (actual != null && est != null && est !== 0) ? ((actual - est) / Math.abs(est)) * 100 : null,
          },
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getEarningsSurprises failed for ' + ticker + ': ' + err.message);
    }
    try {
      const hist = await yahooClient.getEarningsHistory(ticker);
      if (Array.isArray(hist) && hist.length > 0) {
        const latest = hist[hist.length - 1];   // Yahoo returns oldest-first
        const actual = fromYahooRaw(latest.epsActual);
        const est = fromYahooRaw(latest.epsEstimate);
        return {
          source: 'yahoo',
          mostRecent: {
            date: fromYahooDate(latest.quarter),
            epsActual: actual,
            epsEstimate: est,
            beat: (actual != null && est != null) ? actual >= est : null,
            surprisePct: (actual != null && est != null && est !== 0) ? ((actual - est) / Math.abs(est)) * 100 : null,
          },
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getEarningsSurprises failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getInsiderTrades(ticker, limit = 5) {
    try {
      const f = await fmpClient.getInsiderTrades(ticker, limit);
      if (Array.isArray(f) && f.length > 0) {
        return {
          source: 'fmp',
          trades: f.slice(0, limit).map(t => ({
            date: t.filingDate || null,
            name: t.reportingName || null,
            type: t.transactionType || null,
            shares: num(t.securitiesTransacted),
            price: num(t.price),
            value: (num(t.securitiesTransacted) != null && num(t.price) != null) ? t.securitiesTransacted * t.price : null,
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getInsiderTrades failed for ' + ticker + ': ' + err.message);
    }
    try {
      const y = await yahooClient.getInsiderTransactions(ticker);
      if (Array.isArray(y) && y.length > 0) {
        return {
          source: 'yahoo',
          trades: y.slice(0, limit).map(t => ({
            date: fromYahooDate(t.startDate),
            name: t.filerName || null,
            type: t.transactionText || null,
            shares: fromYahooRaw(t.shares),
            price: null,
            value: fromYahooRaw(t.value),
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getInsiderTrades failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getSenateTrades(ticker, limit = 5) {
    try {
      const f = await fmpClient.getSenateTrades(ticker, limit);
      if (Array.isArray(f) && f.length > 0) {
        return {
          source: 'fmp',
          trades: f.slice(0, limit).map(t => ({
            date: t.transactionDate || null,
            name: t.senator || null,
            type: t.type || null,
            amount: t.amount || null,
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getSenateTrades failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getHouseTrades(ticker, limit = 5) {
    try {
      const f = await fmpClient.getHouseTrades(ticker, limit);
      if (Array.isArray(f) && f.length > 0) {
        return {
          source: 'fmp',
          trades: f.slice(0, limit).map(t => ({
            date: t.disclosureDate || null,
            name: t.representative || null,
            type: t.type || null,
            amount: t.amount || null,
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getHouseTrades failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  return {
    getQuote,
    getRatiosTtm,
    getPriceTargetSummary,
    getEarningsSurprises,
    getInsiderTrades,
    getSenateTrades,
    getHouseTrades,
  };
}

module.exports = { createMarketData };
```

### Step 3.4: Run tests to verify they pass

```bash
node --test discord/market-data.test.js
```

Expected: all 15 tests pass.

### Step 3.5: Commit Task 3

```bash
git add discord/market-data.js discord/market-data.test.js
git commit -m "feat(market-data): orchestrator with FMP-first, Yahoo-fallback chain

Wraps fmpClient + yahooClient with unified market-data interface. 5
methods have Yahoo fallback (getQuote, getRatiosTtm, getPriceTarget
Summary, getEarningsSurprises, getInsiderTrades). 2 are FMP-only
(getSenateTrades, getHouseTrades) since Yahoo has no equivalent data.

Each return value includes { source: 'fmp' | 'yahoo' } so callers can
attribute the source in embed footers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Create `discord/slash-commands.js`

Discord registration (global or guild-scoped) + `interactionCreate` dispatcher + 3 handlers + 3 embed builders.

**Files:**
- Create: `discord/slash-commands.js`
- Create: `discord/slash-commands.test.js`

### Step 4.1: Write the failing tests

Create `discord/slash-commands.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createSlashCommands } = require('./slash-commands');

function makeFakeMarketData(overrides = {}) {
  return {
    getQuote: async () => null,
    getRatiosTtm: async () => null,
    getPriceTargetSummary: async () => null,
    getEarningsSurprises: async () => null,
    getInsiderTrades: async () => null,
    getSenateTrades: async () => null,
    getHouseTrades: async () => null,
    ...overrides,
  };
}

function makeFakeInteraction({ commandName, ticker = 'AAPL' } = {}) {
  const calls = { defer: [], edit: [] };
  return {
    commandName,
    isChatInputCommand: () => true,
    options: {
      getString: (key) => (key === 'ticker' ? ticker : null),
    },
    deferReply: async (opts) => { calls.defer.push(opts); },
    editReply: async (payload) => { calls.edit.push(payload); },
    _calls: calls,
  };
}

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

test('register() with SLASH_COMMAND_GUILD_ID set targets the guild', async () => {
  delete process.env.SLASH_COMMAND_GUILD_ID;
  process.env.SLASH_COMMAND_GUILD_ID = 'guild-123';
  try {
    let guildSetCalled = null;
    let globalSetCalled = null;
    const fakeClient = {
      application: { commands: { set: async (defs) => { globalSetCalled = defs; } } },
      guilds: { fetch: async (id) => ({ commands: { set: async (defs) => { guildSetCalled = { id, defs }; } } }) },
    };
    const sc = createSlashCommands({ marketData: makeFakeMarketData(), logger: SILENT_LOGGER });
    await sc.register(fakeClient);
    assert.ok(guildSetCalled, 'guild.commands.set should have been called');
    assert.strictEqual(guildSetCalled.id, 'guild-123');
    assert.strictEqual(guildSetCalled.defs.length, 3);
    assert.strictEqual(globalSetCalled, null, 'global registration should NOT happen when guild is set');
  } finally {
    delete process.env.SLASH_COMMAND_GUILD_ID;
  }
});

test('register() without SLASH_COMMAND_GUILD_ID falls back to global', async () => {
  delete process.env.SLASH_COMMAND_GUILD_ID;
  let globalSetCalled = null;
  const fakeClient = {
    application: { commands: { set: async (defs) => { globalSetCalled = defs; } } },
    guilds: { fetch: async () => { throw new Error('should not be called'); } },
  };
  const sc = createSlashCommands({ marketData: makeFakeMarketData(), logger: SILENT_LOGGER });
  await sc.register(fakeClient);
  assert.ok(globalSetCalled, 'global commands.set should have been called');
  assert.strictEqual(globalSetCalled.length, 3);
  // Verify the 3 command names
  const names = globalSetCalled.map(d => d.name).sort();
  assert.deepStrictEqual(names, ['analyze', 'insider', 'politicians']);
});

test('handleAnalyze posts ephemeral embed with all sections when data is complete', async () => {
  const marketData = makeFakeMarketData({
    getQuote: async () => ({ source: 'fmp', price: 198.42, changePct: 1.23, dayHigh: 199.85, dayLow: 195.10, name: 'Apple Inc.' }),
    getRatiosTtm: async () => ({ source: 'fmp', peRatio: 32.4, eps: 6.13, marketCap: 3e12 }),
    getPriceTargetSummary: async () => ({ source: 'fmp', targetMean: 215, targetHigh: 250, targetLow: 180, numberOfAnalysts: 12 }),
    getEarningsSurprises: async () => ({ source: 'fmp', mostRecent: { date: '2026-04-30', epsActual: 1.53, epsEstimate: 1.50, beat: true, surprisePct: 2.0 } }),
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'analyze', ticker: 'AAPL' });
  await sc.handleAnalyze(interaction);
  assert.strictEqual(interaction._calls.defer.length, 1);
  assert.strictEqual(interaction._calls.defer[0].ephemeral, true);
  assert.strictEqual(interaction._calls.edit.length, 1);
  const payload = interaction._calls.edit[0];
  assert.ok(Array.isArray(payload.embeds));
  assert.strictEqual(payload.embeds.length, 1);
  // Embed should contain ticker, price, P/E, target, earnings info
  const embedJson = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data;
  const text = JSON.stringify(embedJson);
  assert.ok(text.includes('AAPL'));
  assert.ok(text.includes('198.42'));
  assert.ok(text.includes('32.4'));
  assert.ok(text.includes('215'));
  assert.ok(text.includes('1.53'));
});

test('handleAnalyze replies with no-data message when all sources return null', async () => {
  const sc = createSlashCommands({ marketData: makeFakeMarketData(), logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'analyze', ticker: 'XYZ' });
  await sc.handleAnalyze(interaction);
  assert.strictEqual(interaction._calls.edit.length, 1);
  const payload = interaction._calls.edit[0];
  assert.ok(payload.content && payload.content.includes('not found'));
});

test('handleInsider posts ephemeral embed with 5 transactions', async () => {
  const marketData = makeFakeMarketData({
    getInsiderTrades: async () => ({
      source: 'fmp',
      trades: [
        { date: '2026-05-12', name: 'COOK TIMOTHY', type: 'S-Sale', shares: 10000, price: 198.00, value: 1980000 },
        { date: '2026-05-08', name: 'ADAMS KATHERINE', type: 'P-Purchase', shares: 2500, price: 195.50, value: 488750 },
      ],
    }),
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'insider', ticker: 'AAPL' });
  await sc.handleInsider(interaction);
  const payload = interaction._calls.edit[0];
  const text = JSON.stringify(payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data);
  assert.ok(text.includes('COOK TIMOTHY'));
  assert.ok(text.includes('ADAMS KATHERINE'));
});

test('handlePoliticians combines senate + house and posts embed', async () => {
  const marketData = makeFakeMarketData({
    getSenateTrades: async () => ({
      source: 'fmp',
      trades: [{ date: '2026-05-10', name: 'Pelosi', type: 'Purchase', amount: '$15,001 - $50,000' }],
    }),
    getHouseTrades: async () => ({
      source: 'fmp',
      trades: [{ date: '2026-05-05', name: 'McCaul', type: 'Sale', amount: '$1,001 - $15,000' }],
    }),
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'politicians', ticker: 'AAPL' });
  await sc.handlePoliticians(interaction);
  const payload = interaction._calls.edit[0];
  const text = JSON.stringify(payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data);
  assert.ok(text.includes('Pelosi'));
  assert.ok(text.includes('McCaul'));
});

test('handler error path posts ephemeral error message instead of throwing', async () => {
  const marketData = makeFakeMarketData({
    getQuote: async () => { throw new Error('FMP unavailable'); },
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'analyze', ticker: 'AAPL' });
  await sc.handleAnalyze(interaction);
  assert.strictEqual(interaction._calls.edit.length, 1);
  const payload = interaction._calls.edit[0];
  assert.ok(payload.content && payload.content.includes('unavailable'));
});
```

### Step 4.2: Run tests to verify they fail

```bash
node --test discord/slash-commands.test.js
```

Expected: 7 failures with `Cannot find module './slash-commands'`.

### Step 4.3: Implement `discord/slash-commands.js`

Create the file with command registration, dispatcher, 3 handlers, and 3 embed builders.

```js
// ─────────────────────────────────────────────────────────────────────
// discord/slash-commands.js — FMP-powered Discord slash commands
// ─────────────────────────────────────────────────────────────────────
// Three slash commands : /analyze, /insider, /politicians.
// All take a single required `ticker` string option and reply with an
// ephemeral embed. Data is sourced via market-data orchestrator (FMP
// with Yahoo fallback) — handlers don't know which source served the
// data, they just receive { source, ...payload }.
//
// Registration : global by default (slow propagation ~1h, visible in
// all guilds where the bot is). Set SLASH_COMMAND_GUILD_ID env var to
// scope to a single guild (instant propagation, useful for dev).
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-slash-commands-design.md
// ─────────────────────────────────────────────────────────────────────

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0x06b6d4;   // matches BRAND_COLOR default in .env.example

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return '$' + n.toFixed(2);
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtMarketCap(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + n.toFixed(0);
}

function fmtShares(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

function fmtValue(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function collectSources(...results) {
  const sources = new Set();
  for (const r of results) if (r && r.source) sources.add(r.source);
  if (sources.size === 0) return 'No source';
  if (sources.size === 1) return 'Source: ' + Array.from(sources)[0].toUpperCase();
  return 'Sources: ' + Array.from(sources).sort().map(s => s.toUpperCase()).join(' + ') + ' (mixed)';
}

function createSlashCommands({ marketData, logger = console } = {}) {
  if (!marketData) throw new Error('marketData required');

  // ── Command definitions ─────────────────────────────────────────
  const commandDefs = [
    new SlashCommandBuilder()
      .setName('analyze')
      .setDescription('Show fundamentals + analyst targets + last earnings for a ticker')
      .addStringOption(opt => opt
        .setName('ticker')
        .setDescription('Stock ticker (e.g., AAPL)')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('insider')
      .setDescription('Show the last 5 insider transactions for a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Stock ticker').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('politicians')
      .setDescription('Show the last 5 US Senate + House trades for a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Stock ticker').setRequired(true))
      .toJSON(),
  ];

  // ── Registration ────────────────────────────────────────────────
  async function register(client) {
    const guildId = process.env.SLASH_COMMAND_GUILD_ID || '';
    try {
      if (guildId) {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(commandDefs);
        logger.log('[slash-commands] registered ' + commandDefs.length
          + ' commands on guild ' + guildId + ' (instant propagation)');
      } else {
        await client.application.commands.set(commandDefs);
        logger.log('[slash-commands] registered ' + commandDefs.length
          + ' commands GLOBALLY (propagation up to 1h)');
      }
    } catch (err) {
      logger.error('[slash-commands] registration failed: ' + err.message);
    }
  }

  // ── Dispatcher ──────────────────────────────────────────────────
  async function handleInteractionCreate(interaction) {
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case 'analyze':     return handleAnalyze(interaction);
      case 'insider':     return handleInsider(interaction);
      case 'politicians': return handlePoliticians(interaction);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────
  async function handleAnalyze(interaction) {
    const ticker = interaction.options.getString('ticker').toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      const [quote, ratios, targets, earnings] = await Promise.all([
        marketData.getQuote(ticker),
        marketData.getRatiosTtm(ticker),
        marketData.getPriceTargetSummary(ticker),
        marketData.getEarningsSurprises(ticker),
      ]);
      if (!quote && !ratios && !targets && !earnings) {
        await interaction.editReply({ content: '❌ Ticker $' + ticker + ' not found' });
        return;
      }
      const embed = buildAnalyzeEmbed({ ticker, quote, ratios, targets, earnings });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[slash-commands] /analyze ' + ticker + ' error: ' + err.message);
      await interaction.editReply({ content: '❌ Service unavailable, try again later' });
    }
  }

  async function handleInsider(interaction) {
    const ticker = interaction.options.getString('ticker').toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await marketData.getInsiderTrades(ticker, 5);
      if (!data || !data.trades || data.trades.length === 0) {
        await interaction.editReply({ content: '❌ No insider transactions found for $' + ticker });
        return;
      }
      const embed = buildInsiderEmbed({ ticker, data });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[slash-commands] /insider ' + ticker + ' error: ' + err.message);
      await interaction.editReply({ content: '❌ Service unavailable, try again later' });
    }
  }

  async function handlePoliticians(interaction) {
    const ticker = interaction.options.getString('ticker').toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      const [senate, house] = await Promise.all([
        marketData.getSenateTrades(ticker, 5),
        marketData.getHouseTrades(ticker, 5),
      ]);
      const combined = [];
      if (senate && senate.trades) {
        for (const t of senate.trades) combined.push({ chamber: 'Sen.', ...t });
      }
      if (house && house.trades) {
        for (const t of house.trades) combined.push({ chamber: 'Rep.', ...t });
      }
      if (combined.length === 0) {
        await interaction.editReply({ content: '❌ No congressional trades found for $' + ticker });
        return;
      }
      combined.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const top5 = combined.slice(0, 5);
      const embed = buildPoliticiansEmbed({ ticker, trades: top5, sources: [senate, house] });
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('[slash-commands] /politicians ' + ticker + ' error: ' + err.message);
      await interaction.editReply({ content: '❌ Service unavailable, try again later' });
    }
  }

  // ── Embed builders ──────────────────────────────────────────────
  function buildAnalyzeEmbed({ ticker, quote, ratios, targets, earnings }) {
    const name = quote && quote.name ? ' — ' + quote.name : '';
    const e = new EmbedBuilder()
      .setTitle('🔍 ' + ticker + name)
      .setColor(EMBED_COLOR);

    if (quote) {
      const line = fmtPrice(quote.price)
        + (quote.changePct != null ? ' (' + fmtPct(quote.changePct) + ')' : '')
        + (quote.dayHigh != null && quote.dayLow != null
            ? ' — day H/L: ' + fmtPrice(quote.dayHigh) + ' / ' + fmtPrice(quote.dayLow)
            : '');
      e.addFields({ name: 'Price', value: line, inline: false });
    }
    if (ratios) {
      e.addFields({
        name: 'Fundamentals',
        value: 'P/E ' + (ratios.peRatio != null ? ratios.peRatio.toFixed(2) : '—')
          + ' · EPS ' + fmtPrice(ratios.eps)
          + ' · Market Cap ' + fmtMarketCap(ratios.marketCap),
        inline: false,
      });
    }
    if (targets) {
      e.addFields({
        name: 'Analyst Targets',
        value: 'Avg ' + fmtPrice(targets.targetMean)
          + (targets.targetHigh != null ? ' · High ' + fmtPrice(targets.targetHigh) : '')
          + (targets.targetLow != null ? ' · Low ' + fmtPrice(targets.targetLow) : '')
          + (targets.numberOfAnalysts != null ? ' (' + targets.numberOfAnalysts + ' analysts)' : ''),
        inline: false,
      });
    }
    if (earnings && earnings.mostRecent) {
      const er = earnings.mostRecent;
      const beatStr = er.beat === true ? '✅ beat' : er.beat === false ? '❌ miss' : '—';
      e.addFields({
        name: 'Last Earnings',
        value: (er.date || '—')
          + ' — EPS ' + fmtPrice(er.epsActual) + ' vs est ' + fmtPrice(er.epsEstimate)
          + ' (' + beatStr + (er.surprisePct != null ? ' ' + fmtPct(er.surprisePct) : '') + ')',
        inline: false,
      });
    }
    e.setFooter({ text: collectSources(quote, ratios, targets, earnings) });
    return e;
  }

  function buildInsiderEmbed({ ticker, data }) {
    const lines = data.trades.slice(0, 5).map(t => {
      return '▸ `' + (t.date || '—') + '`  ' + (t.name || '—')
        + '  ' + (t.type || '—')
        + '  ' + fmtShares(t.shares) + ' sh @ ' + fmtPrice(t.price)
        + '  (' + fmtValue(t.value) + ')';
    });
    const e = new EmbedBuilder()
      .setTitle('👤 ' + ticker + ' — Insider transactions (' + data.trades.length + ' most recent)')
      .setColor(EMBED_COLOR)
      .setDescription(lines.join('\n'))
      .setFooter({ text: collectSources(data) });
    return e;
  }

  function buildPoliticiansEmbed({ ticker, trades, sources }) {
    const lines = trades.map(t => {
      return '▸ `' + (t.date || '—') + '`  ' + (t.chamber || '') + ' ' + (t.name || '—')
        + '  ' + (t.type || '—') + '  ' + (t.amount || '—');
    });
    const e = new EmbedBuilder()
      .setTitle('🏛️ ' + ticker + ' — US Congressional trades (' + trades.length + ' most recent)')
      .setColor(EMBED_COLOR)
      .setDescription(lines.join('\n'))
      .setFooter({ text: collectSources(...sources) });
    return e;
  }

  // ── Wire-up ─────────────────────────────────────────────────────
  function wire(client) {
    client.once('ready', () => register(client));
    client.on('interactionCreate', (interaction) => {
      handleInteractionCreate(interaction).catch(err =>
        logger.error('[slash-commands] handler error: ' + err.message));
    });
  }

  return {
    wire,
    register,
    handleInteractionCreate,
    handleAnalyze,
    handleInsider,
    handlePoliticians,
  };
}

module.exports = { createSlashCommands };
```

### Step 4.4: Run tests to verify they pass

```bash
node --test discord/slash-commands.test.js
```

Expected: all 7 tests pass.

### Step 4.5: Commit Task 4

```bash
git add discord/slash-commands.js discord/slash-commands.test.js
git commit -m "feat(slash-commands): add /analyze /insider /politicians via marketData

Three Discord slash commands powered by market-data orchestrator. Each
command takes a required ticker string and replies with an ephemeral
embed.

Registration : guild-scoped if SLASH_COMMAND_GUILD_ID is set (instant
propagation), global otherwise (~1h propagation).

Embed footer credits the data source(s) used (FMP, Yahoo, or mixed).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire up in `index.js` + document env var

**Files:**
- Modify: `index.js`
- Modify: `.env.example`

### Step 5.1: Add the requires near the top of `index.js`

Locate the existing require block near line 32 :

```js
const { createYahooClient } = require('./discord/market-commands');
```

Add the three new requires immediately below it :

```js
const { createFmpClient } = require('./discord/fmp-client');
const { createMarketData } = require('./discord/market-data');
const { createSlashCommands } = require('./discord/slash-commands');
```

### Step 5.2: Wire after the existing `sharedYahoo` declaration

Locate the existing line around 349 :

```js
const sharedYahoo = createYahooClient();
```

Immediately after it, add :

```js
// FMP REST client shared across slash commands. Reuses FMP_API_KEY.
// Created with no-op fetch if FMP_API_KEY is absent — handlers will
// fall back to Yahoo automatically.
const fmpKey = process.env.FMP_API_KEY || '';
const sharedFmp = fmpKey
  ? createFmpClient({ apiKey: fmpKey })
  : null;

// Market-data orchestrator with FMP-then-Yahoo fallback. Only wires the
// slash commands when both clients are available — if FMP_API_KEY is
// missing we skip registration entirely (the bot keeps working without
// the slash commands).
if (sharedFmp) {
  const sharedMarketData = createMarketData({
    fmpClient: sharedFmp,
    yahooClient: sharedYahoo,
  });
  const slashCommands = createSlashCommands({ marketData: sharedMarketData });
  slashCommands.wire(client);
} else {
  console.warn('[slash-commands] FMP_API_KEY missing — /analyze, /insider, /politicians not registered');
}
```

### Step 5.3: Document the new env var in `.env.example`

Open `.env.example` and append at the very bottom (after the last existing section) :

```env

# === SLASH COMMANDS ==================================================
# Channel ID Discord pour LIMITER l'enregistrement des slash commands
# (/analyze, /insider, /politicians) à un seul guild.
#
# Si défini : enregistrement guild-scoped → propagation INSTANTANÉE
# (utile en dev / test). Récupérer l'ID via clic droit sur le serveur
# Discord avec Developer Mode activé.
#
# Si vide : enregistrement GLOBAL → propagation ~1h, accessible
# dans tous les serveurs où le bot est invité. À utiliser en prod.
SLASH_COMMAND_GUILD_ID=
```

### Step 5.4: Smoke-check the require chain

```bash
node --check index.js
```

Expected : no output (success).

```bash
node -e "require('./discord/market-data'); require('./discord/slash-commands'); console.log('all load ok')"
```

Expected output : `all load ok`.

### Step 5.5: Commit Task 5

```bash
git add index.js .env.example
git commit -m "feat(index): wire FMP slash commands + document env var

Creates sharedFmp + sharedMarketData and wires slash commands via
slashCommands.wire(client). If FMP_API_KEY is missing, slash commands
are not registered (graceful degradation, bot still runs).

Documents SLASH_COMMAND_GUILD_ID in .env.example with usage guidance
(empty = global registration, set = guild-scoped instant propagation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

VERIFICATION ONLY — no code changes.

### Step 6.1: Run all 4 modified/new test suites

```bash
node --test discord/fmp-client.test.js discord/market-commands.test.js discord/market-data.test.js discord/slash-commands.test.js
```

Expected : ~14 (fmp-client) + ~existing+4 (market-commands) + 15 (market-data) + 7 (slash-commands) = all pass.

### Step 6.2: Run the full test suite for regression check

```bash
npm test 2>&1 | tail -25
```

Expected : only the 2 pre-existing failures (Windows EBUSY in llm-classify cleanup, missing ELEVENLABS_API_KEY in video). No new failures.

### Step 6.3: Module load smoke checks

```bash
node -e "require('./discord/fmp-client'); console.log('fmp-client ok')"
node -e "require('./discord/market-commands'); console.log('market-commands ok')"
node -e "require('./discord/market-data'); console.log('market-data ok')"
node -e "require('./discord/slash-commands'); console.log('slash-commands ok')"
node --check index.js
```

Expected : 4 `ok` prints + no output for `--check`.

### Step 6.4: Verify graceful degradation when FMP_API_KEY missing

```bash
node -e "process.env.FMP_API_KEY=''; const orig = console.warn; let warned=null; console.warn = (m) => warned = String(m); try { require('./index.js'); } catch(_) {} console.warn = orig; console.log(warned && warned.includes('FMP_API_KEY missing') ? 'graceful degradation OK' : 'expected warn missing');"
```

(This may print other errors because `index.js` tries to do more work — but the key check is that the `slash-commands` warning fires before any crash.)

### Step 6.5: Confirm git history

```bash
git log --oneline b2d2e1f..HEAD
```

Expected : 5 commits (1 per task — Task 1 + Task 2 + Task 3 + Task 4 + Task 5) on top of the spec commit `b2d2e1f`.

---

## Manual ops steps (post-merge)

**At merge** : no action required. If `FMP_API_KEY` is set on Railway, slash commands register globally on next deploy. Propagation up to ~1 hour.

**To test instantly during initial validation** :
1. Get your Discord guild ID (clic droit serveur → Copier l'identifiant, Developer Mode activé)
2. Set `SLASH_COMMAND_GUILD_ID=<id>` on Railway → redeploy
3. Slash commands appear in that guild within a few seconds
4. Try `/analyze AAPL` — verify ephemeral embed
5. Once validated, remove `SLASH_COMMAND_GUILD_ID` from Railway → next deploy registers globally

**If FMP endpoint differs from spec** : if any of the 6 FMP endpoint paths return 404, validate the actual path via the FMP dashboard (https://site.financialmodelingprep.com/developer/docs → API Documentation) and update `discord/fmp-client.js` accordingly. The orchestrator will fall back to Yahoo for the 5 methods that have an equivalent, so partial endpoint failures degrade gracefully.

**To monitor data source split** : embed footers show `Source: FMP` / `Source: YAHOO` / `Sources: FMP + YAHOO (mixed)`. If you see Yahoo more often than expected, check FMP quota at https://site.financialmodelingprep.com/developer/docs/dashboard?tab=general.
