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

test('handleMessage skips seeding when FMP returns price=0 (halted ticker)', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  const haltedMarket = {
    getQuote: async () => ({ price: 0, volume: 0 }),
  };
  await watchlist.handleMessage(
    fakeMessage({
      id: 'halted-1',
      content: 'GME looking interesting',
    }),
    { marketClient: haltedMarket },
  );
  // Audit still happens
  assert.ok(db.getTrackedMessage('halted-1'));
  // But no seed (price=0 would cause div-by-zero downstream)
  assert.strictEqual(db.getWatchlistEntry('GME'), null);
});

test('handleMessage skips seeding when FMP returns negative price', async () => {
  process.env.TRADING_CHANNEL = 'trading-floor';
  const negativeMarket = {
    getQuote: async () => ({ price: -50, volume: 100 }),
  };
  await watchlist.handleMessage(
    fakeMessage({
      id: 'neg-1',
      content: 'F looking strong',
    }),
    { marketClient: negativeMarket },
  );
  assert.ok(db.getTrackedMessage('neg-1'));
  assert.strictEqual(db.getWatchlistEntry('F'), null);
});
