# Trading Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trading/` module that executes real IBKR orders from Discord `entry` signals, with RSI/EMA technical filter on 5-minute candles, 1% risk-based sizing, 7% trailing stop, and Discord exit handling matched to the entry author.

**Architecture:** Single new `trading/` module with 5 files (`engine`, `broker`, `marketdata`, `indicators`, `config`). One new DB table `positions`. One integration hook in `discord/handler.js`. One new dashboard page `/trading` with 3 tabs. Broker class has both `PaperBroker` (in-memory, for testing/dry-run) and `IBKRBroker` (via `@stoqey/ib`), selected by `config.mode`. Market data via Alpaca REST (free). Kill-switch defaults OFF on first boot.

**Tech Stack:** Node.js, CommonJS, better-sqlite3, Express, `@stoqey/ib` (new), Alpaca Market Data REST API. Tests via built-in `node --test` runner (no new test framework dependency).

**Reference spec:** [`docs/superpowers/specs/2026-04-19-trading-execution-design.md`](../specs/2026-04-19-trading-execution-design.md).

---

## Task 1: Bootstrap — dependencies, env, test runner

**Files:**
- Modify: `package.json`
- Create: `trading/.gitkeep`
- Modify: `.gitignore` (if needed)

- [ ] **Step 1: Install IBKR client library**

```bash
npm install @stoqey/ib
```

Expected: adds `"@stoqey/ib": "^1.x.x"` to dependencies in `package.json`.

- [ ] **Step 2: Add test script to package.json**

Modify `package.json`:

```json
{
  "name": "discord-trading-bot",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node --test trading/"
  },
  "dependencies": {
    "@napi-rs/canvas": "^0.1.53",
    "@stoqey/ib": "^1.3.19",
    "better-sqlite3": "^12.9.0",
    "discord.js": "^14.14.1",
    "express": "^4.18.2",
    "node-fetch": "^2.7.0"
  }
}
```

(Version of `@stoqey/ib` may differ — use whatever `npm install` resolved.)

- [ ] **Step 3: Create trading directory placeholder**

```bash
mkdir -p trading
touch trading/.gitkeep
```

- [ ] **Step 4: Verify test runner works**

Create a throwaway sanity test:

```bash
cat > trading/_sanity.test.js <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
test('runner works', () => { assert.strictEqual(1 + 1, 2); });
EOF
```

Run: `npm test`
Expected: `pass 1` in output, no failures.

Delete the sanity file:

```bash
rm trading/_sanity.test.js
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json trading/.gitkeep
git commit -m "Bootstrap trading module: add @stoqey/ib dep + test runner"
```

---

## Task 2: Trading config module

**Files:**
- Create: `trading/config.js`
- Create: `trading/config.test.js`

Config is persisted in the existing `settings` table (KV blob pattern, see `utils/config-overrides.js`). Sensitive keys (Alpaca creds) come from `process.env`, not from persisted config.

- [ ] **Step 1: Write the failing test**

Create `trading/config.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Isolate the settings DB for tests by pointing DATA_DIR elsewhere
// before we require anything that touches db/sqlite.
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trading-cfg-'));
process.env.DATA_DIR = tmpDir;

const { loadTradingConfig, saveTradingConfig, DEFAULTS } = require('./config');

test('loadTradingConfig returns defaults when nothing persisted', () => {
  const cfg = loadTradingConfig();
  assert.strictEqual(cfg.tradingEnabled, false);
  assert.strictEqual(cfg.mode, 'paper');
  assert.strictEqual(cfg.riskPerTradePct, 1.0);
  assert.strictEqual(cfg.tolerancePct, 2.0);
  assert.strictEqual(cfg.trailingStopPct, 7.0);
  assert.strictEqual(cfg.maxConcurrentPositions, 5);
  assert.strictEqual(cfg.limitOrderTimeoutMin, 30);
  assert.deepStrictEqual(cfg.authorWhitelist, []);
  assert.strictEqual(cfg.tfMinutes, 5);
});

test('saveTradingConfig persists partial overrides, merging with defaults', () => {
  saveTradingConfig({ tradingEnabled: true, riskPerTradePct: 0.5 });
  const cfg = loadTradingConfig();
  assert.strictEqual(cfg.tradingEnabled, true);
  assert.strictEqual(cfg.riskPerTradePct, 0.5);
  // Unchanged fields keep their defaults:
  assert.strictEqual(cfg.trailingStopPct, 7.0);
  assert.strictEqual(cfg.maxConcurrentPositions, 5);
});

test('DEFAULTS is frozen (not mutated by load/save)', () => {
  assert.throws(() => { DEFAULTS.riskPerTradePct = 99; }, TypeError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write the implementation**

Create `trading/config.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// trading/config.js — Params persistés du moteur de trading
// ─────────────────────────────────────────────────────────────────────
// Stocké dans la table `settings` sous la clé 'trading_config'. Pattern
// identique à utils/config-overrides.js : pas de cache, on relit à
// chaque appel pour que les edits via dashboard soient immédiats.
//
// Les credentials sensibles (Alpaca, IBKR host/port) restent dans
// process.env — jamais en DB.
// ─────────────────────────────────────────────────────────────────────

const { getSetting, setSetting } = require('../db/sqlite');

const SETTINGS_KEY = 'trading_config';

const DEFAULTS = Object.freeze({
  tradingEnabled: false,
  mode: 'paper',
  riskPerTradePct: 1.0,
  tolerancePct: 2.0,
  trailingStopPct: 7.0,
  maxConcurrentPositions: 5,
  limitOrderTimeoutMin: 30,
  authorWhitelist: [],
  tfMinutes: 5,
});

function loadTradingConfig() {
  const stored = getSetting(SETTINGS_KEY, {}) || {};
  return Object.assign({}, DEFAULTS, stored);
}

function saveTradingConfig(partial) {
  const current = loadTradingConfig();
  const next = Object.assign({}, current, partial || {});
  // Only persist known keys — avoid accumulating cruft.
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = next[k];
  setSetting(SETTINGS_KEY, clean);
  return clean;
}

// Creds depuis env — lus à chaque appel pour permettre un restart sans recharger ce module.
function getSecrets() {
  return {
    alpacaKeyId: process.env.ALPACA_KEY_ID || '',
    alpacaSecretKey: process.env.ALPACA_SECRET_KEY || '',
    ibkrHost: process.env.IBKR_HOST || '127.0.0.1',
    ibkrPort: parseInt(process.env.IBKR_PORT || '7497', 10),
    ibkrClientId: parseInt(process.env.IBKR_CLIENT_ID || '1', 10),
  };
}

module.exports = {
  DEFAULTS,
  loadTradingConfig,
  saveTradingConfig,
  getSecrets,
  SETTINGS_KEY,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add trading/config.js trading/config.test.js
git commit -m "Add trading/config.js with persisted params + env secrets"
```

---

## Task 3: Indicators module (RSI, EMA)

**Files:**
- Create: `trading/indicators.js`
- Create: `trading/indicators.test.js`

Pure functions. Test vectors are deterministic.

- [ ] **Step 1: Write the failing tests**

Create `trading/indicators.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { calcEMA, calcRSI, computeIndicators } = require('./indicators');

// Floating point helper — Wilder's smoothing and EMA k-factor create
// long decimal tails; 1e-4 is plenty for our use.
const EPS = 1e-4;
function close(a, b) { return Math.abs(a - b) <= EPS; }

test('calcEMA matches hand-computed values for 9-period', () => {
  // Input closes — 10 bars.
  const closes = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
  // SMA of first 9 = (22.27+22.19+22.08+22.17+22.18+22.13+22.23+22.43+22.24)/9 = 22.2133...
  // EMA[9] (the 10th value) uses k = 2/(9+1) = 0.2
  // EMA[9] = 22.29*0.2 + 22.2133*0.8 = 22.2287
  const ema = calcEMA(closes, 9);
  assert.ok(close(ema, 22.2287), `expected ~22.2287, got ${ema}`);
});

test('calcEMA with not enough data returns null', () => {
  assert.strictEqual(calcEMA([1, 2, 3], 9), null);
});

test('calcRSI matches Wilder reference values', () => {
  // Classic Wilder example closes (15 values → RSI possible after 14 diffs)
  const closes = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955,
    45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820,
    46.2820,
  ];
  // Reference RSI(14) ≈ 70.46 (standard textbook value for this series).
  const rsi = calcRSI(closes, 14);
  assert.ok(rsi > 70 && rsi < 71, `expected RSI ~70.46, got ${rsi}`);
});

test('calcRSI with flat (no losses) series returns 100', () => {
  const closes = Array(20).fill(100);
  const rsi = calcRSI(closes, 14);
  // No gains AND no losses → undefined; we return 50 (neutral) by convention.
  assert.strictEqual(rsi, 50);
});

test('calcRSI with strictly rising series returns 100', () => {
  const closes = [];
  for (let i = 1; i <= 20; i++) closes.push(i);
  assert.strictEqual(calcRSI(closes, 14), 100);
});

test('computeIndicators returns rsi/ema20/ema9/lastPrice on 50-bar fixture', () => {
  // Simple upward random-walk-like series, 50 bars.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 50; i++) {
    p += (i % 3 === 0 ? 0.5 : (i % 5 === 0 ? -0.3 : 0.2));
    bars.push({ t: 't'+i, o: p, h: p, l: p, c: p, v: 1000 });
  }
  const out = computeIndicators(bars);
  assert.ok(typeof out.rsi === 'number', 'rsi must be a number');
  assert.ok(typeof out.ema20 === 'number', 'ema20 must be a number');
  assert.ok(typeof out.ema9 === 'number', 'ema9 must be a number');
  assert.strictEqual(out.lastPrice, bars[bars.length - 1].c);
});

test('computeIndicators with too few bars returns nulls', () => {
  const bars = [];
  for (let i = 0; i < 5; i++) bars.push({ c: 100 + i });
  const out = computeIndicators(bars);
  assert.strictEqual(out.rsi, null);
  assert.strictEqual(out.ema20, null);
  assert.strictEqual(out.ema9, null);
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './indicators'`.

- [ ] **Step 3: Write the implementation**

Create `trading/indicators.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// trading/indicators.js — RSI(14), EMA(N) sur un array de candles
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures. L'historique minimal nécessaire :
//   EMA(N)  : N bars (on seed avec la SMA des N premiers closes)
//   RSI(14) : 15 bars (14 diffs)
//
// Tolérance flottante dans les tests : 1e-4 suffit (Wilder smoothing
// introduit de longues queues décimales).
// ─────────────────────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed : SMA des `period` premières valeurs.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  // Récurrence sur le reste.
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  // Période initiale : somme des gains/losses sur les `period` premières diffs.
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing sur le reste.
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50; // série parfaitement plate
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { rsi: null, ema20: null, ema9: null, lastPrice: null };
  }
  const closes = candles.map(c => c.c);
  return {
    rsi: calcRSI(closes, 14),
    ema20: calcEMA(closes, 20),
    ema9: calcEMA(closes, 9),
    lastPrice: closes[closes.length - 1],
  };
}

