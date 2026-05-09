const { test } = require('node:test');
const assert = require('node:assert');
const { renderGapChartPng } = require('./gap-chart');

// Helper: build a UTC ms timestamp for a wall-clock NY time. EDT (UTC-4)
// chosen for predictability — DST is handled by the renderer's Intl call.
function nyMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour + 4, minute);
}

// Build bars spanning yesterday afternoon → today morning (relative to now)
// so the renderer's "filterToFocusWindow" includes them. We use Date.now()
// as anchor to avoid the test breaking when clock changes.
function buildBarsRelativeToNow() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  // Yesterday: 8 bars from -28h to -16h ago (yesterday afternoon)
  // Today: 8 bars from -8h to 0h ago (today morning)
  const bars = [];
  for (let i = 0; i < 8; i++) {
    const t = now - (28 - i * 1.5) * oneHour;
    bars.push({ t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 });
  }
  for (let i = 0; i < 8; i++) {
    const t = now - (8 - i) * oneHour;
    bars.push({ t, o: 110 + i * 0.2, h: 111 + i * 0.2, l: 109 + i * 0.2, c: 110.5 + i * 0.2, v: 1500 });
  }
  return bars;
}

test('renderGapChartPng returns a Buffer for valid input', () => {
  const bars = buildBarsRelativeToNow();
  const png = renderGapChartPng({
    bars,
    prevSessionClose: 107,
    todayOpen: 110,
    gapPct: 2.8,
    ticker: 'AAPL',
  });
  assert.ok(Buffer.isBuffer(png), 'expected a Buffer');
  // PNG signature: 0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a
  assert.strictEqual(png[0], 0x89);
  assert.strictEqual(png[1], 0x50);
  assert.strictEqual(png[2], 0x4e);
  assert.strictEqual(png[3], 0x47);
});

test('renderGapChartPng works for negative gap (gap_down)', () => {
  const bars = buildBarsRelativeToNow();
  const png = renderGapChartPng({
    bars,
    prevSessionClose: 110,
    todayOpen: 107,
    gapPct: -2.7,
    ticker: 'TSLA',
  });
  assert.ok(Buffer.isBuffer(png));
});

test('renderGapChartPng returns null when fewer than 2 bars in focus window', () => {
  // All bars dated 2020 → outside the focus window (today/yesterday).
  const bars = [
    { t: nyMs(2020, 1, 1, 10, 0), o: 100, h: 101, l: 99, c: 100.5, v: 100 },
    { t: nyMs(2020, 1, 1, 10, 15), o: 100.5, h: 101, l: 100, c: 100.7, v: 100 },
  ];
  const png = renderGapChartPng({
    bars,
    prevSessionClose: 100,
    todayOpen: 102,
    gapPct: 2.0,
    ticker: 'AAPL',
  });
  assert.strictEqual(png, null);
});

test('renderGapChartPng returns null when prevSessionClose is missing', () => {
  const bars = buildBarsRelativeToNow();
  assert.strictEqual(renderGapChartPng({ bars, prevSessionClose: NaN, todayOpen: 110, gapPct: 1, ticker: 'X' }), null);
  assert.strictEqual(renderGapChartPng({ bars, prevSessionClose: null, todayOpen: 110, gapPct: 1, ticker: 'X' }), null);
});

test('renderGapChartPng returns null when gapPct is missing', () => {
  const bars = buildBarsRelativeToNow();
  assert.strictEqual(renderGapChartPng({ bars, prevSessionClose: 100, todayOpen: 110, gapPct: NaN, ticker: 'X' }), null);
});

test('renderGapChartPng returns null with empty bars array', () => {
  assert.strictEqual(renderGapChartPng({ bars: [], prevSessionClose: 100, todayOpen: 110, gapPct: 1, ticker: 'X' }), null);
});
