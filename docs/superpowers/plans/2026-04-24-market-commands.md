# Market commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three Discord commands (`!price`, `!chart`, `!indicator`) backed by Yahoo Finance data.

**Architecture:** One new file `discord/market-commands.js` bundles a Yahoo client factory (cache TTL 30s, 10s timeout), range parsing, a PNG chart renderer using `@napi-rs/canvas`, and three `messageCreate` handlers. One-line registration in `index.js`.

**Tech Stack:** Node.js, `yahoo-finance2@^3.14.0` (already installed), `@napi-rs/canvas` (existing dep), `discord.js` (existing dep), `node:test` runner.

**Spec:** [docs/superpowers/specs/2026-04-24-market-commands-design.md](../specs/2026-04-24-market-commands-design.md)

---

## File Structure

- **Create**: `discord/market-commands.js` — main module (exports `registerMarketCommands` + internals for test)
- **Create**: `discord/market-commands.test.js` — unit tests for pure functions (`parseRange`, `formatMarketCap`, `createYahooClient`, `renderChartPng`)
- **Modify**: `index.js` — register the new commands alongside `registerDiscordCommands`

---

### Task 1: Bootstrap module + `parseRange`

**Files:**
- Create: `discord/market-commands.js`
- Create: `discord/market-commands.test.js`

`parseRange(arg, now)` returns `{ interval, period1 }` for a valid range (`1D/5D/1M/3M/6M/1Y`, case-insensitive), defaults to `1D` when `arg` is falsy, and returns `null` for invalid input. `now` is injected (`Date`) for deterministic tests.

- [ ] **Step 1: Write the failing tests**

Create `discord/market-commands.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseRange } = require('./market-commands');

const FIXED_NOW = new Date('2026-04-24T15:00:00Z');

test('parseRange defaults to 1D when arg is missing', () => {
  const r = parseRange(undefined, FIXED_NOW);
  assert.strictEqual(r.interval, '5m');
  const diffMs = FIXED_NOW - r.period1;
  assert.ok(diffMs >= 86_400_000 - 1000 && diffMs <= 86_400_000 + 1000, 'period1 should be ~1 day ago');
});

test('parseRange 5D uses 15m interval and 5-day period', () => {
  const r = parseRange('5D', FIXED_NOW);
  assert.strictEqual(r.interval, '15m');
  const diffDays = (FIXED_NOW - r.period1) / 86_400_000;
  assert.ok(diffDays >= 4.99 && diffDays <= 5.01);
});

test('parseRange is case-insensitive', () => {
  assert.ok(parseRange('1m', FIXED_NOW));
  assert.ok(parseRange('1M', FIXED_NOW));
});

test('parseRange returns null for invalid input', () => {
  assert.strictEqual(parseRange('42X', FIXED_NOW), null);
  assert.strictEqual(parseRange('10Y', FIXED_NOW), null);
});

test('parseRange covers 1M/3M/6M/1Y with 1d interval', () => {
  for (const r of ['1M', '3M', '6M', '1Y']) {
    const out = parseRange(r, FIXED_NOW);
    assert.strictEqual(out.interval, '1d', `${r} should use 1d interval`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- discord/market-commands.test.js`
Expected: FAIL with `Cannot find module './market-commands'`.

- [ ] **Step 3: Create market-commands.js with parseRange**

Create `discord/market-commands.js`:

