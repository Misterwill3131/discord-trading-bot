// ─────────────────────────────────────────────────────────────────────
// discord/chart-img-client.js — Client chart-img.com (Advanced Chart v2)
// ─────────────────────────────────────────────────────────────────────
// Wrapper minimal autour de l'Advanced Chart API v2 de chart-img.com.
// Renvoie un Buffer PNG prêt à être posté dans Discord.
//
// Endpoint : POST https://api.chart-img.com/v2/tradingview/advanced-chart
//   Auth   : header `x-api-key: <CHART_IMG_API_KEY>`
//   CT     : Content-Type: application/json
//   Body   : { symbol, interval, range, theme, width, height }  (JSON)
//   Resp   : binaire PNG (Content-Type: image/png)
//
// IMPORTANT : `symbol` doit être PRÉFIXÉ par l'exchange TradingView
// (ex: "AMEX:SPY", "NASDAQ:AAPL", "NYSE:BABA"). Le caller est
// responsable de la résolution — voir resolveSymbol() ci-dessous.
//
// Pattern identique à discord/fmp-client.js :
//   - Cache en mémoire (TTL 30s) — chart-img facture par requête
//   - Dedup des appels concurrents pour la même clé
//   - Timeout 10s via Promise.race
//   - fetchImpl injectable pour les tests (Node 18+ a fetch global)
// ─────────────────────────────────────────────────────────────────────

const CHART_IMG_BASE = 'https://api.chart-img.com/v2/tradingview/advanced-chart';

// Mapping range Discord → params chart-img.
// Le range Discord (1m, 5m, 1D, 1M, 1Y, etc.) est case-sensitive comme
// dans VALID_RANGES — '1m' = minute, '1M' = mois.
//
// chart-img attend deux params séparés :
//   - interval : granularité d'une bougie (1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M)
//   - range    : fenêtre temporelle (1D, 5D, 1M, 3M, 6M, YTD, 1Y, 5Y, ALL)
//
// Pour les ranges intraday, l'interval doit être assez fin pour montrer
// du détail mais pas trop (sinon l'image est saturée). Mappings choisis
// pour produire entre ~50 et ~200 bougies à l'écran.
const RANGE_MAP = {
  // Minute-level — 1 jour de bougies fines
  '1m':  { interval: '1m',  range: '1D' },
  '2m':  { interval: '5m',  range: '1D' },   // chart-img ne supporte pas 2m natif
  '5m':  { interval: '5m',  range: '1D' },
  '15m': { interval: '15m', range: '5D' },
  '30m': { interval: '30m', range: '5D' },
  // Hour-level
  '1h':  { interval: '1h',  range: '1M' },
  '4h':  { interval: '4h',  range: '3M' },
  // Daily synthetic ranges (Discord '1D' = vue intraday du jour)
  '1D':  { interval: '5m',  range: '1D' },
  '1d':  { interval: '5m',  range: '1D' },
  '5D':  { interval: '15m', range: '5D' },
  '5d':  { interval: '15m', range: '5D' },
  // Multi-month / year — bougies daily
  '1M':  { interval: '1D', range: '1M' },
  '3M':  { interval: '1D', range: '3M' },
  '6M':  { interval: '1D', range: '6M' },
  '1Y':  { interval: '1D', range: '1Y' },
  '1y':  { interval: '1D', range: '1Y' },
};

function mapRangeToChartImg(range) {
  return RANGE_MAP[String(range)] || null;
}

