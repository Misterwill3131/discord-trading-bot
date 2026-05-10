const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeGapFromBars,
  computeAllGapsFromBars,
  findGapFillTimestamp,
} = require('./gap-commands');

// Helpers : bâtit un timestamp ET pour une date YYYY-MM-DD à hh:mm
// (en UTC pour simplifier les tests — formatDateET convertira en ET).
// 14:30 UTC = 09:30 EST = 09:30 EDT (close enough — formatDateET use ET zone).
function ts(dateStr, hh = 14, mm = 30) {
  return new Date(dateStr + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00Z').getTime();
}

test('computeGapFromBars returns null for empty / too-short input', () => {
  assert.strictEqual(computeGapFromBars(null), null);
  assert.strictEqual(computeGapFromBars(undefined), null);
  assert.strictEqual(computeGapFromBars([]), null);
  assert.strictEqual(computeGapFromBars([{ t: ts('2026-05-08'), o: 100, c: 101 }]), null);
});

test('computeGapFromBars returns null when all bars on the same date', () => {
  // 2 bars same day → only 1 distinct ET date → can't compute gap
  const bars = [
    { t: ts('2026-05-08', 14, 30), o: 100, h: 101, l: 99,  c: 100.5, v: 1000 },
    { t: ts('2026-05-08', 15, 30), o: 100.5, h: 102, l: 100, c: 101, v: 1500 },
  ];
  assert.strictEqual(computeGapFromBars(bars), null);
});

test('computeGapFromBars computes positive gap from 2 trading days', () => {
  // Day 1 close = 100, Day 2 open = 102 → gap +2.0%
  const prevCloseT  = ts('2026-05-07', 19, 30);
  const todayOpenT  = ts('2026-05-08', 14, 30);
  const lastBarT    = ts('2026-05-08', 15, 30);
  const bars = [
    { t: ts('2026-05-07', 14, 30), o:  99, h: 100, l:  98, c:  99,  v: 1000 },
    { t: prevCloseT,               o:  99, h: 101, l:  99, c: 100,  v: 1500 },  // prev session close
    { t: todayOpenT,               o: 102, h: 103, l: 101, c: 102.5, v: 2000 }, // today open
    { t: lastBarT,                 o: 102.5, h: 104, l: 102, c: 103.5, v: 1800 }, // latest bar
  ];
  const gap = computeGapFromBars(bars);
  assert.ok(gap, 'should return non-null');
  assert.strictEqual(gap.prevSessionClose, 100);
  assert.strictEqual(gap.todayOpen, 102);
  assert.ok(Math.abs(gap.gapPct - 2.0) < 0.001, 'gapPct should be ~+2.0%, got ' + gap.gapPct);
  // Timestamps exposed for chart annotation (rectangle drawing in !gap chart):
  // prev close + today open delimit the GAP itself ; latestBar is used to
  // étendre le rectangle horizontalement jusqu'au bord droit du chart.
  assert.strictEqual(gap.prevCloseTimestamp,  prevCloseT);
  assert.strictEqual(gap.todayOpenTimestamp,  todayOpenT);
  assert.strictEqual(gap.latestBarTimestamp,  lastBarT);
});

test('computeGapFromBars computes negative gap', () => {
  // Day 1 close = 200, Day 2 open = 196 → gap -2.0%
  const bars = [
    { t: ts('2026-05-07', 19, 30), o: 201, h: 202, l: 199, c: 200, v: 1500 },
    { t: ts('2026-05-08', 14, 30), o: 196, h: 197, l: 195, c: 196.5, v: 2000 },
  ];
  const gap = computeGapFromBars(bars);
  assert.ok(gap);
  assert.strictEqual(gap.prevSessionClose, 200);
  assert.strictEqual(gap.todayOpen, 196);
  assert.ok(Math.abs(gap.gapPct - (-2.0)) < 0.001);
});

test('computeGapFromBars uses LAST bar of prev day + FIRST bar of latest day', () => {
  // Multi-bar days : prev close = last bar of prev date,
  // today open = first bar of latest date.
  const bars = [
    { t: ts('2026-05-07', 14, 30), o: 100, h: 100, l: 100, c: 100, v: 1000 }, // first bar prev day
    { t: ts('2026-05-07', 16, 30), o: 100, h: 100, l: 100, c: 105, v: 1000 },
    { t: ts('2026-05-07', 19, 30), o: 105, h: 110, l: 105, c: 110, v: 1000 }, // LAST bar prev day → prevSessionClose
    { t: ts('2026-05-08', 14, 30), o: 115, h: 115, l: 115, c: 115, v: 1000 }, // FIRST bar today → todayOpen
    { t: ts('2026-05-08', 19, 30), o: 115, h: 120, l: 115, c: 120, v: 1000 },
  ];
  const gap = computeGapFromBars(bars);
  assert.ok(gap);
  assert.strictEqual(gap.prevSessionClose, 110);
  assert.strictEqual(gap.todayOpen, 115);
});

test('computeGapFromBars returns null for invalid prevSessionClose', () => {
  // If somehow the prev close is 0 or non-finite, division would explode → null
  const bars = [
    { t: ts('2026-05-07', 19, 30), o: 100, h: 100, l: 100, c: 0, v: 1000 },
    { t: ts('2026-05-08', 14, 30), o: 100, h: 100, l: 100, c: 100, v: 1000 },
  ];
  assert.strictEqual(computeGapFromBars(bars), null);
});

test('computeGapFromBars filters Date instance timestamps too', () => {
  // Bars from yahoo may have q.date as Date instance; computeGapFromBars
  // expects already-numeric .t — caller normalises. Just sanity-check
  // numeric .t works.
  const bars = [
    { t: ts('2026-05-07', 19, 30), o: 50, h: 50, l: 50, c: 50, v: 1000 },
    { t: ts('2026-05-08', 14, 30), o: 51, h: 51, l: 51, c: 51, v: 1000 },
  ];
  const gap = computeGapFromBars(bars);
  assert.ok(gap);
  assert.strictEqual(gap.prevSessionClose, 50);
  assert.strictEqual(gap.todayOpen, 51);
  assert.ok(Math.abs(gap.gapPct - 2.0) < 0.001);
});

// ── computeAllGapsFromBars (multi-gap detection) ─────────────────────
test('computeAllGapsFromBars returns [] for empty / too-short input', () => {
  assert.deepStrictEqual(computeAllGapsFromBars(null), []);
  assert.deepStrictEqual(computeAllGapsFromBars(undefined), []);
  assert.deepStrictEqual(computeAllGapsFromBars([]), []);
  assert.deepStrictEqual(computeAllGapsFromBars([{ t: ts('2026-05-08'), o: 1, c: 1 }]), []);
});

test('computeAllGapsFromBars returns [] when all bars on the same date', () => {
  const bars = [
    { t: ts('2026-05-08', 14, 30), o: 100, h: 101, l: 99,  c: 100.5, v: 1000 },
    { t: ts('2026-05-08', 15, 30), o: 100.5, h: 102, l: 100, c: 101, v: 1500 },
  ];
  assert.deepStrictEqual(computeAllGapsFromBars(bars), []);
});

test('computeAllGapsFromBars detects 1 gap between 2 distinct dates', () => {
  const bars = [
    { t: ts('2026-05-07', 19, 30), o: 99, h: 101, l: 99, c: 100, v: 1500 },
    { t: ts('2026-05-08', 14, 30), o: 102, h: 103, l: 101, c: 102.5, v: 2000 },
  ];
  const gaps = computeAllGapsFromBars(bars);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].prevSessionClose, 100);
  assert.strictEqual(gaps[0].todayOpen, 102);
  assert.ok(Math.abs(gaps[0].gapPct - 2.0) < 0.001);
});

