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

// Filtre les bougies pour ne garder que celles dans la session régulière
// (9:30-16:00 ET). Yahoo retourne les bougies premarket (4:00 ET) et
// after-hours (jusqu'à 20:00 ET) à cause de includePrePost: true côté
// client. Ces bougies hors-RTH faussent le calcul du gap (qui doit
// utiliser l'open RTH, pas l'open premarket) et du volume cumulé du
// jour (qui doit refléter le volume de la session, pas l'extended).
//
// Implementation : utilise Intl.DateTimeFormat timezone NY pour gérer
// DST automatiquement. Si une bougie n'a pas de `t` numérique (cas de
// fixtures de test avec t=0,1,2...), elle n'est pas filtrée — la
// fonction garde son comportement original via fallback côté détecteur.
function filterToRTH(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.filter(bar => {
    if (!bar || !Number.isFinite(bar.t)) return false;
    const date = new Date(bar.t);
    if (isNaN(date.getTime())) return false;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    let hour = 0, minute = 0;
    for (const p of parts) {
      if (p.type === 'hour') hour = parseInt(p.value, 10);
      else if (p.type === 'minute') minute = parseInt(p.value, 10);
    }
    if (hour === 24) hour = 0;
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
}

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

// Combines all detectors. Retourne `null` si pas assez de candles pour
// detectDirection (gating). Sinon retourne :
//   { direction, events: [...], snapshot: {...}, stateUpdates: {...} }
//
// dailyContext (optionnel) : { yesterday: { high, low, close, volume }, ... }
//   Si null → les 4 détecteurs PDH/PDL/gap/volume sont skippés (mais
//   direction/breakout/reversal continuent).
//
// state (optionnel) : la ligne trend_state actuelle, lue par les détecteurs
//   PDH/PDL/gap/volume pour décider de fire-or-not.
function detectAll(candles, dailyContext = null, state = null, opts = {}) {
  const direction = detectDirection(candles);
  if (direction === null) return null;

  const events = [];
  const stateUpdates = {};

  const breakout = detectBreakout(candles, opts.breakoutLookback, opts.breakoutVolMult);
  if (breakout) events.push(breakout);

  const reversal = detectReversal(candles, opts.rsiOverbought, opts.rsiOversold);
  if (reversal) events.push(reversal);

  if (dailyContext && dailyContext.yesterday) {
    const y = dailyContext.yesterday;
    const reentryMs = Number.isFinite(opts.reentryMs) ? opts.reentryMs : 15 * 60_000;
    const gapThresholdPct = Number.isFinite(opts.gapThresholdPct) ? opts.gapThresholdPct : 1.0;
    const volumeMultiplier = Number.isFinite(opts.volumeMultiplier) ? opts.volumeMultiplier : 1.05;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    // priorHigh / priorLow = max/min sur les 2 dernières daily bars (yesterday +
    // dayBefore). Fallback sur yesterday.high/low si dailyContext n'a pas le
    // champ (ex. ancien getDailyContext, ticker très jeune avec 2 quotes).
    const priorHigh = Number.isFinite(dailyContext.priorHigh) ? dailyContext.priorHigh : y.high;
    const priorLow  = Number.isFinite(dailyContext.priorLow)  ? dailyContext.priorLow  : y.low;
    // gapPrevClose = close after-hours d'hier (~20:00 ET) si dispo, sinon
    // fallback sur la close RTH d'hier (16:00). Permet de mesurer le vrai
    // gap overnight (premarket open vs after-hours close).
    const gapPrevClose = Number.isFinite(dailyContext.prevSessionClose)
      ? dailyContext.prevSessionClose
      : y.close;
    const detectors = [
      () => detectPDHBreak(candles, priorHigh, state, reentryMs, now),
      () => detectPDLBreak(candles, priorLow,  state, reentryMs, now),
      () => detectGap(candles, gapPrevClose, gapThresholdPct, state),
      () => detectVolumeAbovePrevDay(candles, y.volume, volumeMultiplier, state),
    ];
    // PMH/PML break — calculé à partir de l'intraday lui-même (pas du daily
    // context). Si pas de bougie premarket exploitable (ticker peu liquide,
    // ou fixtures de test), on skip silencieusement les 2 détecteurs.
    const pmRange = getPremarketRange(candles);
    if (pmRange) {
      detectors.push(() => detectPMHBreak(candles, pmRange.pmh, state, reentryMs, now));
      detectors.push(() => detectPMLBreak(candles, pmRange.pml, state, reentryMs, now));
    }
    for (const run of detectors) {
      const { event, stateUpdate } = run();
      if (event) events.push(event);
      if (stateUpdate) Object.assign(stateUpdates, stateUpdate);
    }
  }

  const closes = candles.map(c => c.c);
  const snapshot = {
    price: closes[closes.length - 1],
    ema9:  calcEMA(closes, 9),
    ema20: calcEMA(closes, 20),
    rsi:   calcRSI(closes, 14),
  };

  return { direction, events, snapshot, stateUpdates };
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

// Helper : minutes ET (0-1439) depuis 00:00 ET pour un bar. Retourne null si
// le timestamp n'est pas exploitable (cas des fixtures de tests qui utilisent
// t = 0,1,2... sans timestamps réels).
function _etMinutes(bar) {
  if (!bar || !Number.isFinite(bar.t)) return null;
  const date = new Date(bar.t);
  if (isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  let hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

// Premarket = 4:00 ET (inclusif) à 9:30 ET (exclusif). Bars sans timestamp
// exploitable retournent false (= ignorées).
function isPremarketBar(bar) {
  const m = _etMinutes(bar);
  return m != null && m >= 4 * 60 && m < 9 * 60 + 30;
}

// RTH = 9:30 ET (inclusif) à 16:00 ET (exclusif).
function isRTHBar(bar) {
  const m = _etMinutes(bar);
  return m != null && m >= 9 * 60 + 30 && m < 16 * 60;
}

// Calcule PMH (premarket high) / PML (premarket low) du jour à partir de
// l'intraday (qui inclut les bougies premarket grâce à includePrePost=true).
// Retourne null si aucune bougie premarket exploitable (ticker peu liquide
// ou fixtures de test sans timestamps). Le bar count importe peu — on prend
// max(h) et min(l) sur toutes les bougies premarket trouvées.
function getPremarketRange(intraday) {
  if (!Array.isArray(intraday)) return null;
  let high = -Infinity, low = Infinity, found = false;
  for (const bar of intraday) {
    if (!isPremarketBar(bar)) continue;
    if (Number.isFinite(bar.h) && bar.h > high) high = bar.h;
    if (Number.isFinite(bar.l) && bar.l < low)  low  = bar.l;
    found = true;
  }
  if (!found || !Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { pmh: high, pml: low };
}

// PMH break — close intraday RTH > premarket high d'aujourd'hui.
// Mirror de detectPDHBreak avec colonnes pmh_*. Le check isRTHBar(last) évite
// de fire pendant le premarket lui-même (où PMH se forme encore) et après
// 16:00 ET (irrelevant après la cloche).
function detectPMHBreak(intraday, pmh, state, reentryMs, now = Date.now()) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(pmh)) {
    return { event: null, stateUpdate: null };
  }
  const last = intraday[intraday.length - 1];
  // Skip si on est encore en premarket (PMH pas encore figé) ou hors RTH.
  // Si timestamps non exploitables (fixtures), on accepte (le caller décide).
  if (Number.isFinite(last.t) && !isRTHBar(last)) {
    return { event: null, stateUpdate: null };
  }
  const close = last.c;
  if (!Number.isFinite(close)) {
    return { event: null, stateUpdate: null };
  }

  const alertsToday = (state && state.pmh_alerts_today) || 0;
  const belowSince  = state && state.pmh_below_since;

  if (close > pmh) {
    if (alertsToday === 0) {
      return {
        event: { type: 'pmh_break', pmh, price: close, volume: last.v },
        stateUpdate: { pmh_alerts_today: 1, pmh_below_since: null },
      };
    }
    if (belowSince == null) {
      return { event: null, stateUpdate: null };
    }
    if ((now - belowSince) >= reentryMs) {
      return {
        event: { type: 'pmh_break', pmh, price: close, volume: last.v },
        stateUpdate: { pmh_alerts_today: alertsToday + 1, pmh_below_since: null },
      };
    }
    return { event: null, stateUpdate: { pmh_below_since: null } };
  }

  if (alertsToday > 0 && belowSince == null) {
    return { event: null, stateUpdate: { pmh_below_since: now } };
  }
  return { event: null, stateUpdate: null };
}

// PML break — close intraday RTH < premarket low d'aujourd'hui.
// Symétrique de detectPMHBreak.
function detectPMLBreak(intraday, pml, state, reentryMs, now = Date.now()) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(pml)) {
    return { event: null, stateUpdate: null };
  }
  const last = intraday[intraday.length - 1];
  if (Number.isFinite(last.t) && !isRTHBar(last)) {
    return { event: null, stateUpdate: null };
  }
  const close = last.c;
  if (!Number.isFinite(close)) {
    return { event: null, stateUpdate: null };
  }

  const alertsToday = (state && state.pml_alerts_today) || 0;
  const aboveSince  = state && state.pml_above_since;

  if (close < pml) {
    if (alertsToday === 0) {
      return {
        event: { type: 'pml_break', pml, price: close, volume: last.v },
        stateUpdate: { pml_alerts_today: 1, pml_above_since: null },
      };
    }
    if (aboveSince == null) {
      return { event: null, stateUpdate: null };
    }
    if ((now - aboveSince) >= reentryMs) {
      return {
        event: { type: 'pml_break', pml, price: close, volume: last.v },
        stateUpdate: { pml_alerts_today: alertsToday + 1, pml_above_since: null },
      };
    }
    return { event: null, stateUpdate: { pml_above_since: null } };
  }

  if (alertsToday > 0 && aboveSince == null) {
    return { event: null, stateUpdate: { pml_above_since: now } };
  }
  return { event: null, stateUpdate: null };
}

// Gap up/down overnight. Mesure l'écart entre l'open premarket d'aujourd'hui
// (~4:00 ET, 1re bougie de l'intraday qui inclut le premarket grâce à
// includePrePost=true) et la close after-hours d'hier (~20:00 ET, fournie
// par dailyContext.prevSessionClose côté scanner). Capture donc tout le
// mouvement overnight 20h→4h (news, post-earnings, etc.).
//
// Si prevSessionClose n'est pas dispo, detectAll passe yesterday.close
// (RTH 16:00) → on retombe sur un gap "RTH-only" classique.
//
// Threshold différent selon quote_type côté scanner (ETF/index = seuil bas,
// stocks = seuil haut). 1× par jour via gap_alerted_today.
function detectGap(intraday, prevClose, gapThresholdPct, state) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    return { event: null, stateUpdate: null };
  }
  if (state && state.gap_alerted_today) {
    return { event: null, stateUpdate: null };
  }
  // 1re bougie de l'intraday = open premarket (~4:00 ET) si includePrePost,
  // sinon open RTH (~9:30 ET). Yahoo client partagé a includePrePost=true.
  const todayOpen = intraday[0].o;
  if (!Number.isFinite(todayOpen)) {
    return { event: null, stateUpdate: null };
  }
  const gapPct = ((todayOpen - prevClose) / prevClose) * 100;
  if (gapPct >= gapThresholdPct) {
    return {
      event: { type: 'gap_up', openPrice: todayOpen, prevClose, gapPct },
      stateUpdate: { gap_alerted_today: 1 },
    };
  }
  if (gapPct <= -gapThresholdPct) {
    return {
      event: { type: 'gap_down', openPrice: todayOpen, prevClose, gapPct },
      stateUpdate: { gap_alerted_today: 1 },
    };
  }
  return { event: null, stateUpdate: null };
}