// Yahoo exchange code → préfixe TradingView.
// Source des codes Yahoo : champ `exchange` retourné par yahoo-finance2
// quote() (ex: NMS pour Apple, PCX pour SPY). Source des préfixes TV :
// convention TradingView.com (ex: ETFs sur NYSE Arca s'affichent
// AMEX:XXX, héritage historique).
//
// Fallback NASDAQ : sécuritaire pour les tickers tech non listés ici.
// Si tu vois un ticker légitime tomber dans le fallback et chart-img
// retourne 404, ajoute le code Yahoo correspondant ici.
const YAHOO_TO_TV_EXCHANGE = {
  // Nasdaq
  NMS:  'NASDAQ',  // Nasdaq Global Select Market (ex: AAPL, MSFT)
  NGM:  'NASDAQ',  // Nasdaq Global Market
  NCM:  'NASDAQ',  // Nasdaq Capital Market
  NAS:  'NASDAQ',
  // NYSE
  NYQ:  'NYSE',    // NYSE listed (ex: BABA, JPM)
  NYS:  'NYSE',
  // NYSE Arca / AMEX (ETFs surtout — TV utilise AMEX comme préfixe)
  PCX:  'AMEX',    // NYSE Arca (ex: SPY, QQQ, VOO)
  ASE:  'AMEX',    // NYSE American (ex-AMEX)
  // Autres
  BTS:  'BATS',
  BATS: 'BATS',
  OTC:  'OTC',
  PNK:  'OTC',     // OTC Pink
};

// resolveSymbol(ticker, yahooExchangeCode) → 'TVPREFIX:TICKER'
// Si le code n'est pas dans la map, fallback NASDAQ (statistiquement
// le plus probable pour les tickers US courts).
function resolveSymbol(ticker, yahooExchange) {
  const t = String(ticker).toUpperCase();
  const tv = YAHOO_TO_TV_EXCHANGE[String(yahooExchange || '').toUpperCase()] || 'NASDAQ';
  return tv + ':' + t;
}

// Indicateurs superposés sur le chart par défaut. Noms et schéma vérifiés
// contre la doc chart-img (https://doc.chart-img.com — sections #vwap,
// #moving-average-exponential, #moving-average) :
//   - VWAP n'a PAS d'input (computed sur la session)
//   - EMA / MA prennent `length` (int) + `source` (string), PAS `in_0`/`in_1`
//   - Le nom EMA est "Moving Average Exponential", PAS "Exponential Moving Average"
//
// 7 studies = potentiellement au-dessus du plan free (souvent 5). Si
// chart-img répond "study limit exceeded", retirer EMA 200 + MA 325
// (les moins utilisées en trading court terme).
const DEFAULT_STUDIES = [
  { name: 'VWAP' },
  { name: 'Moving Average Exponential', input: { length: 9,   source: 'close' } },
  { name: 'Moving Average Exponential', input: { length: 20,  source: 'close' } },
  { name: 'Moving Average Exponential', input: { length: 50,  source: 'close' } },
  { name: 'Moving Average Exponential', input: { length: 200, source: 'close' } },
  { name: 'Moving Average',             input: { length: 50,  source: 'close' } },
  { name: 'Moving Average',             input: { length: 325, source: 'close' } },
];

// Construit le drawing Fib Retracement à partir de 2 anchor points
// (start = swing low, end = swing high par convention chart-img).
// Schéma : startDatetime + startPrice + endDatetime + endPrice (tous
// requis selon la doc chart-img https://doc.chart-img.com/#fib-retracement).
// startDatetime/endDatetime doivent être des strings ISO 8601.
// Renvoie null si l'un des champs est invalide.
function buildFibDrawing(anchors) {
  if (!anchors) return null;
  const { startDatetime, startPrice, endDatetime, endPrice } = anchors;
  if (typeof startDatetime !== 'string' || typeof endDatetime !== 'string') return null;
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice)) return null;
  if (startPrice === endPrice) return null;  // FIB dégénéré, pas de range
  return {
    name: 'Fib Retracement',
    input: { startDatetime, startPrice, endDatetime, endPrice },
  };
}

