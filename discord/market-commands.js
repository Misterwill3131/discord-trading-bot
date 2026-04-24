// ─────────────────────────────────────────────────────────────────────
// discord/market-commands.js — Commandes market (Yahoo Finance)
// ─────────────────────────────────────────────────────────────────────
// Commandes globales :
//   !price TICKER           → quote live (prix, change%, volume, ranges, market cap)
//   !chart TICKER [RANGE]   → image PNG du graphe (1D/5D/1M/3M/6M/1Y)
//   !indicator TICKER       → RSI(14) + EMA(9) + EMA(20) sur candles 5min du jour
//
// Source unique : Yahoo Finance via `yahoo-finance2`. Cache mémoire
// TTL 30s + timeout 10s sur chaque appel externe.
// ─────────────────────────────────────────────────────────────────────

const VALID_RANGES = {
  '1D': { interval: '5m',  ms: 86_400_000 },
  '5D': { interval: '15m', ms: 5 * 86_400_000 },
  '1M': { interval: '1d',  ms: 30 * 86_400_000 },
  '3M': { interval: '1d',  ms: 90 * 86_400_000 },
  '6M': { interval: '1d',  ms: 180 * 86_400_000 },
  '1Y': { interval: '1d',  ms: 365 * 86_400_000 },
};

function parseRange(arg, now = new Date()) {
  const key = arg ? String(arg).toUpperCase() : '1D';
  const cfg = VALID_RANGES[key];
  if (!cfg) return null;
  return {
    interval: cfg.interval,
    period1: new Date(now.getTime() - cfg.ms),
  };
}

module.exports = { parseRange };
