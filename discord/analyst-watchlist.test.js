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