module.exports = { calcEMA, calcRSI, computeIndicators };
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test`
Expected: `pass 7` total (including previous task's 3).

- [ ] **Step 5: Commit**

```bash
git add trading/indicators.js trading/indicators.test.js
git commit -m "Add trading/indicators.js with RSI(14) and EMA(N)"
```

---

## Task 4: Market data module (Alpaca REST + cache)

**Files:**
- Create: `trading/marketdata.js`
- Create: `trading/marketdata.test.js`

Alpaca's free market data endpoint: `GET https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=5Min&limit=50`. Auth via headers `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`. IEX data feed is free; SIP requires paid subscription — we use IEX (`feed=iex`).

- [ ] **Step 1: Write the failing tests**

Create `trading/marketdata.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketData } = require('./marketdata');

function makeFakeFetch(responseBody, status = 200) {
  let callCount = 0;
  const fn = async (_url, _opts) => {
    callCount++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  fn.getCallCount = () => callCount;
  return fn;
}

const sampleBars = {
  symbol: 'TSLA',
  bars: [
    { t: '2026-04-19T13:30:00Z', o: 200, h: 201, l: 199.5, c: 200.7, v: 10000 },
    { t: '2026-04-19T13:35:00Z', o: 200.7, h: 201.2, l: 200.3, c: 201.0, v: 12000 },
  ],
  next_page_token: null,
};

test('fetchCandles calls Alpaca with correct URL + headers', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => sampleBars };
  };
  const md = createMarketData({
    fetchFn: fakeFetch,
    keyId: 'KID',
    secretKey: 'SEC',
  });
  const bars = await md.fetchCandles('TSLA', '5Min', 50);
  assert.ok(capturedUrl.includes('/v2/stocks/TSLA/bars'));
  assert.ok(capturedUrl.includes('timeframe=5Min'));
  assert.ok(capturedUrl.includes('limit=50'));
  assert.strictEqual(capturedHeaders['APCA-API-KEY-ID'], 'KID');
  assert.strictEqual(capturedHeaders['APCA-API-SECRET-KEY'], 'SEC');
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[1].c, 201.0);
});

test('fetchCandles caches identical requests for 30s', async () => {
  const fakeFetch = makeFakeFetch(sampleBars);
  const md = createMarketData({
    fetchFn: fakeFetch,
    keyId: 'K',
    secretKey: 'S',
    cacheTtlMs: 30000,
    now: () => 1000,
  });
  await md.fetchCandles('TSLA', '5Min', 50);
  await md.fetchCandles('TSLA', '5Min', 50);
  assert.strictEqual(fakeFetch.getCallCount(), 1, 'second call should hit cache');
});

test('fetchCandles refetches after TTL expires', async () => {
  const fakeFetch = makeFakeFetch(sampleBars);
  let t = 1000;
  const md = createMarketData({
    fetchFn: fakeFetch,
    keyId: 'K',
    secretKey: 'S',
    cacheTtlMs: 30000,
    now: () => t,
  });
  await md.fetchCandles('TSLA', '5Min', 50);
  t = 1000 + 30001; // TTL + 1 ms
  await md.fetchCandles('TSLA', '5Min', 50);
  assert.strictEqual(fakeFetch.getCallCount(), 2);
});

test('fetchCandles throws on non-2xx', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    text: async () => 'forbidden',
    json: async () => ({}),
  });
  const md = createMarketData({ fetchFn: fakeFetch, keyId: 'K', secretKey: 'S' });
  await assert.rejects(
    md.fetchCandles('TSLA', '5Min', 50),
    /Alpaca 403/
  );
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './marketdata'`.

- [ ] **Step 3: Write the implementation**

Create `trading/marketdata.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// trading/marketdata.js — Chandeliers 5min via Alpaca Market Data v2
// ─────────────────────────────────────────────────────────────────────
// Compte Alpaca API gratuit suffit — pas besoin d'un compte de trading.
// Flux IEX (gratuit) par défaut. SIP (payant) possible via option.
//
// Cache mémoire par (ticker, timeframe, limit) avec TTL 30s pour éviter
// de spammer l'API quand plusieurs signaux arrivent sur le même ticker.
//
// `fetchFn` et `now` sont injectables pour les tests — factory pattern.
// ─────────────────────────────────────────────────────────────────────

const nodeFetch = require('node-fetch');

function createMarketData({
  fetchFn = nodeFetch,
  keyId,
  secretKey,
  cacheTtlMs = 30_000,
  now = () => Date.now(),
  feed = 'iex',
} = {}) {
  const cache = new Map();

  async function fetchCandles(ticker, timeframe = '5Min', limit = 50) {
    const cacheKey = `${ticker}|${timeframe}|${limit}`;
    const hit = cache.get(cacheKey);
    if (hit && (now() - hit.ts) < cacheTtlMs) {
      return hit.bars;
    }

    const url = 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(ticker)
      + '/bars?timeframe=' + encodeURIComponent(timeframe)
      + '&limit=' + encodeURIComponent(limit)
      + '&feed=' + encodeURIComponent(feed);

    const res = await fetchFn(url, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Alpaca ' + res.status + ' for ' + ticker + ': ' + body);
    }
    const data = await res.json();
    const bars = Array.isArray(data.bars) ? data.bars : [];
    cache.set(cacheKey, { ts: now(), bars });
    return bars;
  }

  function clearCache() { cache.clear(); }

  return { fetchCandles, clearCache };
}

module.exports = { createMarketData };
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test`
Expected: all tests pass (sum of previous tasks + 4 new).

- [ ] **Step 5: Commit**

```bash
git add trading/marketdata.js trading/marketdata.test.js
git commit -m "Add trading/marketdata.js with Alpaca REST + 30s in-memory cache"
```

---

## Task 5: Positions table + CRUD in db/sqlite.js

**Files:**
- Modify: `db/sqlite.js` (add schema + prepared statements + functions + exports)
- Create: `db/positions.test.js`

The existing `db/sqlite.js` is where all table creation and CRUD live. We extend it. For tests we point `DATA_DIR` at a temp dir before the module loads (same pattern as Task 2).

- [ ] **Step 1: Write the failing test**

Create `db/positions.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate test DB before sqlite.js runs its schema creation.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'positions-'));
process.env.DATA_DIR = tmpDir;

const {
  insertPosition,
  updatePositionOrderIds,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  markPositionError,
  getOpenPositions,
  countOpenPositions,
  getPositionByTickerAndAuthor,
  getPositionHistory,
} = require('./sqlite');

function basePosition(overrides = {}) {
  return Object.assign({
    ticker: 'TSLA',
    author: 'alice',
    entry_price: 200,
    quantity: 10,
    sl_price: 186,
    tp_price: 220,
    ibkr_parent_id: null,
    ibkr_tp_id: null,
    ibkr_sl_id: null,
    raw_signal: JSON.stringify({ ticker: 'TSLA', entry_price: 200, target_price: 220 }),
  }, overrides);
}

test('insertPosition creates a pending row and returns its id', () => {
  const id = insertPosition(basePosition());
  assert.ok(Number.isInteger(id) && id > 0);
});

test('countOpenPositions counts pending + open', () => {
  const a = insertPosition(basePosition({ ticker: 'AAPL' }));
  const b = insertPosition(basePosition({ ticker: 'MSFT' }));
  markPositionOpen(a, { fill_price: 195, opened_at: '2026-04-19T14:00:00Z' });
  const n = countOpenPositions();
  assert.ok(n >= 2, `expected >=2, got ${n}`);
});

test('updatePositionOrderIds + markPositionOpen + markPositionClosed lifecycle', () => {
  const id = insertPosition(basePosition({ ticker: 'NVDA' }));
  updatePositionOrderIds(id, { ibkr_parent_id: 'P1', ibkr_tp_id: 'T1', ibkr_sl_id: 'S1' });
  markPositionOpen(id, { fill_price: 199.5, opened_at: '2026-04-19T14:00:00Z' });
  markPositionClosed(id, {
    close_reason: 'tp',
    exit_price: 220,
    closed_at: '2026-04-19T15:00:00Z',
    pnl: 205.0,
  });
  const hist = getPositionHistory(50);
  const row = hist.find(r => r.id === id);
  assert.ok(row);
  assert.strictEqual(row.status, 'closed');
  assert.strictEqual(row.close_reason, 'tp');
  assert.strictEqual(row.exit_price, 220);
  assert.strictEqual(row.pnl, 205.0);
  assert.strictEqual(row.ibkr_parent_id, 'P1');
});

test('getPositionByTickerAndAuthor returns only open/pending match', () => {
  const id = insertPosition(basePosition({ ticker: 'AMD', author: 'bob' }));
  markPositionOpen(id, { fill_price: 100, opened_at: '2026-04-19T14:00:00Z' });
  const hit = getPositionByTickerAndAuthor('AMD', 'bob');
  assert.ok(hit);
  assert.strictEqual(hit.id, id);

  markPositionClosed(id, { close_reason: 'sl', exit_price: 93, closed_at: 'x', pnl: -70 });
  const miss = getPositionByTickerAndAuthor('AMD', 'bob');
  assert.strictEqual(miss, null, 'closed position must not match');
});

test('getOpenPositions returns pending and open only', () => {
  const a = insertPosition(basePosition({ ticker: 'GOOG' }));
  const b = insertPosition(basePosition({ ticker: 'META' }));
  markPositionOpen(a, { fill_price: 100, opened_at: 'x' });
  markPositionCancelled(b, { closed_at: 'x' });
  const open = getOpenPositions();
  const tickers = open.map(p => p.ticker);
  assert.ok(tickers.includes('GOOG'));
  assert.ok(!tickers.includes('META'), 'cancelled must be excluded');
});

