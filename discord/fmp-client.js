// ─────────────────────────────────────────────────────────────────────
// discord/fmp-client.js — Client Financial Modeling Prep (FMP) /stable/
// ─────────────────────────────────────────────────────────────────────
// Wrapper minimal autour de l'API FMP pour les alertes prix/volume.
// Conforme au contrat marketClient attendu par discord/market-alerts.js :
//
//   getQuote(ticker)     → { price: number, volume: number }
//   getDailyBars(ticker) → [{ date: Date, open, high, low, close, volume }, ...]
//                          (ordre chronologique CROISSANT — plus ancien en
//                          premier, comme attendu par extractContext())
//
// Endpoints utilisés (FMP /stable/, migré le 2026-05-15) :
//   GET /stable/quote?symbol={s}
//     → [{ symbol, price, volume, dayLow, dayHigh, changePercentage, ... }]
//   GET /stable/batch-quote?symbols={s1},{s2},...
//     → same shape as /stable/quote
//   GET /stable/historical-price-eod/full?symbol={s}
//     → [{ symbol, date: 'YYYY-MM-DD', open, high, low, close, volume }, ...]
//     Array plat (plus de wrapper {historical}). Newest-first chez FMP →
//     on inverse pour l'ordre attendu et on slice à 10 dernières barres.
//
// Auth : query param `apikey=...`. Plan free = ~250 req/jour ; on cache
// agressivement (TTL 30s sur les quotes, idem chart) pour rester sous
// le quota. La pacing finale est gérée par le caller (cadence 5min en
// free-tier au lieu de 60s).
//
// Robustesse :
//   - Timeout 10s par défaut (Promise.race) — évite qu'une coupure réseau
//     bloque le scheduler.
//   - Dedup des appels concurrents pour le même ticker (in-flight Map)
//     → si 2 ticks arrivent en parallèle, un seul HTTP fire.
//   - Pas de retry interne — le caller (market-alerts) catche les erreurs
//     et continue avec le ticker suivant.
//
// Tests : injection via `fetch` (Node 18+ a fetch global ; fallback léger
// pour les tests qui passent un mock).
// ─────────────────────────────────────────────────────────────────────

const FMP_BASE = 'https://financialmodelingprep.com/stable';

function withTimeout(promise, ms) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error('fmp timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

// Parse 'YYYY-MM-DD' (UTC midnight). FMP ne donne pas l'heure de close —
// on prend midnight UTC, ça suffit pour la logique ET-date dans
// market-alerts.js (le filtre est `getETDateKey(b.date) < etDate`, et
// midnight UTC d'un YYYY-MM-DD donné mappe correctement à la même date
// ET pour tous les jours de trading US).
function parseFmpDate(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    20, 0, 0,  // 20:00 UTC = 16:00 ET (fermeture) — date mappable sans ambigu
  ));
}

function createFmpClient({
  apiKey,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  now = () => Date.now(),
  ttlMs = 30_000,
  timeoutMs = 10_000,
  base = FMP_BASE,
} = {}) {
  if (!apiKey) throw new Error('FMP apiKey required');
  if (!fetchImpl) throw new Error('fetch not available — provide fetchImpl');

  const quoteCache = new Map();    // ticker → { ts, data } | { inflight }
  const barsCache = new Map();     // ticker → { ts, data } | { inflight }

  async function httpJson(url) {
    const res = await withTimeout(fetchImpl(url), timeoutMs);
    if (!res || typeof res.ok !== 'boolean') {
      throw new Error('fmp: invalid response object');
    }
    if (!res.ok) {
      const text = typeof res.text === 'function'
        ? await res.text().catch(() => '') : '';
      throw new Error('fmp HTTP ' + res.status + ': ' + (text || '').slice(0, 200));
    }
    if (typeof res.json !== 'function') {
      throw new Error('fmp: response missing json()');
    }
    return res.json();
  }

  async function getQuote(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = quoteCache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const url = base + '/quote?symbol=' + encodeURIComponent(key)
      + '&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      // FMP renvoie un tableau (souvent à 1 élément) ; tableau vide =
      // ticker inconnu → on retourne null pour matcher la sémantique
      // de Yahoo (no-data = no-alert).
      const row = Array.isArray(json) && json.length > 0 ? json[0] : null;
      if (!row) return null;
      return {
        price: Number.isFinite(row.price) ? row.price : null,
        volume: Number.isFinite(row.volume) ? row.volume : 0,
      };
    })();
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

  async function getDailyBars(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = barsCache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    // timeseries=10 : 10 dernières barres daily — assez pour yesterday
    // (1 barre) + week (5) avec marge pour weekend/holiday gaps.
    const url = base + '/historical-price-full/' + encodeURIComponent(key)
      + '?timeseries=10&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      const hist = json && Array.isArray(json.historical) ? json.historical : [];
      // FMP envoie newest-first → on inverse pour respecter le contrat
      // (chronologique croissant), comme extractContext() s'y attend.
      const bars = [];
      for (let i = hist.length - 1; i >= 0; i--) {
        const b = hist[i];
        const date = parseFmpDate(b && b.date);
        if (!date) continue;
        bars.push({
          date,
          open:   Number.isFinite(b.open)   ? b.open   : null,
          high:   Number.isFinite(b.high)   ? b.high   : null,
          low:    Number.isFinite(b.low)    ? b.low    : null,
          close:  Number.isFinite(b.close)  ? b.close  : null,
          volume: Number.isFinite(b.volume) ? b.volume : 0,
        });
      }
      return bars;
    })();
    barsCache.set(key, { inflight });
    try {
      const data = await inflight;
      barsCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      barsCache.delete(key);
      throw err;
    }
  }

  // Bulk quote: FMP supports up to ~250 tickers per call via comma-joined
  // path (`/quote/AAPL,TSLA,NVDA`). Returns { TICKER: { price, volume }, ... }
  // keyed by upper-cased symbol. Tickers missing from the response simply
  // don't appear in the output map (no exception). Non-finite prices are
  // skipped — same sanity rule as getQuote.
  async function getQuotesBulk(tickers) {
    const list = Array.from(new Set(
      (Array.isArray(tickers) ? tickers : [])
        .map(t => String(t).toUpperCase())
        .filter(Boolean)
    ));
    if (list.length === 0) return {};
    const url = base + '/quote/' + list.map(encodeURIComponent).join(',')
      + '?apikey=' + encodeURIComponent(apiKey);
    const json = await httpJson(url);
    const rows = Array.isArray(json) ? json : [];
    const out = {};
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const sym = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : null;
      if (!sym) continue;
      const price = Number.isFinite(row.price) ? row.price : null;
      if (price == null) continue;
      out[sym] = {
        price,
        volume: Number.isFinite(row.volume) ? row.volume : 0,
      };
    }
    return out;
  }

  return { getQuote, getDailyBars, getQuotesBulk };
}

module.exports = {
  createFmpClient,
  // exposed for tests
  parseFmpDate,
};