// Construit le drawing Rectangle (https://doc.chart-img.com/#rectangle).
// Use case principal : surligner la zone d'un gap overnight (prev close →
// today open) sur le chart !gap.
//
// Schéma input requis : startDatetime + startPrice + endDatetime + endPrice
// (ISO 8601 pour les datetimes, float pour les prices). Optionnel :
//   - text          : label affiché dans le rectangle
//   - lineColor     : couleur de la bordure (CSS color string)
//   - backgroundColor : remplissage (typiquement rgba avec alpha 0.2-0.3)
//   - fillBackground : false pour une bordure sans remplissage
//   - zOrder        : 'top' (défaut, au-dessus des candles) ou 'bottom'
//
// `text` non vide → on active automatiquement showLabel + fontBold + center
// alignment pour que le label soit visible et lisible. Override defaults
// chart-img sont du violet — on laisse le caller décider de la couleur via
// lineColor / backgroundColor.
//
// ⚠️ Format couleur — le validator chart-img est STRICT :
//   - `rgb(R,G,B)`        OK  (ints 0-255, pas d'espaces)
//   - `rgba(R,G,B,0.X)`   OK  (alpha = 1 décimale max, ex: 0.2, 0.3, 0.5)
//   - `rgba(R,G,B,0.25)`  KO  → HTTP 422 "must be a valid rgb/rgba color"
//   - `#RRGGBB`           pas testé, à éviter
// Toujours passer une alpha à 1 décimale (0.1 … 0.9).
//
// Renvoie null si un champ requis est invalide.
function buildRectangleDrawing(rect) {
  if (!rect) return null;
  const { startDatetime, startPrice, endDatetime, endPrice } = rect;
  if (typeof startDatetime !== 'string' || typeof endDatetime !== 'string') return null;
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice)) return null;

  const drawing = {
    name: 'Rectangle',
    input: { startDatetime, startPrice, endDatetime, endPrice },
    zOrder: rect.zOrder === 'bottom' ? 'bottom' : 'top',
  };

  const hasLabel = typeof rect.text === 'string' && rect.text.length > 0;
  if (hasLabel) drawing.input.text = rect.text;

  const override = {};
  if (typeof rect.lineColor === 'string')        override.lineColor = rect.lineColor;
  if (typeof rect.backgroundColor === 'string')  override.backgroundColor = rect.backgroundColor;
  if (typeof rect.fillBackground === 'boolean')  override.fillBackground = rect.fillBackground;
  if (Number.isInteger(rect.lineWidth))          override.lineWidth = rect.lineWidth;
  if (hasLabel) {
    override.showLabel     = true;
    override.fontBold      = true;
    override.horzLabelAlign = 'center';
    override.vertLabelAlign = 'middle';
  }
  if (Object.keys(override).length > 0) drawing.override = override;

  return drawing;
}