```js
// ─────────────────────────────────────────────────────────────────────
// discord/market-commands.js — Commandes market (Yahoo Finance)
// ─────────────────────────────────────────────────────────────────────
// Commandes globales :
//   !price TICKER           → quote live (prix, change%, volume, ranges, market cap)
//   !chart TICKER [RANGE]   → image PNG du graphe (1D/5D/1M/3M/6M/1Y)
//   !indicator TICKER       → RSI(14) + EMA(9) + EMA(20) sur candles 5min du jour
//
// Source unique : Yahoo Finance via `yahoo-finance2`. Cache mémoire
// TTL 30s + timeout 10s sur chaque appel externe.
// ─────────────────────────────────────────────────────────────────────

const VALID_RANGES = {
  '1D': { interval: '5m',  ms: 86_400_000 },
  '5D': { interval: '15m', ms: 5 * 86_400_000 },
  '1M': { interval: '1d',  ms: 30 * 86_400_000 },
  '3M': { interval: '1d',  ms: 90 * 86_400_000 },
  '6M': { interval: '1d',  ms: 180 * 86_400_000 },
  '1Y': { interval: '1d',  ms: 365 * 86_400_000 },
};

function parseRange(arg, now = new Date()) {
  const key = arg ? String(arg).toUpperCase() : '1D';
  const cfg = VALID_RANGES[key];
  if (!cfg) return null;
  return {
    interval: cfg.interval,
    period1: new Date(now.getTime() - cfg.ms),
  };
}

module.exports = { parseRange };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- discord/market-commands.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add discord/market-commands.js discord/market-commands.test.js
git commit -m "Add parseRange helper for market-commands timeframe parsing"
```

---

### Task 2: `formatMarketCap` helper

**Files:**
- Modify: `discord/market-commands.js`
- Modify: `discord/market-commands.test.js`

Formats large integers (e.g. `2_720_000_000_000`) as readable strings (`$2.72T`, `$45.30B`, `$12.10M`, else raw dollars). Returns `'N/A'` for falsy input.

- [ ] **Step 1: Add the failing tests**

Append to `discord/market-commands.test.js`:

```js
const { formatMarketCap } = require('./market-commands');

test('formatMarketCap renders trillions with T suffix', () => {
  assert.strictEqual(formatMarketCap(2_720_000_000_000), '$2.72T');
});

test('formatMarketCap renders billions with B suffix', () => {
  assert.strictEqual(formatMarketCap(45_300_000_000), '$45.30B');
});

test('formatMarketCap renders millions with M suffix', () => {
  assert.strictEqual(formatMarketCap(12_100_000), '$12.10M');
});

test('formatMarketCap returns N/A for falsy input', () => {
  assert.strictEqual(formatMarketCap(null), 'N/A');
  assert.strictEqual(formatMarketCap(undefined), 'N/A');
  assert.strictEqual(formatMarketCap(0), 'N/A');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- discord/market-commands.test.js`
Expected: FAIL with `formatMarketCap is not a function`.

- [ ] **Step 3: Implement formatMarketCap**

Add to `discord/market-commands.js` (before the `module.exports` line):

```js
function formatMarketCap(n) {
  if (!n || typeof n !== 'number') return 'N/A';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2)  + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2)  + 'M';
  return '$' + n.toLocaleString('en-US');
}
```

Update exports:

```js
module.exports = { parseRange, formatMarketCap };
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- discord/market-commands.test.js`
Expected: 9 tests pass (5 previous + 4 new).

- [ ] **Step 5: Commit**

```bash
git add discord/market-commands.js discord/market-commands.test.js
git commit -m "Add formatMarketCap helper for human-readable market cap display"
```

---

### Task 3: `createYahooClient` with cache + timeout

**Files:**
- Modify: `discord/market-commands.js`
- Modify: `discord/market-commands.test.js`

Factory `createYahooClient({ yahoo, now, ttlMs, timeoutMs })` returns `{ getQuote(ticker), getChart(ticker, range) }`. Caches responses by key for `ttlMs` (default 30s). Wraps external calls with `timeoutMs` (default 10s). `yahoo` and `now` are injectable for tests.

- [ ] **Step 1: Add the failing tests**

Append to `discord/market-commands.test.js`:

