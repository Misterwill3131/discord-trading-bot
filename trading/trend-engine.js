// ─────────────────────────────────────────────────────────────────────
// trading/trend-engine.js — Pure trend detection
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures : in = candles { t, o, h, l, c, v }, out = verdict.
// Aucune dépendance Discord/DB. Réutilisable par !trend (à la demande)
// et par trend-scanner (auto).
// ─────────────────────────────────────────────────────────────────────

const { calcEMA, calcEMASeries, calcRSI } = require('./indicators');

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

const DEFAULT_BREAKOUT_LOOKBACK = 20;
const DEFAULT_BREAKOUT_VOL_MULT = 1.5;

// Breakout : la dernière clôture casse le plus haut des `lookback` bougies
// précédentes ET le volume de la dernière bougie > `volMult` × moyenne des
// `lookback` volumes précédents. On utilise `c` (close) plutôt que `h` (high)
// pour exiger que le breakout "tienne" jusqu'à la fin de la bougie — évite
// les wicks.
function detectBreakout(candles, lookback = DEFAULT_BREAKOUT_LOOKBACK, volMult = DEFAULT_BREAKOUT_VOL_MULT) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const last = candles.length - 1;
  const lastBar = candles[last];
  const window = candles.slice(last - lookback, last); // exclut la dernière bougie
  let maxHigh = -Infinity;
  let sumVol = 0;
  for (const b of window) {
    if (Number.isFinite(b.h) && b.h > maxHigh) maxHigh = b.h;
    if (Number.isFinite(b.v)) sumVol += b.v;
  }
  if (!Number.isFinite(maxHigh)) return null;
  const avgVolume = sumVol / lookback;
  if (lastBar.c > maxHigh && lastBar.v > avgVolume * volMult) {
    return { type: 'breakout', high: maxHigh, volume: lastBar.v, avgVolume };
  }
  return null;
}

const DEFAULT_RSI_OVERBOUGHT = 70;
const DEFAULT_RSI_OVERSOLD   = 30;
const REVERSAL_RSI_WINDOW    = 3;   // RSI doit avoir touché l'extrême sur les 3 dernières bougies
const MIN_REVERSAL_BARS      = 21;  // 14 (RSI seed) + 6 (room) + 1

// Reversal : EMA9 vient de croiser EMA20 ET RSI a touché un extrême récent.
//   bearish : croisement EMA9 sous EMA20 + max(RSI) > overbought sur les
//             3 dernières bougies (peak RSI récent, retournement à la
//             baisse).
//   bullish : croisement EMA9 au-dessus EMA20 + min(RSI) < oversold sur
//             les 3 dernières bougies.
function detectReversal(candles, rsiOverbought = DEFAULT_RSI_OVERBOUGHT, rsiOversold = DEFAULT_RSI_OVERSOLD) {
  if (!Array.isArray(candles) || candles.length < MIN_REVERSAL_BARS) return null;
  const closes = candles.map(c => c.c);
  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);
  const last = candles.length - 1;
  const ema9Now = ema9Series[last];
  const ema9Prev = ema9Series[last - 1];
  const ema20Now = ema20Series[last];
  const ema20Prev = ema20Series[last - 1];
  if (ema9Now == null || ema9Prev == null || ema20Now == null || ema20Prev == null) return null;

  const crossedDown = ema9Prev >= ema20Prev && ema9Now < ema20Now;
  const crossedUp   = ema9Prev <= ema20Prev && ema9Now > ema20Now;
  if (!crossedDown && !crossedUp) return null;

  // RSI sur les 3 dernières bougies : on calcule à 3 points distincts en
  // tronquant la série à chaque longueur.
  const rsiWindow = [];
  for (let i = REVERSAL_RSI_WINDOW; i >= 1; i--) {
    const rsi = calcRSI(closes.slice(0, last - i + 2), 14);
    if (rsi != null) rsiWindow.push(rsi);
  }
  if (rsiWindow.length === 0) return null;
  const lastRsi = rsiWindow[rsiWindow.length - 1];

  if (crossedDown) {
    const peakRsi = Math.max(...rsiWindow);
    if (peakRsi > rsiOverbought) {
      return { type: 'bearish_reversal', rsi: lastRsi, ema9: ema9Now, ema20: ema20Now, peakRsi };
    }
  }
  if (crossedUp) {
    const troughRsi = Math.min(...rsiWindow);
    if (troughRsi < rsiOversold) {
      return { type: 'bullish_reversal', rsi: lastRsi, ema9: ema9Now, ema20: ema20Now, troughRsi };
    }
  }
  return null;
}

