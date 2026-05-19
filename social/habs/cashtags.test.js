const { test } = require('node:test');
const assert = require('node:assert');
const { topWinners, normalizeTicker, computeGain } = require('./cashtags');

test('topWinners returns top 3 by gain percent descending', () => {
  const trades = [
    { ticker: 'AAPL', entryPrice: 100, hodPrice: 110 },  // +10%
    { ticker: 'TSLA', entryPrice: 50,  hodPrice: 75 },   // +50%
    { ticker: 'NVDA', entryPrice: 200, hodPrice: 220 },  // +10%
    { ticker: 'GME',  entryPrice: 20,  hodPrice: 40 },   // +100%
  ];
  assert.deepStrictEqual(topWinners(trades, 3), ['GME', 'TSLA', 'AAPL']);
});

test('topWinners strips leading $ and uppercases', () => {
  const trades = [{ ticker: '$aapl', entryPrice: 1, hodPrice: 2 }];
  assert.deepStrictEqual(topWinners(trades, 3), ['AAPL']);
});

test('topWinners accepts pre-computed gainPct', () => {
  const trades = [
    { ticker: 'A', gainPct: 5 },
    { ticker: 'B', gainPct: 50 },
  ];
  assert.deepStrictEqual(topWinners(trades, 2), ['B', 'A']);
});

test('topWinners returns fewer than n when fewer trades exist', () => {
  const trades = [{ ticker: 'AAPL', entryPrice: 100, hodPrice: 110 }];
  assert.deepStrictEqual(topWinners(trades, 3), ['AAPL']);
});

test('topWinners returns empty array for empty input', () => {
  assert.deepStrictEqual(topWinners([], 3), []);
  assert.deepStrictEqual(topWinners(null, 3), []);
  assert.deepStrictEqual(topWinners(undefined, 3), []);
});

test('topWinners includes losers when all trades are red', () => {
  // Edge case from spec section 6: trades all losing → top "3 least bad"
  const trades = [
    { ticker: 'A', entryPrice: 100, hodPrice: 90 },  // -10%
    { ticker: 'B', entryPrice: 100, hodPrice: 50 },  // -50%
    { ticker: 'C', entryPrice: 100, hodPrice: 95 },  // -5%
  ];
  assert.deepStrictEqual(topWinners(trades, 3), ['C', 'A', 'B']);
});

test('normalizeTicker strips $ and uppercases', () => {
  assert.strictEqual(normalizeTicker('$aapl'), 'AAPL');
  assert.strictEqual(normalizeTicker('TSLA'), 'TSLA');
  assert.strictEqual(normalizeTicker(''), '');
  assert.strictEqual(normalizeTicker(null), '');
});

test('computeGain prefers gainPct when provided and finite', () => {
  assert.strictEqual(computeGain({ ticker: 'A', gainPct: 42 }), 42);
  assert.strictEqual(computeGain({ ticker: 'A', gainPct: -10 }), -10);
  assert.strictEqual(computeGain({ ticker: 'A', gainPct: 0 }), 0);
});

test('computeGain falls back to price calculation when gainPct is absent', () => {
  // (110 - 100) / 100 * 100 = 10
  assert.strictEqual(computeGain({ ticker: 'A', entryPrice: 100, hodPrice: 110 }), 10);
  // (50 - 100) / 100 * 100 = -50
  assert.strictEqual(computeGain({ ticker: 'A', entryPrice: 100, hodPrice: 50 }), -50);
});

test('computeGain returns null when entry <= 0 or inputs missing', () => {
  assert.strictEqual(computeGain({ ticker: 'A' }), null);                              // no prices, no gainPct
  assert.strictEqual(computeGain({ ticker: 'A', entryPrice: 0, hodPrice: 5 }), null);  // entry = 0 (div by zero guard)
  assert.strictEqual(computeGain({ ticker: 'A', entryPrice: -1, hodPrice: 5 }), null); // entry < 0
  assert.strictEqual(computeGain({ ticker: 'A', gainPct: Infinity }), null);            // gainPct not finite
  assert.strictEqual(computeGain({ ticker: 'A', gainPct: 'foo' }), null);               // gainPct not numeric
});

test('computeGain handles null/undefined trade gracefully', () => {
  assert.strictEqual(computeGain(null), null);
  assert.strictEqual(computeGain(undefined), null);
});

test('topWinners ranks mixed gainPct and price-form trades together', () => {
  const trades = [
    { ticker: 'A', entryPrice: 100, hodPrice: 105 },  // +5% (price form)
    { ticker: 'B', gainPct: 80 },                     // +80% (gainPct form)
    { ticker: 'C', entryPrice: 10, hodPrice: 13 },    // +30% (price form)
    { ticker: 'D', gainPct: 15 },                     // +15% (gainPct form)
  ];
  assert.deepStrictEqual(topWinners(trades, 3), ['B', 'C', 'D']);
});