```js
const { createYahooClient } = require('./market-commands');

function makeFakeYahoo({ quoteImpl, chartImpl } = {}) {
  const calls = { quote: 0, chart: 0 };
  return {
    calls,
    quote: async (t) => { calls.quote++; return quoteImpl ? quoteImpl(t) : { regularMarketPrice: 100 }; },
    chart: async (t, opts) => { calls.chart++; return chartImpl ? chartImpl(t, opts) : { quotes: [] }; },
  };
}

test('createYahooClient caches quote within TTL', async () => {
  const yahoo = makeFakeYahoo();
  let clock = 0;
  const client = createYahooClient({ yahoo, now: () => clock, ttlMs: 1000 });

  await client.getQuote('AAPL');
  clock = 500;
  await client.getQuote('AAPL');
  assert.strictEqual(yahoo.calls.quote, 1, 'second call within TTL should hit cache');

  clock = 1500;
  await client.getQuote('AAPL');
  assert.strictEqual(yahoo.calls.quote, 2, 'call after TTL should refetch');
});

test('createYahooClient cache key includes range for getChart', async () => {
  const yahoo = makeFakeYahoo();
  const client = createYahooClient({ yahoo, now: () => 0, ttlMs: 1000 });

  await client.getChart('AAPL', '1D');
  await client.getChart('AAPL', '5D');
  assert.strictEqual(yahoo.calls.chart, 2, 'different ranges should be cached separately');
});

test('createYahooClient getChart throws on invalid range', async () => {
  const yahoo = makeFakeYahoo();
  const client = createYahooClient({ yahoo, now: () => 0 });
  await assert.rejects(() => client.getChart('AAPL', '10Y'), /Invalid range/);
});

test('createYahooClient wraps calls with timeout', async () => {
  const yahoo = {
    quote: () => new Promise(() => {}), // never resolves
    chart: () => new Promise(() => {}),
  };
  const client = createYahooClient({ yahoo, now: () => 0, timeoutMs: 20 });
  await assert.rejects(() => client.getQuote('AAPL'), /timeout/i);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- discord/market-commands.test.js`
Expected: FAIL with `createYahooClient is not a function`.

- [ ] **Step 3: Implement createYahooClient**

Add to `discord/market-commands.js` (after `formatMarketCap`, before `module.exports`):

```js
function withTimeout(promise, ms) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error('yahoo timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

function createYahooClient({
  yahoo,
  now = () => Date.now(),
  ttlMs = 30_000,
  timeoutMs = 10_000,
} = {}) {
  if (!yahoo) {
    // Lazy require to keep the module loadable even if yahoo-finance2 is not installed
    // in some edge path (tests always inject their own fake).
    yahoo = require('yahoo-finance2').default;
  }

  const quoteCache = new Map();
  const chartCache = new Map();

  async function getQuote(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = quoteCache.get(key);
    if (hit && (now() - hit.ts) < ttlMs) return hit.data;
    const data = await withTimeout(yahoo.quote(key), timeoutMs);
    quoteCache.set(key, { ts: now(), data });
    return data;
  }

  async function getChart(ticker, range) {
    const parsed = parseRange(range, new Date(now()));
    if (!parsed) throw new Error('Invalid range: ' + range);
    const key = String(ticker).toUpperCase() + '|' + String(range || '1D').toUpperCase();
    const hit = chartCache.get(key);
    if (hit && (now() - hit.ts) < ttlMs) return hit.data;
    const data = await withTimeout(
      yahoo.chart(String(ticker).toUpperCase(), {
        interval: parsed.interval,
        period1: parsed.period1,
      }),
      timeoutMs,
    );
    chartCache.set(key, { ts: now(), data });
    return data;
  }

  return { getQuote, getChart };
}
```

Update exports:

```js
module.exports = { parseRange, formatMarketCap, createYahooClient };
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- discord/market-commands.test.js`
Expected: 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add discord/market-commands.js discord/market-commands.test.js
git commit -m "Add Yahoo client factory with cache and timeout"
```

---

### Task 4: `renderChartPng` PNG renderer

**Files:**
- Modify: `discord/market-commands.js`
- Modify: `discord/market-commands.test.js`

`renderChartPng(candles, ticker, range)` draws a simple close-price line chart on an 800×400 canvas, title at the top, green line for positive change / red for negative. Candles are expected in Yahoo's shape `{ date, close, ... }`. Returns a `Buffer` (PNG).

- [ ] **Step 1: Add the failing smoke test**

Append to `discord/market-commands.test.js`:

```js
const { renderChartPng } = require('./market-commands');

