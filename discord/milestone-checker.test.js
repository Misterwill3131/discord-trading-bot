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
