# FMP WebSocket — Stocks (Sub-project B1) Design Spec

**Date:** 2026-05-14
**Status:** Approved
**Scope:** Replace the REST polling that drives `discord/market-alerts.js` with an FMP WebSocket stream for stocks. Same alerts, same dedup, same Discord output — just real-time data instead of 5-min polling. Feature-flagged via env var so rollback is one variable away.

This is sub-project **B1** of the larger "FMP paid tier" initiative. Out of scope here: crypto/forex (B2), live dashboard (B3), trade-level events beyond the price/volume already used (B4).

---

## 1. Goal

Today: `jobs.js` arms `setInterval(MARKET_ALERTS_INTERVAL_MIN × 60_000)`. On each tick, `market-alerts.js` calls `marketClient.getQuote(ticker)` (a REST call to `/api/v3/quote/{symbol}` via `discord/fmp-client.js`). With the free FMP tier the default cadence is 5 minutes — alerts arrive up to 5 minutes after the market move.

After this work: a persistent FMP WebSocket connection streams trades for every ticker in `WATCHED_TICKERS`. An in-memory cache holds the latest price + cumulative day volume per ticker. The alert evaluator polls this cache every 5 seconds (configurable). Result: alerts fire within ~5 seconds of the market move, with NO REST quota pressure.

Behavior parity: same 5 alert types (`yday_high`, `yday_low`, `week_high`, `week_low`, `volume_spike`), same dedup `(ticker, alert_type, ET-date)`, same Discord message format, same RTH gating (09:30–16:00 ET only).

## 2. Architecture

```
                           FMP WebSocket
                           (paid tier — Premium)
                                  │
                                  │ trades stream (type='T')
                                  ▼
              ┌──────────────────────────────────┐
              │  discord/fmp-ws-client.js        │
              │  (raw protocol: login, sub,      │
              │   reconnect, parse, emit)        │
              └────────────┬─────────────────────┘
                           │ events: { ticker, price, tradeSize, ts }
                           ▼
              ┌──────────────────────────────────┐
              │  discord/fmp-ws-marketclient.js  │
              │  (in-memory cache + adapter to   │
              │   the marketClient contract)     │
              │                                  │
              │  Map<ticker, {                   │
              │    lastPrice,                    │
              │    lastTs,                       │
              │    cumulativeVolumeToday         │
              │  }>                              │
              │                                  │
              │  getQuote(t)     → cached state  │
              │  getDailyBars(t) → delegates to  │
              │                    REST fmp-client│
              └────────────┬─────────────────────┘
                           │ marketClient contract (unchanged)
                           ▼
              ┌──────────────────────────────────┐
              │  discord/market-alerts.js        │
              │  (unchanged — same evaluate,     │
              │   same dedup, same buildMessage) │
              └──────────────────────────────────┘
```

The hybrid design — **WS streams into memory, polling evaluates against memory** — keeps `market-alerts.js` untouched. The WS layer is a drop-in replacement for the REST `marketClient`.

Why not pure event-driven (evaluate on every WS tick)?
- A liquid ticker (AAPL) can fire 10+ trades/second. Evaluating + SQLite-dedup-checking + Discord-sending on every tick is wasteful — dedup catches the spam but we still pay the CPU.
- Decoupling poll-eval from data-streaming keeps the alert engine simple and unchanged.
- A 5-second evaluation cadence is functionally indistinguishable from event-driven for our use case (operator notification, not arbitrage).

## 3. New modules

### `discord/fmp-ws-client.js` (~300 lines)

Raw FMP WebSocket protocol. No knowledge of market alerts. Emits typed events.

Public surface:
```javascript
function createFmpWsClient({
  apiKey,                   // FMP API key (required)
  tickers = [],             // initial subscription list (lowercased internally)
  endpoint = 'wss://websockets.financialmodelingprep.com',
                            // override-able for tests
  WebSocketImpl,            // injectable — defaults to `ws` package
  reconnectMinMs = 1_000,   // initial backoff
  reconnectMaxMs = 30_000,  // max backoff
  reconnectMaxAttempts = 0, // 0 = retry forever
  logger = console,
}) {
  // Returns an EventEmitter-like object:
  //   client.start()                  → opens connection, logs in, subscribes
  //   client.stop()                   → closes connection, no more events
  //   client.subscribe(tickers)       → adds tickers (sends subscribe msg if connected)
  //   client.unsubscribe(tickers)     → drops tickers
  //   client.on('trade', cb)          → cb({ ticker, price, tradeSize, ts })
  //   client.on('connected', cb)      → cb()  fires on each successful login
  //   client.on('disconnected', cb)   → cb(reason)
  //   client.on('error', cb)          → cb(err)
  //   client.getStatus()              → { connected, attemptCount, subscribedTickers }
}
```

