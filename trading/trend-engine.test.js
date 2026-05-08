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

test('detectPDHBreak returns no event when not enough candles', () => {
  const { detectPDHBreak } = require('./trend-engine');
  assert.deepStrictEqual(
    detectPDHBreak([], 100, {}, 15 * 60_000, 0),
    { event: null, stateUpdate: null }
  );
});

test('detectPDHBreak: first break of the day fires alert and updates state', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const state = { pdh_alerts_today: 0, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pdh_break');
  assert.strictEqual(result.event.pdh, 100);
  assert.strictEqual(result.event.price, 100.5);
  assert.deepStrictEqual(result.stateUpdate, { pdh_alerts_today: 1, pdh_below_since: null });
});

test('detectPDHBreak: still above after first alert returns null/null', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const state = { pdh_alerts_today: 1, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectPDHBreak: drops below PDH sets pdh_below_since', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 99.5, v: 1000 }];
  const state = { pdh_alerts_today: 1, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pdh_below_since: 1_000_000 });
});

test('detectPDHBreak: still below (already in below phase) returns null/null', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 99.5, v: 1000 }];
  const state = { pdh_alerts_today: 1, pdh_below_since: 500_000 };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectPDHBreak: clean re-entry after >= reentryMs fires alert', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdh_alerts_today: 1, pdh_below_since: 1_000_000 };
  const now = 1_000_000 + reentryMs; // exactly at threshold
  const result = detectPDHBreak(candles, 100, state, reentryMs, now);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pdh_break');
  assert.deepStrictEqual(result.stateUpdate, { pdh_alerts_today: 2, pdh_below_since: null });
});

test('detectPDHBreak: quick recovery (< reentryMs) clears below_since but no alert', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 100.5, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdh_alerts_today: 1, pdh_below_since: 1_000_000 };
  const now = 1_000_000 + 5 * 60_000; // 5 min < 15
  const result = detectPDHBreak(candles, 100, state, reentryMs, now);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pdh_below_since: null });
});

test('detectPDHBreak: never broken yet (alerts=0 and close <= pdh) returns null/null', () => {
  const { detectPDHBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 99, h: 101, l: 98, c: 99.5, v: 1000 }];
  const state = { pdh_alerts_today: 0, pdh_below_since: null };
  const result = detectPDHBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectPDLBreak: first break of the day fires alert', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 99.5, v: 1000 }];
  const state = { pdl_alerts_today: 0, pdl_above_since: null };
  const result = detectPDLBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pdl_break');
  assert.strictEqual(result.event.pdl, 100);
  assert.strictEqual(result.event.price, 99.5);
  assert.deepStrictEqual(result.stateUpdate, { pdl_alerts_today: 1, pdl_above_since: null });
});

test('detectPDLBreak: rebounds above PDL sets pdl_above_since', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 100.5, v: 1000 }];
  const state = { pdl_alerts_today: 1, pdl_above_since: null };
  const result = detectPDLBreak(candles, 100, state, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result.stateUpdate, { pdl_above_since: 1_000_000 });
});

test('detectPDLBreak: clean re-break after >= reentryMs fires alert', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 99.2, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdl_alerts_today: 1, pdl_above_since: 1_000_000 };
  const now = 1_000_000 + reentryMs;
  const result = detectPDLBreak(candles, 100, state, reentryMs, now);
  assert.ok(result.event);
  assert.deepStrictEqual(result.stateUpdate, { pdl_alerts_today: 2, pdl_above_since: null });
});

test('detectPDLBreak: quick recovery clears above_since without alert', () => {
  const { detectPDLBreak } = require('./trend-engine');
  const candles = [{ t: 0, o: 101, h: 102, l: 99, c: 99.2, v: 1000 }];
  const reentryMs = 15 * 60_000;
  const state = { pdl_alerts_today: 1, pdl_above_since: 1_000_000 };
  const now = 1_000_000 + 5 * 60_000;
  const result = detectPDLBreak(candles, 100, state, reentryMs, now);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pdl_above_since: null });
});

