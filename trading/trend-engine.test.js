const { test } = require('node:test');
const assert = require('node:assert');
const { detectDirection, detectBreakout, detectReversal, detectAll } = require('./trend-engine');

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

test('detectBreakout returns null when not enough bars', () => {
  const candles = bars(Array(20).fill(100));
  assert.strictEqual(detectBreakout(candles), null);
});

test('detectBreakout fires when last close > 20-bar high AND volume > 1.5x avg', () => {
  // 20 bars at high=100/vol=1000, then 1 bar at close=101/vol=2000.
  const window = Array(20).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 20, o: 100, h: 102, l: 100, c: 101, v: 2000 };
  const r = detectBreakout([...window, last]);
  assert.ok(r, 'expected breakout');
  assert.strictEqual(r.type, 'breakout');
  assert.strictEqual(r.high, 100);
  assert.strictEqual(r.volume, 2000);
  assert.strictEqual(r.avgVolume, 1000);
});

test('detectBreakout rejects when close above high but volume too low', () => {
  const window = Array(20).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 20, o: 100, h: 102, l: 100, c: 101, v: 1200 };  // 1.2x < 1.5x
  assert.strictEqual(detectBreakout([...window, last]), null);
});

test('detectBreakout rejects when volume high but close not above 20-bar high', () => {
  const window = Array(20).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 20, o: 99, h: 100, l: 99, c: 99.99, v: 5000 };  // close ≤ high
  assert.strictEqual(detectBreakout([...window, last]), null);
});

test('detectBreakout custom thresholds', () => {
  const window = Array(10).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 99, c: 100, v: 1000 }));
  const last = { t: 10, o: 100, h: 102, l: 100, c: 101, v: 1100 };  // 1.1x avg
  // lookback=10, multiplier=1.05 → fires
  const r = detectBreakout([...window, last], 10, 1.05);
  assert.ok(r);
  // multiplier=1.5 → does not fire
  assert.strictEqual(detectBreakout([...window, last], 10, 1.5), null);
});

test('detectReversal returns null when not enough bars', () => {
  assert.strictEqual(detectReversal(bars(Array(20).fill(100))), null);
});

test('detectReversal fires bearish on RSI > 70 + EMA9 crosses below EMA20', () => {
  // Uptrend to position EMA9 above EMA20, then crash to force crossing.
  const closes = [];
  // Build a strong uptrend: consistent +1 gains to push RSI > 70
  for (let i = 0; i < 25; i++) closes.push(100 + i);  // 100..124
  // Continue uptrend to ensure EMA9 > EMA20 at this point
  for (let i = 0; i < 8; i++) closes.push(124 + i);   // 124..131
  // Now crash hard to force EMA9 below EMA20
  closes.push(90, 60);
  const r = detectReversal(bars(closes));
  assert.ok(r, 'expected bearish reversal');
  assert.strictEqual(r.type, 'bearish_reversal');
  assert.ok(r.peakRsi > 70);
});

test('detectReversal fires bullish on RSI < 30 + EMA9 crosses above EMA20', () => {
  // Downtrend to position EMA9 below EMA20, then recover to force crossing.
  const closes = [];
  // Build a strong downtrend: consistent -1 losses to push RSI < 30
  for (let i = 0; i < 25; i++) closes.push(300 - i);  // 300..276
  // Continue downtrend to ensure EMA9 < EMA20 at this point
  for (let i = 0; i < 8; i++) closes.push(276 - i);   // 276..268
  // Now surge hard to force EMA9 above EMA20
  closes.push(310, 340);
  const r = detectReversal(bars(closes));
  assert.ok(r, 'expected bullish reversal');
  assert.strictEqual(r.type, 'bullish_reversal');
  assert.ok(r.troughRsi < 30);
});

test('detectReversal returns null when EMAs cross but RSI not extreme', () => {
  // Mild oscillation : EMAs may cross but RSI hovers around 50.
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100 + (i % 2 ? 0.3 : -0.3));
  closes.push(100.5, 99.7, 100.2, 99.9);
  assert.strictEqual(detectReversal(bars(closes)), null);
});

test('detectAll returns { direction, events, snapshot }', () => {
  // Steady uptrend → direction "uptrend", possibly a breakout if last
  // close is the new high (which it is in a monotonic series), no reversal.
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  const out = detectAll(bars(closes, 1500));
  assert.ok(out, 'expected non-null');
  assert.strictEqual(out.direction, 'uptrend');
  assert.ok(Array.isArray(out.events));
  assert.ok(out.snapshot);
  assert.ok(typeof out.snapshot.price === 'number');
  assert.ok(typeof out.snapshot.ema9 === 'number');
  assert.ok(typeof out.snapshot.ema20 === 'number');
  assert.ok(typeof out.snapshot.rsi === 'number');
});

test('detectAll returns null when not enough candles', () => {
  assert.strictEqual(detectAll(bars(Array(10).fill(100))), null);
});