test('renderChartPng returns a non-empty PNG buffer', () => {
  const candles = [];
  for (let i = 0; i < 50; i++) {
    candles.push({ date: new Date(2026, 3, 24, 9, i * 6), close: 100 + Math.sin(i / 5) * 3 });
  }
  const buf = renderChartPng(candles, 'AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf), 'should return a Buffer');
  assert.ok(buf.length > 1000, 'PNG should be at least 1KB, got ' + buf.length);
  // PNG signature: 89 50 4E 47
  assert.strictEqual(buf[0], 0x89);
  assert.strictEqual(buf[1], 0x50);
  assert.strictEqual(buf[2], 0x4E);
  assert.strictEqual(buf[3], 0x47);
});

test('renderChartPng handles empty candles gracefully', () => {
  const buf = renderChartPng([], 'AAPL', '1D');
  assert.ok(Buffer.isBuffer(buf));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- discord/market-commands.test.js`
Expected: FAIL with `renderChartPng is not a function`.

- [ ] **Step 3: Implement renderChartPng**

Add to the top of `discord/market-commands.js` (after the header comment):

```js
const { createCanvas } = require('@napi-rs/canvas');
```

Add the function (after `createYahooClient`):

```js
function renderChartPng(candles, ticker, range) {
  const W = 800, H = 400, PAD = 50;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('$' + ticker + ' — ' + range, PAD, 30);

  const closes = (candles || []).map(c => c.close).filter(c => typeof c === 'number');
  if (closes.length < 2) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '16px sans-serif';
    ctx.fillText('Not enough data to render chart.', PAD, H / 2);
    return canvas.toBuffer('image/png');
  }

  const minC = Math.min(...closes);
  const maxC = Math.max(...closes);
  const chartW = W - 2 * PAD;
  const chartH = H - 2 * PAD - 20; // room for title
  const chartY0 = PAD + 20;
  const span = (maxC - minC) || 1;

  const x = (i) => PAD + (i / (closes.length - 1)) * chartW;
  const y = (v) => chartY0 + chartH - ((v - minC) / span) * chartH;

  // Subtle horizontal gridlines at min/mid/max
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  [minC, (minC + maxC) / 2, maxC].forEach(v => {
    ctx.beginPath();
    ctx.moveTo(PAD, y(v));
    ctx.lineTo(W - PAD, y(v));
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px sans-serif';
    ctx.fillText('$' + v.toFixed(2), 4, y(v) + 4);
  });

  // Price line (green if last >= first, else red)
  const rising = closes[closes.length - 1] >= closes[0];
  ctx.strokeStyle = rising ? '#2fc774' : '#f5515f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  closes.forEach((c, i) => {
    if (i === 0) ctx.moveTo(x(i), y(c));
    else ctx.lineTo(x(i), y(c));
  });
  ctx.stroke();

  return canvas.toBuffer('image/png');
}
```

Update exports:

```js
module.exports = { parseRange, formatMarketCap, createYahooClient, renderChartPng };
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- discord/market-commands.test.js`
Expected: 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add discord/market-commands.js discord/market-commands.test.js
git commit -m "Add renderChartPng for !chart command"
```

---

### Task 5: `!price` handler

**Files:**
- Modify: `discord/market-commands.js`

Adds `registerMarketCommands(client, { yahooClient } = {})`. Wires a `messageCreate` listener for `!price TICKER`. Defaults `yahooClient` to `createYahooClient()` for production. Handles: missing ticker, unknown ticker, Yahoo error, rate limit.

- [ ] **Step 1: Implement the handler**

Add at the bottom of `discord/market-commands.js` (before `module.exports`):