Protocol details (verified from FMP docs):
- **Endpoint** for stocks: `wss://websockets.financialmodelingprep.com`. Crypto uses `wss://crypto.financialmodelingprep.com`. The default in code is the stocks one; configurable so we can swap or mock.
- **Login**: `{"event":"login","data":{"apiKey":"<key>"}}` sent first.
- **Subscribe**: `{"event":"subscribe","data":{"ticker":["aapl","msft"]}}` (lowercase, array). Sent after login is acknowledged. The client buffers `subscribe` calls until login is confirmed.
- **Incoming trade**: `{s, t, type, lp, ls, ...}` where `type='T'` is last trade, `s` is the lowercase ticker, `lp` is the price, `ls` is the trade size, `t` is timestamp (ms epoch). The client emits `'trade'` with `{ ticker: s.toUpperCase(), price: lp, tradeSize: ls, ts: t }`.
- **Other message types** (`type='Q'` quote, `type='B'` trade break) are ignored in B1.
- **Heartbeat**: WS native ping/pong handled by the `ws` package automatically. If the server doesn't respond, the socket errors out and we reconnect.
- **Reconnect**: on any close/error, schedule a reconnect with exponential backoff (`reconnectMinMs` × 2^attemptCount, capped at `reconnectMaxMs`). On reconnect, re-login then re-subscribe to all currently-subscribed tickers.

Dependency: `ws` (npm package, ~250 KB). Already used by `node-fetch`? Not directly — `ws` is a new dependency. Add to `package.json`. No native compilation needed.

### `discord/fmp-ws-marketclient.js` (~150 lines)

Adapter that implements the `marketClient` contract using the WS client + REST fallback for daily bars.

Public surface:
```javascript
function createFmpWsMarketClient({
  apiKey,                   // FMP API key (used for both WS auth and REST fallback)
  tickers,                  // initial watchlist
  restClient,               // existing REST fmp-client instance, for getDailyBars
  wsClient,                 // injectable for tests; default = createFmpWsClient(...)
  now = () => new Date(),
  logger = console,
}) {
  // Internal: Map<TICKER_UPPERCASE, { lastPrice, lastTs, cumulativeVolumeToday, etDateOfCumulative }>
  // Wires wsClient.on('trade', ...) to update the cache.
  //
  // Returns the marketClient contract:
  //   getQuote(ticker)      → { price, volume } from cache, or null if no data yet
  //   getDailyBars(ticker)  → delegates to restClient.getDailyBars
  //
  // Plus:
  //   start()               → starts the WS client
  //   stop()                → stops the WS client
  //   getStatus()           → diagnostic for /alertstatus
}
```

**Cumulative volume reset**: on each incoming trade, if `etDateOfCumulative` for that ticker differs from "today's ET date", reset `cumulativeVolumeToday = 0` before adding the new trade size. This handles the 00:00 ET rollover correctly without a separate scheduler.

Why this works: `getETDateKey(now)` is called once per trade — if the ticker hasn't traded since yesterday and gets its first trade today, the comparison `etDateOfCumulative !== todayKey` is true → reset → add `ls`. Subsequent trades the same day match → just accumulate.

**Pre-market handling**: FMP streams trades from 8 AM ET, but RTH starts at 9:30 AM. Two options for pre-market trades:
- **Option A** (chosen): accumulate from 9:30 AM ET only. Pre-market trades (8:00–9:30) are skipped for the volume counter — we compare against yesterday's regular-session volume, so including pre-market would inflate the count.
- Option B (rejected): accumulate from 8:00 AM. Simpler code, but volume_spike fires earlier and from a different baseline. Confusing.

Implementation: when handling a trade, if `now.ET < 09:30`, update `lastPrice`/`lastTs` (for chart context) but skip the volume accumulation. Once `now.ET ≥ 09:30`, start accumulating.

**Cold start**: when `getQuote(ticker)` is called before the first trade has been seen (e.g., before market open, or just after WS connection), returns `null`. `market-alerts.js` already handles `null` gracefully (no alert, no error). No fallback REST call here — keep the layer simple.

### Test files

