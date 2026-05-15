const { test } = require('node:test');
const assert = require('node:assert');
const {
  GRADE_RANK,
  gradeRank,
  deriveAction,
  eventId,
  evaluate,
  buildMessage,
} = require('./analyst-grades-feed');

// ── gradeRank ───────────────────────────────────────────────────────

test('gradeRank returns the correct integer for canonical grades', () => {
  assert.strictEqual(gradeRank('Strong Sell'), 1);
  assert.strictEqual(gradeRank('Sell'), 2);
  assert.strictEqual(gradeRank('Hold'), 3);
  assert.strictEqual(gradeRank('Buy'), 4);
  assert.strictEqual(gradeRank('Strong Buy'), 5);
});

test('gradeRank is case-insensitive and trims whitespace', () => {
  assert.strictEqual(gradeRank('  buy '), 4);
  assert.strictEqual(gradeRank('OUTPERFORM'), 4);
  assert.strictEqual(gradeRank('overweight'), 4);
});

test('gradeRank treats Equal-Weight / Equal Weight / Inline / In-Line as Hold-tier', () => {
  assert.strictEqual(gradeRank('Equal-Weight'), 3);
  assert.strictEqual(gradeRank('Equal Weight'), 3);
  assert.strictEqual(gradeRank('In-Line'), 3);
  assert.strictEqual(gradeRank('Inline'), 3);
  assert.strictEqual(gradeRank('Market Perform'), 3);
});

test('gradeRank returns null for unknown grades, null, empty, non-string', () => {
  assert.strictEqual(gradeRank('Frobnicate'), null);
  assert.strictEqual(gradeRank(''), null);
  assert.strictEqual(gradeRank(null), null);
  assert.strictEqual(gradeRank(undefined), null);
  assert.strictEqual(gradeRank(42), null);
});

// ── deriveAction ────────────────────────────────────────────────────

test('deriveAction: upgrade when new rank > old rank', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Hold', newGrade: 'Buy' }), 'upgrade');
  assert.strictEqual(deriveAction({ prevGrade: 'Sell', newGrade: 'Strong Buy' }), 'upgrade');
});

test('deriveAction: downgrade when new rank < old rank', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Buy', newGrade: 'Hold' }), 'downgrade');
  assert.strictEqual(deriveAction({ prevGrade: 'Strong Buy', newGrade: 'Sell' }), 'downgrade');
});

test('deriveAction: initiate when prevGrade is empty/null but newGrade is known', () => {
  assert.strictEqual(deriveAction({ prevGrade: '', newGrade: 'Buy' }), 'initiate');
  assert.strictEqual(deriveAction({ prevGrade: null, newGrade: 'Overweight' }), 'initiate');
});

test('deriveAction: reiterate when both ranks match', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Hold', newGrade: 'Neutral' }), 'reiterate');
  assert.strictEqual(deriveAction({ prevGrade: 'Buy', newGrade: 'Buy' }), 'reiterate');
});

test('deriveAction: reiterate when one grade is unknown', () => {
  assert.strictEqual(deriveAction({ prevGrade: 'Buy', newGrade: 'Frobnicate' }), 'reiterate');
  assert.strictEqual(deriveAction({ prevGrade: 'Frobnicate', newGrade: 'Buy' }), 'reiterate');
});

// ── eventId ─────────────────────────────────────────────────────────

test('eventId prefers newsURL when present', () => {
  const e = { symbol: 'AAPL', gradingCompany: 'MS', publishedDate: '2026-01-01', newGrade: 'Buy', newsURL: 'https://example.com/x' };
  assert.strictEqual(eventId(e), 'https://example.com/x');
});

test('eventId falls back to composite key when newsURL is missing', () => {
  const e = { symbol: 'AAPL', gradingCompany: 'MS', publishedDate: '2026-01-01', newGrade: 'Buy' };
  assert.strictEqual(eventId(e), 'AAPL|MS|2026-01-01|Buy');
});

test('eventId falls back to composite when newsURL is empty string', () => {
  const e = { symbol: 'AAPL', gradingCompany: 'MS', publishedDate: '2026-01-01', newGrade: 'Buy', newsURL: '' };
  assert.strictEqual(eventId(e), 'AAPL|MS|2026-01-01|Buy');
});

// ── evaluate ────────────────────────────────────────────────────────

const TIER1 = new Set(['goldman sachs', 'morgan stanley', 'jpmorgan']);

function makeEvent(overrides = {}) {
  return {
    symbol: 'AAPL',
    publishedDate: '2026-05-15T12:00:00Z',
    gradingCompany: 'Goldman Sachs',
    newGrade: 'Buy',
    previousGrade: 'Hold',
    priceTarget: 200,
    priceWhenPosted: 180,
    newsURL: 'https://example.com/article',
    action: 'upgrade',
    ...overrides,
  };
}

