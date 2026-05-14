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