test('detectGap: gap up above threshold fires gap_up', () => {
  const { detectGap } = require('./trend-engine');
  // todayOpen 102, prevClose 100 → +2.0%
  const candles = [{ t: 0, o: 102, h: 103, l: 101.5, c: 102.5, v: 1000 }];
  const state = { gap_alerted_today: 0 };
  const result = detectGap(candles, 100, 1.5, state);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'gap_up');
  assert.strictEqual(result.event.openPrice, 102);
  assert.strictEqual(result.event.prevClose, 100);
  assert.ok(Math.abs(result.event.gapPct - 2.0) < 0.001);
  assert.deepStrictEqual(result.stateUpdate, { gap_alerted_today: 1 });
});

test('detectGap: gap down below negative threshold fires gap_down', () => {
  const { detectGap } = require('./trend-engine');
  // todayOpen 98, prevClose 100 → -2.0%
  const candles = [{ t: 0, o: 98, h: 98.5, l: 97, c: 97.5, v: 1000 }];
  const result = detectGap(candles, 100, 1.5, { gap_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'gap_down');
  assert.ok(result.event.gapPct < 0);
});

test('detectGap: under threshold returns null', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 100.8, h: 101, l: 100, c: 100.5, v: 1000 }];
  const result = detectGap(candles, 100, 1.5, { gap_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectGap: index threshold (0.5) detects smaller gaps', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 100.8, h: 101, l: 100, c: 100.5, v: 1000 }];
  // 0.8% gap with 0.5 threshold → fires
  const result = detectGap(candles, 100, 0.5, { gap_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'gap_up');
});

test('detectGap: already alerted today returns null', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 102, h: 103, l: 101.5, c: 102.5, v: 1000 }];
  const result = detectGap(candles, 100, 1.5, { gap_alerted_today: 1 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectGap: missing prevClose returns null', () => {
  const { detectGap } = require('./trend-engine');
  const candles = [{ t: 0, o: 102, h: 103, l: 101.5, c: 102.5, v: 1000 }];
  const result = detectGap(candles, 0, 1.5, { gap_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: cumulative > prev × multiplier fires alert', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  // 5 bars × 2200 = 11000 ; prev = 10000 ; 11000 > 10000 × 1.05 = 10500
  const candles = Array(5).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 2200 }));
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'volume_above_prev_day');
  assert.strictEqual(result.event.todayVolume, 11000);
  assert.strictEqual(result.event.prevDayVolume, 10000);
  assert.deepStrictEqual(result.stateUpdate, { volume_above_alerted_today: 1 });
});

test('detectVolumeAbovePrevDay: cumulative under threshold returns null', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = Array(5).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 2000 }));
  // 10000 not > 10000 * 1.05 = 10500
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: already alerted returns null', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = Array(5).fill(0).map((_, i) => ({ t: i, o: 100, h: 100, l: 100, c: 100, v: 5000 }));
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 1 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: prevDayVolume <= 0 returns null', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 5000 }];
  const result = detectVolumeAbovePrevDay(candles, 0, 1.05, { volume_above_alerted_today: 0 });
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectVolumeAbovePrevDay: handles NaN volumes (skips them)', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  const candles = [
    { t: 0, o: 100, h: 100, l: 100, c: 100, v: 5000 },
    { t: 1, o: 100, h: 100, l: 100, c: 100, v: NaN },
    { t: 2, o: 100, h: 100, l: 100, c: 100, v: 6000 },
  ];
  // sum = 11000 (NaN skipped) ; > 10000 * 1.05 = 10500 → fires
  const result = detectVolumeAbovePrevDay(candles, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.ok(result.event);
  assert.strictEqual(result.event.todayVolume, 11000);
});

test('detectAll: returns stateUpdates accumulated from new detectors', () => {
  const { detectAll } = require('./trend-engine');
  // Build a 40-bar uptrend so direction returns non-null. Last close = 119.5.
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  const intraday = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1000 }));
  // Daily context: yesterday high=119, low=100, close=118, volume=10000
  const dailyContext = { yesterday: { high: 119, low: 100, close: 118, volume: 10000 } };
  const state = {
    pdh_alerts_today: 0, pdh_below_since: null,
    pdl_alerts_today: 0, pdl_above_since: null,
    gap_alerted_today: 0, volume_above_alerted_today: 0,
  };
  const opts = { reentryMs: 15 * 60_000, gapThresholdPct: 1.5, volumeMultiplier: 1.05 };
  const result = detectAll(intraday, dailyContext, state, opts);
  assert.ok(result, 'should return non-null verdict');
  assert.strictEqual(result.direction, 'uptrend');
  assert.ok(Array.isArray(result.events));
  // PDH=119, last close=119.5 → pdh_break should fire
  assert.ok(result.events.some(e => e.type === 'pdh_break'));
  // stateUpdates contains pdh_alerts_today: 1 from PDH detector
  assert.ok(result.stateUpdates);
  assert.strictEqual(result.stateUpdates.pdh_alerts_today, 1);
});

