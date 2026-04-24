// ─────────────────────────────────────────────────────────────────────
// trading/indicators.js — RSI(14), EMA(N), VWAP sur un array de candles
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures. Historique minimal :
//   EMA(N)  : N bars (seed avec SMA des N premiers closes)
//   RSI(14) : 15 bars (14 diffs)
//   VWAP    : 1 bar valide avec volume > 0 (anchored depuis la 1re bougie
//             de la série — pas de reset par session)
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

// VWAP cumulé (anchored) : Σ(typical_price × volume) / Σ(volume) avec
// typical_price = (H+L+C)/3, ancré depuis la 1re bougie valide.
// Retourne un array de même longueur que `bars`. Sur un bar sans volume
// exploitable, on ne modifie pas le cumul (donc le ratio est inchangé)
// et on reprend la dernière valeur VWAP connue — la ligne reste
// continue. Tant qu'aucun bar valide n'a été vu, on retourne null.
function calcVWAPSeries(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const out = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  let lastVwap = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const h = b && b.h, l = b && b.l, c = b && b.c, v = b && b.v;
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)
        || !Number.isFinite(v) || v <= 0) {
      if (lastVwap != null) out[i] = lastVwap;   // carry forward
      continue;
    }
    const tp = (h + l + c) / 3;
    cumPV += tp * v;
    cumV += v;
    lastVwap = cumPV / cumV;
    out[i] = lastVwap;
  }
  return out;
}

function computeIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { rsi: null, ema20: null, ema9: null, vwap: null, lastPrice: null };
  }
  const closes = candles.map(c => c.c);
  const vwapSeries = calcVWAPSeries(candles);
  // VWAP final = dernière valeur non-null de la série.
  let vwap = null;
  for (let i = vwapSeries.length - 1; i >= 0; i--) {
    if (vwapSeries[i] != null) { vwap = vwapSeries[i]; break; }
  }
  return {
    rsi: calcRSI(closes, 14),
    ema20: calcEMA(closes, 20),
    ema9: calcEMA(closes, 9),
    vwap,
    lastPrice: closes[closes.length - 1],
  };
}

module.exports = { calcEMA, calcEMASeries, calcRSI, calcVWAPSeries, computeIndicators };