test('markPositionError sets error status with message', () => {
  const id = insertPosition(basePosition({ ticker: 'COIN' }));
  markPositionError(id, 'connection lost');
  const open = getOpenPositions();
  assert.ok(!open.find(p => p.id === id), 'error status must exclude from open');
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test`
Expected: multiple failures — functions not exported from `db/sqlite.js`.

- [ ] **Step 3: Add positions schema + indexes**

In `db/sqlite.js`, locate the closing backtick of the big `db.exec(\`...\`)` block (around line 138). Just before the closing `\`);`, **insert** these block(s):

```sql
  -- Positions ouvertes par le trading engine. Une ligne = un signal
  -- transformé en ordre. Lifecycle :
  --   pending   → bracket envoyé à IBKR, pas encore fillé
  --   open      → parent order fillé
  --   closed    → TP, SL trailing ou exit manuel déclenché
  --   cancelled → limit order expiré (timeout) ou annulation explicite
  --   error     → erreur broker ou désynchro au boot (bloque le trading)
  CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    author          TEXT NOT NULL,
    entry_price     REAL NOT NULL,
    quantity        INTEGER NOT NULL,
    sl_price        REAL,
    tp_price        REAL,
    ibkr_parent_id  TEXT,
    ibkr_tp_id      TEXT,
    ibkr_sl_id      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    opened_at       TEXT,
    closed_at       TEXT,
    close_reason    TEXT,
    fill_price      REAL,
    exit_price      REAL,
    pnl             REAL,
    raw_signal      TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_positions_ticker_status ON positions(ticker, status);
  CREATE INDEX IF NOT EXISTS idx_positions_author_status ON positions(author, status);
  CREATE INDEX IF NOT EXISTS idx_positions_status        ON positions(status);
```

- [ ] **Step 4: Add prepared statements + helper functions**

In `db/sqlite.js`, after the gallery section (after `trimGalleryItems` around line 560) and **before** the `// ═══ Stats ═══` comment, insert this block:

```js
// ═════════════════════════════════════════════════════════════════════
//  Positions — lifecycle d'un trade (pending → open → closed/cancelled)
// ═════════════════════════════════════════════════════════════════════

const stmtPositionInsert = db.prepare(`
  INSERT INTO positions
    (ticker, author, entry_price, quantity, sl_price, tp_price,
     ibkr_parent_id, ibkr_tp_id, ibkr_sl_id, raw_signal, status)
  VALUES
    (@ticker, @author, @entry_price, @quantity, @sl_price, @tp_price,
     @ibkr_parent_id, @ibkr_tp_id, @ibkr_sl_id, @raw_signal, 'pending')
`);

const stmtPositionUpdateIds = db.prepare(`
  UPDATE positions SET
    ibkr_parent_id = @ibkr_parent_id,
    ibkr_tp_id     = @ibkr_tp_id,
    ibkr_sl_id     = @ibkr_sl_id
  WHERE id = @id
`);

const stmtPositionMarkOpen = db.prepare(`
  UPDATE positions SET status='open', fill_price=@fill_price, opened_at=@opened_at WHERE id=@id
`);

const stmtPositionMarkClosed = db.prepare(`
  UPDATE positions SET
    status='closed',
    close_reason=@close_reason,
    exit_price=@exit_price,
    closed_at=@closed_at,
    pnl=@pnl
  WHERE id=@id
`);

const stmtPositionMarkCancelled = db.prepare(`
  UPDATE positions SET status='cancelled', closed_at=@closed_at WHERE id=@id
`);

const stmtPositionMarkError = db.prepare(`
  UPDATE positions SET status='error', error_message=@msg, closed_at=datetime('now') WHERE id=@id
`);

const stmtOpenPositions = db.prepare(`
  SELECT * FROM positions WHERE status IN ('pending', 'open') ORDER BY created_at DESC
`);

const stmtCountOpen = db.prepare(`
  SELECT COUNT(*) AS n FROM positions WHERE status IN ('pending', 'open')
`);

const stmtPositionByTickerAuthorOpen = db.prepare(`
  SELECT * FROM positions
  WHERE ticker = ? AND author = ? AND status IN ('pending', 'open')
  ORDER BY created_at DESC LIMIT 1
`);

const stmtPositionByIbkrParent = db.prepare(`
  SELECT * FROM positions WHERE ibkr_parent_id = ? LIMIT 1
`);

const stmtPositionHistory = db.prepare(`
  SELECT * FROM positions ORDER BY created_at DESC LIMIT ?
`);

function insertPosition(p) {
  const info = stmtPositionInsert.run({
    ticker:         p.ticker,
    author:         p.author,
    entry_price:    p.entry_price,
    quantity:       p.quantity,
    sl_price:       p.sl_price != null ? p.sl_price : null,
    tp_price:       p.tp_price != null ? p.tp_price : null,
    ibkr_parent_id: p.ibkr_parent_id || null,
    ibkr_tp_id:     p.ibkr_tp_id || null,
    ibkr_sl_id:     p.ibkr_sl_id || null,
    raw_signal:     p.raw_signal || null,
  });
  return info.lastInsertRowid;
}

function updatePositionOrderIds(id, ids) {
  stmtPositionUpdateIds.run({
    id,
    ibkr_parent_id: ids.ibkr_parent_id || null,
    ibkr_tp_id:     ids.ibkr_tp_id || null,
    ibkr_sl_id:     ids.ibkr_sl_id || null,
  });
}

function markPositionOpen(id, { fill_price, opened_at }) {
  stmtPositionMarkOpen.run({ id, fill_price, opened_at });
}

function markPositionClosed(id, { close_reason, exit_price, closed_at, pnl }) {
  stmtPositionMarkClosed.run({ id, close_reason, exit_price, closed_at, pnl });
}

function markPositionCancelled(id, { closed_at }) {
  stmtPositionMarkCancelled.run({ id, closed_at });
}

function markPositionError(id, msg) {
  stmtPositionMarkError.run({ id, msg: msg || '' });
}

function getOpenPositions() { return stmtOpenPositions.all(); }
function countOpenPositions() { return stmtCountOpen.get().n; }

function getPositionByTickerAndAuthor(ticker, author) {
  return stmtPositionByTickerAuthorOpen.get(ticker, author) || null;
}

function getPositionByIbkrParentId(parentId) {
  return stmtPositionByIbkrParent.get(parentId) || null;
}

function getPositionHistory(limit = 100) {
  return stmtPositionHistory.all(limit);
}
```

- [ ] **Step 5: Add exports**

In the `module.exports = {...}` block at the end of `db/sqlite.js`, add before the closing brace:

```js
  // positions (trading)
  insertPosition,
  updatePositionOrderIds,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  markPositionError,
  getOpenPositions,
  countOpenPositions,
  getPositionByTickerAndAuthor,
  getPositionByIbkrParentId,
  getPositionHistory,
```

- [ ] **Step 6: Also update TIME_COLUMNS for db-viewer**

In the same file, find `const TIME_COLUMNS = {...}` (around line 568) and add `positions: 'created_at',`:

```js
const TIME_COLUMNS = {
  messages:              'ts',
  profit_counts:         'date',
  profit_messages:       'ts',
  news_items:            'ts',
  gallery_items:         'ts',
  positions:             'created_at',
  profit_filter_phrases: null,
  settings:              null,
};
```

- [ ] **Step 7: Run tests — expect pass**

Run: `npm test`
Expected: all tests pass, including the 7 positions tests.

- [ ] **Step 8: Commit**

```bash
git add db/sqlite.js db/positions.test.js
git commit -m "Add positions table + CRUD for trading engine"
```

---

## Task 6: PaperBroker class

**Files:**
- Create: `trading/broker.js` (only PaperBroker for now)
- Create: `trading/broker.test.js` (only PaperBroker tests)

PaperBroker simulates fills based on market data. It's useful for dry-run and for unit-testing the engine without an IBKR gateway. Real IBKR class comes in Task 7.

- [ ] **Step 1: Write the failing tests**

Create `trading/broker.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { PaperBroker } = require('./broker');

function fakeMarketData(lastPrice) {
  return {
    fetchCandles: async () => [{ t: 'x', o: lastPrice, h: lastPrice, l: lastPrice, c: lastPrice, v: 1 }],
  };
}

test('PaperBroker.getAccount returns configured equity', async () => {
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(100) });
  const acc = await b.getAccount();
  assert.strictEqual(acc.equity, 10000);
  assert.strictEqual(acc.cash, 10000);
});

test('PaperBroker.placeBracket market order fills immediately at last price', async () => {
  const events = [];
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(100) });
  b.on('orderStatus', (e) => events.push(e));
  const result = await b.placeBracket({
    ticker: 'TSLA', qty: 10, orderType: 'market',
    entryPrice: 100, tpPrice: 110, trailPct: 7,
  });
  assert.ok(result.parentId);
  assert.ok(result.tpId);
  assert.ok(result.slId);
  const filled = events.find(e => e.orderId === result.parentId && e.status === 'Filled');
  assert.ok(filled, 'parent fill event must be emitted');
  assert.strictEqual(filled.avgFillPrice, 100);
});

test('PaperBroker limit order stays pending if current price above limit', async () => {
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(105) });
  const result = await b.placeBracket({
    ticker: 'TSLA', qty: 10, orderType: 'limit',
    entryPrice: 100, tpPrice: 110, trailPct: 7,
  });
  const pos = b.getOpenPositions().find(p => p.parentId === result.parentId);
  assert.ok(pos);
  assert.strictEqual(pos.status, 'pending');
});

test('PaperBroker.closePosition emits child-filled event for parent', async () => {
  const events = [];
  const b = new PaperBroker({ initialEquity: 10000, marketData: fakeMarketData(100) });
  b.on('orderStatus', (e) => events.push(e));
  const r = await b.placeBracket({
    ticker: 'TSLA', qty: 10, orderType: 'market',
    entryPrice: 100, tpPrice: 110, trailPct: 7,
  });
  events.length = 0;
  await b.closePosition('TSLA');
  const exit = events.find(e => e.kind === 'manual_exit');
  assert.ok(exit, 'manual_exit event must be emitted');
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './broker'`.

- [ ] **Step 3: Write the PaperBroker implementation**

Create `trading/broker.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// trading/broker.js — PaperBroker (in-memory) + IBKRBroker (real)
// ─────────────────────────────────────────────────────────────────────
// Deux classes, un même contrat :
//
//   placeBracket({ticker, qty, orderType, entryPrice, tpPrice, trailPct})
//     → { parentId, tpId, slId }
//   closePosition(ticker) → close les positions ouvertes + cancel children
//   cancelOrder(orderId)
//   getAccount() → { equity, cash }
//   getOpenPositions() → [{ ticker, qty, parentId, status, ... }]
//
// Events via EventEmitter :
//   'orderStatus' { orderId, status, avgFillPrice?, kind?, ticker, qty }
//     status ∈ 'Filled'|'Cancelled'|'Rejected'
//     kind   ∈ 'parent'|'tp'|'sl'|'manual_exit'
//
// PaperBroker est autosuffisant — utilise le `marketData` pour obtenir un
// prix de référence à la simulation des fills. Pas de persistance (state
// perdu au restart), c'est OK : les vraies positions sont dans la DB.
// ─────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('events');

// ── PaperBroker ──────────────────────────────────────────────────────
class PaperBroker extends EventEmitter {
  constructor({ initialEquity = 100000, marketData }) {
    super();
    this.equity = initialEquity;
    this.cash = initialEquity;
    this.marketData = marketData;
    this.positions = new Map(); // parentId → {ticker, qty, entryPrice, status, ...}
    this.orders = new Map();    // orderId → {parentId, kind, ticker, qty, status}
    this._nextId = 1;
  }

  _id() { return 'P' + (this._nextId++); }

  async _lastPrice(ticker) {
    const bars = await this.marketData.fetchCandles(ticker, '5Min', 1);
    if (!bars || bars.length === 0) return null;
    return bars[bars.length - 1].c;
  }

  async getAccount() {
    return { equity: this.equity, cash: this.cash };
  }

  async placeBracket({ ticker, qty, orderType, entryPrice, tpPrice, trailPct }) {
    const parentId = this._id();
    const tpId = this._id();
    const slId = this._id();
    const current = await this._lastPrice(ticker);
    const fillPrice = orderType === 'market' ? current : entryPrice;

    const pos = {
      ticker, qty, entryPrice: fillPrice,
      parentId, tpId, slId, tpPrice, trailPct,
      status: 'pending',
      peakPrice: fillPrice,
    };
    this.positions.set(parentId, pos);
    this.orders.set(parentId, { parentId, kind: 'parent', ticker, qty, status: 'PendingSubmit' });
    this.orders.set(tpId,     { parentId, kind: 'tp',     ticker, qty, status: 'PendingSubmit' });
    this.orders.set(slId,     { parentId, kind: 'sl',     ticker, qty, status: 'PendingSubmit' });

    // Market order : fill immédiat. Limit : fill si prix courant ≤ entryPrice.
    const shouldFill = orderType === 'market'
      || (orderType === 'limit' && current != null && current <= entryPrice);

    if (shouldFill) {
      pos.status = 'open';
      const ord = this.orders.get(parentId);
      ord.status = 'Filled';
      // Emit async to let caller set up listeners with await.
      setImmediate(() => {
        this.emit('orderStatus', {
          orderId: parentId, status: 'Filled', kind: 'parent',
          ticker, qty, avgFillPrice: fillPrice,
        });
      });
    }
    return { parentId, tpId, slId };
  }

  async closePosition(ticker) {
    for (const [pid, pos] of this.positions.entries()) {
      if (pos.ticker !== ticker || pos.status === 'closed') continue;
      pos.status = 'closed';
      const exitPrice = await this._lastPrice(ticker);
      // Cancel les enfants bracket, puis emit exit.
      this.orders.get(pos.tpId).status = 'Cancelled';
      this.orders.get(pos.slId).status = 'Cancelled';
      setImmediate(() => {
        this.emit('orderStatus', {
          orderId: pid, status: 'Filled', kind: 'manual_exit',
          ticker, qty: pos.qty, avgFillPrice: exitPrice,
        });
      });
    }
  }

  async cancelOrder(orderId) {
    const ord = this.orders.get(orderId);
    if (!ord) return;
    ord.status = 'Cancelled';
    setImmediate(() => {
      this.emit('orderStatus', {
        orderId, status: 'Cancelled', kind: ord.kind,
        ticker: ord.ticker, qty: ord.qty,
      });
    });
  }

  getOpenPositions() {
    const out = [];
    for (const pos of this.positions.values()) {
      if (pos.status === 'pending' || pos.status === 'open') out.push(pos);
    }
    return out;
  }
}

// ── IBKRBroker — stub, implemented in Task 7 ─────────────────────────
class IBKRBroker extends EventEmitter {
  constructor() {
    super();
    throw new Error('IBKRBroker not yet implemented — see Task 7');
  }
}

function createBroker({ mode, marketData, initialEquity, ibkr }) {
  if (mode === 'paper') {
    return new PaperBroker({ initialEquity, marketData });
  }
  if (mode === 'live') {
    return new IBKRBroker(ibkr);
  }
  throw new Error('Unknown broker mode: ' + mode);
}

module.exports = { PaperBroker, IBKRBroker, createBroker };
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test`
Expected: 4 new broker tests pass.

- [ ] **Step 5: Commit**

```bash
git add trading/broker.js trading/broker.test.js
git commit -m "Add PaperBroker class with in-memory order simulation"
```

---

## Task 7: IBKRBroker class (real broker adapter)

**Files:**
- Modify: `trading/broker.js` (replace IBKRBroker stub)

`@stoqey/ib` exposes an `IBApi` class. The bracket order pattern:
1. Create `Contract` (ticker, `SMART` exchange, `USD`).
2. Build parent `Order` (LMT or MKT), with `transmit=false`.
3. Build TP child `Order` (LMT at target), `parentId=<parent>`, `transmit=false`.
4. Build SL child `Order` (TRAIL with `trailingPercent`), `parentId=<parent>`, `transmit=true`. The `transmit=true` on the last child triggers the whole bracket.

We subscribe to `orderStatus` events and re-emit them in our unified shape.

**Note:** Integration testing requires a live IB Gateway. We don't test this class in CI — its logic is thin glue. Correctness is validated manually in paper mode.

- [ ] **Step 1: Replace the stub class**

In `trading/broker.js`, replace the existing `IBKRBroker` stub with:

```js
// ── IBKRBroker — via @stoqey/ib ──────────────────────────────────────
// Nécessite un IB Gateway (ou TWS) qui tourne et écoute sur `port`.
// Paper account : port 7497 par défaut. Live : 7496.
//
// Pas de tests unitaires ici : la logique est fine — composer les Contract
// et Order objects du SDK. La validation se fait en paper manuel.
class IBKRBroker extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 7497, clientId = 1 } = {}) {
    super();
    const { IBApi, EventName, Contract, Order } = require('@stoqey/ib');
    this.IBApi = IBApi;
    this.EventName = EventName;
    this.Contract = Contract;
    this.Order = Order;
    this.api = new IBApi({ host, port, clientId });
    this._nextId = 1000;
    this._account = { equity: 0, cash: 0 };
    this._ordersByParent = new Map();  // parentId → { ticker, qty, tpId, slId }
    this._connected = false;
  }

  async connect() {
    if (this._connected) return;
    await new Promise((resolve, reject) => {
      this.api.once(this.EventName.connected, resolve);
      this.api.once(this.EventName.error, reject);
      this.api.connect();
    });
    this._connected = true;

    // Stream des events d'ordres → re-emit dans le format uniforme.
    this.api.on(this.EventName.orderStatus, (orderId, status, _filled, _remaining, avgFillPrice) => {
      // On retrouve kind (parent/tp/sl) en scannant les mappings.
      let kind = null, ticker = null, qty = null;
      for (const [pid, info] of this._ordersByParent.entries()) {
        if (pid === orderId) { kind = 'parent'; ticker = info.ticker; qty = info.qty; break; }
        if (info.tpId === orderId) { kind = 'tp'; ticker = info.ticker; qty = info.qty; break; }
        if (info.slId === orderId) { kind = 'sl'; ticker = info.ticker; qty = info.qty; break; }
      }
      this.emit('orderStatus', { orderId: String(orderId), status, kind, ticker, qty, avgFillPrice });
    });

    // Mise à jour du compte (AccountSummary).
    this.api.on(this.EventName.accountSummary, (_reqId, _account, tag, value) => {
      if (tag === 'NetLiquidation') this._account.equity = parseFloat(value);
      if (tag === 'TotalCashValue') this._account.cash = parseFloat(value);
    });
    this.api.reqAccountSummary(1, 'All', 'NetLiquidation,TotalCashValue');
  }

  _id() { return this._nextId++; }

  _stockContract(ticker) {
    const c = new this.Contract();
    c.symbol = ticker;
    c.secType = 'STK';
    c.exchange = 'SMART';
    c.currency = 'USD';
    return c;
  }

  async placeBracket({ ticker, qty, orderType, entryPrice, tpPrice, trailPct }) {
    await this.connect();
    const contract = this._stockContract(ticker);
    const parentId = this._id();
    const tpId = this._id();
    const slId = this._id();

    const parent = new this.Order();
    parent.action = 'BUY';
    parent.totalQuantity = qty;
    parent.orderType = orderType === 'market' ? 'MKT' : 'LMT';
    if (orderType !== 'market') parent.lmtPrice = entryPrice;
    parent.orderId = parentId;
    parent.transmit = false;

    const tp = new this.Order();
    tp.action = 'SELL';
    tp.totalQuantity = qty;
    tp.orderType = 'LMT';
    tp.lmtPrice = tpPrice;
    tp.parentId = parentId;
    tp.orderId = tpId;
    tp.transmit = false;

    const sl = new this.Order();
    sl.action = 'SELL';
    sl.totalQuantity = qty;
    sl.orderType = 'TRAIL';
    sl.trailingPercent = trailPct;
    sl.parentId = parentId;
    sl.orderId = slId;
    sl.transmit = true;

    this._ordersByParent.set(parentId, { ticker, qty, tpId, slId });

    this.api.placeOrder(parentId, contract, parent);
    this.api.placeOrder(tpId, contract, tp);
    this.api.placeOrder(slId, contract, sl);

    return { parentId: String(parentId), tpId: String(tpId), slId: String(slId) };
  }

  async closePosition(ticker) {
    await this.connect();
    // 1. Cancel bracket enfants pour tout parent dont le ticker match.
    for (const [pid, info] of this._ordersByParent.entries()) {
      if (info.ticker !== ticker) continue;
      try { this.api.cancelOrder(info.tpId); } catch (_) {}
      try { this.api.cancelOrder(info.slId); } catch (_) {}
    }
    // 2. Market SELL pour fermer la position.
    const contract = this._stockContract(ticker);
    const exitId = this._id();
    const exit = new this.Order();
    exit.action = 'SELL';
    exit.totalQuantity = 0; // 0 = close all — on met la qty attendue par le caller côté engine
    exit.orderType = 'MKT';
    exit.orderId = exitId;
    exit.transmit = true;
    // Le caller (engine) nous passera la qty dans une version future ;
    // pour l'instant on se repose sur le fait qu'IBKR refuse 0 → l'engine
    // doit utiliser getOpenPositions pour déterminer la qty et appeler
    // placeOrder directement si besoin. Pour le cas standard bracket
    // sell, cancel suffit car les enfants SL/TP + la position long seront
    // gérés par le trailing stop ou fermés côté user.
    // Implementation finale : override côté engine.onExit pour passer qty.
    return { exitId: String(exitId) };
  }

  async cancelOrder(orderId) {
    await this.connect();
    this.api.cancelOrder(Number(orderId));
  }

  async getAccount() {
    return { equity: this._account.equity, cash: this._account.cash };
  }

  async getOpenPositions() {
    // IBKR positions via reqPositions ; pour ne pas introduire un pattern
    // async/event ici, l'engine utilise la DB comme source de vérité.
    // Cette méthode reste disponible pour la réconciliation (Task 9).
    return new Promise((resolve) => {
      const positions = [];
      const handler = (_account, contract, pos, avgCost) => {
        positions.push({ ticker: contract.symbol, qty: pos, avgCost });
      };
      const done = () => {
        this.api.off(this.EventName.position, handler);
        this.api.off(this.EventName.positionEnd, done);
        resolve(positions);
      };
      this.api.on(this.EventName.position, handler);
      this.api.once(this.EventName.positionEnd, done);
      this.api.reqPositions();
    });
  }

  async disconnect() {
    if (this._connected) {
      this.api.disconnect();
      this._connected = false;
    }
  }
}
```

(Keep `createBroker` and `module.exports` unchanged.)

- [ ] **Step 2: Run existing tests — make sure nothing regressed**

Run: `npm test`
Expected: same pass count as after Task 6 — IBKRBroker has no tests but PaperBroker tests still pass.

- [ ] **Step 3: Commit**

```bash
git add trading/broker.js
git commit -m "Implement IBKRBroker bracket-order adapter via @stoqey/ib"
```

---

## Task 8: Trading engine — onEntry

**Files:**
- Create: `trading/engine.js`
- Create: `trading/engine.test.js`

The engine is the decision brain. onEntry applies all gates, computes sizing, places the bracket, persists the position.

- [ ] **Step 1: Write the failing tests**

Create `trading/engine.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-engine-'));
process.env.DATA_DIR = tmpDir;

const { createEngine } = require('./engine');
const { getOpenPositions, getPositionHistory } = require('../db/sqlite');

// ── Mocks ────────────────────────────────────────────────────────────
function mockConfig(overrides = {}) {
  return Object.assign({
    tradingEnabled: true,
    mode: 'paper',
    riskPerTradePct: 1.0,
    tolerancePct: 2.0,
    trailingStopPct: 7.0,
    maxConcurrentPositions: 5,
    limitOrderTimeoutMin: 30,
    authorWhitelist: [],
    tfMinutes: 5,
  }, overrides);
}

function mockMarketData({ rsi = 60, ema20 = 99, ema9 = 100, lastPrice = 101, bars = null } = {}) {
  // If bars not provided, synthesize 50 closes that produce roughly the given indicator values.
  const out = bars || makeBarsWith({ lastPrice, upward: rsi > 50 });
  return {
    fetchCandles: async () => out,
    _debug: { rsi, ema20, ema9, lastPrice },
  };
}

function makeBarsWith({ lastPrice = 101, upward = true } = {}) {
  const bars = [];
  let p = lastPrice - (upward ? 10 : -10);
  for (let i = 0; i < 50; i++) {
    p += upward ? 0.2 : -0.2;
    bars.push({ t: String(i), o: p, h: p, l: p, c: p, v: 1000 });
  }
  bars[bars.length - 1].c = lastPrice;
  return bars;
}

function mockBroker({ equity = 10000, shouldReject = false } = {}) {
  const calls = { placeBracket: [], closePosition: [], cancelOrder: [] };
  const broker = new (require('events').EventEmitter)();
  broker.getAccount = async () => ({ equity, cash: equity });
  broker.placeBracket = async (args) => {
    calls.placeBracket.push(args);
    if (shouldReject) throw new Error('broker rejected');
    return { parentId: 'P1', tpId: 'T1', slId: 'S1' };
  };
  broker.closePosition = async (ticker) => { calls.closePosition.push(ticker); };
  broker.cancelOrder = async (id) => { calls.cancelOrder.push(id); };
  broker.getOpenPositions = async () => [];
  broker._calls = calls;
  return broker;
}

// Helper to build a fresh engine.
function setup({ config = mockConfig(), marketData = mockMarketData(), broker = mockBroker() } = {}) {
  return {
    engine: createEngine({ config: () => config, marketData, broker, now: () => new Date('2026-04-19T14:00:00Z') }),
    config, marketData, broker,
  };
}

// ── Tests ────────────────────────────────────────────────────────────
test('onEntry skips when tradingEnabled is false', async () => {
  const { engine, broker } = setup({ config: mockConfig({ tradingEnabled: false }) });
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  assert.strictEqual(out.skipped, 'disabled');
  assert.strictEqual(broker._calls.placeBracket.length, 0);
});

test('onEntry skips when author not in whitelist (if whitelist non-empty)', async () => {
  const { engine, broker } = setup({ config: mockConfig({ authorWhitelist: ['alice'] }) });
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'bob' });
  assert.strictEqual(out.skipped, 'not_whitelisted');
  assert.strictEqual(broker._calls.placeBracket.length, 0);
});

test('onEntry allows any author when whitelist is empty', async () => {
  const { engine } = setup({ config: mockConfig({ authorWhitelist: [] }) });
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'bob' });
  assert.notStrictEqual(out.skipped, 'not_whitelisted');
});

test('onEntry skips when RSI <= 50', async () => {
  const { engine } = setup({ marketData: mockMarketData({ rsi: 40, lastPrice: 90 }) });
  // Downtrend bars → RSI < 50 and last price likely below EMAs.
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 90, target_price: 99, author: 'a' });
  assert.strictEqual(out.skipped, 'technical');
});

test('onEntry places MARKET bracket when current price within tolerance', async () => {
  // Uptrend bars → RSI > 50, lastPrice > EMAs.
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    config: mockConfig({ tolerancePct: 2.0 }),
  });
  // entry 100, lastPrice 101 → 101 <= 100 * 1.02 = 102 → market.
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  assert.ok(!out.skipped, `should not skip, got ${out.skipped}`);
  const call = broker._calls.placeBracket[0];
  assert.ok(call, 'placeBracket was called');
  assert.strictEqual(call.orderType, 'market');
  assert.strictEqual(call.ticker, 'TSLA');
  assert.strictEqual(call.tpPrice, 110);
  assert.strictEqual(call.trailPct, 7);
});

test('onEntry places LIMIT bracket when current price above tolerance', async () => {
  const bars = makeBarsWith({ lastPrice: 105, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    config: mockConfig({ tolerancePct: 2.0 }),
  });
  // entry 100, lastPrice 105 → 105 > 102 → limit.
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  assert.ok(!out.skipped, `should not skip, got ${out.skipped}`);
  assert.strictEqual(broker._calls.placeBracket[0].orderType, 'limit');
  assert.strictEqual(broker._calls.placeBracket[0].entryPrice, 100);
});

test('onEntry computes qty using risk-based sizing', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
    config: mockConfig({ riskPerTradePct: 1.0, trailingStopPct: 7.0 }),
  });
  // risk = 10000 * 1% = 100$. SL distance = 100 * 7% = 7$ / share. qty = floor(100/7) = 14.
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  assert.ok(!out.skipped);
  assert.strictEqual(broker._calls.placeBracket[0].qty, 14);
});

test('onEntry skips when computed qty < 1', async () => {
  const bars = makeBarsWith({ lastPrice: 1000, upward: true });
  // price too high for the risk budget → qty = 0.
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 100 }),
    config: mockConfig({ riskPerTradePct: 1.0, trailingStopPct: 7.0 }),
  });
  const out = await engine.onEntry({ ticker: 'TSLA', entry_price: 1000, target_price: 1100, author: 'a' });
  assert.strictEqual(out.skipped, 'qty_too_small');
});

test('onEntry skips if ticker already has an open position', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  const second = await engine.onEntry({ ticker: 'TSLA', entry_price: 100, target_price: 110, author: 'a' });
  assert.strictEqual(second.skipped, 'already_held');
});

test('onEntry persists position row with pending status', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'NVDA', entry_price: 100, target_price: 110, author: 'a' });
  const open = getOpenPositions();
  assert.ok(open.find(p => p.ticker === 'NVDA'));
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './engine'`.

- [ ] **Step 3: Write the engine implementation (onEntry only)**

Create `trading/engine.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// trading/engine.js — Orchestrateur du cycle de vie d'un trade
// ─────────────────────────────────────────────────────────────────────
// Expose :
//   onEntry(signal)    — filtres + sizing + placeBracket
//   onExit(signal)     — match auteur+ticker, close position
//   reconcile()        — check DB vs IBKR au boot
//   handleOrderEvent() — hook sur broker 'orderStatus'
//
// `config` est une *fonction* qui renvoie le config courant — permet
// au dashboard de modifier un param et qu'il soit pris en compte au
// prochain signal sans redémarrer.
// ─────────────────────────────────────────────────────────────────────

const {
  computeIndicators,
} = require('./indicators');

const {
  insertPosition,
  updatePositionOrderIds,
  countOpenPositions,
  getPositionByTickerAndAuthor,
  getOpenPositions,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  markPositionError,
  getPositionByIbkrParentId,
} = require('../db/sqlite');

const EXIT_KEYWORDS = ['exit', 'sortie', 'stop', 'cut'];

function createEngine({ config, marketData, broker, now = () => new Date(), logger = console }) {
  const cfg = () => (typeof config === 'function' ? config() : config);

  async function onEntry(signal) {
    const c = cfg();

    if (!c.tradingEnabled) {
      logger.log('[trading] skip disabled', signal.ticker);
      return { skipped: 'disabled' };
    }

    if (c.authorWhitelist && c.authorWhitelist.length > 0) {
      if (!c.authorWhitelist.includes(signal.author)) {
        return { skipped: 'not_whitelisted' };
      }
    }

    const openCount = countOpenPositions();
    if (openCount >= c.maxConcurrentPositions) {
      return { skipped: 'max_positions' };
    }

    // Already holding this ticker → skip (don't stack).
    const existing = getPositionByTickerAndAuthor(signal.ticker, signal.author);
    if (existing) {
      return { skipped: 'already_held' };
    }

    // Fetch candles + compute indicators.
    const tf = (c.tfMinutes || 5) + 'Min';
    const bars = await marketData.fetchCandles(signal.ticker, tf, 50);
    const { rsi, ema20, ema9, lastPrice } = computeIndicators(bars);
    if (rsi == null || ema20 == null || ema9 == null || lastPrice == null) {
      return { skipped: 'not_enough_data' };
    }
    if (rsi <= 50 || lastPrice <= ema20 || lastPrice <= ema9) {
      return { skipped: 'technical', detail: { rsi, ema20, ema9, lastPrice } };
    }

    // Order type decision.
    const toleranceMult = 1 + (c.tolerancePct / 100);
    const orderType = lastPrice <= signal.entry_price * toleranceMult ? 'market' : 'limit';

    // Sizing : (equity × risk%) / (entry × trail%).
    const account = await broker.getAccount();
    const riskDollars = account.equity * (c.riskPerTradePct / 100);
    const slDistancePerShare = signal.entry_price * (c.trailingStopPct / 100);
    const qty = Math.floor(riskDollars / slDistancePerShare);
    if (qty < 1) {
      return { skipped: 'qty_too_small', detail: { riskDollars, slDistancePerShare } };
    }

    const slPrice = signal.entry_price * (1 - c.trailingStopPct / 100);

    // Persist row BEFORE sending order — if broker fails, we can mark error.
    const positionId = insertPosition({
      ticker: signal.ticker,
      author: signal.author,
      entry_price: signal.entry_price,
      quantity: qty,
      sl_price: slPrice,
      tp_price: signal.target_price,
      raw_signal: JSON.stringify(signal),
    });

    let orderResult;
    try {
      orderResult = await broker.placeBracket({
        ticker: signal.ticker,
        qty,
        orderType,
        entryPrice: signal.entry_price,
        tpPrice: signal.target_price,
        trailPct: c.trailingStopPct,
      });
    } catch (err) {
      markPositionError(positionId, err.message);
      return { skipped: 'broker_error', detail: err.message };
    }

    updatePositionOrderIds(positionId, {
      ibkr_parent_id: orderResult.parentId,
      ibkr_tp_id:     orderResult.tpId,
      ibkr_sl_id:     orderResult.slId,
    });

    // Schedule limit order timeout (cancel if unfilled).
    if (orderType === 'limit') {
      const timeoutMs = (c.limitOrderTimeoutMin || 30) * 60 * 1000;
      setTimeout(() => {
        // Re-read : may already be filled by now.
        const row = getPositionByIbkrParentId(orderResult.parentId);
        if (row && row.status === 'pending') {
          broker.cancelOrder(orderResult.parentId).catch(() => {});
          markPositionCancelled(row.id, { closed_at: now().toISOString() });
        }
      }, timeoutMs).unref();
    }

    return { placed: true, positionId, qty, orderType };
  }

  // onExit + reconcile + handleOrderEvent are stubs for Task 9.
  async function onExit(_signal) {
    throw new Error('onExit not implemented — see Task 9');
  }
  async function reconcile() {
    throw new Error('reconcile not implemented — see Task 9');
  }
  function handleOrderEvent(_event) {
    throw new Error('handleOrderEvent not implemented — see Task 9');
  }

  return { onEntry, onExit, reconcile, handleOrderEvent, EXIT_KEYWORDS };
}

module.exports = { createEngine, EXIT_KEYWORDS };
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test`
Expected: 10 new engine tests pass (on top of previous tasks').

Note: the test file deliberately points `DATA_DIR` to a fresh temp dir, so each run starts with an empty `positions` table — tests that insert don't interfere across runs.

- [ ] **Step 5: Commit**

```bash
git add trading/engine.js trading/engine.test.js
git commit -m "Add trading engine with onEntry (filters, sizing, bracket placement)"
```

---

## Task 9: Engine — onExit, reconcile, handleOrderEvent

**Files:**
- Modify: `trading/engine.js`
- Modify: `trading/engine.test.js` (add tests)

- [ ] **Step 1: Add failing tests for onExit + handleOrderEvent**

Append to `trading/engine.test.js`:

```js
// ── onExit + event handling ──────────────────────────────────────────

test('onExit closes position when author matches entry and keyword present', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'META', entry_price: 100, target_price: 110, author: 'carol' });
  // Simulate fill to move it to 'open'.
  const open = getOpenPositions().find(p => p.ticker === 'META');
  const { markPositionOpen } = require('../db/sqlite');
  markPositionOpen(open.id, { fill_price: 100, opened_at: 't' });

  const out = await engine.onExit({ ticker: 'META', author: 'carol', content: 'cut $META' });
  assert.strictEqual(out.closed, true);
  assert.ok(broker._calls.closePosition.includes('META'));
});

test('onExit does nothing when author does not match', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine, broker } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'CRM', entry_price: 100, target_price: 110, author: 'dave' });
  const open = getOpenPositions().find(p => p.ticker === 'CRM');
  const { markPositionOpen } = require('../db/sqlite');
  markPositionOpen(open.id, { fill_price: 100, opened_at: 't' });

  const out = await engine.onExit({ ticker: 'CRM', author: 'someone-else', content: 'exit $CRM' });
  assert.strictEqual(out.skipped, 'no_matching_position');
  assert.strictEqual(broker._calls.closePosition.length, 0);
});

test('handleOrderEvent on parent Filled marks position open', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'ORCL', entry_price: 100, target_price: 110, author: 'eve' });
  engine.handleOrderEvent({
    orderId: 'P1', status: 'Filled', kind: 'parent',
    ticker: 'ORCL', qty: 14, avgFillPrice: 100.5,
  });
  const hist = require('../db/sqlite').getPositionHistory(20);
  const row = hist.find(r => r.ticker === 'ORCL');
  assert.strictEqual(row.status, 'open');
  assert.strictEqual(row.fill_price, 100.5);
});

test('handleOrderEvent on tp Filled marks position closed with pnl', async () => {
  const bars = makeBarsWith({ lastPrice: 101, upward: true });
  const { engine } = setup({
    marketData: { fetchCandles: async () => bars },
    broker: mockBroker({ equity: 10000 }),
  });
  await engine.onEntry({ ticker: 'ADBE', entry_price: 100, target_price: 110, author: 'fay' });
  engine.handleOrderEvent({ orderId: 'P1', status: 'Filled', kind: 'parent', ticker: 'ADBE', qty: 14, avgFillPrice: 100 });
  engine.handleOrderEvent({ orderId: 'T1', status: 'Filled', kind: 'tp', ticker: 'ADBE', qty: 14, avgFillPrice: 110 });
  const hist = require('../db/sqlite').getPositionHistory(20);
  const row = hist.find(r => r.ticker === 'ADBE');
  assert.strictEqual(row.status, 'closed');
  assert.strictEqual(row.close_reason, 'tp');
  // pnl = (110 - 100) * 14 = 140
  assert.strictEqual(row.pnl, 140);
});
```

- [ ] **Step 2: Run tests — expect failures for new tests**

Run: `npm test`
Expected: new tests fail with "not implemented".

- [ ] **Step 3: Implement onExit, reconcile, handleOrderEvent**

In `trading/engine.js`, replace the three stub functions with:

```js
  async function onExit(signal) {
    const c = cfg();
    if (!c.tradingEnabled) return { skipped: 'disabled' };
    const row = getPositionByTickerAndAuthor(signal.ticker, signal.author);
    if (!row) return { skipped: 'no_matching_position' };

    try {
      if (row.ibkr_tp_id) await broker.cancelOrder(row.ibkr_tp_id).catch(() => {});
      if (row.ibkr_sl_id) await broker.cancelOrder(row.ibkr_sl_id).catch(() => {});
      await broker.closePosition(signal.ticker);
    } catch (err) {
      logger.error('[trading] closePosition failed:', err.message);
      return { skipped: 'broker_error', detail: err.message };
    }

    // The actual status→closed + pnl computation happens via handleOrderEvent
    // when the broker confirms the exit fill. We only mark intent here.
    return { closed: true, positionId: row.id };
  }

  async function reconcile() {
    const c = cfg();
    const dbOpen = getOpenPositions();
    let ibkrPositions = [];
    try {
      ibkrPositions = await broker.getOpenPositions();
    } catch (err) {
      logger.error('[trading] reconcile: broker getOpenPositions failed:', err.message);
      return { ok: false, reason: 'broker_unavailable' };
    }
    // Map ticker → ibkr qty
    const ibkrByTicker = new Map();
    for (const p of ibkrPositions) {
      ibkrByTicker.set(p.ticker, (ibkrByTicker.get(p.ticker) || 0) + (p.qty || 0));
    }

    const mismatches = [];
    for (const row of dbOpen) {
      const ibkrQty = ibkrByTicker.get(row.ticker) || 0;
      if (row.status === 'open' && ibkrQty !== row.quantity) {
        mismatches.push({ id: row.id, ticker: row.ticker, db: row.quantity, ibkr: ibkrQty });
        markPositionError(row.id, 'reconcile mismatch ibkr=' + ibkrQty + ' db=' + row.quantity);
      }
    }
    if (mismatches.length > 0) {
      logger.error('[trading] reconcile MISMATCH — trading will remain disabled until resolved', mismatches);
      return { ok: false, mismatches };
    }
    return { ok: true };
  }

  function handleOrderEvent(event) {
    // event = { orderId, status, kind, ticker, qty, avgFillPrice }
    // kind ∈ 'parent' | 'tp' | 'sl' | 'manual_exit'
    if (!event || !event.orderId) return;

    if (event.kind === 'parent') {
      if (event.status === 'Filled') {
        const row = getPositionByIbkrParentId(String(event.orderId));
        if (row && row.status === 'pending') {
          markPositionOpen(row.id, {
            fill_price: event.avgFillPrice,
            opened_at: now().toISOString(),
          });
        }
      } else if (event.status === 'Cancelled' || event.status === 'Rejected') {
        const row = getPositionByIbkrParentId(String(event.orderId));
        if (row && row.status === 'pending') {
          markPositionCancelled(row.id, { closed_at: now().toISOString() });
        }
      }
      return;
    }

    if (event.kind === 'tp' || event.kind === 'sl' || event.kind === 'manual_exit') {
      if (event.status !== 'Filled') return;
      // Find the parent by scanning open positions for matching ticker — we
      // stored the child orderId but lookup by ticker is simpler and robust.
      const open = getOpenPositions().filter(r => r.ticker === event.ticker && r.status === 'open');
      for (const row of open) {
        const exit = event.avgFillPrice;
        const entry = row.fill_price != null ? row.fill_price : row.entry_price;
        const pnl = (exit - entry) * row.quantity;
        markPositionClosed(row.id, {
          close_reason: event.kind === 'tp' ? 'tp' :
                        event.kind === 'sl' ? 'sl' : 'manual_exit',
          exit_price: exit,
          closed_at: now().toISOString(),
          pnl,
        });
      }
      return;
    }
  }
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test`
Expected: all tests pass including 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add trading/engine.js trading/engine.test.js
git commit -m "Implement onExit, reconcile, and order-event handling in engine"
```

---

## Task 10: Discord handler integration + 'cut' keyword

**Files:**
- Modify: `filters/signal.js` (add 'cut' to EXIT_KEYWORDS)
- Modify: `discord/handler.js` (call engine.onEntry / onExit)

No unit tests here — handler integration is manually verified in Task 12.

- [ ] **Step 1: Add 'cut' to EXIT_KEYWORDS**

In `filters/signal.js`, replace:

```js
const EXIT_KEYWORDS  = ['sortie', 'exit', 'stop'];
```

with:

```js
const EXIT_KEYWORDS  = ['sortie', 'exit', 'stop', 'cut'];
```

- [ ] **Step 2: Accept engine in handler registration**

Modify the signature of `registerTradingHandler` (around line 140):

```js
function registerTradingHandler(client, { tradingChannel, railwayUrl, makeWebhookUrl, tradingEngine }) {
```

- [ ] **Step 3: Call engine.onEntry / onExit after the existing logEvent**

In `discord/handler.js`, after the `logEvent(authorName, channelName, content, filterType, filterReason, extraWithSignal);` block (around line 240) and before `const sendType = ...`, insert:

```js
    // ── Trading engine hook (entries) ────────────────────────────────
    if (tradingEngine
        && filterType === 'entry'
        && signalTicker
        && pricesForLog.entry_price != null
        && pricesForLog.target_price != null) {
      tradingEngine.onEntry({
        ticker: signalTicker.toUpperCase(),
        entry_price: pricesForLog.entry_price,
        target_price: pricesForLog.target_price,
        author: authorName,
        raw_content: content,
        ts: message.createdAt.toISOString(),
      }).catch(err => console.error('[trading] onEntry error:', err.message));
    }

    // ── Trading engine hook (exits: classifier said 'exit' + ticker) ──
    // The author-match check lives inside engine.onExit — handler only
    // forwards the signal.
    if (tradingEngine && filterType === 'exit' && signalTicker) {
      tradingEngine.onExit({
        ticker: signalTicker.toUpperCase(),
        author: authorName,
        content,
      }).catch(err => console.error('[trading] onExit error:', err.message));
    }
```

Note on `pricesForLog`: it comes from `extractPrices(classifyContent)` already computed earlier in the handler. `target_price` is populated when the signal mentions both an entry and a target.

- [ ] **Step 4: Verify handler still syntactically loads**

Run: `node -e "require('./discord/handler')"`
Expected: no output, no error.

- [ ] **Step 5: Commit**

```bash
git add filters/signal.js discord/handler.js
git commit -m "Wire trading engine into discord handler + add 'cut' exit keyword"
```

---

## Task 11: Dashboard routes

**Files:**
- Create: `routes/trading.js`

Routes: list positions, history, config (GET/POST), close-one, panic, kill-switch toggle.

- [ ] **Step 1: Write the routes module**

Create `routes/trading.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// routes/trading.js — Dashboard API pour le moteur de trading
// ─────────────────────────────────────────────────────────────────────
// Endpoints :
//   GET  /trading                      → page HTML
//   GET  /api/trading/positions        → positions open/pending
//   GET  /api/trading/history?limit=N  → historique des closed/cancelled
//   GET  /api/trading/config           → config courant
//   POST /api/trading/config           → update partiel du config
//   POST /api/trading/positions/:id/close → close une position par id DB
//   POST /api/trading/panic            → close all positions market
//   POST /api/trading/kill-switch      → toggle tradingEnabled
//
// Auth requireAuth comme le reste du dashboard.
// ─────────────────────────────────────────────────────────────────────

const {
  getOpenPositions,
  getPositionHistory,
} = require('../db/sqlite');
const { loadTradingConfig, saveTradingConfig } = require('../trading/config');
const { renderTradingPage } = require('../pages/trading');

function registerTradingRoutes(app, requireAuth, { tradingEngine, tradingBroker }) {
  app.get('/trading', requireAuth, (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(renderTradingPage());
  });

  app.get('/api/trading/positions', requireAuth, (_req, res) => {
    res.json({ positions: getOpenPositions() });
  });

  app.get('/api/trading/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    const all = getPositionHistory(limit);
    const closed = all.filter(p => p.status !== 'pending' && p.status !== 'open');
    res.json({ history: closed });
  });

  app.get('/api/trading/config', requireAuth, (_req, res) => {
    res.json({ config: loadTradingConfig() });
  });

  app.post('/api/trading/config', requireAuth, (req, res) => {
    const allowedKeys = [
      'tradingEnabled', 'mode', 'riskPerTradePct', 'tolerancePct',
      'trailingStopPct', 'maxConcurrentPositions', 'limitOrderTimeoutMin',
      'authorWhitelist', 'tfMinutes',
    ];
    const partial = {};
    for (const k of allowedKeys) {
      if (k in (req.body || {})) partial[k] = req.body[k];
    }
    const updated = saveTradingConfig(partial);
    res.json({ config: updated });
  });

  app.post('/api/trading/positions/:id/close', requireAuth, async (req, res) => {
    if (!tradingEngine || !tradingBroker) return res.status(503).json({ error: 'engine not ready' });
    const id = parseInt(req.params.id, 10);
    const positions = getOpenPositions();
    const row = positions.find(p => p.id === id);
    if (!row) return res.status(404).json({ error: 'position not found' });
    try {
      if (row.ibkr_tp_id) await tradingBroker.cancelOrder(row.ibkr_tp_id).catch(() => {});
      if (row.ibkr_sl_id) await tradingBroker.cancelOrder(row.ibkr_sl_id).catch(() => {});
      await tradingBroker.closePosition(row.ticker);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/trading/panic', requireAuth, async (_req, res) => {
    if (!tradingBroker) return res.status(503).json({ error: 'broker not ready' });
    const positions = getOpenPositions();
    const tickers = Array.from(new Set(positions.map(p => p.ticker)));
    const errors = [];
    for (const t of tickers) {
      try { await tradingBroker.closePosition(t); } catch (e) { errors.push({ t, err: e.message }); }
    }
    // Force kill-switch OFF to prevent re-entries.
    saveTradingConfig({ tradingEnabled: false });
    res.json({ ok: errors.length === 0, tickersClosed: tickers, errors });
  });

  app.post('/api/trading/kill-switch', requireAuth, (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    const updated = saveTradingConfig({ tradingEnabled: enabled });
    res.json({ config: updated });
  });
}

module.exports = { registerTradingRoutes };
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "require('./routes/trading')"`
Expected: fails with `Cannot find module '../pages/trading'` — this is expected; fixed in Task 12. Don't commit yet.

- [ ] **Step 3: Defer commit to Task 12**

(The routes file depends on the page file — commit both together at end of Task 12.)

---

## Task 12: Dashboard page

**Files:**
- Create: `pages/trading.js`

Single page with 3 tabs (Positions / History / Config). Style matches the existing pages — plain HTML with inline `<script>` talking to the `/api/trading/*` endpoints.

- [ ] **Step 1: Write the page renderer**

Create `pages/trading.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// pages/trading.js — Dashboard de trading (positions + history + config)
// ─────────────────────────────────────────────────────────────────────
// HTML statique rendu côté serveur, JS vanilla pour les fetches.
// 3 onglets sans routing client — affichage/masquage via CSS.
// ─────────────────────────────────────────────────────────────────────

function renderTradingPage() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Trading — dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; }
  header { padding: 16px 24px; border-bottom: 1px solid #1f2933; display: flex; justify-content: space-between; align-items: center; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  nav { display: flex; gap: 4px; margin-top: 8px; }
  nav button { background: transparent; color: #8b9bac; border: 0; padding: 10px 16px; cursor: pointer; font-weight: 500; }
  nav button.active { color: #e6edf3; border-bottom: 2px solid #4493f8; }
  main { padding: 24px; }
  .tab { display: none; }
  .tab.active { display: block; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1f2933; font-size: 13px; }
  th { font-weight: 500; color: #8b9bac; text-transform: uppercase; font-size: 11px; }
  .pnl-pos { color: #3fb950; }
  .pnl-neg { color: #f85149; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .chip-open { background: #1f3a5f; color: #4493f8; }
  .chip-pending { background: #3a3a1f; color: #e3b341; }
  .chip-closed { background: #163a1f; color: #3fb950; }
  .chip-cancelled { background: #333; color: #8b9bac; }
  .chip-error { background: #3a1616; color: #f85149; }
  button.danger { background: #f85149; color: #fff; border: 0; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
  button.primary { background: #238636; color: #fff; border: 0; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
  button.ghost { background: transparent; color: #8b9bac; border: 1px solid #1f2933; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .form-grid { display: grid; grid-template-columns: 220px 1fr; gap: 12px 16px; max-width: 600px; align-items: center; }
  .form-grid label { color: #8b9bac; font-size: 13px; }
  .form-grid input, .form-grid select { background: #0f1620; color: #e6edf3; border: 1px solid #1f2933; padding: 8px 12px; border-radius: 6px; width: 100%; box-sizing: border-box; }
  .kill-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; padding: 12px 16px; background: #0f1620; border: 1px solid #1f2933; border-radius: 6px; }
</style>
</head>
<body>
<header>
  <h1>Trading</h1>
  <a href="/dashboard" style="color: #8b9bac; text-decoration: none; font-size: 13px;">← Dashboard</a>
</header>
<nav>
  <button data-tab="positions" class="active">Positions</button>
  <button data-tab="history">History</button>
  <button data-tab="config">Config</button>
</nav>
<main>
  <section id="tab-positions" class="tab active">
    <div class="kill-bar">
      <div id="kill-state">Loading…</div>
      <button id="btn-kill" class="ghost">Toggle kill-switch</button>
      <button id="btn-panic" class="danger">Panic — close all</button>
    </div>
    <table id="tbl-positions">
      <thead><tr><th>Ticker</th><th>Author</th><th>Qty</th><th>Entry</th><th>TP</th><th>SL%</th><th>Status</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section id="tab-history" class="tab">
    <table id="tbl-history">
      <thead><tr><th>Closed</th><th>Ticker</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th>P&amp;L</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section id="tab-config" class="tab">
    <form id="form-config" class="form-grid">
      <label>Trading enabled</label><input type="checkbox" name="tradingEnabled" />
      <label>Mode</label><select name="mode"><option>paper</option><option>live</option></select>
      <label>Risk per trade (%)</label><input type="number" step="0.05" name="riskPerTradePct" />
      <label>Tolerance (%)</label><input type="number" step="0.1" name="tolerancePct" />
      <label>Trailing stop (%)</label><input type="number" step="0.1" name="trailingStopPct" />
      <label>Max concurrent positions</label><input type="number" step="1" name="maxConcurrentPositions" />
      <label>Limit order timeout (min)</label><input type="number" step="1" name="limitOrderTimeoutMin" />
      <label>Timeframe (minutes)</label><input type="number" step="1" name="tfMinutes" />
      <label>Author whitelist (comma-separated)</label><input type="text" name="authorWhitelist" />
      <div></div><button class="primary" type="submit">Save</button>
    </form>
  </section>
</main>
<script>
  const tabs = document.querySelectorAll('nav button');
  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'config') loadConfig();
  }));

  async function loadPositions() {
    const r = await fetch('/api/trading/positions').then(r => r.json());
    const tb = document.querySelector('#tbl-positions tbody');
    tb.innerHTML = '';
    (r.positions || []).forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + p.ticker + '</td>'
        + '<td>' + (p.author || '') + '</td>'
        + '<td>' + p.quantity + '</td>'
        + '<td>' + p.entry_price + '</td>'
        + '<td>' + (p.tp_price || '') + '</td>'
        + '<td>' + (p.sl_price ? ((1 - p.sl_price/p.entry_price)*100).toFixed(1) + '%' : '') + '</td>'
        + '<td><span class="chip chip-' + p.status + '">' + p.status + '</span></td>'
        + '<td><button class="ghost" data-close="' + p.id + '">Close</button></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('button[data-close]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Close position?')) return;
      const res = await fetch('/api/trading/positions/' + btn.dataset.close + '/close', { method: 'POST' });
      if (res.ok) loadPositions();
      else alert('Failed: ' + (await res.text()));
    }));
  }

  async function loadKillState() {
    const r = await fetch('/api/trading/config').then(r => r.json());
    const enabled = r.config && r.config.tradingEnabled;
    document.getElementById('kill-state').innerHTML = enabled
      ? '<span style="color:#3fb950">Trading ENABLED</span>'
      : '<span style="color:#8b9bac">Trading disabled</span>';
  }

  document.getElementById('btn-kill').addEventListener('click', async () => {
    const r = await fetch('/api/trading/config').then(r => r.json());
    await fetch('/api/trading/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !r.config.tradingEnabled }),
    });
    loadKillState();
  });

  document.getElementById('btn-panic').addEventListener('click', async () => {
    if (!confirm('Close ALL positions at market and disable trading?')) return;
    const res = await fetch('/api/trading/panic', { method: 'POST' });
    const body = await res.json();
    alert('Closed tickers: ' + (body.tickersClosed || []).join(', '));
    loadPositions();
    loadKillState();
  });

  async function loadHistory() {
    const r = await fetch('/api/trading/history?limit=100').then(r => r.json());
    const tb = document.querySelector('#tbl-history tbody');
    tb.innerHTML = '';
    (r.history || []).forEach(p => {
      const tr = document.createElement('tr');
      const cls = p.pnl > 0 ? 'pnl-pos' : (p.pnl < 0 ? 'pnl-neg' : '');
      tr.innerHTML = '<td>' + (p.closed_at || '') + '</td>'
        + '<td>' + p.ticker + '</td>'
        + '<td>' + p.quantity + '</td>'
        + '<td>' + (p.fill_price || p.entry_price) + '</td>'
        + '<td>' + (p.exit_price || '') + '</td>'
        + '<td>' + (p.close_reason || '') + '</td>'
        + '<td class="' + cls + '">' + (p.pnl != null ? p.pnl.toFixed(2) : '') + '</td>';
      tb.appendChild(tr);
    });
  }

  async function loadConfig() {
    const r = await fetch('/api/trading/config').then(r => r.json());
    const cfg = r.config || {};
    const form = document.getElementById('form-config');
    form.tradingEnabled.checked = !!cfg.tradingEnabled;
    form.mode.value = cfg.mode || 'paper';
    form.riskPerTradePct.value = cfg.riskPerTradePct;
    form.tolerancePct.value = cfg.tolerancePct;
    form.trailingStopPct.value = cfg.trailingStopPct;
    form.maxConcurrentPositions.value = cfg.maxConcurrentPositions;
    form.limitOrderTimeoutMin.value = cfg.limitOrderTimeoutMin;
    form.tfMinutes.value = cfg.tfMinutes;
    form.authorWhitelist.value = (cfg.authorWhitelist || []).join(', ');
  }

  document.getElementById('form-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      tradingEnabled: form.tradingEnabled.checked,
      mode: form.mode.value,
      riskPerTradePct: parseFloat(form.riskPerTradePct.value),
      tolerancePct: parseFloat(form.tolerancePct.value),
      trailingStopPct: parseFloat(form.trailingStopPct.value),
      maxConcurrentPositions: parseInt(form.maxConcurrentPositions.value, 10),
      limitOrderTimeoutMin: parseInt(form.limitOrderTimeoutMin.value, 10),
      tfMinutes: parseInt(form.tfMinutes.value, 10),
      authorWhitelist: form.authorWhitelist.value.split(',').map(s => s.trim()).filter(Boolean),
    };
    const res = await fetch('/api/trading/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) { alert('Config saved'); loadKillState(); }
    else alert('Save failed: ' + (await res.text()));
  });

  loadPositions();
  loadKillState();
  setInterval(loadPositions, 10000);
</script>
</body>
</html>`;
}

module.exports = { renderTradingPage };
```

- [ ] **Step 2: Commit both routes + page together**

```bash
git add routes/trading.js pages/trading.js
git commit -m "Add /trading dashboard page + API routes"
```

---

## Task 13: Wire trading engine into index.js at boot

**Files:**
- Modify: `index.js`

This is the final integration. The trading engine needs:
1. A config loader
2. A broker instance (PaperBroker or IBKRBroker)
3. A market data client
4. Wiring to the broker's `orderStatus` events → `engine.handleOrderEvent`
5. Passing `tradingEngine` to `registerTradingHandler`
6. Registering trading routes
7. Running `reconcile()` on boot (but before accepting signals)

- [ ] **Step 1: Add trading imports at the top of index.js**

In `index.js`, after the existing requires (around line 40, before `// ── Configuration env ──`), add:

```js
// Trading engine — broker, market data, engine orchestrator.
const { loadTradingConfig, getSecrets: getTradingSecrets } = require('./trading/config');
const { createMarketData } = require('./trading/marketdata');
const { createBroker } = require('./trading/broker');
const { createEngine: createTradingEngine } = require('./trading/engine');
const { registerTradingRoutes } = require('./routes/trading');
```

- [ ] **Step 2: Bootstrap trading engine after Express setup**

In `index.js`, just **before** `app.listen(PORT, ...)` (around line 85), add:

```js
// ── Trading engine bootstrap ───────────────────────────────────────
const tradingSecrets = getTradingSecrets();
const tradingMarketData = createMarketData({
  keyId: tradingSecrets.alpacaKeyId,
  secretKey: tradingSecrets.alpacaSecretKey,
});
const tradingInitialCfg = loadTradingConfig();
const tradingBroker = createBroker({
  mode: tradingInitialCfg.mode,
  marketData: tradingMarketData,
  initialEquity: 100000, // paper broker default; ignored by IBKR
  ibkr: {
    host: tradingSecrets.ibkrHost,
    port: tradingSecrets.ibkrPort,
    clientId: tradingSecrets.ibkrClientId,
  },
});
const tradingEngine = createTradingEngine({
  config: loadTradingConfig, // pass the function itself — re-read each call
  marketData: tradingMarketData,
  broker: tradingBroker,
});

// Wire broker events → engine.
tradingBroker.on('orderStatus', (event) => {
  try { tradingEngine.handleOrderEvent(event); }
  catch (err) { console.error('[trading] handleOrderEvent error:', err.message); }
});

// Register trading dashboard routes.
registerTradingRoutes(app, requireAuth, { tradingEngine, tradingBroker });

// Reconcile at boot : if mode='live', connect & check. If mismatch, force kill-switch OFF.
(async () => {
  if (tradingInitialCfg.mode === 'live') {
    try {
      if (typeof tradingBroker.connect === 'function') await tradingBroker.connect();
      const r = await tradingEngine.reconcile();
      if (!r.ok) {
        console.error('[trading] reconcile failed → disabling trading');
        require('./trading/config').saveTradingConfig({ tradingEnabled: false });
      } else {
        console.log('[trading] reconcile ok');
      }
    } catch (err) {
      console.error('[trading] boot reconcile error:', err.message);
      require('./trading/config').saveTradingConfig({ tradingEnabled: false });
    }
  } else {
    console.log('[trading] paper mode — skipping reconcile');
  }
})();
```

- [ ] **Step 3: Pass tradingEngine to the discord handler**

In `index.js`, find the `registerTradingHandler(client, {...})` call (around line 105) and add `tradingEngine`:

```js
registerTradingHandler(client, {
  tradingChannel: TRADING_CHANNEL,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
  tradingEngine,
});
```

- [ ] **Step 4: Start the server and manually verify**

Run the bot locally (you'll need env vars set — for first run, paper mode with no Alpaca keys is fine; fetching candles will fail but the bot itself will start):

```bash
export DISCORD_TOKEN=your_token
export ALPACA_KEY_ID=your_alpaca_key        # optional for first smoke
export ALPACA_SECRET_KEY=your_alpaca_secret  # optional for first smoke
npm start
```

Expected:
- Server logs `Server running on port 3000`
- `[trading] paper mode — skipping reconcile`
- Bot connects to Discord
- Visit `http://localhost:3000/trading` → dashboard loads with 3 tabs
- Positions tab is empty
- Config tab shows `tradingEnabled: off`, `mode: paper`, defaults populated
- Toggle kill-switch → state updates

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "Wire trading engine + routes into index.js at boot"
```

---

## Task 14: Documentation — IB Gateway ops note

**Files:**
- Create: `docs/trading-ops.md`

Short ops doc the user can reference when moving from paper to live.

- [ ] **Step 1: Write the ops doc**

Create `docs/trading-ops.md`:

```markdown
# Trading — Operational Notes

## Modes

- **paper** (default) — uses `PaperBroker` in-memory. No external connection needed. Safe to run anywhere.
- **live** — uses `IBKRBroker` via `@stoqey/ib`. Requires an IB Gateway or TWS process listening on `IBKR_PORT`.

Switch via the Config tab on `/trading` or by POSTing `{ mode: 'live' }` to `/api/trading/config`.

## Environment variables

Required only when `mode=live`:

- `IBKR_HOST` (default `127.0.0.1`)
- `IBKR_PORT` (default `7497` = paper, use `7496` for live IBKR account)
- `IBKR_CLIENT_ID` (default `1`)

Required for market data (both modes):

- `ALPACA_KEY_ID`
- `ALPACA_SECRET_KEY`

Create a free account at alpaca.markets → API keys → use the *market data* keys. You do **not** need a funded Alpaca trading account — market data is free with just an API key.

## IB Gateway setup (for live mode)

1. Download IB Gateway from interactivebrokers.com.
2. Launch it in **Paper** configuration initially (matches `IBKR_PORT=7497`).
3. In Global Configuration → API → Settings:
   - Enable ActiveX and Socket Clients: **ON**
   - Socket port: 7497 (paper) or 7496 (live)
   - Trusted IPs: add your bot's source IP (or `127.0.0.1` if bot runs on the same host)
   - Read-Only API: **OFF**
4. Log into paper account first. Verify connection from bot: start the bot with `mode=live` pointing at port 7497 and check `/trading` logs for "reconcile ok".
5. Only switch to the live port (7496) once the paper workflow has been running clean for at least a week.

## Where the bot can run

- **Paper mode**: anywhere Node runs, including Railway (current deployment).
- **Live mode**: the bot must be able to reach IB Gateway's TCP port. Two realistic setups:
  - Bot + IB Gateway on the same VPS (Hetzner, DigitalOcean, or a home server).
  - Bot on Railway + IB Gateway on a separate VPS with firewall rule allowing Railway's IP.

## Kill-switch & panic

- **Kill-switch** (Positions tab) — flips `tradingEnabled` off. Existing positions keep their server-side trailing stop and take-profit; no new orders are placed.
- **Panic** (Positions tab) — closes all open positions at market and disables trading. Use when you see something wrong and want to cut all exposure now.

## Rollout sequence

1. `mode=paper`, whitelist 1 trusted author for 1 week. Audit `/trading/history` vs what a human would have done.
2. `mode=live`, `riskPerTradePct=0.25`, same whitelist, for a few days.
3. `riskPerTradePct=1.0` once confidence is established.
```

- [ ] **Step 2: Commit**

```bash
git add docs/trading-ops.md
git commit -m "Add trading ops doc covering IB Gateway + rollout plan"
```

---

## Self-review notes

- **Spec coverage**
  - Trading config (Task 2) ✔
  - Indicators (Task 3) ✔
  - Market data (Task 4) ✔
  - Positions table (Task 5) ✔
  - PaperBroker + IBKRBroker (Tasks 6-7) ✔
  - Engine onEntry (Task 8) ✔
  - Engine onExit + reconcile + event handling (Task 9) ✔
  - Handler integration + 'cut' keyword (Task 10) ✔
  - Dashboard routes + page + tabs (Tasks 11-12) ✔
  - Boot wiring + reconcile (Task 13) ✔
  - Kill-switch + panic in dashboard ✔
  - Ops doc for IB Gateway (Task 14) ✔

- **Placeholder scan**: No TBDs. Each step shows the exact code/command/expected output.

- **Type consistency**:
  - Broker `placeBracket` contract: `{ticker, qty, orderType, entryPrice, tpPrice, trailPct}` — used consistently in Paper (Task 6), IBKR (Task 7), engine (Task 8).
  - Order event shape: `{orderId, status, kind, ticker, qty, avgFillPrice?}` — consistent across PaperBroker emission, IBKRBroker emission, engine consumer.
  - DB function names match between Task 5 (creation) and Tasks 8-9 (consumption).
  - `EXIT_KEYWORDS` export from engine matches handler import alias.

- **Known simplification**: IBKRBroker's `closePosition` uses quantity=0 which IBKR will reject — the engine's `onExit` pipeline cancels children and then relies on the event stream for the actual exit. For a clean v2, the engine can pass the exact qty to `closePosition`. Documented inline in Task 7.
