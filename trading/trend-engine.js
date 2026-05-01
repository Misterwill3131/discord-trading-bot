// ─────────────────────────────────────────────────────────────────────
// trading/trend-engine.js — Pure trend detection
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures : in = candles { t, o, h, l, c, v }, out = verdict.
// Aucune dépendance Discord/DB. Réutilisable par !trend (à la demande)
// et par trend-scanner (auto).
// ─────────────────────────────────────────────────────────────────────

const { calcEMASeries } = require('./indicators');

const SLOPE_LOOKBACK = 6;       // EMA20 slope mesurée sur 6 bougies
const MIN_DIRECTION_BARS = 26;  // 20 (EMA20 seed) + 6 (slope window)

// Direction du marché basée sur prix vs EMA20, EMA9 vs EMA20, et pente d'EMA20.
function detectDirection(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_DIRECTION_BARS) return null;
  const closes = candles.map(c => c.c);
  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);
  const last = candles.length - 1;
  const price = closes[last];
  const ema9 = ema9Series[last];
  const ema20 = ema20Series[last];
  const ema20Past = ema20Series[last - SLOPE_LOOKBACK];
  if (ema9 == null || ema20 == null || ema20Past == null) return null;

  if (price > ema20 && ema9 > ema20 && ema20 > ema20Past) return 'uptrend';
  if (price < ema20 && ema9 < ema20 && ema20 < ema20Past) return 'downtrend';
  return 'sideways';
}

module.exports = { detectDirection };
