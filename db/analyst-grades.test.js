const { test } = require('node:test');
const assert = require('node:assert');
const db = require('./sqlite');

function resetTable() {
  db.db.exec('DELETE FROM analyst_grade_alerts');
}

test('markAnalystGradeFired inserts on first call and returns true', () => {
  resetTable();
  const result = db.markAnalystGradeFired({
    event_id: 'evt-1', ticker: 'AAPL', ts: '2026-05-15T12:00:00Z',
    firm: 'Morgan Stanley', action: 'upgrade',
    new_grade: 'Buy', prev_grade: 'Hold',
    source: 'watchlist', fired_at: '2026-05-15T12:00:01Z',
  });
  assert.strictEqual(result, true);
});

test('markAnalystGradeFired returns false on duplicate event_id', () => {
  resetTable();
  const payload = {
    event_id: 'evt-dup', ticker: 'AAPL', ts: '2026-05-15T12:00:00Z',
    firm: 'Morgan Stanley', action: 'upgrade',
    new_grade: 'Buy', prev_grade: 'Hold',
    source: 'watchlist', fired_at: '2026-05-15T12:00:01Z',
  };
  db.markAnalystGradeFired(payload);
  const second = db.markAnalystGradeFired(payload);
  assert.strictEqual(second, false);
});

test('markAnalystGradeFired accepts null prev_grade (initiations)', () => {
  resetTable();
  const result = db.markAnalystGradeFired({
    event_id: 'evt-init', ticker: 'ARM', ts: '2026-05-15T12:00:00Z',
    firm: 'JPMorgan', action: 'initiate',
    new_grade: 'Overweight', prev_grade: null,
    source: 'tier1-global', fired_at: '2026-05-15T12:00:01Z',
  });
  assert.strictEqual(result, true);
});

test('getAnalystWatchlistTickers returns a Set of UPPERCASE strings', () => {
  const result = db.getAnalystWatchlistTickers();
  assert.ok(result instanceof Set, 'should return a Set');
  for (const t of result) {
    assert.strictEqual(typeof t, 'string');
    assert.strictEqual(t, t.toUpperCase(), 'tickers should be uppercase');
  }
});

test('cleanup: empty the analyst_grade_alerts table', () => {
  resetTable();
});