// Cumul du volume aujourd'hui > volume total d'hier × multiplier (default 1.05).
// Fire 1× / jour. NaN volumes ignorés (Yahoo peut renvoyer NaN sur des bars vides).
//
// Filtre RTH : on somme uniquement les bougies de la session régulière
// (9:30-16:00 ET). yesterday.volume venant de Yahoo est aussi le volume
// daily RTH, donc la comparaison est apple-to-apple. Fallback sur
// intraday brut si aucune bougie RTH (fixtures de test).
function detectVolumeAbovePrevDay(intraday, prevDayVolume, multiplier, state) {
  if (!Array.isArray(intraday) || intraday.length === 0) {
    return { event: null, stateUpdate: null };
  }
  if (!Number.isFinite(prevDayVolume) || prevDayVolume <= 0) {
    return { event: null, stateUpdate: null };
  }
  if (state && state.volume_above_alerted_today) {
    return { event: null, stateUpdate: null };
  }
  const rthBars = filterToRTH(intraday);
  const sourceBars = rthBars.length > 0 ? rthBars : intraday;
  let cumVolume = 0;
  for (const bar of sourceBars) {
    if (Number.isFinite(bar.v)) cumVolume += bar.v;
  }
  if (cumVolume > prevDayVolume * multiplier) {
    return {
      event: {
        type: 'volume_above_prev_day',
        todayVolume: cumVolume,
        prevDayVolume,
        ratio: cumVolume / prevDayVolume,
      },
      stateUpdate: { volume_above_alerted_today: 1 },
    };
  }
  return { event: null, stateUpdate: null };
}

module.exports = {
  detectDirection, detectBreakout, detectReversal, detectAll,
  detectPDHBreak, detectPDLBreak, detectPMHBreak, detectPMLBreak,
  detectGap, detectVolumeAbovePrevDay,
  filterToRTH, isPremarketBar, isRTHBar, getPremarketRange,
};