- `discord/fmp-ws-client.test.js` — unit tests with a fake WebSocket implementation:
  - login message format
  - subscribe queued before login, sent after login
  - parse trade message → emit 'trade' with right shape
  - non-T messages are ignored
  - reconnect with backoff after error
  - resubscribe on reconnect
  - subscribe/unsubscribe after running
- `discord/fmp-ws-marketclient.test.js` — unit tests with an injected `wsClient` (just an EventEmitter):
  - on('trade') updates the cache
  - getQuote returns the cached price + volume
  - getQuote returns null before any trade
  - cumulativeVolumeToday accumulates within a day
  - cumulativeVolumeToday resets at the next ET-date
  - pre-market trades update lastPrice but NOT volume

## 4. Wiring in `discord/jobs.js`

Currently `jobs.js` does:
```javascript
const marketClient = createFmpClient({ apiKey: fmpKey });
marketAlerts = createMarketAlertsScheduler({ marketClient, sendAlert, tickers });
```

After this work:
```javascript
const useWs = process.env.FMP_WS_ENABLED === 'true';
const restClient = createFmpClient({ apiKey: fmpKey });
const marketClient = useWs
  ? createFmpWsMarketClient({ apiKey: fmpKey, tickers, restClient })
  : restClient;
marketAlerts = createMarketAlertsScheduler({ marketClient, sendAlert, tickers });
if (useWs) marketClient.start();
```

The existing free-tier budget warning (lines 220-226 of `jobs.js`) is skipped when `useWs` is true (no REST calls for quotes when WS is on).

**Cadence change**: when `useWs=true`, the alert evaluation cadence drops from `MARKET_ALERTS_INTERVAL_MIN × 60s` (default 5 min) to a new constant `MARKET_ALERTS_EVAL_INTERVAL_SEC` (default 5 sec). New env var `MARKET_ALERTS_EVAL_INTERVAL_SEC` overrides if set. Implementation: in `market-alerts.js`, the existing `tick(now)` method is unchanged — `jobs.js` just calls it more frequently when WS is on.

## 5. Fallback strategy

If the WS connection drops repeatedly (>10 reconnect attempts in 5 minutes), `fmp-ws-marketclient` logs an error and SWITCHES the internal `getQuote()` to call `restClient.getQuote(ticker)` directly. WS continues to retry in the background; on the next successful reconnect, switch back to the cache.

Operator-visible: `/alertstatus` command shows the current data source (`ws` or `rest-fallback`) and reconnect attempt count.

Why not just stop alerting on WS failure: the bot must keep working. The REST fallback at 5s cadence will hit rate limits quickly — but Premium FMP allows ~3000 req/min, plenty for a 10-ticker watchlist at 5s cadence (10 × 12 calls/min = 120 calls/min). Acceptable degraded mode.

## 6. Env vars (new)

| Variable | Default | Purpose |
|---|---|---|
| `FMP_WS_ENABLED` | `false` | Feature flag — set to `true` to use WS instead of REST polling. |
| `FMP_WS_ENDPOINT` | `wss://websockets.financialmodelingprep.com` | Override the WS URL — used to point at a mock server in tests or if FMP changes the URL. |
| `MARKET_ALERTS_EVAL_INTERVAL_SEC` | `5` when WS enabled, otherwise unused (legacy `MARKET_ALERTS_INTERVAL_MIN × 60` still drives REST mode) | How often the alert evaluator polls the in-memory cache. |
| `FMP_WS_RECONNECT_MAX_MS` | `30000` | Max backoff between reconnect attempts. |

Existing `FMP_API_KEY` is reused (same key works for REST and WS on Premium).

## 7. Data flow on the happy path

1. **Boot**: `jobs.js` sees `FMP_WS_ENABLED=true`, creates the marketclient, calls `start()`. The WS client opens the socket, sends login, then subscribe (for all `WATCHED_TICKERS`).
2. **FMP server** responds with trade messages as they happen on the market.
3. **WS client** parses each `type='T'` message and emits `'trade'` with `{ ticker, price, tradeSize, ts }`.
4. **Marketclient** receives the event, updates `cache.get(ticker) = { lastPrice: price, lastTs: ts, cumulativeVolumeToday: prev + tradeSize }` (with the ET-date reset logic above).
5. **Every 5 seconds**, `market-alerts.tick(now)` runs. For each ticker, it calls `marketClient.getQuote(ticker)` (reads from cache) and `marketClient.getDailyBars(ticker)` (delegates to REST — daily-cached so 1 call/ticker/day max). Evaluates the 5 alert types. SQLite dedup ensures each `(ticker, type, ET-date)` fires once.
6. On a fire: build the message, send to Discord. Same exact wire format as today.

