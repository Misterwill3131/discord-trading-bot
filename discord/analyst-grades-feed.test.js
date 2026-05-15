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