test('computeAllGapsFromBars detects 3 gaps across 4 trading days', () => {
  // 4 dates → 3 consecutive pairs → 3 gaps
  // Day A close=100, Day B open=102 (gap +2%)
  // Day B close=103, Day C open=105 (gap +1.94%)
  // Day C close=106, Day D open=108 (gap +1.89%)
  const bars = [
    { t: ts('2026-05-04', 19, 30), o: 99,  h: 101, l: 99,  c: 100, v: 1000 },
    { t: ts('2026-05-05', 14, 30), o: 102, h: 102, l: 102, c: 102, v: 1000 }, // open
    { t: ts('2026-05-05', 19, 30), o: 102, h: 104, l: 102, c: 103, v: 1000 }, // close
    { t: ts('2026-05-06', 14, 30), o: 105, h: 105, l: 105, c: 105, v: 1000 },
    { t: ts('2026-05-06', 19, 30), o: 105, h: 107, l: 105, c: 106, v: 1000 },
    { t: ts('2026-05-07', 14, 30), o: 108, h: 108, l: 108, c: 108, v: 1000 },
    { t: ts('2026-05-07', 19, 30), o: 108, h: 109, l: 108, c: 109, v: 1000 },
  ];
  const gaps = computeAllGapsFromBars(bars);
  assert.strictEqual(gaps.length, 3, 'expected 3 gaps for 4 dates, got ' + gaps.length);

  // Gap 1: 2026-05-04 close 100 → 2026-05-05 open 102
  assert.strictEqual(gaps[0].prevSessionClose, 100);
  assert.strictEqual(gaps[0].todayOpen, 102);
  // Gap 2: 2026-05-05 close 103 → 2026-05-06 open 105
  assert.strictEqual(gaps[1].prevSessionClose, 103);
  assert.strictEqual(gaps[1].todayOpen, 105);
  // Gap 3: 2026-05-06 close 106 → 2026-05-07 open 108
  assert.strictEqual(gaps[2].prevSessionClose, 106);
  assert.strictEqual(gaps[2].todayOpen, 108);
});

