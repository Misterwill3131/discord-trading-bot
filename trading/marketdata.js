// ─────────────────────────────────────────────────────────────────────
// trading/marketdata.js — Chandeliers 5min via Alpaca Market Data v2
// ─────────────────────────────────────────────────────────────────────
// Compte Alpaca API gratuit suffit (pas besoin d'un compte de trading).
// Flux IEX par défaut (gratuit). SIP disponible via option.
//
// Cache mémoire par (ticker, timeframe, limit) avec TTL 30s pour éviter
// de spammer l'API quand plusieurs signaux arrivent sur le même ticker.
//
// `fetchFn` et `now` injectables pour les tests.
// ─────────────────────────────────────────────────────────────────────

const nodeFetch = require('node-fetch');

function createMarketData({
  fetchFn = nodeFetch,
  keyId,
  secretKey,
  cacheTtlMs = 30_000,
  now = () => Date.now(),
  feed = 'iex',
} = {}) {
  const cache = new Map();

  async function fetchCandles(ticker, timeframe = '5Min', limit = 50) {
    const cacheKey = `${ticker}|${timeframe}|${limit}`;
    const hit = cache.get(cacheKey);
    if (hit && (now() - hit.ts) < cacheTtlMs) {
      return hit.bars;
    }

    const url = 'https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(ticker)
      + '/bars?timeframe=' + encodeURIComponent(timeframe)
      + '&limit=' + encodeURIComponent(limit)
      + '&feed=' + encodeURIComponent(feed);

    const res = await fetchFn(url, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Alpaca ' + res.status + ' for ' + ticker + ': ' + body);
    }
    const data = await res.json();
    const bars = Array.isArray(data.bars) ? data.bars : [];
    cache.set(cacheKey, { ts: now(), bars });
    return bars;
  }

  function clearCache() { cache.clear(); }

  return { fetchCandles, clearCache };
}

module.exports = { createMarketData };
