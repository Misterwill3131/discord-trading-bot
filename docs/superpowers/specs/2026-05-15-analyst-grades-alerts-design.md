# Wall Street Analyst Grade Alerts — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Scope:** Real-time alerts when Wall Street analysts upgrade or downgrade stocks. Two-tier filter: tickers on a watchlist (always alerted) + global feed (filtered to tier-1 firms with strong moves). Discord-posted, dedup-guarded, feature-flagged.

---

## 1. Goal

Today: the bot has no visibility into Wall Street analyst activity. When Morgan Stanley upgrades a stock the user watches, the operator finds out from Twitter or news minutes-to-hours later.

After this work: a new module polls FMP's `/upgrades-downgrades-rss-feed` every 15 minutes during US market hours, evaluates each event against a two-tier filter, and posts a Discord alert when it matches. Alerts dedup atomically by event ID. Feature-flagged via `ANALYST_ALERTS_ENABLED=true`.

## 2. Two-tier filter

Each FMP grade event is evaluated in this order:

1. **Is the ticker in the operator's watchlist?**
   - `watchlist = WATCHED_TICKERS (env var) ∪ tickers in analyst_watchlist DB table` (the latter has a 30-day TTL maintained by the existing milestone-checker)
   - If yes → alert with `source: 'watchlist'`, no further filtering. Operator wants to see EVERY grade change on tickers they're tracking.

2. **Otherwise, apply the tier-1 filter:**
   - Firm must be in `TIER_1_FIRMS` (configurable env var with a sensible default — see §5)
   - AND one of:
     - `|gradeMagnitude(newGrade) - gradeMagnitude(prevGrade)| >= 2` (a "strong" change like Hold→Buy or Hold→Sell)
     - OR initiation: `prevGrade` is empty AND `newGrade` is strongly directional (`Buy` / `Strong Buy` / `Sell` / `Strong Sell`)
   - If both pass → alert with `source: 'tier1-global'`

3. **Otherwise** → skip silently (no log, no Discord post, no DB write).

This keeps the signal-to-noise ratio high: any grade on a watched ticker is signal; on a non-watched ticker, only loud moves by big names get through.

## 3. Grade rank mapping

Different firms use different vocabularies. Map them all onto an integer scale:

```javascript
const GRADE_RANK = {
  // Strong sell tier
  'Strong Sell': 1,
  // Sell tier
  'Sell':         2, 'Underperform':   2, 'Underweight':  2,
  // Neutral tier
  'Hold':         3, 'Neutral':        3, 'Market Perform': 3,
  'Equal-Weight': 3, 'Equal Weight':   3, 'In-Line':      3, 'Inline':       3,
  // Buy tier
  'Buy':          4, 'Outperform':     4, 'Overweight':   4,
  'Accumulate':   4, 'Positive':       4,
  // Strong buy tier
  'Strong Buy':   5,
};
```

Unknown grades map to `null` and are treated as "no information" (no alert for unknown→unknown transitions; an alert if known→unknown or unknown→known happens, with magnitude defaulting to a safe value).

Matching is case-insensitive. Whitespace-trimmed. Hyphens optional (Equal-Weight = Equal Weight).

## 4. Determining the event action

FMP returns a free-text `action` field (`upgrade`, `downgrade`, `initiate`, `maintain`, `reiterated`, etc.). We don't trust it blindly — instead we derive the action from the grade transition:

```javascript
function deriveAction({ prevGrade, newGrade }) {
  const oldRank = rankOrNull(prevGrade);
  const newRank = rankOrNull(newGrade);
  if (oldRank == null && newRank != null) return 'initiate';
  if (oldRank == null || newRank == null) return 'reiterate';
  if (newRank > oldRank) return 'upgrade';
  if (newRank < oldRank) return 'downgrade';
  return 'reiterate';
}
```

`reiterate` events never trigger alerts (covered in §2 — the magnitude is 0).

## 5. Tier-1 firms

Default whitelist (configurable via `TIER_1_FIRMS` env var, comma-separated):

```
Goldman Sachs, JPMorgan, JP Morgan, Morgan Stanley,
BofA Securities, Bank of America, Wells Fargo, Citigroup, Citi,
Barclays, Deutsche Bank, UBS, Jefferies, Credit Suisse,
Evercore ISI, Cowen, Wedbush, Piper Sandler, RBC Capital,
Truist, Stifel, Raymond James, Oppenheimer
```

Matching is case-insensitive and uses substring match (so "Goldman Sachs Securities" still matches "Goldman Sachs"). Operators can override via env var. The default is intentionally generous — better to over-include than miss a tier-1 firm under a slightly different name.

## 6. Architecture (new modules)