test('detectAll: missing dailyContext skips new detectors silently', () => {
  const { detectAll } = require('./trend-engine');
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i * 0.5);
  const intraday = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1000 }));
  const result = detectAll(intraday, null, {}, {});
  assert.ok(result);
  assert.strictEqual(result.direction, 'uptrend');
  // No PDH/PDL/gap/volume events
  for (const ev of result.events) {
    assert.ok(!['pdh_break', 'pdl_break', 'gap_up', 'gap_down', 'volume_above_prev_day'].includes(ev.type));
  }
  assert.deepStrictEqual(result.stateUpdates, {});
});

// Helper for tests below: build a UTC ms timestamp for a wall-clock NY time.
// 2026-05-01 is in EDT (UTC-4).
function nyMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour + 4, minute);
}

test('filterToRTH: keeps only bars with timestamps between 9:30 and 16:00 ET', () => {
  const { filterToRTH } = require('./trend-engine');
  const bars = [
    { t: nyMs(2026, 5, 1, 4, 0),  o: 100, h: 100, l: 100, c: 100, v: 100 },  // 4:00 ET premarket
    { t: nyMs(2026, 5, 1, 9, 25), o: 100, h: 100, l: 100, c: 100, v: 100 },  // 9:25 premarket
    { t: nyMs(2026, 5, 1, 9, 30), o: 100, h: 100, l: 100, c: 100, v: 100 },  // 9:30 RTH (boundary)
    { t: nyMs(2026, 5, 1, 12, 0), o: 100, h: 100, l: 100, c: 100, v: 100 },  // noon RTH
    { t: nyMs(2026, 5, 1, 15, 55), o: 100, h: 100, l: 100, c: 100, v: 100 }, // 15:55 RTH
    { t: nyMs(2026, 5, 1, 16, 0), o: 100, h: 100, l: 100, c: 100, v: 100 },  // 16:00 after-hours
    { t: nyMs(2026, 5, 1, 18, 0), o: 100, h: 100, l: 100, c: 100, v: 100 },  // 18:00 after-hours
  ];
  const rth = filterToRTH(bars);
  assert.strictEqual(rth.length, 3);
  assert.deepStrictEqual(rth.map(b => b.t), [
    nyMs(2026, 5, 1, 9, 30),
    nyMs(2026, 5, 1, 12, 0),
    nyMs(2026, 5, 1, 15, 55),
  ]);
});

test('filterToRTH: rejects bars with missing or non-numeric t', () => {
  const { filterToRTH } = require('./trend-engine');
  const bars = [
    { o: 100, h: 100, l: 100, c: 100, v: 100 },          // missing t
    { t: 'foo', o: 100, h: 100, l: 100, c: 100, v: 100 }, // non-numeric t
    { t: nyMs(2026, 5, 1, 12, 0), o: 100, h: 100, l: 100, c: 100, v: 100 },
  ];
  assert.strictEqual(filterToRTH(bars).length, 1);
});

