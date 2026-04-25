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

const { createCanvas } = require('@napi-rs/canvas');
const { computeIndicators, calcEMASeries, calcVWAPSeries } = require('../trading/indicators');
const { FONT } = require('../canvas/config');

// Table des timeframes acceptés, convention TradingView :
//   - minute en MINUSCULE  : 1m, 2m, 5m, 15m, 30m
//   - heure en minuscule   : 1h
//   - jour                 : 1d / 1D, 5d / 5D (case-insensitive)
//   - mois en MAJUSCULE    : 1M, 3M, 6M (UPPERCASE M, pour distinguer de 1m)
//   - année                : 1y / 1Y (case-insensitive)
// Chaque entrée : interval = paramètre passé à Yahoo ; ms = durée
// couverte par la range (nb de bars dépend de l'interval).
const VALID_RANGES = {
  // Minutes (lowercase m)
  '1m':  { interval: '1m',  ms: 86_400_000 },        // 1 jour (~390 bars RTH)
  '2m':  { interval: '2m',  ms: 86_400_000 },        // 1 jour
  '5m':  { interval: '5m',  ms: 86_400_000 },        // 1 jour
  '15m': { interval: '15m', ms: 5 * 86_400_000 },    // 5 jours
  '30m': { interval: '30m', ms: 5 * 86_400_000 },    // 5 jours
  // Heure (lowercase h)
  '1h':  { interval: '1h',  ms: 20 * 86_400_000 },   // 20 jours
  '4h':  { interval: '1h',  ms: 60 * 86_400_000, aggregateBy: 4, displayLabel: '4h' }, // 60j, 4×1h agrégés
  // Jour (case-insensitive)
  '1D':  { interval: '5m',  ms: 86_400_000 },
  '1d':  { interval: '5m',  ms: 86_400_000 },
  '5D':  { interval: '15m', ms: 5 * 86_400_000 },
  '5d':  { interval: '15m', ms: 5 * 86_400_000 },
  // Mois (UPPERCASE M uniquement — sinon collision avec minute)
  '1M':  { interval: '1d',  ms: 30 * 86_400_000 },
  '3M':  { interval: '1d',  ms: 90 * 86_400_000 },
  '6M':  { interval: '1d',  ms: 180 * 86_400_000 },
  // Année (case-insensitive)
  '1Y':  { interval: '1d',  ms: 365 * 86_400_000 },
  '1y':  { interval: '1d',  ms: 365 * 86_400_000 },
};

// Case-sensitive : '1m' et '1M' sont deux ranges différentes.
function parseRange(arg, now = new Date()) {
  const key = arg ? String(arg) : '1D';
  const cfg = VALID_RANGES[key];
  if (!cfg) return null;
  return {
    interval: cfg.interval,
    period1: new Date(now.getTime() - cfg.ms),
    aggregateBy: cfg.aggregateBy || 1,
  };
}

function formatMarketCap(n) {
  // Yahoo peut renvoyer -1 comme sentinel "unavailable" → on traite comme N/A.
  if (!Number.isFinite(n) || n <= 0) return 'N/A';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2)  + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2)  + 'M';
  return '$' + n.toLocaleString('en-US');
}

