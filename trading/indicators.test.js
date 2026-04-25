const { test } = require('node:test');
const assert = require('node:assert');
const { calcEMA, calcEMASeries, calcRSI, calcVWAPSeries, computeIndicators } = require('./indicators');

const EPS = 1e-4;
function close(a, b) { return Math.abs(a - b) <= EPS; }

test('calcEMA matches hand-computed values for 9-period', () => {
  const closes = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
  // SMA of first 9 = 22.2133... EMA[9] (10th value) = 22.29*0.2 + 22.2133*0.8 = 22.2287
  const ema = calcEMA(closes, 9);
  assert.ok(close(ema, 22.2287), `expected ~22.2287, got ${ema}`);
});

test('calcEMA with not enough data returns null', () => {
  assert.strictEqual(calcEMA([1, 2, 3], 9), null);
});

test('calcRSI matches Wilder reference values', () => {
  const closes = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955,
    45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820,
    46.2820,
  ];
  const rsi = calcRSI(closes, 14);
  assert.ok(rsi > 70 && rsi < 71, `expected RSI ~70.46, got ${rsi}`);
});

test('calcRSI with flat (no losses) series returns 50', () => {
  const closes = Array(20).fill(100);
  const rsi = calcRSI(closes, 14);
  assert.strictEqual(rsi, 50);
});

test('calcRSI with strictly rising series returns 100', () => {
  const closes = [];
  for (let i = 1; i <= 20; i++) closes.push(i);
  assert.strictEqual(calcRSI(closes, 14), 100);
});

test('computeIndicators returns rsi/ema20/ema9/lastPrice on 50-bar fixture', () => {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 50; i++) {
    p += (i % 3 === 0 ? 0.5 : (i % 5 === 0 ? -0.3 : 0.2));
    bars.push({ t: 't'+i, o: p, h: p, l: p, c: p, v: 1000 });
  }
  const out = computeIndicators(bars);
  assert.ok(typeof out.rsi === 'number', 'rsi must be a number');
  assert.ok(typeof out.ema20 === 'number', 'ema20 must be a number');
  assert.ok(typeof out.ema9 === 'number', 'ema9 must be a number');
  assert.strictEqual(out.lastPrice, bars[bars.length - 1].c);
});

test('computeIndicators with too few bars returns nulls', () => {
  const bars = [];
  for (let i = 0; i < 5; i++) bars.push({ c: 100 + i });
  const out = computeIndicators(bars);
  assert.strictEqual(out.rsi, null);
  assert.strictEqual(out.ema20, null);
  assert.strictEqual(out.ema9, null);
});

test('calcEMASeries returns nulls for first period-1 indices and values after', () => {
  const closes = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
  const series = calcEMASeries(closes, 9);
  assert.strictEqual(series.length, closes.length);
  for (let i = 0; i < 8; i++) {
    assert.strictEqual(series[i], null, `series[${i}] should be null (seed period)`);
  }
  // Seed SMA at index 8 (= SMA of closes[0..8])
  const sma = closes.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  assert.ok(close(series[8], sma), `series[8] should equal SMA=${sma}, got ${series[8]}`);
  // Final value must match calcEMA for the same inputs
  assert.ok(close(series[series.length - 1], calcEMA(closes, 9)));
});

test('calcEMASeries returns empty array when values.length < period', () => {
  assert.deepStrictEqual(calcEMASeries([1, 2, 3], 9), []);
});

test('calcVWAPSeries cumulative anchored VWAP over 3 bars', () => {
  // Bar 1: HLC = 11,9,10  tp=10  v=100 → cumPV=1000  cumV=100  vwap=10
  // Bar 2: HLC = 12,10,11 tp=11  v=200 → cumPV=1000+2200=3200  cumV=300  vwap=10.6667
  // Bar 3: HLC = 13,11,12 tp=12  v=100 → cumPV=3200+1200=4400  cumV=400  vwap=11
  const bars = [
    { h: 11, l:  9, c: 10, v: 100 },
    { h: 12, l: 10, c: 11, v: 200 },
    { h: 13, l: 11, c: 12, v: 100 },
  ];
  const s = calcVWAPSeries(bars);
  assert.strictEqual(s.length, 3);
  assert.ok(close(s[0], 10), `s[0] expected 10, got ${s[0]}`);
  assert.ok(close(s[1], 10.6667), `s[1] expected ~10.6667, got ${s[1]}`);
  assert.ok(close(s[2], 11), `s[2] expected 11, got ${s[2]}`);
});

test('calcVWAPSeries carries forward over bars with invalid data', () => {
  const bars = [
    { h: 11, l:  9, c: 10, v: 100 }, // valid → vwap=10
    { h: 12, l: 10, c: 11, v: 0 },   // skip (v=0) → inherit previous (10)
    { h: 13, l: 11, c: 12, v: 100 }, // valid → cumPV=1000+1200=2200, cumV=200, vwap=11
  ];
  const s = calcVWAPSeries(bars);
  assert.ok(close(s[0], 10));
  assert.ok(close(s[1], 10), 'invalid bar inherits previous VWAP (continuous line)');
  assert.ok(close(s[2], 11));
});

test('calcVWAPSeries returns null for bars before any valid data', () => {
  const bars = [
    { h: 12, l: 10, c: 11, v: 0 },   // pas de VWAP à carry-forward
    { h: 11, l:  9, c: 10, v: 100 }, // 1er valide → vwap=10
  ];
  const s = calcVWAPSeries(bars);
  assert.strictEqual(s[0], null, 'no previous value to carry');
  assert.ok(close(s[1], 10));
});

test('calcVWAPSeries returns empty array for empty input', () => {
  assert.deepStrictEqual(calcVWAPSeries([]), []);
  assert.deepStrictEqual(calcVWAPSeries(null), []);
});

test('computeIndicators returns vwap final value', () => {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 25; i++) {
    p += 0.1;
    bars.push({ t: 't'+i, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1000 });
  }
  const out = computeIndicators(bars);
  assert.ok(typeof out.vwap === 'number', 'vwap must be a number');
  // VWAP doit être proche du prix moyen (puisque tp ≈ close et v constant)
  assert.ok(out.vwap > 100 && out.vwap < 110, `vwap out of expected range: ${out.vwap}`);
});