test('evaluate: watchlist ticker always alerts (source=watchlist)', () => {
  const watchlist = new Set(['AAPL']);
  const e = makeEvent({ gradingCompany: 'Some Tiny Boutique', newGrade: 'Buy', previousGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'watchlist');
});

test('evaluate: non-watchlist + non-tier1 firm → no alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Tiny Boutique LLC' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, false);
  assert.strictEqual(r.source, null);
});

test('evaluate: tier1 firm + magnitude 2 (Hold→Buy) → alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Morgan Stanley', previousGrade: 'Hold', newGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
  assert.strictEqual(r.reason, 'magnitude2');
});

test('evaluate: tier1 firm + magnitude 1 (Buy→Strong Buy) → no alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Morgan Stanley', previousGrade: 'Buy', newGrade: 'Strong Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, false);
});

test('evaluate: tier1 firm + initiate with Buy → alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'JPMorgan', previousGrade: '', newGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
  assert.strictEqual(r.reason, 'initiation');
});

test('evaluate: tier1 firm + initiate with Hold → no alert (Hold initiation is not signal)', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'JPMorgan', previousGrade: '', newGrade: 'Hold' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, false);
});

test('evaluate: tier1 firm + downgrade magnitude 2 (Buy→Sell) → alert', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Goldman Sachs', previousGrade: 'Buy', newGrade: 'Sell' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
});

