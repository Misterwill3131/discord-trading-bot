// ─────────────────────────────────────────────────────────────────────
// trading/marketdata.js — Bougies historiques via IBKR Gateway
// ─────────────────────────────────────────────────────────────────────
// Utilise le même IBKR Gateway qui sert aux ordres → une seule
// connexion, zéro dépendance externe (plus d'Alpaca).
//
// Cache mémoire par (ticker, timeframe, limit) avec TTL 30s pour éviter
// de spammer `reqHistoricalData` quand plusieurs signaux arrivent sur
// le même ticker.
//
// Pour les tests, on peut passer un broker mocké ou un `fetchBars`
// custom en options.
// ─────────────────────────────────────────────────────────────────────

function createMarketData({
  broker,
  fetchBars,                // optionnel : override direct (utile en tests)
  cacheTtlMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  async function fetchCandles(ticker, timeframe = '5 mins', limit = 50) {
    const cacheKey = ticker + '|' + timeframe + '|' + limit;
    const hit = cache.get(cacheKey);
    if (hit && (now() - hit.ts) < cacheTtlMs) {
      return hit.bars;
    }

    let bars;
    if (typeof fetchBars === 'function') {
      bars = await fetchBars(ticker, timeframe, limit);
    } else if (broker && typeof broker.getHistoricalBars === 'function') {
      bars = await broker.getHistoricalBars(ticker, timeframe, limit);
    } else {
      throw new Error('marketdata: no broker with getHistoricalBars (live IBKR mode required)');
    }

    cache.set(cacheKey, { ts: now(), bars });
    return bars;
  }

  function clearCache() { cache.clear(); }

  return { fetchCandles, clearCache };
}

module.exports = { createMarketData };
