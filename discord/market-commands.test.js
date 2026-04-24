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
  const lower = parseRange('1m', FIXED_NOW);
  const upper = parseRange('1M', FIXED_NOW);
  assert.ok(lower, 'lowercase 1m should not return null');
  assert.strictEqual(lower.interval, '1d');
  assert.deepStrictEqual(lower, upper);
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

test('formatMarketCap returns N/A for negative, Infinity, and NaN', () => {
  assert.strictEqual(formatMarketCap(-1), 'N/A', 'Yahoo -1 sentinel');
  assert.strictEqual(formatMarketCap(-2_700_000_000_000), 'N/A');
  assert.strictEqual(formatMarketCap(Infinity), 'N/A');
  assert.strictEqual(formatMarketCap(-Infinity), 'N/A');
  assert.strictEqual(formatMarketCap(NaN), 'N/A');
});