function withTimeout(promise, ms) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error('yahoo timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

function createYahooClient({
  yahoo,
  now = () => Date.now(),
  ttlMs = 30_000,
  timeoutMs = 10_000,
} = {}) {
  if (!yahoo) {
    // yahoo-finance2 v3 exporte une CLASSE (pas un singleton comme v2) :
    // il faut `new YahooFinance()` avant d'appeler .quote()/.chart().
    // Sans ça : "Call `const yahooFinance = new YahooFinance()` first."
    // La classe est require'd paresseusement ici ; les tests injectent un fake.
    // suppressNotices évite l'impression du survey Yahoo sur le premier appel.
    const YahooFinance = require('yahoo-finance2').default;
    yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  const quoteCache = new Map();
  const chartCache = new Map();

  async function getQuote(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = quoteCache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const inflight = withTimeout(yahoo.quote(key), timeoutMs);
    quoteCache.set(key, { inflight });
    try {
      const data = await inflight;
      quoteCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      quoteCache.delete(key);
      throw err;
    }
  }

  async function getChart(ticker, range) {
    const parsed = parseRange(range, new Date(now()));
    if (!parsed) throw new Error('Invalid range: ' + range);
    const t = String(ticker).toUpperCase();
    // Case-sensitive range pour la clé : 1m et 1M sont deux ranges.
    const key = t + '|' + String(range || '1D');
    const hit = chartCache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    // includePrePost : on récupère pre-market + after-hours (4:00 → 20:00 ET).
    // Ignoré par Yahoo pour les intervals daily (1d) — pas de risque à le
    // passer systématiquement. Pour les intervals intraday ça élargit
    // la fenêtre de données visible dans le chart.
    const inflight = withTimeout(
      yahoo.chart(t, {
        interval: parsed.interval,
        period1: parsed.period1,
        includePrePost: true,
      }),
      timeoutMs,
    );
    chartCache.set(key, { inflight });
    try {
      const data = await inflight;
      // Agrégation côté client pour les ranges synthétiques (ex: 4h = 4×1h).
      // Yahoo ne supporte pas 4h nativement, donc on requête en 1h puis on
      // fusionne. L'objet `data.quotes` est remplacé par la série agrégée ;
      // les autres champs (meta, events) restent intacts.
      if (parsed.aggregateBy && parsed.aggregateBy > 1 && data && Array.isArray(data.quotes)) {
        data.quotes = aggregateBars(data.quotes, parsed.aggregateBy);
      }
      chartCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      chartCache.delete(key);
      throw err;
    }
  }

  return { getQuote, getChart };
}

// Label d'intervalle affiché dans le titre — dérivé du range demandé.
// On préfère displayLabel quand défini (cas de 4h qui utilise 1h côté
// Yahoo mais s'affiche 4h après agrégation).
const INTERVAL_LABEL = Object.fromEntries(
  Object.entries(VALID_RANGES).map(([k, v]) => [k, v.displayLabel || v.interval])
);

// Renvoie 'pre' | 'rth' | 'post' | 'closed' selon l'heure ET d'une
// bougie. Frontières US NYSE : pre 04:00-09:30, RTH 09:30-16:00,
// post 16:00-20:00. Hors de ces plages = 'closed'. Intl gère la DST
// automatiquement pour 'America/New_York'.
function getETPhase(date) {
  if (!(date instanceof Date)) return 'closed';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  let hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  const mins = hour * 60 + minute;
  if (mins < 4 * 60) return 'closed';         // 00:00-03:59
  if (mins < 9 * 60 + 30) return 'pre';       // 04:00-09:29
  if (mins < 16 * 60) return 'rth';           // 09:30-15:59
  if (mins < 20 * 60) return 'post';          // 16:00-19:59
  return 'closed';                             // 20:00-23:59
}

// Agrège des bars OHLCV N-par-N : O = premier, H = max, L = min,
// C = dernier, V = somme. Utilisé pour 4h (4 × 1h).
function aggregateBars(bars, n) {
  if (!Array.isArray(bars) || n <= 1) return bars || [];
  const out = [];
  for (let i = 0; i < bars.length; i += n) {
    const group = bars.slice(i, i + n);
    if (group.length === 0) continue;
    const highs = group.map(b => b.high).filter(Number.isFinite);
    const lows  = group.map(b => b.low).filter(Number.isFinite);
    const first = group[0];
    const last  = group[group.length - 1];
    const open  = Number.isFinite(first.open) ? first.open : last.close;
    const close = Number.isFinite(last.close) ? last.close : first.open;
    out.push({
      date: first.date,
      open,
      high: highs.length ? Math.max(...highs) : Math.max(open, close),
      low:  lows.length  ? Math.min(...lows)  : Math.min(open, close),
      close,
      volume: group.reduce((s, b) => s + (Number.isFinite(b.volume) ? b.volume : 0), 0),
    });
  }
  return out;
}

// Format de prix adaptatif : sous-dollar → 3 décimales, sinon 2.
function formatPrice(v) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1) return v.toFixed(3);
  return v.toFixed(2);
}