test('evaluate: tier1 firm matched via substring (Goldman Sachs Securities → Goldman Sachs)', () => {
  const watchlist = new Set();
  const e = makeEvent({ gradingCompany: 'Goldman Sachs Securities', previousGrade: 'Hold', newGrade: 'Buy' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'tier1-global');
});

test('evaluate: case-insensitive watchlist match', () => {
  const watchlist = new Set(['AAPL']);
  const e = makeEvent({ symbol: 'aapl' });
  const r = evaluate(e, { watchlist, tier1Firms: TIER1 });
  assert.strictEqual(r.shouldAlert, true);
  assert.strictEqual(r.source, 'watchlist');
});

// ── buildMessage ────────────────────────────────────────────────────

test('buildMessage formats an upgrade with PT delta and URL', () => {
  const e = makeEvent({ previousGrade: 'Hold', newGrade: 'Buy',
    priceTarget: 240, priceWhenPosted: 180,
  });
  e.prevPriceTarget = 200;
  const msg = buildMessage(e, { action: 'upgrade' });
  assert.match(msg, /📈/);
  assert.match(msg, /\*\*\$AAPL\*\*/);
  assert.match(msg, /Goldman Sachs/);
  assert.match(msg, /Hold → Buy/);
  assert.match(msg, /\$200 → \$240/);
  assert.match(msg, /\+20\.0%/);
  assert.match(msg, /https:\/\/example\.com\/article/);
});

test('buildMessage formats a downgrade', () => {
  const e = makeEvent({ previousGrade: 'Buy', newGrade: 'Hold',
    priceTarget: 30, prevPriceTarget: 40 });
  const msg = buildMessage(e, { action: 'downgrade' });
  assert.match(msg, /📉/);
  assert.match(msg, /Buy → Hold/);
  assert.match(msg, /-25\.0%/);
});

test('buildMessage formats an initiation', () => {
  const e = makeEvent({ previousGrade: '', newGrade: 'Overweight',
    gradingCompany: 'JPMorgan', priceTarget: 150 });
  const msg = buildMessage(e, { action: 'initiate' });
  assert.match(msg, /🆕/);
  assert.match(msg, /initiated by JPMorgan/);
  assert.match(msg, /Overweight/);
  assert.match(msg, /\$150/);
});

test('buildMessage omits PT clause when priceTarget is missing', () => {
  const e = makeEvent({ priceTarget: null, prevPriceTarget: null });
  const msg = buildMessage(e, { action: 'upgrade' });
  assert.doesNotMatch(msg, /PT/);
  assert.doesNotMatch(msg, /\$\d+ → \$\d+/);
});

test('buildMessage omits URL when newsURL is missing', () => {
  const e = makeEvent({ newsURL: null });
  const msg = buildMessage(e, { action: 'upgrade' });
  assert.doesNotMatch(msg, /https/);
});

// ── createAnalystGradesPoller (integration) ─────────────────────────

const { createAnalystGradesPoller } = require('./analyst-grades-feed');

function makeMocks() {
  const sent = [];
  const fired = [];
  let nextMarkResult = true;
  return {
    fmpClient: {
      getAnalystGradesFeed: async () => [],
    },
    sendAlert: async (msg) => { sent.push(msg); },
    db: {
      markAnalystGradeFired: (payload) => { fired.push(payload); return nextMarkResult; },
      getAnalystWatchlistTickers: () => new Set(),
    },
    setFeedRows: function (rows) {
      this.fmpClient.getAnalystGradesFeed = async () => rows;
    },
    setNextMarkResult: function (b) { nextMarkResult = b; },
    sent,
    fired,
  };
}

test('tick: fires an alert on a watchlist event (single iteration)', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([{
    symbol: 'AAPL', gradingCompany: 'Tiny Firm',
    previousGrade: 'Hold', newGrade: 'Buy',
    priceTarget: 200, priceWhenPosted: 180,
    newsURL: 'https://example.com/x', publishedDate: '2026-05-15T12:00:00Z',
  }]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(),
    tier1Firms: new Set(['goldman sachs']),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(m.sent.length, 1);
  assert.match(m.sent[0], /\*\*\$AAPL\*\*/);
  assert.strictEqual(m.fired.length, 1);
  assert.strictEqual(m.fired[0].event_id, 'https://example.com/x');
  assert.strictEqual(m.fired[0].source, 'watchlist');
});

test('tick: skips events that don\'t match the filter', async () => {
  const m = makeMocks();
  m.setFeedRows([{
    symbol: 'XYZ', gradingCompany: 'Tiny Firm',
    previousGrade: 'Buy', newGrade: 'Strong Buy',
    publishedDate: '2026-05-15T12:00:00Z',
    newsURL: 'https://example.com/y',
  }]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(),
    tier1Firms: new Set(['goldman sachs']),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(m.sent.length, 0);
  assert.strictEqual(m.fired.length, 0);
});

test('tick: dedup — same event in feed twice fires only once', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([{
    symbol: 'AAPL', gradingCompany: 'Tiny Firm',
    previousGrade: 'Hold', newGrade: 'Buy',
    newsURL: 'https://example.com/dup', publishedDate: '2026-05-15T12:00:00Z',
  }]);
  let firstResult = true;
  m.db.markAnalystGradeFired = () => {
    const r = firstResult;
    firstResult = false;
    return r;
  };
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(),
    tier1Firms: new Set(),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  await poller.tick();
  assert.strictEqual(m.sent.length, 1, 'second tick should be deduped');
});

test('tick: hors RTH → early return, no FMP call', async () => {
  const m = makeMocks();
  let fetchCount = 0;
  m.fmpClient.getAnalystGradesFeed = async () => { fetchCount++; return []; };
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T03:00:00Z'),
    isRTH: () => false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(fetchCount, 0);
});

test('tick: FMP error is caught, no crash, no alerts', async () => {
  const m = makeMocks();
  m.fmpClient.getAnalystGradesFeed = async () => { throw new Error('FMP boom'); };
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  assert.strictEqual(m.sent.length, 0);
});

test('tick: respects forced ignoreRTH option (for pre-market 06:00 ET tick)', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([{
    symbol: 'AAPL', gradingCompany: 'Tiny Firm',
    previousGrade: 'Hold', newGrade: 'Buy',
    newsURL: 'https://example.com/x', publishedDate: '2026-05-15T12:00:00Z',
  }]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T10:00:00Z'),
    isRTH: () => false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick({ ignoreRTH: true });
  assert.strictEqual(m.sent.length, 1, 'pre-market tick should still fire');
});

test('getStats returns counters', async () => {
  const m = makeMocks();
  m.db.getAnalystWatchlistTickers = () => new Set(['AAPL']);
  m.setFeedRows([
    { symbol: 'AAPL', gradingCompany: 'X', previousGrade: 'Hold', newGrade: 'Buy', newsURL: 'a', publishedDate: 't' },
    { symbol: 'AAPL', gradingCompany: 'Y', previousGrade: 'Hold', newGrade: 'Buy', newsURL: 'b', publishedDate: 't' },
    { symbol: 'XYZ',  gradingCompany: 'Z', previousGrade: 'Buy',  newGrade: 'Buy', newsURL: 'c', publishedDate: 't' },
  ]);
  const poller = createAnalystGradesPoller({
    fmpClient: m.fmpClient, sendAlert: m.sendAlert, db: m.db,
    watchedTickers: new Set(), tier1Firms: new Set(),
    now: () => new Date('2026-05-15T14:00:00Z'),
    isRTH: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  await poller.tick();
  const stats = poller.getStats();
  assert.strictEqual(stats.eventsSeen, 3);
  assert.strictEqual(stats.alertsFired, 2);
  assert.strictEqual(typeof stats.lastPollTs, 'string');
});