```js
function formatQuoteMessage(quote) {
  const price = quote.regularMarketPrice;
  const change = quote.regularMarketChangePercent;
  const up = change >= 0;
  const arrow = up ? '🟢' : '🔴';
  const sign = up ? '+' : '';
  const vol = (quote.regularMarketVolume || 0).toLocaleString('en-US');
  const dayLow = quote.regularMarketDayLow != null ? '$' + quote.regularMarketDayLow.toFixed(2) : 'N/A';
  const dayHigh = quote.regularMarketDayHigh != null ? '$' + quote.regularMarketDayHigh.toFixed(2) : 'N/A';
  const w52Low = quote.fiftyTwoWeekLow != null ? '$' + quote.fiftyTwoWeekLow.toFixed(2) : 'N/A';
  const w52High = quote.fiftyTwoWeekHigh != null ? '$' + quote.fiftyTwoWeekHigh.toFixed(2) : 'N/A';
  const name = quote.longName || quote.shortName || quote.symbol;

  return [
    '📊 **$' + quote.symbol + ' — ' + name + '**',
    '> 💰 Prix : $' + price.toFixed(2) + ' ' + arrow + ' ' + sign + change.toFixed(2) + '%',
    '> 📦 Volume : ' + vol,
    '> 📉 Day : ' + dayLow + ' → ' + dayHigh,
    '> 📆 52W : ' + w52Low + ' → ' + w52High,
    '> 🏦 Market cap : ' + formatMarketCap(quote.marketCap),
  ].join('\n');
}

function isRateLimitError(err) {
  const msg = String(err && err.message || err);
  return /429|rate/i.test(msg);
}

function isUnknownTickerError(err) {
  const msg = String(err && err.message || err);
  return /not found|quote.*not.*found|invalid symbol|no fundamentals|404/i.test(msg);
}

function registerMarketCommands(client, { yahooClient } = {}) {
  const yc = yahooClient || createYahooClient();

  // ── !price TICKER ───────────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const m = message.content.trim().match(/^!price(?:\s+([A-Za-z$.\-]{1,10}))?$/i);
    if (!m) return;

    const tickerArg = m[1];
    if (!tickerArg) {
      try { await message.reply('❌ Usage: !price TICKER (ex: !price AAPL)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace('$', '').toUpperCase();

    try {
      const quote = await yc.getQuote(ticker);
      if (!quote || quote.regularMarketPrice == null) {
        console.log('[!price] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      await message.reply(formatQuoteMessage(quote));
    } catch (err) {
      if (isUnknownTickerError(err)) {
        console.log('[!price] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        console.error('[!price] Rate limited');
        try { await message.reply('❌ Trop de requêtes, patiente 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance indisponible, réessaye dans quelques minutes'); } catch (_) {}
    }
  });
}
```

Update exports:

```js
module.exports = {
  parseRange,
  formatMarketCap,
  createYahooClient,
  renderChartPng,
  registerMarketCommands,
  // exposed for tests
  formatQuoteMessage,
};
```

- [ ] **Step 2: Add a test for `formatQuoteMessage`**

Append to `discord/market-commands.test.js`:

```js
const { formatQuoteMessage } = require('./market-commands');

test('formatQuoteMessage renders expected lines for a full quote', () => {
  const msg = formatQuoteMessage({
    symbol: 'AAPL',
    longName: 'Apple Inc.',
    regularMarketPrice: 174.23,
    regularMarketChangePercent: 1.24,
    regularMarketVolume: 52_340_120,
    regularMarketDayLow: 172.10,
    regularMarketDayHigh: 175.00,
    fiftyTwoWeekLow: 124.17,
    fiftyTwoWeekHigh: 199.62,
    marketCap: 2_720_000_000_000,
  });
  assert.match(msg, /\$AAPL — Apple Inc\./);
  assert.match(msg, /\$174\.23/);
  assert.match(msg, /\+1\.24%/);
  assert.match(msg, /52,340,120/);
  assert.match(msg, /\$172\.10 → \$175\.00/);
  assert.match(msg, /\$124\.17 → \$199\.62/);
  assert.match(msg, /\$2\.72T/);
});

test('formatQuoteMessage uses red arrow on negative change', () => {
  const msg = formatQuoteMessage({
    symbol: 'TSLA',
    longName: 'Tesla',
    regularMarketPrice: 200,
    regularMarketChangePercent: -2.5,
    regularMarketVolume: 1000,
    regularMarketDayLow: 195,
    regularMarketDayHigh: 205,
    fiftyTwoWeekLow: 100,
    fiftyTwoWeekHigh: 300,
    marketCap: 6e11,
  });
  assert.match(msg, /🔴/);
  assert.match(msg, /-2\.50%/);
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- discord/market-commands.test.js`
Expected: 17 tests pass.

