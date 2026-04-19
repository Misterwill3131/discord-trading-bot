# Trading — Operational Notes

## Modes

- **paper** (default) — uses `PaperBroker` in-memory. No external connection needed. Safe to run anywhere.
- **live** — uses `IBKRBroker` via `@stoqey/ib`. Requires an IB Gateway or TWS process listening on `IBKR_PORT`.

Switch via the Config tab on `/trading` or by POSTing `{ mode: 'live' }` to `/api/trading/config`.

## Environment variables

Required only when `mode=live`:

- `IBKR_HOST` (default `127.0.0.1`)
- `IBKR_PORT` (default `4002` — IB Gateway paper; use `4001` for Gateway live, `7497`/`7496` for TWS paper/live)
- `IBKR_CLIENT_ID` (default `1`)

Required for market data (both modes):

- `ALPACA_KEY_ID`
- `ALPACA_SECRET_KEY`

Free Alpaca signup at [alpaca.markets](https://alpaca.markets/). You do **not** need a funded Alpaca trading account — market data is free with just an API key.

## IB Gateway / TWS setup

See [`trading-ibgateway-setup.md`](./trading-ibgateway-setup.md) for step-by-step Gateway installation and API configuration.

## Where the bot can run

- **Paper mode**: anywhere Node runs, including Railway (current deployment).
- **Live mode**: the bot must be able to reach IB Gateway's TCP port. Two realistic setups:
  - Bot + IB Gateway on the same VPS (Hetzner, DigitalOcean, or a home server).
  - Bot on Railway + IB Gateway on a separate VPS with firewall allowing Railway's egress.

## Kill-switch & panic

- **Kill-switch** (Positions tab) — flips `tradingEnabled` off. Existing positions keep their server-side trailing stop and take-profit; no new orders are placed.
- **Panic** (Positions tab) — closes all open positions at market and disables trading. Use when you see something wrong and want to cut all exposure now.

## Rollout sequence

1. `mode=paper`, whitelist 1 trusted author for 1 week. Audit `/trading/history` vs what a human would have done.
2. `mode=live`, `riskPerTradePct=0.25`, same whitelist, for a few days.
3. `riskPerTradePct=1.0` once confidence is established.

## Base currency note (Canadian accounts)

If your IBKR account is in CAD (like a typical Canadian IBKR account), `NetLiquidation` from the broker is in CAD. The engine computes risk per trade as `equity * riskPerTradePct / 100` — so "1% of 1M CAD" ≈ 10 000 CAD of risk per trade. US stocks trade in USD; IBKR performs FX conversion automatically.

If you prefer to size in USD directly, convert your capital mentally or adjust `riskPerTradePct` accordingly (e.g. `0.73` to target 1% of the USD equivalent).
