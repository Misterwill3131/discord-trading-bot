// ─────────────────────────────────────────────────────────────────────
// trading/indicators.js — RSI(14), EMA(N) sur un array de candles
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures. Historique minimal :
//   EMA(N)  : N bars (seed avec SMA des N premiers closes)
//   RSI(14) : 15 bars (14 diffs)
// ─────────────────────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// Retourne l'EMA calculée à chaque index : null pour les `period-1`
// premiers points (pas assez de bars pour seed la SMA), puis la valeur
// EMA pour chaque index suivant. Utilisé pour dessiner la ligne EMA
// complète sur un graphe, pas seulement la valeur finale.
function calcEMASeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { rsi: null, ema20: null, ema9: null, lastPrice: null };
  }
  const closes = candles.map(c => c.c);
  return {
    rsi: calcRSI(closes, 14),
    ema20: calcEMA(closes, 20),
    ema9: calcEMA(closes, 9),
    lastPrice: closes[closes.length - 1],
  };
}

module.exports = { calcEMA, calcEMASeries, calcRSI, computeIndicators };
