const { test } = require('node:test');
const assert = require('node:assert');

const { jobToApiShape, buildVideoFilename } = require('./render-queue');

test('jobToApiShape converts snake_case DB row to camelCase API payload', () => {
  const dbRow = {
    id: 42,
    ticker: 'TSLA',
    entry_author: 'Z',
    entry_message: '$TSLA 150 entry long',
    entry_ts: '2026-04-25T13:32:00-04:00',
    exit_author: 'Z',
    exit_message: '$TSLA out +20%',
    exit_ts: '2026-04-25T16:30:00-04:00',
    pnl: '+20%',
  };
  const api = jobToApiShape(dbRow);
  assert.strictEqual(api.id, 42);
  assert.strictEqual(api.ticker, 'TSLA');
  assert.strictEqual(api.entryAuthor, 'Z');
  assert.strictEqual(api.entryMessage, '$TSLA 150 entry long');
  assert.strictEqual(api.entryTimestamp, '2026-04-25T13:32:00-04:00');
  assert.strictEqual(api.exitAuthor, 'Z');
  assert.strictEqual(api.exitMessage, '$TSLA out +20%');
  assert.strictEqual(api.exitTimestamp, '2026-04-25T16:30:00-04:00');
  assert.strictEqual(api.pnl, '+20%');
  // No leaked DB-only fields
  assert.strictEqual(api.entry_author, undefined);
  assert.strictEqual(api.status, undefined);
});

test('buildVideoFilename produces YYYY-MM-DD_HHMM_TICKER_chart-template.mp4', () => {
  const filename = buildVideoFilename('TSLA', '2026-04-25T16:30:00-04:00');
  // exit_ts is in NY tz (-04:00). 16:30 NY = 20:30 UTC. The function uses NY tz formatting.
  assert.match(filename, /^2026-04-25_\d{4}_TSLA_chart-template\.mp4$/);
});

test('buildVideoFilename uppercases ticker', () => {
  const filename = buildVideoFilename('tsla', '2026-04-25T16:30:00-04:00');
  assert.match(filename, /TSLA_chart-template\.mp4$/);
});