// Combines all detectors. Retourne `null` si pas assez de candles.
// Les paramètres (lookback, volume mult, RSI seuils) acceptent des
// overrides — utiles pour les tests et pour l'env tuning au runtime.
function detectAll(candles, opts = {}) {
  const direction = detectDirection(candles);
  if (direction === null) return null;  // pas assez de bars

  const events = [];
  const breakout = detectBreakout(candles, opts.breakoutLookback, opts.breakoutVolMult);
  if (breakout) events.push(breakout);
  const reversal = detectReversal(candles, opts.rsiOverbought, opts.rsiOversold);
  if (reversal) events.push(reversal);

  const closes = candles.map(c => c.c);
  const snapshot = {
    price: closes[closes.length - 1],
    ema9:  calcEMA(closes, 9),
    ema20: calcEMA(closes, 20),
    rsi:   calcRSI(closes, 14),
  };

  return { direction, events, snapshot };
}

// PDH break : intraday close > yesterday's high. Pure function — retourne
// { event, stateUpdate } sans muter `state`. Le scanner applique le delta.
//
// Logique de ré-entrée (cohérence avec le state machine PDH) :
//   - premier break du jour       → alert + alerts_today=1, below_since=null
//   - toujours au-dessus (déjà alerted, below_since=null) → no-op
//   - retombé sous PDH après alert → set below_since=now
//   - re-cassure après >= reentryMs sous PDH → alert + alerts_today++, below_since=null
//   - re-cassure rapide (< reentryMs)         → clear below_since (no alert)
function detectPDHBreak(intraday, pdh, state, reentryMs, now = Date.now()) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(pdh)) {
    return { event: null, stateUpdate: null };
  }
  const last = intraday[intraday.length - 1];
  const close = last.c;
  if (!Number.isFinite(close)) {
    return { event: null, stateUpdate: null };
  }

  const alertsToday = (state && state.pdh_alerts_today) || 0;
  const belowSince  = state && state.pdh_below_since;

  if (close > pdh) {
    if (alertsToday === 0) {
      return {
        event: { type: 'pdh_break', pdh, price: close, volume: last.v },
        stateUpdate: { pdh_alerts_today: 1, pdh_below_since: null },
      };
    }
    if (belowSince == null) {
      // Already above and already alerted today.
      return { event: null, stateUpdate: null };
    }
    if ((now - belowSince) >= reentryMs) {
      return {
        event: { type: 'pdh_break', pdh, price: close, volume: last.v },
        stateUpdate: { pdh_alerts_today: alertsToday + 1, pdh_below_since: null },
      };
    }
    // Quick recovery — clear without alerting.
    return { event: null, stateUpdate: { pdh_below_since: null } };
  }

  // close <= pdh
  if (alertsToday > 0 && belowSince == null) {
    return { event: null, stateUpdate: { pdh_below_since: now } };
  }
  return { event: null, stateUpdate: null };
}

// PDL break : intraday close < yesterday's low. Symétrique de detectPDHBreak,
// avec inversion < / > et utilisation des colonnes pdl_*.
function detectPDLBreak(intraday, pdl, state, reentryMs, now = Date.now()) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(pdl)) {
    return { event: null, stateUpdate: null };
  }
  const last = intraday[intraday.length - 1];
  const close = last.c;
  if (!Number.isFinite(close)) {
    return { event: null, stateUpdate: null };
  }

  const alertsToday = (state && state.pdl_alerts_today) || 0;
  const aboveSince  = state && state.pdl_above_since;

  if (close < pdl) {
    if (alertsToday === 0) {
      return {
        event: { type: 'pdl_break', pdl, price: close, volume: last.v },
        stateUpdate: { pdl_alerts_today: 1, pdl_above_since: null },
      };
    }
    if (aboveSince == null) {
      return { event: null, stateUpdate: null };
    }
    if ((now - aboveSince) >= reentryMs) {
      return {
        event: { type: 'pdl_break', pdl, price: close, volume: last.v },
        stateUpdate: { pdl_alerts_today: alertsToday + 1, pdl_above_since: null },
      };
    }
    return { event: null, stateUpdate: { pdl_above_since: null } };
  }

  // close >= pdl
  if (alertsToday > 0 && aboveSince == null) {
    return { event: null, stateUpdate: { pdl_above_since: now } };
  }
  return { event: null, stateUpdate: null };
}

module.exports = { detectDirection, detectBreakout, detectReversal, detectAll, detectPDHBreak, detectPDLBreak };