- [ ] **Step 4: Commit**

```bash
git add discord/market-commands.js discord/market-commands.test.js
git commit -m "Add !price handler for live quote display"
```

---

### Task 6: `!chart` handler

**Files:**
- Modify: `discord/market-commands.js`

Wires `!chart TICKER [RANGE]`. Extracts candles from Yahoo's `chart()` response (under `quotes` array), validates range (defaults `1D`), renders PNG, replies with attachment. Handles: missing ticker, invalid range, no data, Yahoo error, render failure.

- [ ] **Step 1: Add the handler**

Inside `registerMarketCommands`, after the `!price` block, add:

```js
  // ── !chart TICKER [RANGE] ───────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const m = message.content.trim().match(/^!chart(?:\s+([A-Za-z$.\-]{1,10}))?(?:\s+([A-Za-z0-9]{1,3}))?$/i);
    if (!m) return;

    const tickerArg = m[1];
    const rangeArg = m[2];
    if (!tickerArg) {
      try { await message.reply('❌ Usage: !chart TICKER [RANGE] (ex: !chart AAPL 5D)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace('$', '').toUpperCase();
    const range = (rangeArg || '1D').toUpperCase();

    if (!parseRange(range)) {
      try { await message.reply('❌ Range invalide. Utilise: 1D, 5D, 1M, 3M, 6M, 1Y'); } catch (_) {}
      return;
    }

    let candles;
    try {
      const chart = await yc.getChart(ticker, range);
      candles = (chart && chart.quotes) || [];
      if (candles.length === 0) {
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
    } catch (err) {
      if (isUnknownTickerError(err)) {
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        try { await message.reply('❌ Trop de requêtes, patiente 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance indisponible, réessaye dans quelques minutes'); } catch (_) {}
      return;
    }

    let buffer;
    try {
      buffer = renderChartPng(candles, ticker, range);
    } catch (err) {
      console.error('[!chart] render failed', err.stack || err.message);
      try { await message.reply('❌ Erreur génération graphique'); } catch (_) {}
      return;
    }

    try {
      await message.reply({
        files: [{ attachment: buffer, name: ticker + '-' + range + '.png' }],
      });
    } catch (err) {
      console.error('[!chart] send failed', err.message);
    }
  });
```

- [ ] **Step 2: Run existing tests (no new tests needed)**

Run: `npm test -- discord/market-commands.test.js`
Expected: all 17 tests still pass.

- [ ] **Step 3: Commit**

```bash
git add discord/market-commands.js
git commit -m "Add !chart handler for intraday/historical PNG chart"
```

---

### Task 7: `!indicator` handler

**Files:**
- Modify: `discord/market-commands.js`

Wires `!indicator TICKER`. Uses `getChart(ticker, '1D')` for 5min candles, adapts Yahoo shape to what `computeIndicators` expects (the `c` close field), calls `computeIndicators`, formats message. Handles: missing ticker, no data, not enough data (null indicators), Yahoo error.

- [ ] **Step 1: Add the handler**

At the top of `discord/market-commands.js` (next to `createCanvas` require):

```js
const { computeIndicators } = require('../trading/indicators');
```

Inside `registerMarketCommands`, after the `!chart` block, add:

