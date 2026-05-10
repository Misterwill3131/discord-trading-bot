const { test } = require('node:test');
const assert = require('node:assert');
const { computeGapFromBars } = require('./gap-commands');

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
  const prevCloseT = ts('2026-05-07', 19, 30);
  const todayOpenT = ts('2026-05-08', 14, 30);
  const bars = [
    { t: ts('2026-05-07', 14, 30), o:  99, h: 100, l:  98, c:  99,  v: 1000 },
    { t: prevCloseT,               o:  99, h: 101, l:  99, c: 100,  v: 1500 },  // prev session close
    { t: todayOpenT,               o: 102, h: 103, l: 101, c: 102.5, v: 2000 }, // today open
    { t: ts('2026-05-08', 15, 30), o: 102.5, h: 104, l: 102, c: 103.5, v: 1800 },
  ];
  const gap = computeGapFromBars(bars);
  assert.ok(gap, 'should return non-null');
  assert.strictEqual(gap.prevSessionClose, 100);
  assert.strictEqual(gap.todayOpen, 102);
  assert.ok(Math.abs(gap.gapPct - 2.0) < 0.001, 'gapPct should be ~+2.0%, got ' + gap.gapPct);
  // Timestamps exposed for chart annotation (rectangle drawing in !gap chart)
  assert.strictEqual(gap.prevCloseTimestamp, prevCloseT);
  assert.strictEqual(gap.todayOpenTimestamp, todayOpenT);
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