test('detectGap: uses premarket open (1st bar) for overnight gap measurement', () => {
  const { detectGap } = require('./trend-engine');
  // Overnight gap : prev session close = 100, premarket open = 99.5 → -0.5%.
  // Avec threshold 0.4 → fire gap_down basé sur l'open premarket à 4:00 ET,
  // pas sur l'open RTH à 9:30.
  const intraday = [
    { t: nyMs(2026, 5, 1, 4, 0),  o: 99.5, h: 100, l: 99,  c: 99.8, v: 50 },   // premarket open
    { t: nyMs(2026, 5, 1, 8, 0),  o: 99.8, h: 100, l: 99.5, c: 100, v: 100 },
    { t: nyMs(2026, 5, 1, 9, 30), o: 102,  h: 102.5, l: 101.5, c: 102, v: 5000 },
    { t: nyMs(2026, 5, 1, 9, 35), o: 102,  h: 102.3, l: 101.8, c: 102.1, v: 4000 },
  ];
  const result = detectGap(intraday, 100, 0.4, { gap_alerted_today: 0 });
  assert.ok(result.event, 'expected gap_down based on premarket open');
  assert.strictEqual(result.event.type, 'gap_down');
  assert.strictEqual(result.event.openPrice, 99.5);  // premarket bar's open
  assert.ok(Math.abs(result.event.gapPct - (-0.5)) < 0.001);
});

test('detectVolumeAbovePrevDay: sums only RTH bars, ignoring premarket volume', () => {
  const { detectVolumeAbovePrevDay } = require('./trend-engine');
  // Premarket volume = 1000, RTH volume = 11000. Yesterday = 10000.
  // Without filter: 12000 > 10500 → fire (incorrectly counting premarket).
  // With filter: 11000 > 10500 → fire (correctly RTH-only).
  // To test filtering specifically, set premarket vol so big that without
  // the filter we'd over-count to a different total than RTH alone.
  const intraday = [
    { t: nyMs(2026, 5, 1, 4, 0),  o: 100, h: 100, l: 100, c: 100, v: 5000 }, // premarket — should be excluded
    { t: nyMs(2026, 5, 1, 9, 30), o: 100, h: 100, l: 100, c: 100, v: 6000 }, // RTH
    { t: nyMs(2026, 5, 1, 9, 35), o: 100, h: 100, l: 100, c: 100, v: 5000 }, // RTH
  ];
  const result = detectVolumeAbovePrevDay(intraday, 10000, 1.05, { volume_above_alerted_today: 0 });
  assert.ok(result.event);
  // Should be 11000 (RTH only), not 16000 (with premarket)
  assert.strictEqual(result.event.todayVolume, 11000);
});

// ── PMH / PML break ────────────────────────────────────────────────────

test('isPremarketBar: 4:00-9:30 ET inclusive/exclusive boundaries', () => {
  const { isPremarketBar } = require('./trend-engine');
  assert.strictEqual(isPremarketBar({ t: nyMs(2026, 5, 1, 3, 59) }), false);  // before
  assert.strictEqual(isPremarketBar({ t: nyMs(2026, 5, 1, 4, 0)  }), true);   // start
  assert.strictEqual(isPremarketBar({ t: nyMs(2026, 5, 1, 7, 0)  }), true);   // mid
  assert.strictEqual(isPremarketBar({ t: nyMs(2026, 5, 1, 9, 29) }), true);   // last
  assert.strictEqual(isPremarketBar({ t: nyMs(2026, 5, 1, 9, 30) }), false);  // RTH starts
  assert.strictEqual(isPremarketBar({ t: nyMs(2026, 5, 1, 12, 0) }), false);  // RTH
});

test('getPremarketRange: extracts max(h) and min(l) over premarket bars only', () => {
  const { getPremarketRange } = require('./trend-engine');
  const intraday = [
    { t: nyMs(2026, 5, 1, 4, 0),  o: 100, h: 102, l: 99,   c: 101, v: 50 },   // pre
    { t: nyMs(2026, 5, 1, 8, 0),  o: 101, h: 105, l: 100,  c: 104, v: 100 },  // pre
    { t: nyMs(2026, 5, 1, 9, 25), o: 104, h: 106, l: 103,  c: 105, v: 200 },  // pre
    { t: nyMs(2026, 5, 1, 9, 30), o: 105, h: 110, l: 95,   c: 108, v: 5000 }, // RTH (excluded)
    { t: nyMs(2026, 5, 1, 9, 35), o: 108, h: 112, l: 107,  c: 110, v: 4000 }, // RTH (excluded)
  ];
  const range = getPremarketRange(intraday);
  assert.ok(range);
  assert.strictEqual(range.pmh, 106);  // max of premarket highs (102, 105, 106)
  assert.strictEqual(range.pml, 99);   // min of premarket lows  (99, 100, 103)
});