// Construit le drawing Callout — texte avec flèche pointant vers un prix.
// Use case : marquer l'entry price ('When alerted') ou exit price ('$X.XX')
// sur le chart vidéo BoomProof.
//
// Schéma input (chart-img v2 — partage le shape start/end de Rectangle/Fib) :
//   startDatetime (ISO 8601) — pointe de la flèche : temps
//   startPrice    (number)   — pointe de la flèche : prix exact
//   endDatetime   (ISO 8601) — position de la box texte : temps (offset)
//   endPrice      (number)   — position de la box texte : prix (offset)
//   text          (string)   — contenu de la bulle
//
// Helpers d'input du caller :
//   datetime/price (anchor) — auto-construit start/end avec un offset par
//     défaut (start = anchor, end = anchor + 5% bar offset). Backward-compat
//     avec l'ancienne signature pour les call sites simples.
//
// Override (optionnel) : textColor, backgroundColor, borderColor, fontSize,
// fontBold.
//
// Renvoie null si un champ requis est invalide.
function buildCalloutDrawing(callout) {
  if (!callout) return null;

  // Mode start/end explicit (advanced) — laisse le caller piloter la box.
  let startDatetime = callout.startDatetime;
  let startPrice    = callout.startPrice;
  let endDatetime   = callout.endDatetime;
  let endPrice      = callout.endPrice;

  // Mode simple : caller passe datetime + price (anchor) — on calcule
  // automatiquement endDatetime/endPrice pour positionner la box texte.
  // L'offset par défaut place la box légèrement à droite et au-dessus
  // de la pointe pour rester lisible sans encombrer la candle.
  if (!startDatetime && typeof callout.datetime === 'string') {
    startDatetime = callout.datetime;
    startPrice    = callout.price;
    // End offset : +20 minutes (lisible sur 1D 5m candles) + 3% prix.
    if (typeof startDatetime === 'string' && Number.isFinite(startPrice)) {
      try {
        const startMs = new Date(startDatetime).getTime();
        endDatetime = new Date(startMs + 20 * 60 * 1000).toISOString();
        endPrice    = startPrice * 1.03;
      } catch { /* invalid date, leave undefined */ }
    }
  }

  const { text } = callout;
  if (typeof startDatetime !== 'string') return null;
  if (typeof endDatetime !== 'string')   return null;
  if (!Number.isFinite(startPrice))      return null;
  if (!Number.isFinite(endPrice))        return null;
  if (typeof text !== 'string' || text.length === 0) return null;

  const drawing = {
    name: 'Callout',
    input: { startDatetime, startPrice, endDatetime, endPrice, text },
  };

  const override = {};
  if (typeof callout.textColor === 'string')       override.textColor       = callout.textColor;
  if (typeof callout.backgroundColor === 'string') override.backgroundColor = callout.backgroundColor;
  if (typeof callout.borderColor === 'string')     override.borderColor     = callout.borderColor;
  if (Number.isInteger(callout.fontSize))          override.fontSize        = callout.fontSize;
  if (typeof callout.fontBold === 'boolean')       override.fontBold        = callout.fontBold;
  if (Object.keys(override).length > 0) drawing.override = override;

  return drawing;
}

// Construit le drawing "Arrow Mark Up" (ou "Arrow Mark Down") — flèche
// qui pointe vers un prix précis, avec un label optionnel.
// Schéma vérifié contre la doc + exemple user :
//   {
//     "name": "Arrow Mark Up",
//     "input": { "datetime": ISO, "price": number, "text"?: string },
//     "override": { "fontBold"?: bool, "color"?: rgb }
//   }
//
// Use case : marquer entry price ('When alerted') et exit price ('$X.XX')
// sur le chart BoomProof, plus visuellement clair que Callout.
//
// `arrow.direction` = 'up' (default) | 'down' — sélectionne le bon
// drawing TradingView.
//
// Renvoie null si un champ requis est invalide.
function buildArrowMarkupDrawing(arrow) {
  if (!arrow) return null;
  const { datetime, price, text } = arrow;
  if (typeof datetime !== 'string') return null;
  if (!Number.isFinite(price)) return null;

  const name = arrow.direction === 'down' ? 'Arrow Mark Down' : 'Arrow Mark Up';
  const drawing = { name, input: { datetime, price } };
  if (typeof text === 'string' && text.length > 0) {
    drawing.input.text = text;
  }

  const override = {};
  if (typeof arrow.fontBold === 'boolean') override.fontBold = arrow.fontBold;
  if (typeof arrow.color === 'string')     override.color    = arrow.color;
  if (Number.isInteger(arrow.fontSize))    override.fontSize = arrow.fontSize;
  if (Object.keys(override).length > 0) drawing.override = override;

  return drawing;
}