### `discord/analyst-grades-feed.js` (~250 lines)

Public surface:
```javascript
function createAnalystGradesPoller({
  fmpClient,           // existing REST client from discord/fmp-client.js
  sendAlert,           // function(message) — same as market-alerts
  db,                  // db/sqlite — for dedup table + watchlist lookups
  watchlistProvider,   // function() → Set<UPPERCASE ticker>
  tier1Firms,          // Set<string> (lowercased)
  now,                 // function() → Date
  logger,
}) {
  return {
    tick(nowMs),       // poll feed, evaluate, dedup, send
    getStats(),        // diagnostics: events seen, alerts fired, last poll ts
  };
}
```

Pure subfunctions exposed for testing:
- `parseGradeEvent(rawFmpRow)` → normalized `{eventId, ticker, ts, firm, newGrade, prevGrade, priceTarget, prevPriceTarget, newsURL, priceWhenPosted}`
- `evaluate(event, { watchlist, tier1Firms, gradeRank })` → `{shouldAlert: bool, source: 'watchlist'|'tier1-global'|null, reason: 'magnitude2'|'initiation'|'in-watchlist'|null, action: 'upgrade'|...}`
- `buildMessage(event, { source, action })` → Discord-ready string
- `gradeRank(grade)` → `1..5 | null`

### `db/sqlite.js` (modify)

Add a new table `analyst_grade_alerts` to the schema bootstrap:

```sql
CREATE TABLE IF NOT EXISTS analyst_grade_alerts (
  event_id    TEXT PRIMARY KEY,
  ticker      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  firm        TEXT NOT NULL,
  action      TEXT NOT NULL,
  new_grade   TEXT,
  prev_grade  TEXT,
  source      TEXT NOT NULL,
  fired_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyst_grade_alerts_ts ON analyst_grade_alerts(ts);
```