```js
  // ── !indicator TICKER ───────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const m = message.content.trim().match(/^!indicator(?:\s+([A-Za-z$.\-]{1,10}))?$/i);
    if (!m) return;

    const tickerArg = m[1];
    if (!tickerArg) {
      try { await message.reply('❌ Usage: !indicator TICKER (ex: !indicator AAPL)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace('$', '').toUpperCase();

    let yahooCandles;
    try {
      const chart = await yc.getChart(ticker, '1D');
      yahooCandles = (chart && chart.quotes) || [];
      if (yahooCandles.length === 0) {
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
    } catch (err) {
      if (isUnknownTickerError(err)) {
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        try { await message.reply('❌ Trop de requêtes, patiente 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance indisponible, réessaye dans quelques minutes'); } catch (_) {}
      return;
    }

    // Adapt Yahoo shape { date, open, high, low, close, volume } → { t, o, h, l, c, v }
    const bars = yahooCandles
      .filter(q => typeof q.close === 'number')
      .map(q => ({ t: q.date, o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume }));

    const ind = computeIndicators(bars);
    if (ind.rsi == null || ind.ema9 == null || ind.ema20 == null) {
      try { await message.reply('❌ Pas assez de données historiques pour $' + ticker); } catch (_) {}
      return;
    }

    const lines = [
      '📈 **$' + ticker + ' — Indicators**',
      '> Prix : $' + ind.lastPrice.toFixed(2),
      '> RSI(14) : ' + ind.rsi.toFixed(1),
      '> EMA(9) : $' + ind.ema9.toFixed(2),
      '> EMA(20) : $' + ind.ema20.toFixed(2),
    ];
    try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!indicator]', e.message); }
  });
```

- [ ] **Step 2: Run existing tests**

Run: `npm test -- discord/market-commands.test.js`
Expected: all 17 tests still pass (no new tests required, computeIndicators already tested in `trading/indicators.test.js`).

- [ ] **Step 3: Commit**

```bash
git add discord/market-commands.js
git commit -m "Add !indicator handler using Yahoo candles + computeIndicators"
```

---

### Task 8: Register in `index.js`

**Files:**
- Modify: `index.js` (around lines 28-29 and 225)

- [ ] **Step 1: Read current registration block**

Run: `grep -n "registerDiscordCommands\|registerTradingHandler" index.js`
Expected output includes:

```
28:const { registerTradingHandler } = require('./discord/handler');
29:const { registerDiscordCommands } = require('./discord/commands');
225:registerDiscordCommands(client, { profitsChannelId: PROFITS_CHANNEL_ID });
```

- [ ] **Step 2: Add the require near line 29**

Edit `index.js`. Change:

```js
const { registerDiscordCommands } = require('./discord/commands');
```

to:

```js
const { registerDiscordCommands } = require('./discord/commands');
const { registerMarketCommands } = require('./discord/market-commands');
```

- [ ] **Step 3: Register the commands near line 225**

Edit `index.js`. Change:

```js
registerDiscordCommands(client, { profitsChannelId: PROFITS_CHANNEL_ID });
```

to:

```js
registerDiscordCommands(client, { profitsChannelId: PROFITS_CHANNEL_ID });
registerMarketCommands(client);
```

- [ ] **Step 4: Syntax check**

Run: `node --check index.js`
Expected: no output (success).

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: all tests in the repo still pass, including the 17 new ones in `discord/market-commands.test.js`.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "Wire registerMarketCommands into bot startup"
```

---

### Task 9: Live smoke test (manual)

**Files:** none (manual verification step).

- [ ] **Step 1: Start the bot locally**

Run: `npm start`
Expected: bot connects to Discord without errors; no stack traces about `market-commands`.

- [ ] **Step 2: Test `!price AAPL` in Discord**

Expected: a message with Apple's current price, change%, volume, day range, 52W range, market cap.

- [ ] **Step 3: Test `!price ZZZZZZ` (invalid ticker)**

Expected: `❌ Ticker $ZZZZZZ introuvable`.

- [ ] **Step 4: Test `!chart AAPL`**

Expected: a PNG attachment showing Apple's intraday line chart.

- [ ] **Step 5: Test `!chart AAPL 5D` and `!chart AAPL 99Y`**

Expected: 5D works (15min candles, 5-day line). 99Y replies with `❌ Range invalide. Utilise: 1D, 5D, 1M, 3M, 6M, 1Y`.

- [ ] **Step 6: Test `!indicator AAPL`**

Expected: a message with RSI, EMA9, EMA20 and the last price.

- [ ] **Step 7: Stop the bot**

Ctrl+C. No commit needed for this task.
