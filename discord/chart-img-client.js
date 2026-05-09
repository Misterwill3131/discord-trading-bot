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

// Indicateurs superposés sur le chart par défaut. Format chart-img v2 :
// `name` = nom canonique TradingView, `input.in_0` = longueur (ou source
// pour VWAP), `input.in_1` = price source ('close' usuel).
//
// 7 studies = potentiellement au-dessus de la limite du plan free
// (typiquement 5). Si chart-img répond 4xx avec "study limit exceeded",
// la solution rapide est de retirer MA 325 et EMA 200 (les moins
// utilisées sur du trading court terme).
const DEFAULT_STUDIES = [
  { name: 'Volume Weighted Average', input: { in_0: 'Session', in_1: 'hlc3' } },
  { name: 'Exponential Moving Average', input: { in_0: 9,   in_1: 'close' } },
  { name: 'Exponential Moving Average', input: { in_0: 20,  in_1: 'close' } },
  { name: 'Exponential Moving Average', input: { in_0: 50,  in_1: 'close' } },
  { name: 'Exponential Moving Average', input: { in_0: 200, in_1: 'close' } },
  { name: 'Moving Average',             input: { in_0: 50,  in_1: 'close' } },
  { name: 'Moving Average',             input: { in_0: 325, in_1: 'close' } },
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

  function buildBody(symbol, mapping, drawings) {
    const body = {
      symbol,
      interval: mapping.interval,
      range:    mapping.range,
      theme,
      width,
      height,
    };
    if (studies && studies.length > 0) body.studies = studies;
    if (drawings && drawings.length > 0) body.drawings = drawings;
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

    // Clé case-sensitive sur le range. La présence du FIB et les anchors
    // exacts font partie de la clé pour qu'un changement de swing (nouveau
    // high/low intraday) bypass le cache.
    const fibKey = drawings.length
      ? '|FIB:' + opts.fibAnchors.startDatetime + '@' + opts.fibAnchors.startPrice
        + '-' + opts.fibAnchors.endDatetime + '@' + opts.fibAnchors.endPrice
      : '';
    const key = sym + '|' + String(range) + fibKey;

    const hit = cache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }

    const body = buildBody(sym, mapping, drawings);
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
  YAHOO_TO_TV_EXCHANGE,
  DEFAULT_STUDIES,
  CHART_IMG_BASE,
};
