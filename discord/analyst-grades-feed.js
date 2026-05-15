// ─────────────────────────────────────────────────────────────────────
// discord/analyst-grades-feed.js — Wall Street analyst upgrades/downgrades
// ─────────────────────────────────────────────────────────────────────
// Poll FMP /api/v4/upgrades-downgrades-rss-feed every Nmin during RTH.
// Two-tier filter:
//   1. If ticker ∈ watchlist (WATCHED_TICKERS ∪ analyst_watchlist) → alert.
//   2. Else if firm ∈ TIER_1_FIRMS AND (|magnitude| >= 2 OR initiation
//      with directional grade) → alert.
//   3. Else → skip.
// Dedup via analyst_grade_alerts.event_id PK (mark-then-send).
//
// Spec : docs/superpowers/specs/2026-05-15-analyst-grades-alerts-design.md
// ─────────────────────────────────────────────────────────────────────

// Grade vocabulary → integer rank (1=Strong Sell .. 5=Strong Buy).
// Different firms use different terms; we normalize them all.
const GRADE_RANK = {
  'strong sell':    1,
  'sell':           2,
  'underperform':   2,
  'underweight':    2,
  'hold':           3,
  'neutral':        3,
  'market perform': 3,
  'equal-weight':   3,
  'equal weight':   3,
  'in-line':        3,
  'inline':         3,
  'buy':            4,
  'outperform':     4,
  'overweight':     4,
  'accumulate':     4,
  'positive':       4,
  'strong buy':     5,
};

// Case-insensitive, whitespace-trimmed lookup. Returns 1..5 or null.
function gradeRank(grade) {
  if (typeof grade !== 'string') return null;
  const key = grade.trim().toLowerCase();
  if (!key) return null;
  const r = GRADE_RANK[key];
  return r == null ? null : r;
}

// Compute action from grade transition. Doesn't trust FMP's free-text `action`.
function deriveAction({ prevGrade, newGrade }) {
  // Check if prevGrade is explicitly missing (empty string or null/undefined).
  const prevGradeExists = prevGrade != null && String(prevGrade).trim() !== '';
  const oldRank = gradeRank(prevGrade);
  const newRank = gradeRank(newGrade);
  // Only 'initiate' if prevGrade was explicitly missing AND newGrade is known.
  if (!prevGradeExists && newRank != null) return 'initiate';
  // If either is unknown (unrecognized grade string), it's a reiterate.
  if (oldRank == null || newRank == null) return 'reiterate';
  if (newRank > oldRank) return 'upgrade';
  if (newRank < oldRank) return 'downgrade';
  return 'reiterate';
}

// Synthesize a stable event ID for dedup. Prefer newsURL (unique per article)
// when present; fall back to composite key from salient fields.
function eventId(event) {
  if (event && typeof event.newsURL === 'string' && event.newsURL.length > 0) {
    return event.newsURL;
  }
  const parts = [
    event && (event.symbol || event.ticker),
    event && (event.gradingCompany || event.firm),
    event && (event.publishedDate || event.ts),
    event && event.newGrade,
  ];
  return parts.map(s => String(s == null ? '' : s)).join('|');
}

// Check if a firm name is in the tier-1 list (substring match, case-insensitive).
function isTier1Firm(firmName, tier1Firms) {
  if (typeof firmName !== 'string' || !tier1Firms) return false;
  const lower = firmName.toLowerCase();
  for (const tier1 of tier1Firms) {
    if (lower.includes(String(tier1).toLowerCase())) return true;
  }
  return false;
}

