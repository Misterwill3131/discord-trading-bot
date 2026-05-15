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

const { tick } = require('./milestone-checker');

// Tiny fake DB capturing calls and configurable state.
function makeFakeDb({ active = [], archiveReturns = 0 } = {}) {
  const calls = {
    insertMilestoneAlert: [],
    updateWatchlistAfterAlert: [],
    archiveExpiredWatchlist: [],
    setMilestoneAlertDiscordId: [],
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
    setMilestoneAlertDiscordId(entry) {
      calls.setMilestoneAlertDiscordId = calls.setMilestoneAlertDiscordId || [];
      calls.setMilestoneAlertDiscordId.push(entry);
    },
    _calls: calls,
  };
}

// Minimal fake Discord client + channel + message that returns the reply.
function makeFakeDiscord({
  replyId = 'reply-1',
  failFetch = false,
  dedicatedChannelId = null,
  sourceGuildId = 'guild-1',
  dedicatedSendFails = false,
} = {}) {
  const replies = [];
  const sends   = [];

  const sourceChannel = {
    messages: {
      fetch: async (id) => {
        if (failFetch) throw new Error('source message gone');
        return {
          guildId: sourceGuildId,
          reply: async ({ content }) => {
            replies.push({ messageId: id, content });
            return { id: replyId };
          },
        };
      },
    },
  };

  const dedicatedChannel = {
    send: async ({ content }) => {
      if (dedicatedSendFails) throw new Error('dedicated send failed');
      sends.push({ content });
      return { id: 'sent-' + replyId };
    },
  };

  return {
    channels: {
      fetch: async (id) => {
        if (dedicatedChannelId && String(id) === String(dedicatedChannelId)) {
          return dedicatedChannel;
        }
        return sourceChannel;
      },
    },
    _replies: replies,
    _sends:   sends,
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

test('readConfig falls back to defaults when MILESTONE_COOLDOWN_HOURS is non-numeric', () => {
  const prev = process.env.MILESTONE_COOLDOWN_HOURS;
  process.env.MILESTONE_COOLDOWN_HOURS = 'abc';
  try {
    const cfg = require('./milestone-checker').readConfig();
    assert.strictEqual(cfg.cooldownMs, 3600_000);  // 1h default, not NaN
  } finally {
    if (prev === undefined) delete process.env.MILESTONE_COOLDOWN_HOURS;
    else process.env.MILESTONE_COOLDOWN_HOURS = prev;
  }
});

test('readConfig falls back to defaults when WATCHLIST_TTL_DAYS is non-numeric', () => {
  const prev = process.env.WATCHLIST_TTL_DAYS;
  process.env.WATCHLIST_TTL_DAYS = 'xyz';
  try {
    const cfg = require('./milestone-checker').readConfig();
    assert.strictEqual(cfg.ttlMs, 30 * 86400_000);  // 30d default, not NaN
  } finally {
    if (prev === undefined) delete process.env.WATCHLIST_TTL_DAYS;
    else process.env.WATCHLIST_TTL_DAYS = prev;
  }
});

test('tick backfills discord_message_id after successful reply', async () => {
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
  const fakeClient = makeFakeDiscord({ replyId: 'rep-aapl-backfill' });
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId.length, 1);
  assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId[0].ticker, 'AAPL');
  assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId[0].milestonePct, 20);
  assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId[0].discordMessageId, 'rep-aapl-backfill');
});

test('tick does not backfill discord_message_id when reply fails', async () => {
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
  // Insert happened, but reply failed → no backfill call
  assert.strictEqual(fakeDb._calls.insertMilestoneAlert.length, 1);
  assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId.length, 0);
});

test('tick mode reply : env var empty → behaviour inchangé (sourceMsg.reply)', async () => {
  delete process.env.MILESTONE_ALERTS_CHANNEL_ID;
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
  const fakeClient = makeFakeDiscord({ replyId: 'rep-reply-mode' });
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeClient._replies.length, 1);
  assert.strictEqual(fakeClient._sends.length, 0);
  assert.ok(fakeClient._replies[0].content.includes('+20%'));
  assert.ok(!fakeClient._replies[0].content.includes('📎'));
  assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
});

test('tick mode canal dédié : env var set → channel.send + lien source', async () => {
  process.env.MILESTONE_ALERTS_CHANNEL_ID = 'dedicated-chan-id';
  try {
    const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
    const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
    const fakeClient = makeFakeDiscord({
      replyId: 'rep-dedicated',
      dedicatedChannelId: 'dedicated-chan-id',
      sourceGuildId: 'guild-xyz',
    });
    await tick(fakeClient, 1700001000000, {
      db: fakeDb,
      marketClient: fakeMarket,
      isRTH: () => true,
      milestones: [20, 50],
      cooldownMs: 3600_000,
      ttlMs: 30 * 86400_000,
    });
    assert.strictEqual(fakeClient._replies.length, 0);
    assert.strictEqual(fakeClient._sends.length, 1);
    assert.ok(fakeClient._sends[0].content.includes('+20%'));
    assert.ok(fakeClient._sends[0].content.includes(
      '📎 https://discord.com/channels/guild-xyz/chan-1/src-1'
    ));
    assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId.length, 1);
    assert.strictEqual(
      fakeDb._calls.setMilestoneAlertDiscordId[0].discordMessageId,
      'sent-rep-dedicated'
    );
    assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
  } finally {
    delete process.env.MILESTONE_ALERTS_CHANNEL_ID;
  }
});

test('tick mode canal dédié : source message gone → post sans lien (graceful)', async () => {
  process.env.MILESTONE_ALERTS_CHANNEL_ID = 'dedicated-chan-id';
  try {
    const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
    const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
    const fakeClient = makeFakeDiscord({
      replyId: 'rep-no-link',
      dedicatedChannelId: 'dedicated-chan-id',
      failFetch: true,
    });
    await tick(fakeClient, 1700001000000, {
      db: fakeDb,
      marketClient: fakeMarket,
      isRTH: () => true,
      milestones: [20, 50],
      cooldownMs: 3600_000,
      ttlMs: 30 * 86400_000,
    });
    assert.strictEqual(fakeClient._sends.length, 1);
    assert.ok(!fakeClient._sends[0].content.includes('📎'));
    assert.ok(fakeClient._sends[0].content.includes('+20%'));
    assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
  } finally {
    delete process.env.MILESTONE_ALERTS_CHANNEL_ID;
  }
});
