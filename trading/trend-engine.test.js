const { test } = require('node:test');
const assert = require('node:assert');
const { detectDirection } = require('./trend-engine');

// Helper: build N candles from a closes array. OHLC = close everywhere
// (the engine only cares about close for direction).
function bars(closes, vol = 1000) {
  return closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: vol }));
}

test('detectDirection returns null when fewer than 26 candles', () => {
  const closes = Array(25).fill(100);
  assert.strictEqual(detectDirection(bars(closes)), null);
});

test('detectDirection returns "uptrend" on a steadily rising series', () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  assert.strictEqual(detectDirection(bars(closes)), 'uptrend');
});

test('detectDirection returns "downtrend" on a steadily falling series', () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(120 - i * 0.5);
  assert.strictEqual(detectDirection(bars(closes)), 'downtrend');
});

test('detectDirection returns "sideways" on a flat series', () => {
  const closes = Array(40).fill(100);
  assert.strictEqual(detectDirection(bars(closes)), 'sideways');
});

test('detectDirection returns "sideways" when EMAs are not aligned', () => {
  // Build up to 105, then oscillate ±2.5 around it.
  // Price ends below EMA20 while EMAs still trending up → alignment breaks.
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(100 + i * 0.25);  // uptrend seed
  for (let i = 0; i < 20; i++) closes.push(105 + (i % 2 ? -2.5 : 2.5));  // oscillate
  assert.strictEqual(detectDirection(bars(closes)), 'sideways');
});
