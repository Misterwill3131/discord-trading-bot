const { test } = require('node:test');
const assert = require('node:assert');

const { formatDateET } = require('./dates');

test('formatDateET returns YYYY-MM-DD in NY timezone — EDT case (May)', () => {
  // 2026-05-08 19:22 UTC = 2026-05-08 15:22 EDT (UTC-4 in DST)
  const d = new Date('2026-05-08T19:22:00Z');
  assert.strictEqual(formatDateET(d), '2026-05-08');
});

test('formatDateET returns YYYY-MM-DD in NY timezone — EST case (January)', () => {
  // 2026-01-15 04:00 UTC = 2026-01-14 23:00 EST (UTC-5)
  const d = new Date('2026-01-15T04:00:00Z');
  assert.strictEqual(formatDateET(d), '2026-01-14');
});

test('formatDateET handles UTC-day-rollover correctly', () => {
  // 2026-05-09 02:00 UTC = 2026-05-08 22:00 EDT
  const d = new Date('2026-05-09T02:00:00Z');
  assert.strictEqual(formatDateET(d), '2026-05-08');
});

test('formatDateET defaults to current time when no arg', () => {
  const result = formatDateET();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});