function withTimeout(promise, ms) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error('chart-img timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

function createChartImgClient({
  apiKey,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  now = () => Date.now(),
  ttlMs = 30_000,
  timeoutMs = 10_000,
  base = CHART_IMG_BASE,
  theme = 'dark',
  width = 800,
  height = 500,
  studies = DEFAULT_STUDIES,
} = {}) {
  if (!apiKey) throw new Error('chart-img apiKey required');
  if (!fetchImpl) throw new Error('fetch not available — provide fetchImpl');

  const cache = new Map();   // 'SYMBOL|RANGE|FIB' → { ts, data: Buffer } | { inflight }

  function buildBody(symbol, mapping, drawings, studiesOverride, sessionOverride, timezoneOverride, bodyOverride) {
    const body = {
      symbol,
      interval: mapping.interval,
      range:    mapping.range,
      theme,
      width,
      height,
    };
    // Per-call studies override (Array.isArray check) takes precedence over
    // the client default. `[]` is a valid override = "no studies at all".
    const effectiveStudies = Array.isArray(studiesOverride)
      ? studiesOverride
      : studies;
    if (effectiveStudies && effectiveStudies.length > 0) {
      body.studies = effectiveStudies;
    }
    // Per-call session/timezone override. chart-img defaults : session
    // 'regular' (9:30-16h ET), timezone 'Etc/UTC'. `!gap chart` passe
    // 'extended' (4h-20h ET) + 'America/New_York' pour aligner avec la
    // convention trader (X-axis en ET, gap visible entre 8pm et 4am).
    if (typeof sessionOverride === 'string')   body.session  = sessionOverride;
    if (typeof timezoneOverride === 'string')  body.timezone = timezoneOverride;
    if (drawings && drawings.length > 0) body.drawings = drawings;
    // Body-level override : permet de passer des TradingView property names
    // arbitraires (paneProperties.background, etc.) pour customiser le rendu
    // au-delà des params documentés. Use case : désactiver l'ombrage de
    // l'extended session via une propriété TV native.
    if (bodyOverride && typeof bodyOverride === 'object') {
      body.override = bodyOverride;
    }
    return body;
  }

  async function fetchPng(body) {
    const res = await withTimeout(
      fetchImpl(base, {
        method: 'POST',
        headers: {
          'x-api-key':    apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      timeoutMs,
    );
    if (!res || typeof res.ok !== 'boolean') {
      throw new Error('chart-img: invalid response object');
    }
    if (!res.ok) {
      const text = typeof res.text === 'function'
        ? await res.text().catch(() => '') : '';
      throw new Error(
        'chart-img HTTP ' + res.status + ': ' + (text || '').slice(0, 200));
    }
    if (typeof res.arrayBuffer !== 'function') {
      throw new Error('chart-img: response missing arrayBuffer()');
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  // getChart(symbol, range, opts?) → Buffer PNG
  // `symbol` doit être pré-résolu (ex: 'AMEX:SPY'). Voir resolveSymbol().
  // opts.fibAnchors = { startDatetime, startPrice, endDatetime, endPrice }
  //   → ajoute un Fib Retracement drawing entre ces 2 points. Caller
  //   responsable de trouver les swing low/high (timestamp + prix) sur
  //   la même fenêtre que le range demandé. Voir buildFibDrawing().
  // opts.rectangles = [ { startDatetime, startPrice, endDatetime, endPrice,
  //   text?, lineColor?, backgroundColor?, fillBackground?, lineWidth?,
  //   zOrder? }, ... ] → ajoute N rectangles (une zone surlignée par item).
  //   Use case principal : !gap chart pour surligner la zone du gap.
  //   Voir buildRectangleDrawing().
  // opts.studies = array → REMPLACE les DEFAULT_STUDIES du client pour ce
  //   call seulement. Use case : `!gap chart` veut juste [{ name: 'Volume' }]
  //   (pas de VWAP/EMAs/MAs qui obscurcissent la zone du gap). Passer `[]`
  //   pour zéro studies. `undefined` (ou absent) → defaults du client.
  // opts.session = 'regular' | 'extended' → override la session affichée.
  //   Default chart-img = 'regular' (9:30-16h ET). 'extended' inclut le
  //   pre-market (4h ET) et l'after-hours (jusqu'à 20h ET). Use case :
  //   `!gap chart` veut 'extended' pour rendre visible la zone 20h-4am
  //   où le gap se produit réellement.
  // opts.timezone = string IANA → override la timezone du X-axis (ex:
  //   'America/New_York'). Default chart-img = 'Etc/UTC'. Use case : afficher
  //   les heures de session US correctement labellisées sur le chart.
  // Throws 'Invalid range' si le range n'est pas mappable, sinon
  // propage les erreurs HTTP/timeout au caller.
  async function getChart(symbol, range, opts = {}) {
    const mapping = mapRangeToChartImg(range);
    if (!mapping) throw new Error('Invalid range: ' + range);

    const sym = String(symbol);

    const drawings = [];
    if (opts.fibAnchors) {
      const fib = buildFibDrawing(opts.fibAnchors);
      if (fib) drawings.push(fib);
    }
    if (Array.isArray(opts.rectangles)) {
      for (const r of opts.rectangles) {
        const rect = buildRectangleDrawing(r);
        if (rect) drawings.push(rect);
      }
    }
    if (Array.isArray(opts.callouts)) {
      for (const c of opts.callouts) {
        const callout = buildCalloutDrawing(c);
        if (callout) drawings.push(callout);
      }
    }
    if (Array.isArray(opts.arrows)) {
      for (const a of opts.arrows) {
        const arrow = buildArrowMarkupDrawing(a);
        if (arrow) drawings.push(arrow);
      }
    }

    // Clé case-sensitive sur le range. La présence du FIB / des rectangles
    // et leurs anchors exacts font partie de la clé pour qu'un changement
    // de swing ou de zone bypass le cache. Les studies aussi : un override
    // (ex: `!gap chart` avec juste Volume) doit avoir un cache distinct
    // du chart `!chart` avec les DEFAULT_STUDIES.
    const fibKey = opts.fibAnchors
      ? '|FIB:' + opts.fibAnchors.startDatetime + '@' + opts.fibAnchors.startPrice
        + '-' + opts.fibAnchors.endDatetime + '@' + opts.fibAnchors.endPrice
      : '';
    const rectKey = (Array.isArray(opts.rectangles) && opts.rectangles.length > 0)
      ? '|RECT:' + opts.rectangles.map(r =>
          r.startDatetime + '@' + r.startPrice + '-' + r.endDatetime + '@' + r.endPrice
            + (r.text ? '#' + r.text : '')
        ).join(',')
      : '';
    const calloutKey = (Array.isArray(opts.callouts) && opts.callouts.length > 0)
      ? '|CO:' + opts.callouts.map(c => {
          const dt = c.startDatetime || c.datetime;
          const pr = c.startPrice ?? c.price;
          return dt + '@' + pr + '#' + c.text;
        }).join(',')
      : '';
    const arrowKey = (Array.isArray(opts.arrows) && opts.arrows.length > 0)
      ? '|AR:' + opts.arrows.map(a => (a.direction || 'up') + '|' + a.datetime + '@' + a.price + '#' + (a.text || '')).join(',')
      : '';
    const studiesKey = Array.isArray(opts.studies)
      ? '|S:' + JSON.stringify(opts.studies)
      : '';
    const sessionKey  = typeof opts.session  === 'string' ? '|SES:' + opts.session  : '';
    const timezoneKey = typeof opts.timezone === 'string' ? '|TZ:'  + opts.timezone : '';
    const overrideKey = (opts.bodyOverride && typeof opts.bodyOverride === 'object')
      ? '|OV:' + JSON.stringify(opts.bodyOverride)
      : '';
    const key = sym + '|' + String(range) + fibKey + rectKey + calloutKey + arrowKey + studiesKey + sessionKey + timezoneKey + overrideKey;

    const hit = cache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }

    const body = buildBody(sym, mapping, drawings, opts.studies, opts.session, opts.timezone, opts.bodyOverride);
    const inflight = fetchPng(body);
    cache.set(key, { inflight });
    try {
      const data = await inflight;
      cache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  }

  return { getChart };
}

module.exports = {
  createChartImgClient,
  resolveSymbol,
  // exposed for tests
  mapRangeToChartImg,
  buildFibDrawing,
  buildRectangleDrawing,
  buildCalloutDrawing,
  buildArrowMarkupDrawing,
  YAHOO_TO_TV_EXCHANGE,
  DEFAULT_STUDIES,
  CHART_IMG_BASE,
};