// Format de volume humain : 1.2M, 500K, 12345.
function formatVolume(v) {
  if (!Number.isFinite(v)) return '0';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

// Format label temporel. `dailyGranularity` = true quand l'intervalle
// est 1d → on affiche MMM dd. Sinon intraday → HH:mm.
function formatTimeLabel(date, dailyGranularity) {
  if (!(date instanceof Date)) return '';
  if (dailyGranularity) {
    return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
  }
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDateLabel(date) {
  if (!(date instanceof Date)) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function renderChartPng(candles, ticker, range) {
  // ── Layout ────────────────────────────────────────────────────────
  const W = 1200, H = 700;
  const TITLE_H = 50;
  const TIME_H = 28;
  const VOL_H = 120;                         // zone volume réduite…
  const VOL_GAP = 12;                        // gap entre chart et volume
  const BOTTOM_PAD = 18;                     // …pour garder une marge bas
  const RIGHT_AXIS_W = 90;
  const LEFT_PAD = 10;

  const chartY0 = TITLE_H;
  const chartY1 = H - BOTTOM_PAD - VOL_H - VOL_GAP - TIME_H;
  const chartH = chartY1 - chartY0;
  const timeY = chartY1 + 18;                // baseline label temps
  const volY0 = chartY1 + TIME_H + VOL_GAP;  // haut sous-graphe volume
  const plotX0 = LEFT_PAD;
  const plotX1 = W - RIGHT_AXIS_W;
  const plotW = plotX1 - plotX0;

  // ── Couleurs (thème sombre "TradingView-ish") ─────────────────────
  const BG = '#0b0e11';
  const TEXT = '#e6edf3';
  const TEXT_DIM = '#6e7681';
  const GRID = '#20252c';
  const UP = '#2fc774';
  const DOWN = '#f5515f';
  const AXIS_PILL_BG = '#1f6feb';
  const AXIS_PILL_TEXT = '#ffffff';

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Background ────────────────────────────────────────────────────
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // ── Filter candles : on a besoin de O/H/L/C finis pour dessiner
  //    un candlestick. Les bars sans OHLC complet sont ignorées. ────
  const validCandles = (candles || []).filter(c =>
    Number.isFinite(c.open) && Number.isFinite(c.high)
    && Number.isFinite(c.low) && Number.isFinite(c.close)
  );
  if (validCandles.length < 2) {
    ctx.fillStyle = TEXT_DIM;
    ctx.font = '16px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillText('Not enough data to render chart.', LEFT_PAD + 20, chartY0 + chartH / 2);
    return canvas.toBuffer('image/png');
  }

  const N = validCandles.length;
  const opens  = validCandles.map(c => c.open);
  const highs  = validCandles.map(c => c.high);
  const lows   = validCandles.map(c => c.low);
  const closes = validCandles.map(c => c.close);
  const volumes = validCandles.map(c => Number.isFinite(c.volume) ? c.volume : 0);

  // ── Overlays (EMAs, VWAP) ─────────────────────────────────────────
  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);
  const vwapBars = validCandles.map(c => ({ h: c.high, l: c.low, c: c.close, v: c.volume }));
  const vwapSeries = calcVWAPSeries(vwapBars);

  // ── Échelle Y prix : clipping par percentile pour éviter qu'un
  //    outlier (spike illiquide pre/post-market chez Yahoo) compresse
  //    toute la zone principale. On prend le 2e/98e percentile des
  //    highs et lows, puis on ajoute un padding 5% de chaque côté.
  //    Les valeurs hors percentile sont visuellement CLAMPED à
  //    [minY, maxY] (PAS [minC, maxC]) pour qu'un wick extrême
  //    s'arrête à 5% du bord du chart, pas pile sur le bord. ────────
  function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
    return sorted[idx];
  }
  const yValuesForScale = highs.concat(
    lows,
    ema9Series.filter(v => v != null),
    ema20Series.filter(v => v != null),
    vwapSeries.filter(v => v != null),
  );
  const minY = percentile(yValuesForScale, 0.02);
  const maxY = percentile(yValuesForScale, 0.98);
  const ySpan = (maxY - minY) || 1;
  const yPad = ySpan * 0.05;
  const minC = minY - yPad;
  const maxC = maxY + yPad;
  const span = maxC - minC;
  const clampToRange = (v) => Math.max(minY, Math.min(maxY, v));

  // ── Helpers de projection ─────────────────────────────────────────
  // Candle centre en x = plotX0 + (i + 0.5) * slotW, slotW = plotW / N.
  const slotW = plotW / N;
  const xCenter = (i) => plotX0 + (i + 0.5) * slotW;
  // y projeté, puis clampé à la bbox du plot pour les valeurs hors
  // scale (percentile-clipped outliers).
  const y = (v) => {
    const raw = chartY0 + chartH - ((v - minC) / span) * chartH;
    if (raw < chartY0) return chartY0;
    if (raw > chartY0 + chartH) return chartY0 + chartH;
    return raw;
  };

  // ── Titre : "TICKER, INTERVAL • $PRICE • ±CHANGE%" ────────────────
  const interval = INTERVAL_LABEL[String(range)] || '';
  const firstOpen = opens[0];
  const lastClose = closes[N - 1];
  const changePct = firstOpen !== 0 ? ((lastClose - firstOpen) / firstOpen) * 100 : 0;
  const up = changePct >= 0;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const titleY = 32;
  let tx = LEFT_PAD + 14;
  ctx.font = 'bold 22px ' + FONT;
  ctx.fillStyle = TEXT;
  const titleLeft = ticker + (interval ? ', ' + interval : '');
  ctx.fillText(titleLeft, tx, titleY);
  tx += ctx.measureText(titleLeft).width;
  ctx.fillStyle = TEXT_DIM;
  ctx.fillText(' • ', tx, titleY);
  tx += ctx.measureText(' • ').width;
  ctx.fillStyle = TEXT;
  const priceStr = '$' + formatPrice(lastClose);
  ctx.fillText(priceStr, tx, titleY);
  tx += ctx.measureText(priceStr).width;
  ctx.fillStyle = TEXT_DIM;
  ctx.fillText(' • ', tx, titleY);
  tx += ctx.measureText(' • ').width;
  ctx.fillStyle = up ? UP : DOWN;
  ctx.fillText((up ? '+' : '') + changePct.toFixed(2) + '%', tx, titleY);

  // ── Background shading pour les phases hors RTH ───────────────────
  // Pré-market / after-hours obtiennent un léger éclaircissement pour
  // distinguer visuellement la session régulière (9:30-16:00 ET) du
  // reste. Skip pour les ranges daily (intervals '1d') où le concept
  // ne s'applique pas (chaque bar = 1 journée complète).
  if (interval !== '1d') {
    // Groupe les bars contiguës de même phase pour dessiner un seul
    // rectangle par groupe (évite N fillRect pour N bars).
    const EXT_HOURS_SHADE = 'rgba(255, 255, 255, 0.03)';
    let groupStart = -1;
    let groupPhase = null;
    const shadeGroup = (startIdx, endIdx) => {
      const x0 = xCenter(startIdx) - slotW / 2;
      const x1 = xCenter(endIdx) + slotW / 2;
      ctx.fillStyle = EXT_HOURS_SHADE;
      ctx.fillRect(x0, chartY0, x1 - x0, chartH);
      ctx.fillRect(x0, volY0, x1 - x0, VOL_H);
    };
    for (let i = 0; i < N; i++) {
      const phase = getETPhase(validCandles[i].date);
      const shade = phase === 'pre' || phase === 'post';
      if (shade && groupPhase !== 'ext') {
        groupStart = i;
        groupPhase = 'ext';
      } else if (!shade && groupPhase === 'ext') {
        shadeGroup(groupStart, i - 1);
        groupPhase = null;
      }
    }
    if (groupPhase === 'ext') shadeGroup(groupStart, N - 1);
  }

  // ── Gridlines horizontales + axe Y droit ──────────────────────────
  // 5 niveaux de grille équidistants en prix.
  ctx.font = '11px ' + FONT;
  ctx.textAlign = 'left';
  const gridSteps = 5;
  for (let k = 0; k <= gridSteps; k++) {
    const v = minC + (span * k) / gridSteps;
    const yy = y(v);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX0, yy);
    ctx.lineTo(plotX1, yy);
    ctx.stroke();
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(formatPrice(v), plotX1 + 6, yy + 4);
  }

  // ── Pill High (en haut à droite) ─────────────────────────────────
  const highMax = Math.max(...highs);
  const lowMin  = Math.min(...lows);
  function drawPill(textLine1, textLine2, color, textColor, yTop) {
    ctx.font = 'bold 11px ' + FONT;
    const w = Math.max(
      ctx.measureText(textLine1).width,
      textLine2 ? ctx.measureText(textLine2).width : 0,
    ) + 12;
    const h = textLine2 ? 28 : 18;
    ctx.fillStyle = color;
    ctx.fillRect(plotX1 + 1, yTop, w, h);
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.fillText(textLine1, plotX1 + 7, yTop + 12);
    if (textLine2) ctx.fillText(textLine2, plotX1 + 7, yTop + 24);
    return w;
  }
  // High pill en haut (aligné avec le max réel)
  drawPill('High ' + formatPrice(highMax), null, AXIS_PILL_BG, AXIS_PILL_TEXT, y(highMax) - 14);
  // Low pill en bas
  drawPill('Low ' + formatPrice(lowMin), null, AXIS_PILL_BG, AXIS_PILL_TEXT, y(lowMin) - 4);

  // ── Helper pour dessiner une série (null = pen-up) ───────────────
  function drawSeries(series, color, lineWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v == null) { penDown = false; continue; }
      if (!penDown) { ctx.moveTo(xCenter(i), y(v)); penDown = true; }
      else { ctx.lineTo(xCenter(i), y(v)); }
    }
    ctx.stroke();
  }

  // ── Candlesticks ──────────────────────────────────────────────────
  // Body : max 80% du slot, min 1px, wick toujours au centre.
  //
  // Single filter conservé : range (H−L) > 8× la médiane. Catch les
  // single-print aberrants (ex: SPY 5m bar avec L=655 alors que la
  // médiane des ranges est 0.37) qui apparaissent occasionnellement
  // dans le flux Yahoo, y compris pendant les heures de marché. Le
  // 1-bar-gap qui en résulte est préférable au spike artifact.
  // (Les gaps "naturels" d'overnight/weekend restent intacts —
  // toutes les autres bougies sont rendues, hors percentile ou non.)
  const ranges = [];
  for (let i = 0; i < N; i++) {
    const r = highs[i] - lows[i];
    if (Number.isFinite(r) && r >= 0) ranges.push(r);
  }
  const sortedRanges = [...ranges].sort((a, b) => a - b);
  const medianRange = sortedRanges.length
    ? sortedRanges[Math.floor(sortedRanges.length / 2)]
    : 0;
  const maxReasonableRange = medianRange > 0
    ? medianRange * 8
    : Number.POSITIVE_INFINITY;

  const bodyW = Math.max(1, Math.min(slotW * 0.7, 12));
  for (let i = 0; i < N; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if ((h - l) > maxReasonableRange) continue;  // bad print → skip

    const cx = xCenter(i);
    const isUp = c >= o;
    const color = isUp ? UP : DOWN;

    const yOpen = y(clampToRange(o));
    const yClose = y(clampToRange(c));
    const bodyTop = Math.min(yOpen, yClose);
    const bodyBottom = Math.max(yOpen, yClose);
    const bodyH = Math.max(1, bodyBottom - bodyTop);

    // Wick clampé au percentile range — évite les outlier bars qui
    // tracent des lignes verticales jusqu'au bord du chart.
    const yH = y(clampToRange(h));
    const yL = y(clampToRange(l));
    if (yH < yL) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, yH);
      ctx.lineTo(cx, yL);
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
  }

  // ── Overlays (par-dessus les candles) ─────────────────────────────
  if (vwapSeries.some(v => v != null))  drawSeries(vwapSeries,  '#ff59b9', 1.5);
  if (ema20Series.some(v => v != null)) drawSeries(ema20Series, '#4ac4ff', 1.5);
  if (ema9Series.some(v => v != null))  drawSeries(ema9Series,  '#ffd700', 1.5);

  // ── Légende des overlays (haut-gauche, sous le titre) ─────────────
  // Seules les séries réellement dessinées apparaissent.
  const legendItems = [];
  if (ema9Series.some(v => v != null))  legendItems.push({ label: 'EMA9',  color: '#ffd700' });
  if (ema20Series.some(v => v != null)) legendItems.push({ label: 'EMA20', color: '#4ac4ff' });
  if (vwapSeries.some(v => v != null))  legendItems.push({ label: 'VWAP',  color: '#ff59b9' });
  if (legendItems.length > 0) {
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'left';
    const SWATCH = 8, SG = 4, IG = 12;
    let lx = LEFT_PAD + 14;
    const ly = chartY0 + 14;
    legendItems.forEach((it) => {
      ctx.fillStyle = it.color;
      ctx.fillRect(lx, ly - SWATCH + 1, SWATCH, SWATCH);
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(it.label, lx + SWATCH + SG, ly);
      lx += SWATCH + SG + ctx.measureText(it.label).width + IG;
    });
  }

  // ── Pill du prix courant (sur l'axe de droite) ────────────────────
  const currentPriceColor = up ? UP : DOWN;
  ctx.font = 'bold 12px ' + FONT;
  const cpText = formatPrice(lastClose);
  const cpW = ctx.measureText(cpText).width + 12;
  const cpY = y(lastClose) - 10;
  ctx.fillStyle = currentPriceColor;
  ctx.fillRect(plotX1 + 1, cpY, cpW, 20);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(cpText, plotX1 + 7, cpY + 14);

  // Ligne pointillée du prix courant sur toute la largeur du chart.
  ctx.strokeStyle = TEXT_DIM;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0, y(lastClose));
  ctx.lineTo(plotX1, y(lastClose));
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Axe temporel : 5 ticks évenly-spaced + date à gauche ──────────
  // Labels "HH:mm" pour les ranges qui tiennent en une seule session
  // (≤ 1 jour : 1m, 2m, 5m, 1D). Sinon labels "MMM dd" — l'heure
  // n'apporte rien quand le range s'étale sur plusieurs jours, et ça
  // évite les labels ambigus type "22:00" qui peuvent appartenir à
  // n'importe quel jour.
  const rangeCfg = VALID_RANGES[range];
  const useDateLabels = !rangeCfg || rangeCfg.ms > 86_400_000;
  ctx.font = '11px ' + FONT;
  ctx.fillStyle = TEXT_DIM;
  ctx.textAlign = 'center';
  const tickCount = 5;
  for (let k = 0; k < tickCount; k++) {
    const idx = Math.round((k / (tickCount - 1)) * (N - 1));
    const xx = xCenter(idx);
    const date = validCandles[idx].date;
    ctx.fillText(formatTimeLabel(date, useDateLabels), xx, timeY);
  }
  // Date complète sous la zone des labels de temps, alignée à gauche
  // dans la marge pour ne jamais sortir du canvas.
  ctx.textAlign = 'left';
  const firstDate = validCandles[0].date;
  ctx.fillStyle = TEXT_DIM;
  ctx.fillText(formatDateLabel(firstDate), LEFT_PAD + 4, timeY + 14);

  // ── Volume sub-chart ──────────────────────────────────────────────
  // On utilise le 95e percentile comme max d'échelle (au lieu du max
  // absolu) pour que les bars extended-hours (10×-1000× plus faibles
  // que le peak RTH) restent visibles. Les quelques bars qui dépassent
  // sont clippés à la hauteur max. Plus : hauteur min 1px pour tout
  // volume > 0 non trivial.
  const posVolumes = volumes.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const p95Vol = posVolumes.length
    ? posVolumes[Math.min(posVolumes.length - 1, Math.floor(posVolumes.length * 0.95))]
    : 1;
  const maxVol = p95Vol || 1;
  // Gridlines volume (3 niveaux : 0, mid, max)
  for (const frac of [0, 0.5, 1]) {
    const yy = volY0 + VOL_H - frac * VOL_H;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX0, yy);
    ctx.lineTo(plotX1, yy);
    ctx.stroke();
    ctx.fillStyle = TEXT_DIM;
    ctx.font = '10px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillText(formatVolume(frac * maxVol), plotX1 + 6, yy + 3);
  }
  // Bars volume (même couleur que la candle correspondante).
  for (let i = 0; i < N; i++) {
    const v = volumes[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    // Clip à VOL_H (pour les bars qui dépassent le 95e percentile) et
    // force 2px minimum pour que les petits volumes (extended-hours,
    // souvent 100×-1000× plus faibles que RTH) restent visibles.
    const vh = Math.max(2, Math.min(VOL_H, (v / maxVol) * VOL_H));
    const isUp = closes[i] >= opens[i];
    ctx.fillStyle = isUp ? UP : DOWN;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(xCenter(i) - bodyW / 2, volY0 + VOL_H - vh, bodyW, vh);
  }
  ctx.globalAlpha = 1;

  return canvas.toBuffer('image/png');
}

