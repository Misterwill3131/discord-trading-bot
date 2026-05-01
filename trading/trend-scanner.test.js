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

const Database = require('better-sqlite3');
const { createTrendStore } = require('../db/trend-store');
const { runScanCycle } = require('./trend-scanner');

function makeStoreDb() {
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
