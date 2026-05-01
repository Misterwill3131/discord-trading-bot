const { test } = require('node:test');
const assert = require('node:assert');
const { isUSMarketOpen } = require('./trend-scanner');

// Build a Date from a "wall-clock ET" specification by computing the
// corresponding UTC. The trick: hard-code the UTC offset for the case
// at hand (EST = -5, EDT = -4). Tests below use canonical examples.
//
// Helper: New York 2026-04-30 is in EDT (UTC-4).
// 2026-12-15 is in EST (UTC-5).
function utcFromET(yyyy, mm, dd, hh, mi, isDST) {
  const offset = isDST ? 4 : 5;
  return new Date(Date.UTC(yyyy, mm - 1, dd, hh + offset, mi, 0));
}

test('isUSMarketOpen: weekday 10:00 ET (EDT) is open', () => {
  const d = utcFromET(2026, 4, 30, 10, 0, true); // Thursday Apr 30, 2026
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 9:29 ET is closed (pre-open)', () => {
  const d = utcFromET(2026, 4, 30, 9, 29, true);
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 9:30 ET is open (boundary)', () => {
  const d = utcFromET(2026, 4, 30, 9, 30, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 16:00 ET is closed (boundary)', () => {
  const d = utcFromET(2026, 4, 30, 16, 0, true);
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 15:59 ET is open', () => {
  const d = utcFromET(2026, 4, 30, 15, 59, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: Saturday 12:00 ET is closed', () => {
  const d = utcFromET(2026, 5, 2, 12, 0, true); // Saturday May 2, 2026
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: Sunday 12:00 ET is closed', () => {
  const d = utcFromET(2026, 5, 3, 12, 0, true); // Sunday
  assert.strictEqual(isUSMarketOpen(d), false);
});

test('isUSMarketOpen: weekday 10:00 ET in winter (EST) is open', () => {
  const d = utcFromET(2026, 12, 15, 10, 0, false); // Tuesday Dec 15, 2026 (EST)
  assert.strictEqual(isUSMarketOpen(d), true);
});

test('isUSMarketOpen: weekday 10:00 ET on March DST switch day is open', () => {
  // 2026 DST starts Sunday March 8. Monday March 9 is EDT.
  const d = utcFromET(2026, 3, 9, 10, 0, true);
  assert.strictEqual(isUSMarketOpen(d), true);
});