function formatQuoteMessage(quote) {
  const price = quote.regularMarketPrice;
  const change = quote.regularMarketChangePercent;
  // Yahoo renvoie parfois null sur le change% en pre/post-market.
  // On affiche N/A plutôt que de crasher sur .toFixed().
  const hasChange = typeof change === 'number' && Number.isFinite(change);
  const up = hasChange && change >= 0;
  const arrow = hasChange ? (up ? '🟢' : '🔴') : '⚪';
  const changeStr = hasChange ? (up ? '+' : '') + change.toFixed(2) + '%' : 'N/A';
  const vol = (quote.regularMarketVolume || 0).toLocaleString('en-US');
  const dayLow = quote.regularMarketDayLow != null ? '$' + quote.regularMarketDayLow.toFixed(2) : 'N/A';
  const dayHigh = quote.regularMarketDayHigh != null ? '$' + quote.regularMarketDayHigh.toFixed(2) : 'N/A';
  const w52Low = quote.fiftyTwoWeekLow != null ? '$' + quote.fiftyTwoWeekLow.toFixed(2) : 'N/A';
  const w52High = quote.fiftyTwoWeekHigh != null ? '$' + quote.fiftyTwoWeekHigh.toFixed(2) : 'N/A';
  const name = quote.longName || quote.shortName || quote.symbol;

  return [
    '📊 **$' + quote.symbol + ' — ' + name + '**',
    '> 💰 Price: $' + price.toFixed(2) + ' ' + arrow + ' ' + changeStr,
    '> 📦 Volume: ' + vol,
    '> 📉 Day: ' + dayLow + ' → ' + dayHigh,
    '> 📆 52W: ' + w52Low + ' → ' + w52High,
    '> 🏦 Market cap: ' + formatMarketCap(quote.marketCap),
  ].join('\n');
}