test('computeAllGapsFromBars skips degenerate gaps (prev close == today open)', () => {
  // 3 dates, but the 2nd→3rd transition has open == prev close → skip
  const bars = [
    { t: ts('2026-05-05', 19, 30), o: 99,  h: 101, l: 99,  c: 100, v: 1000 },
    { t: ts('2026-05-06', 14, 30), o: 103, h: 103, l: 103, c: 103, v: 1000 }, // gap +3%
    { t: ts('2026-05-06', 19, 30), o: 103, h: 105, l: 103, c: 105, v: 1000 },
    { t: ts('2026-05-07', 14, 30), o: 105, h: 105, l: 105, c: 105, v: 1000 }, // open == prev close → skip
  ];
  const gaps = computeAllGapsFromBars(bars);
  assert.strictEqual(gaps.length, 1, 'only 1 real gap; the 2nd should be skipped');
  assert.strictEqual(gaps[0].prevSessionClose, 100);
  assert.strictEqual(gaps[0].todayOpen, 103);
});

test('computeAllGapsFromBars latestBarTimestamp = LAST bar of each gap day', () => {
  // For each gap, latestBarTimestamp must be the last bar of the day
  // FOLLOWING the gap (= the chart-img rectangle's right edge).
  const day1Last = ts('2026-05-05', 19, 30);
  const day2Last = ts('2026-05-06', 19, 30);
  const day3Last = ts('2026-05-07', 19, 30);
  const bars = [
    { t: ts('2026-05-05', 14, 30), o: 100, h: 100, l: 100, c: 100, v: 1000 },
    { t: day1Last,                 o: 100, h: 102, l: 100, c: 102, v: 1000 },
    { t: ts('2026-05-06', 14, 30), o: 105, h: 105, l: 105, c: 105, v: 1000 },
    { t: day2Last,                 o: 105, h: 107, l: 105, c: 107, v: 1000 },
    { t: ts('2026-05-07', 14, 30), o: 110, h: 110, l: 110, c: 110, v: 1000 },
    { t: day3Last,                 o: 110, h: 112, l: 110, c: 112, v: 1000 },
  ];
  const gaps = computeAllGapsFromBars(bars);
  assert.strictEqual(gaps.length, 2);
  // Gap 1 happened entering day 2 (2026-05-06) → right edge = day2Last
  assert.strictEqual(gaps[0].latestBarTimestamp, day2Last);
  // Gap 2 happened entering day 3 (2026-05-07) → right edge = day3Last
  assert.strictEqual(gaps[1].latestBarTimestamp, day3Last);
});

test('computeGapFromBars (backward-compat) returns the LATEST gap from the array', () => {
  // 3 dates → 2 gaps. computeGapFromBars (singular) must return the most
  // recent (last element of computeAllGapsFromBars).
  const bars = [
    { t: ts('2026-05-05', 19, 30), o: 100, h: 100, l: 100, c: 100, v: 1000 },
    { t: ts('2026-05-06', 14, 30), o: 102, h: 102, l: 102, c: 102, v: 1000 },
    { t: ts('2026-05-06', 19, 30), o: 102, h: 104, l: 102, c: 104, v: 1000 },
    { t: ts('2026-05-07', 14, 30), o: 107, h: 107, l: 107, c: 107, v: 1000 }, // most recent gap
  ];
  const all = computeAllGapsFromBars(bars);
  const single = computeGapFromBars(bars);
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(single, all[all.length - 1]);
  assert.strictEqual(single.prevSessionClose, 104);
  assert.strictEqual(single.todayOpen, 107);
});

// ── findGapFillTimestamp (gap fill detection) ────────────────────────
test('findGapFillTimestamp returns null for empty/invalid input', () => {
  assert.strictEqual(findGapFillTimestamp(null, null), null);
  assert.strictEqual(findGapFillTimestamp([], null), null);
  assert.strictEqual(findGapFillTimestamp(null, {}), null);
  assert.strictEqual(findGapFillTimestamp([], {
    prevSessionClose: 100, todayOpen: 102, todayOpenTimestamp: 1
  }), null);
});