## 8. Tests

Following project conventions (node:test, no jest):

`discord/fmp-ws-client.test.js`:
1. Login message is sent with the exact JSON shape on connect
2. Subscribe is BUFFERED before login response; flushed after
3. Subscribe message contains the lowercased tickers as an array
4. Incoming trade message `{s:'aapl', t:1, type:'T', lp:100, ls:50}` emits `'trade'` with `{ ticker:'AAPL', price:100, tradeSize:50, ts:1 }`
5. Non-T messages (type='Q', type='B', or no `type`) do NOT emit 'trade'
6. On socket close, schedule reconnect with backoff (first attempt at `reconnectMinMs`, second at 2×, etc.)
7. On reconnect, re-login then re-subscribe to all previously-subscribed tickers
8. `subscribe([newTicker])` after running sends a subscribe message immediately
9. `unsubscribe([oldTicker])` removes from internal set + sends unsubscribe message

`discord/fmp-ws-marketclient.test.js`:
1. `getQuote('AAPL')` returns `null` before any trade arrives
2. After a trade `{ticker:'AAPL', price:100, tradeSize:50, ts:<within RTH>}`, `getQuote('AAPL')` returns `{ price:100, volume:50 }`
3. After two trades same day (within RTH), `getQuote.volume` is the SUM of the two `tradeSize`
4. After two trades on different ET-dates, the cumulative volume RESETS (= only the second trade's `tradeSize`)
5. Pre-market trade (now=08:30 ET): `lastPrice` updates but `volume` stays 0
6. RTH trade after pre-market trade: `volume` starts from this trade's `tradeSize` (pre-market not counted)
7. `getDailyBars('AAPL')` delegates to `restClient.getDailyBars` and returns its result
8. `start()` calls `wsClient.start()`; `stop()` calls `wsClient.stop()`

No end-to-end "actual WS connection" tests (would require a real FMP API key and is non-deterministic). Manual smoke verification at deploy time.

## 9. Failure modes & recovery

| Scenario | Behavior |
|---|---|
| WS connection refused at boot | Backoff retry. Until first success, `getQuote` returns null → no alerts. After 10 failures in 5 min, log + flip to REST fallback. |
| WS connection drops mid-day | Schedule reconnect with backoff. Cache stays warm during the gap (last known price/volume). On reconnect, re-login + resubscribe. If reconnect succeeds within 5 min, no fallback. |
| FMP sends a malformed message | Try/catch around JSON.parse + the message handler. Log + skip. No crash. |
| Tickers added to `WATCHED_TICKERS` after boot | Today: not supported. Bot must restart to pick up changes. Out of scope to make this dynamic in B1. |
| API key invalid | Login response indicates error → emit 'error' event with message → flip to REST fallback. |

## 10. Backward compatibility

Default `FMP_WS_ENABLED=false`. Existing prod (with the polling) is untouched until the operator opts in. To roll back: set `FMP_WS_ENABLED=false` (or remove the var) and redeploy. No DB migration, no schema changes.

The REST `fmp-client.js` is NOT modified by this work. It stays as both the daily-bars source (always) and the quote source (when WS disabled or in fallback).

## 11. Performance considerations

- One persistent TCP/WS connection. Negligible memory (~10 KB for the socket + ~100 bytes/ticker in cache).
- Trade events: a 10-ticker watchlist on a busy day = ~5-50 events/sec across all tickers. Each event is a few hundred bytes of JSON, parsed and stored in a Map. Node handles this without breaking a sweat.
- The 5-second evaluation tick runs O(tickers) work — for each ticker, one Map read + the existing evaluate() pure function + one SQLite check per fired alert. Bounded.
- Daily bars are still cached per `(ticker, ET-date)` — one REST call per ticker per day max. No change from today.

## 12. Out of scope (per B1 scope, deferred to follow-up subprojects)

- **Crypto/forex WS** (B2). FMP supports separate endpoints — would need a second client instance.
- **Live dashboard** (B3). Stream quotes to the dashboard via SSE.
- **Trade-level events** (B4). Per-trade volume spike detection (vs. cumulative).
- **Pre-market alerts**. Stays gated to RTH only.
- **Dynamic ticker management** (add/remove without restart).
- **Order book / level-2 data** (`type='Q'` messages). Ignored.
- **Multiple WS regions / failover between FMP endpoints**.
- **Webhook delivery of alerts** (currently only Discord).
