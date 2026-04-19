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
  assert.strictEqual(Object.isFrozen(DEFAULTS), true);
  // Sloppy-mode assignment silently fails on frozen objects — verify the value stayed put.
  try { DEFAULTS.riskPerTradePct = 99; } catch (_) {}
  assert.strictEqual(DEFAULTS.riskPerTradePct, 1.0);
});