test('findGapFillTimestamp finds the bar that fills a gap UP', () => {
  // Gap up: prevClose=100, todayOpen=102. Zone = [100, 102].
  // Filled when a subsequent bar's range overlaps with [100, 102].
  const todayT = ts('2026-05-08', 13, 30);
  const fillT  = ts('2026-05-08', 14, 30);
  const bars = [
    { t: ts('2026-05-07', 19, 45), o: 99,  h: 100, l: 99,  c: 100, v: 1 },  // prev close
    { t: todayT,                   o: 102, h: 102.5, l: 102, c: 102.3, v: 1 }, // gap to 102
    { t: fillT,                    o: 102, h: 102, l: 100.5, c: 101, v: 1 }, // l=100.5 enters [100,102]
  ];
  const gap = { prevSessionClose: 100, todayOpen: 102, todayOpenTimestamp: todayT };
  assert.strictEqual(findGapFillTimestamp(bars, gap), fillT);
});

test('findGapFillTimestamp finds the bar that fills a gap DOWN', () => {
  // Gap down: prevClose=102, todayOpen=100. Zone = [100, 102].
  // Filled when a subsequent bar's high reaches back into [100, 102].
  const todayT = ts('2026-05-08', 13, 30);
  const fillT  = ts('2026-05-08', 14, 30);
  const bars = [
    { t: ts('2026-05-07', 19, 45), o: 102, h: 102, l: 101, c: 102, v: 1 },
    { t: todayT,                   o: 100, h: 100.5, l: 99.5, c: 100, v: 1 }, // gap down to 100
    { t: fillT,                    o: 100, h: 101.5, l: 100, c: 101, v: 1 },  // h=101.5 enters [100,102]
  ];
  const gap = { prevSessionClose: 102, todayOpen: 100, todayOpenTimestamp: todayT };
  assert.strictEqual(findGapFillTimestamp(bars, gap), fillT);
});

test('findGapFillTimestamp returns null when gap stays unfilled', () => {
  // Gap up to 102, subsequent bars all stay above 102 (no fill).
  const todayT = ts('2026-05-08', 13, 30);
  const bars = [
    { t: ts('2026-05-07', 19, 45), o: 99,  h: 100, l: 99,  c: 100, v: 1 },
    { t: todayT,                   o: 102, h: 102.5, l: 102, c: 102.3, v: 1 },
    { t: ts('2026-05-08', 14, 30), o: 103, h: 104, l: 102.5, c: 103.5, v: 1 }, // l=102.5 NOT in [100,102]
    { t: ts('2026-05-08', 14, 45), o: 103, h: 105, l: 103,   c: 104,   v: 1 },
  ];
  const gap = { prevSessionClose: 100, todayOpen: 102, todayOpenTimestamp: todayT };
  assert.strictEqual(findGapFillTimestamp(bars, gap), null);
});

test('findGapFillTimestamp ignores bars at or before todayOpenTimestamp', () => {
  // Pré-condition : le bar AT todayOpenTimestamp est exclu (c'est le bar
  // qui crée le gap, il ne peut pas le filler par construction).
  const todayT = ts('2026-05-08', 13, 30);
  const fillT  = ts('2026-05-08', 14, 30);
  const bars = [
    { t: ts('2026-05-07', 19, 45), o: 99, h: 100, l: 99, c: 100, v: 1 },  // prev close, in zone
    { t: todayT,                   o: 102, h: 102, l: 100, c: 102, v: 1 }, // open bar TOUCHE la zone (l=100) — IGNORÉ
    { t: fillT,                    o: 102, h: 102, l: 101, c: 101.5, v: 1 }, // 1er bar APRÈS open
  ];
  const gap = { prevSessionClose: 100, todayOpen: 102, todayOpenTimestamp: todayT };
  // Bar at todayOpenTimestamp ignored. Next bar fills (l=101 in [100,102]).
  assert.strictEqual(findGapFillTimestamp(bars, gap), fillT);
});

test('findGapFillTimestamp returns the FIRST filling bar (not the last)', () => {
  const todayT  = ts('2026-05-08', 13, 30);
  const firstT  = ts('2026-05-08', 14, 0);
  const secondT = ts('2026-05-08', 14, 30);
  const bars = [
    { t: ts('2026-05-07', 19, 45), o: 99,  h: 100, l: 99,  c: 100, v: 1 },
    { t: todayT,                   o: 102, h: 102.5, l: 102, c: 102.3, v: 1 },
    { t: firstT,                   o: 102, h: 102, l: 101.8, c: 101.9, v: 1 }, // FIRST fill
    { t: secondT,                  o: 101.9, h: 102, l: 100.5, c: 101, v: 1 }, // second fill (deeper)
  ];
  const gap = { prevSessionClose: 100, todayOpen: 102, todayOpenTimestamp: todayT };
  assert.strictEqual(findGapFillTimestamp(bars, gap), firstT);
});