Add 3 new exports:
- `markAnalystGradeFired({ event_id, ticker, ts, firm, action, new_grade, prev_grade, source, fired_at })` → returns `true` if INSERT OR IGNORE inserted (= we're first), `false` otherwise
- `getAnalystWatchlistTickers()` → returns `Set<UPPERCASE>` of currently-active (non-expired) tickers from the existing `analyst_watchlist` table
- (Optional) `recentAnalystGradeAlerts(limit)` for a future dashboard page (kept in scope for diagnostics, no UI yet)

### `discord/fmp-client.js` (modify)

Add one new method to the client returned by `createFmpClient`:

```javascript
async function getAnalystGradesFeed({ page = 0, limit = 100 } = {}) {
  // GET /api/v4/upgrades-downgrades-rss-feed?page={page}
  // Returns the array of grade events, newest-first.
}
```

The feed pagination is FMP's standard. We poll page 0 only (default ~100 events, far more than 15 min of activity).

### `discord/jobs.js` (modify)

Behind `ANALYST_ALERTS_ENABLED=true`, wire the poller next to the existing milestone checker. Tick every 15 minutes during RTH + one 06:00 ET pre-market tick to catch overnight downgrades.

## 7. Event ID for dedup

FMP doesn't expose a stable globally unique ID per grade event. We synthesize one:

```javascript
function eventId(event) {
  // Prefer the news URL if FMP gave one — it's unique-ish per article.
  if (event.newsURL && event.newsURL.length > 0) return event.newsURL;
  // Fall back to a deterministic key from the salient fields.
  return [
    event.symbol || event.ticker,
    event.gradingCompany || event.firm,
    event.publishedDate || event.ts,
    event.newGrade,
  ].map(s => String(s || '')).join('|');
}
```

The `analyst_grade_alerts.event_id` column is the primary key — an INSERT OR IGNORE makes the dedup atomic. Mark-then-send pattern (same as milestone-checker): record the event before sending the Discord message; if Discord fails, we lose the alert rather than spam.

## 8. Message format (English, per memory)

```
📈 **$NVDA** upgraded by Morgan Stanley — Hold → Buy (PT $750 → $900, +20%) — https://example.com/article
📉 **$INTC** downgraded by Goldman Sachs — Buy → Hold (PT $40 → $30, -25%) — https://example.com/article
🆕 **$ARM** coverage initiated by JPMorgan with Overweight (PT $150) — https://example.com/article
```

Format rules:
- Ticker bold + `$` prefix (matches existing market-alerts style)
- Firm name as-given by FMP (no normalization to defaults)
- Grade transition `prev → new` (or just `new` for initiate)
- Price target in parentheses, with % delta when both PT are present
- URL appended if available (FMP sometimes provides `newsURL`)

If `priceTarget` is missing (some firms only change the grade), omit the PT clause silently.

## 9. Operating hours

- Polling cadence: every 15 min during RTH (9:30 ET → 16:00 ET, Mon-Fri)
- Plus a single 06:00 ET pre-market poll to catch downgrades published overnight (most US firms publish before market open)
- Total: ~27 polls per trading day × 1 API call each = ~30/day. Negligible vs Premium quota.

Outside these windows, the `tick()` method early-returns (no API call, no DB write). Same `isRTH()` helper as `market-alerts.js`, with a special exception for the 06:00 pre-market tick (driven from `jobs.js` with a separate cron-style condition).

## 10. Channel destination

Reuse `TRADING_ALERTS_CHANNEL_ID` (the same channel used by `market-alerts.js`). No new env var. Operator wants all market-related alerts in one place.

## 11. Env vars (new)

| Variable | Default | Purpose |
|---|---|---|
| `ANALYST_ALERTS_ENABLED` | `false` | Feature flag. Default off — explicit opt-in. |
| `TIER_1_FIRMS` | (default list of ~23 firms) | Comma-separated whitelist for the tier-1 filter. Case-insensitive substring match. |
| `ANALYST_ALERTS_INTERVAL_MIN` | `15` | Polling cadence in minutes during RTH. |

Reuses existing: `FMP_API_KEY`, `TRADING_ALERTS_CHANNEL_ID`, `WATCHED_TICKERS`.

## 12. Tests

`discord/analyst-grades-feed.test.js`:
- `gradeRank` returns correct integer for each canonical grade
- `gradeRank` handles case/whitespace/hyphen variants
- `gradeRank` returns null for unknown grades
- `deriveAction`: upgrade / downgrade / initiate / reiterate cases
- `evaluate`: watchlist ticker always alerts (`source: 'watchlist'`)
- `evaluate`: non-watchlist + non-tier-1 firm → no alert
- `evaluate`: tier-1 firm + magnitude 2 → alert
- `evaluate`: tier-1 firm + magnitude 1 (Buy→Strong Buy) → no alert
- `evaluate`: tier-1 firm + initiate with `Buy` → alert
- `evaluate`: tier-1 firm + initiate with `Hold` → no alert (Hold initiation is not signal)
- `eventId` prefers newsURL, falls back to composite key
- `buildMessage` for each action type (upgrade/downgrade/initiate)
- `buildMessage` omits PT clause when missing
- `tick`: full integration test with injected fmpClient + db + sendAlert — confirms an alert fires exactly once on first run, never on second (dedup)

`db/sqlite.test.js` (extension):
- `markAnalystGradeFired` inserts on first call, returns true
- `markAnalystGradeFired` returns false on second call (same event_id)
- `getAnalystWatchlistTickers` returns expected set from the existing analyst_watchlist table

## 13. Failure modes

| Scenario | Behavior |
|---|---|
| FMP returns 4xx/5xx | Catch, log `[analyst-grades] feed fetch failed`, no DB write, next tick retries. |
| FMP returns malformed JSON | Catch, log, skip tick. |
| Event missing critical field (ticker, firm) | Skip that event, continue processing others. |
| Unknown grade in event | Map to `null`, derive action accordingly (likely 'reiterate' → no alert). |
| Discord send fails | Log, but dedup row stays — we explicitly prefer "lose one alert" over "spam 50 retries". |
| Network timeout on FMP | Reuse `fmp-client.js`'s 10s timeout (no new infra). |
| Bot offline during a grade publication | Permanent miss. Acceptable — alerts are real-time signals, not a queue. |

## 14. Backward compatibility

Default `ANALYST_ALERTS_ENABLED=false`. Existing prod (with milestone-checker + market-alerts) is untouched until operator opts in. To roll back: set to `false` and redeploy. The new SQLite table is created via CREATE IF NOT EXISTS — no data migration.

## 15. Out of scope

- Price target changes WITHOUT grade changes (some firms only adjust the target — could be a follow-up alert type)
- Consensus grade tracking (`Buy consensus shifted to Hold consensus` — interesting but slow signal)
- Dashboard page showing recent analyst alerts (DB Viewer covers this need for now)
- LLM sentiment analysis on the analyst's published rationale
- Tier-2 or tier-3 firms with different thresholds (could refine later)
- Filtering by sector or market cap
- Configurable alert format / templates from the dashboard (hardcoded for v1)
- Webhooks beyond Discord
- Cooldown per ticker (we rely on dedup by event_id — multiple firms upgrading the same ticker on the same day = multiple alerts, which is signal-rich)
- Pre-market alerts beyond the 06:00 ET tick (no after-hours polling)
- IBKR or other broker integration for the watchlist
- Coverage of non-US tickers (FMP Premium includes UK/Canada — could include them with a small filter change)
