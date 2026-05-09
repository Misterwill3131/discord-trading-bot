// ─────────────────────────────────────────────────────────────────────
// discord/chart-img-client.js — Client chart-img.com (Advanced Chart v2)
// ─────────────────────────────────────────────────────────────────────
// Wrapper minimal autour de l'Advanced Chart API v2 de chart-img.com.
// Renvoie un Buffer PNG prêt à être posté dans Discord.
//
// Endpoint : GET https://api.chart-img.com/v2/tradingview/advanced-chart
//   Auth   : header `x-api-key: <CHART_IMG_API_KEY>`
//   Query  : symbol, interval, range, theme, width, height
//   Resp   : binaire PNG (Content-Type: image/png)
//
// Pattern identique à discord/fmp-client.js :
//   - Cache en mémoire (TTL 30s) — chart-img facture par requête
//   - Dedup des appels concurrents pour la même clé
//   - Timeout 10s via Promise.race
//   - fetchImpl injectable pour les tests (Node 18+ a fetch global)
//
// Usage côté handler :
//   const buffer = await client.getChart('AAPL', '1D');
//   await message.reply({ files: [{ attachment: buffer, name: 'AAPL-1D.png' }] });
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
} = {}) {
  if (!apiKey) throw new Error('chart-img apiKey required');
  if (!fetchImpl) throw new Error('fetch not available — provide fetchImpl');

  const cache = new Map();   // 'TICKER|RANGE' → { ts, data: Buffer } | { inflight }

  function buildUrl(symbol, mapping) {
    const params = new URLSearchParams({
      symbol,
      interval: mapping.interval,
      range:    mapping.range,
      theme,
      width:    String(width),
      height:   String(height),
    });
    return base + '?' + params.toString();
  }

  async function fetchPng(url) {
    const res = await withTimeout(
      fetchImpl(url, { headers: { 'x-api-key': apiKey } }),
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
    // L'API renvoie du PNG binaire. fetch global expose .arrayBuffer().
    if (typeof res.arrayBuffer !== 'function') {
      throw new Error('chart-img: response missing arrayBuffer()');
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  // getChart(ticker, range) → Buffer PNG
  // Throws 'invalid range' si le range n'est pas mappable, sinon
  // propage les erreurs HTTP/timeout au caller.
  async function getChart(ticker, range) {
    const mapping = mapRangeToChartImg(range);
    if (!mapping) throw new Error('Invalid range: ' + range);

    const symbol = String(ticker).toUpperCase();
    // Clé case-sensitive sur le range pour distinguer 1m/1M.
    const key = symbol + '|' + String(range);

    const hit = cache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }

    const url = buildUrl(symbol, mapping);
    const inflight = fetchPng(url);
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
  // exposed for tests
  mapRangeToChartImg,
  CHART_IMG_BASE,
};