test('getPremarketRange: returns null with no premarket bars', () => {
  const { getPremarketRange } = require('./trend-engine');
  const intraday = [
    { t: nyMs(2026, 5, 1, 9, 30), o: 100, h: 110, l: 90, c: 105, v: 1000 },
    { t: nyMs(2026, 5, 1, 10, 0), o: 105, h: 115, l: 100, c: 112, v: 2000 },
  ];
  assert.strictEqual(getPremarketRange(intraday), null);
});

test('detectPMHBreak: first break of the day (close > PMH during RTH) fires alert', () => {
  const { detectPMHBreak } = require('./trend-engine');
  const candles = [
    { t: nyMs(2026, 5, 1, 9, 35), o: 105, h: 107, l: 104, c: 106.5, v: 1000 },
  ];
  const result = detectPMHBreak(candles, 106, { pmh_alerts_today: 0, pmh_below_since: null }, 15 * 60_000, 1_000_000);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pmh_break');
  assert.strictEqual(result.event.pmh, 106);
  assert.strictEqual(result.event.price, 106.5);
  assert.deepStrictEqual(result.stateUpdate, { pmh_alerts_today: 1, pmh_below_since: null });
});

test('detectPMHBreak: skip if last bar is premarket (PMH still forming)', () => {
  const { detectPMHBreak } = require('./trend-engine');
  const candles = [
    { t: nyMs(2026, 5, 1, 9, 25), o: 105, h: 107, l: 104, c: 106.5, v: 1000 },  // premarket
  ];
  const result = detectPMHBreak(candles, 106, { pmh_alerts_today: 0, pmh_below_since: null }, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});

test('detectPMHBreak: drops below PMH sets pmh_below_since', () => {
  const { detectPMHBreak } = require('./trend-engine');
  const candles = [
    { t: nyMs(2026, 5, 1, 10, 0), o: 105, h: 105.5, l: 104, c: 105.5, v: 1000 },
  ];
  const state = { pmh_alerts_today: 1, pmh_below_since: null };
  const result = detectPMHBreak(candles, 106, state, 15 * 60_000, 1_000_000);
  assert.strictEqual(result.event, null);
  assert.deepStrictEqual(result.stateUpdate, { pmh_below_since: 1_000_000 });
});

test('detectPMHBreak: clean re-entry after >= reentryMs fires alert', () => {
  const { detectPMHBreak } = require('./trend-engine');
  const candles = [
    { t: nyMs(2026, 5, 1, 11, 0), o: 105, h: 107, l: 104, c: 106.5, v: 1000 },
  ];
  const reentryMs = 15 * 60_000;
  const state = { pmh_alerts_today: 1, pmh_below_since: 1_000_000 };
  const now = 1_000_000 + reentryMs;
  const result = detectPMHBreak(candles, 106, state, reentryMs, now);
  assert.ok(result.event);
  assert.deepStrictEqual(result.stateUpdate, { pmh_alerts_today: 2, pmh_below_since: null });
});

test('detectPMLBreak: first break of the day fires alert', () => {
  const { detectPMLBreak } = require('./trend-engine');
  const candles = [
    { t: nyMs(2026, 5, 1, 9, 35), o: 100, h: 100, l: 98.5, c: 98.8, v: 1000 },
  ];
  const result = detectPMLBreak(candles, 99, { pml_alerts_today: 0, pml_above_since: null }, 15 * 60_000, 1_000_000);
  assert.ok(result.event);
  assert.strictEqual(result.event.type, 'pml_break');
  assert.strictEqual(result.event.pml, 99);
  assert.strictEqual(result.event.price, 98.8);
});

test('detectPMLBreak: skip if last bar is premarket', () => {
  const { detectPMLBreak } = require('./trend-engine');
  const candles = [
    { t: nyMs(2026, 5, 1, 8, 0), o: 100, h: 100, l: 98.5, c: 98.8, v: 1000 },  // premarket
  ];
  const result = detectPMLBreak(candles, 99, { pml_alerts_today: 0, pml_above_since: null }, 15 * 60_000, 1_000_000);
  assert.deepStrictEqual(result, { event: null, stateUpdate: null });
});