function isRateLimitError(err) {
  const msg = String(err && err.message || err);
  return /\b429\b|rate.?limit/i.test(msg);
}

function isUnknownTickerError(err) {
  const msg = String(err && err.message || err);
  // Ancré sur des signaux Yahoo spécifiques pour éviter de capturer des
  // erreurs génériques comme ENOENT ou "Module not found".
  return /quote\s+not\s+found|invalid\s+(?:symbol|ticker)|no\s+fundamentals|HTTPError.*404|symbol\s+not\s+found/i.test(msg);
}

function registerMarketCommands(client, { yahooClient } = {}) {
  const yc = yahooClient || createYahooClient();

  // ── !price TICKER ───────────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const m = message.content.trim().match(/^!price(?:\s+([A-Za-z$.\-]{1,10}))?$/i);
    if (!m) return;

    const tickerArg = m[1];
    if (!tickerArg) {
      try { await message.reply('❌ Usage: !price TICKER (e.g. !price AAPL)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace(/\$/g, '').toUpperCase();
    console.log('[!price] ' + ticker + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    try {
      const quote = await yc.getQuote(ticker);
      if (!quote || quote.regularMarketPrice == null) {
        console.log('[!price] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' not found'); } catch (_) {}
        return;
      }
      await message.reply(formatQuoteMessage(quote));
    } catch (err) {
      if (isUnknownTickerError(err)) {
        console.log('[!price] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' not found'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        console.error('[!price] Rate limited');
        try { await message.reply('❌ Rate limited, try again in 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance unavailable, try again in a few minutes'); } catch (_) {}
    }
  });

  // ── !chart TICKER [RANGE] ───────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const m = message.content.trim().match(/^!chart(?:\s+([A-Za-z$.\-]{1,10}))?(?:\s+([A-Za-z0-9]{1,3}))?$/i);
    if (!m) return;

    const tickerArg = m[1];
    const rangeArg = m[2];
    if (!tickerArg) {
      try { await message.reply('❌ Usage: !chart TICKER [RANGE] (e.g. !chart AAPL 5D)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace(/\$/g, '').toUpperCase();
    // Case-sensitive : 1m (minute) ≠ 1M (month). On ne normalise pas.
    const range = rangeArg || '1D';

    if (!parseRange(range)) {
      try { await message.reply('❌ Invalid range. Use: 1m, 2m, 5m, 15m, 30m, 1h, 1D, 5D, 1M, 3M, 6M, 1Y'); } catch (_) {}
      return;
    }

    console.log('[!chart] ' + ticker + ' ' + range + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    let candles;
    try {
      const chart = await yc.getChart(ticker, range);
      candles = (chart && chart.quotes) || [];
      if (candles.length === 0) {
        // Ticker valide mais pas de données (jour férié, hors séance, ticker
        // très illiquide). On distingue du cas "ticker introuvable" qui passe
        // par le catch.
        try { await message.reply('❌ No data available for $' + ticker + ' on ' + range); } catch (_) {}
        return;
      }
    } catch (err) {
      if (isUnknownTickerError(err)) {
        console.log('[!chart] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' not found'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        console.error('[!chart] Rate limited');
        try { await message.reply('❌ Rate limited, try again in 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance unavailable, try again in a few minutes'); } catch (_) {}
      return;
    }

    let buffer;
    try {
      buffer = renderChartPng(candles, ticker, range);
    } catch (err) {
      console.error('[!chart] render failed', err.stack || err.message);
      try { await message.reply('❌ Chart rendering failed'); } catch (_) {}
      return;
    }

    try {
      await message.reply({
        files: [{ attachment: buffer, name: ticker + '-' + range + '.png' }],
      });
    } catch (err) {
      console.error('[!chart] send failed', err.message);
    }
  });

  // ── !indicator TICKER ───────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const m = message.content.trim().match(/^!indicator(?:\s+([A-Za-z$.\-]{1,10}))?$/i);
    if (!m) return;

    const tickerArg = m[1];
    if (!tickerArg) {
      try { await message.reply('❌ Usage: !indicator TICKER (e.g. !indicator AAPL)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace(/\$/g, '').toUpperCase();
    console.log('[!indicator] ' + ticker + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    let yahooCandles;
    try {
      const chart = await yc.getChart(ticker, '1D');
      yahooCandles = (chart && chart.quotes) || [];
      if (yahooCandles.length === 0) {
        try { await message.reply('❌ No data available for $' + ticker); } catch (_) {}
        return;
      }
    } catch (err) {
      if (isUnknownTickerError(err)) {
        console.log('[!indicator] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' not found'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        console.error('[!indicator] Rate limited');
        try { await message.reply('❌ Rate limited, try again in 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance unavailable, try again in a few minutes'); } catch (_) {}
      return;
    }

    // Adapt Yahoo shape { date, open, high, low, close, volume } → { t, o, h, l, c, v }
    // Number.isFinite exclut NaN/Infinity — sinon ils propageraient dans
    // les calculs d'EMA/RSI et produiraient des NaN visibles dans le reply.
    const bars = yahooCandles
      .filter(q => Number.isFinite(q.close))
      .map(q => ({ t: q.date, o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume }));

    const ind = computeIndicators(bars);
    if (ind.rsi == null || ind.ema9 == null || ind.ema20 == null || !Number.isFinite(ind.lastPrice)) {
      try { await message.reply('❌ Not enough historical data for $' + ticker); } catch (_) {}
      return;
    }

    // VWAP peut être null si aucune bougie n'a de volume exploitable —
    // rare mais on affiche N/A pour rester robuste.
    const vwapStr = Number.isFinite(ind.vwap) ? '$' + ind.vwap.toFixed(2) : 'N/A';
    const lines = [
      '📈 **$' + ticker + ' — Indicators**',
      '> Price: $' + ind.lastPrice.toFixed(2),
      '> VWAP: ' + vwapStr,
      '> RSI(14): ' + ind.rsi.toFixed(1),
      '> EMA(9): $' + ind.ema9.toFixed(2),
      '> EMA(20): $' + ind.ema20.toFixed(2),
    ];
    try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!indicator]', e.message); }
  });
}

module.exports = {
  parseRange,
  formatMarketCap,
  createYahooClient,
  renderChartPng,
  registerMarketCommands,
  // exposed for tests
  formatQuoteMessage,
};