// Two-tier filter. Returns { shouldAlert, source, reason, action }.
function evaluate(event, { watchlist, tier1Firms } = {}) {
  if (!event) return { shouldAlert: false, source: null, reason: null, action: null };
  const action = deriveAction({ prevGrade: event.previousGrade, newGrade: event.newGrade });

  const tickerUpper = String(event.symbol || event.ticker || '').toUpperCase();

  // Tier 1: watchlist always alerts (even on reiterate).
  if (watchlist && watchlist.has && watchlist.has(tickerUpper)) {
    return { shouldAlert: true, source: 'watchlist', reason: 'in-watchlist', action };
  }

  // If not watchlist and action is reiterate, no alert.
  if (action === 'reiterate') {
    return { shouldAlert: false, source: null, reason: null, action };
  }

  // Tier 2: tier-1 firm + strong move.
  const firmName = event.gradingCompany || event.firm || '';
  if (!isTier1Firm(firmName, tier1Firms)) {
    return { shouldAlert: false, source: null, reason: null, action };
  }
  if (action === 'initiate') {
    const newRank = gradeRank(event.newGrade);
    // Directional initiation: Buy (4), Strong Buy (5), Sell (2), Strong Sell (1).
    if (newRank === 4 || newRank === 5 || newRank === 1 || newRank === 2) {
      return { shouldAlert: true, source: 'tier1-global', reason: 'initiation', action };
    }
    return { shouldAlert: false, source: null, reason: null, action };
  }
  // Upgrade or downgrade — check magnitude.
  // Alert if: |magnitude| >= 2, OR magnitude >= 1 AND moving FROM Hold (3).
  const oldRank = gradeRank(event.previousGrade);
  const newRank = gradeRank(event.newGrade);
  const magnitude = Math.abs((newRank || 0) - (oldRank || 0));
  if (magnitude >= 2 || (magnitude >= 1 && oldRank === 3)) {
    return { shouldAlert: true, source: 'tier1-global', reason: 'magnitude2', action };
  }
  return { shouldAlert: false, source: null, reason: null, action };
}

// Format price with 2 decimals + no trailing zeros (e.g. $200, $199.50, $1.05).
function fmtPrice(n) {
  if (!Number.isFinite(n)) return null;
  const s = (Math.round(n * 100) / 100).toString();
  return s;
}

// Compute % delta between two prices. Returns null if either is missing.
function pctDelta(prev, next) {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === 0) return null;
  return ((next - prev) / prev) * 100;
}

// Build the Discord message string for an alert.
function buildMessage(event, { action } = {}) {
  const ticker = String(event.symbol || event.ticker || '').toUpperCase();
  const firm = event.gradingCompany || event.firm || 'an analyst';
  const newGrade = event.newGrade || '';
  const prevGrade = event.previousGrade || '';
  const pt = event.priceTarget != null ? Number(event.priceTarget) : null;
  const prevPt = event.prevPriceTarget != null ? Number(event.prevPriceTarget) : null;
  const url = (typeof event.newsURL === 'string' && event.newsURL.length > 0) ? event.newsURL : null;

  let icon = '📊';
  let action_phrase = '';
  let transition = '';
  if (action === 'upgrade') {
    icon = '📈';
    action_phrase = 'upgraded by ' + firm;
    transition = prevGrade + ' → ' + newGrade;
  } else if (action === 'downgrade') {
    icon = '📉';
    action_phrase = 'downgraded by ' + firm;
    transition = prevGrade + ' → ' + newGrade;
  } else if (action === 'initiate') {
    icon = '🆕';
    action_phrase = 'coverage initiated by ' + firm + ' with ' + newGrade;
    transition = '';
  } else {
    action_phrase = 'grade change from ' + firm;
    transition = prevGrade + ' → ' + newGrade;
  }

  // PT clause.
  let ptClause = '';
  if (Number.isFinite(pt)) {
    if (Number.isFinite(prevPt) && prevPt > 0 && action !== 'initiate') {
      const delta = pctDelta(prevPt, pt);
      const sign = delta >= 0 ? '+' : '';
      ptClause = ' (PT $' + fmtPrice(prevPt) + ' → $' + fmtPrice(pt) + ', ' + sign + delta.toFixed(1) + '%)';
    } else {
      ptClause = ' (PT $' + fmtPrice(pt) + ')';
    }
  }

  let msg = icon + ' **$' + ticker + '** ' + action_phrase;
  if (transition) msg += ' — ' + transition;
  msg += ptClause;
  if (url) msg += ' — ' + url;
  return msg;
}

module.exports = {
  GRADE_RANK,
  gradeRank,
  deriveAction,
  eventId,
  evaluate,
  buildMessage,
  isTier1Firm,
};
