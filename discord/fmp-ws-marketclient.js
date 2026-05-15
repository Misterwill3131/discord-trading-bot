// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-marketclient.js — Adapter marketClient via WS FMP
// ─────────────────────────────────────────────────────────────────────
// Implements the marketClient contract (getQuote, getDailyBars) expected
// by discord/market-alerts.js, sourcing live prices from a wsClient that
// streams full FMP quote objects, with automatic REST fallback when the
// WebSocket is unstable.
//
// FMP streams are subscribed at the EXCHANGE / SYNTHETIC level (e.g.
// fmp-us-equities-stream). Every quote for every symbol in that stream
// is delivered — we filter client-side against the configured tickers
// of interest and cache only the latest per-symbol.
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-websocket-fix-design.md
// ─────────────────────────────────────────────────────────────────────

function createFmpWsMarketClient({
  apiKey,
  tickers = [],
  wsClient,
  restClient,
  now = () => new Date(),
  logger = console,
  fallbackFailureThreshold = 10,
  fallbackFailureWindowMs = 5 * 60_000,
  maxStalenessMs = 15 * 60_000,
} = {}) {
  if (!wsClient)   throw new Error('wsClient required');
  if (!restClient) throw new Error('restClient required');

  // Cache: keyed by UPPERCASE symbol.
  const cache = new Map();

  // Tickers of interest — UPPERCASE for case-insensitive matching.
  const watchedTickers = new Set(
    tickers.map(t => String(t).toUpperCase()).filter(Boolean),
  );

  // Sliding window of disconnect timestamps; flip inFallback when count
  // within the window exceeds threshold.
  let disconnectTimes = [];
  let inFallback = false;

  function recordDisconnect() {
    const t = now().getTime();
    disconnectTimes = disconnectTimes.filter(x => (t - x) <= fallbackFailureWindowMs);
    disconnectTimes.push(t);
    if (!inFallback && disconnectTimes.length >= fallbackFailureThreshold) {
      inFallback = true;
      logger.warn('[fmp-ws-marketclient] WS unstable — flipping to REST fallback ('
        + disconnectTimes.length + ' disconnects in '
        + Math.round(fallbackFailureWindowMs / 1000) + 's window)');
    }
  }

  function clearFallback() {
    if (inFallback) {
      logger.log('[fmp-ws-marketclient] WS reconnected — leaving REST fallback');
      inFallback = false;
    }
    disconnectTimes = [];
  }

  function onQuote(q) {
    if (!q || typeof q !== 'object') return;
    const symbol = String(q.symbol || '').toUpperCase();
    if (!symbol || !watchedTickers.has(symbol)) return;

    const price = Number.isFinite(q.price) ? q.price : null;
    if (price == null) return;   // do not cache garbage

    cache.set(symbol, {
      price,
      volume:    Number.isFinite(q.volume) ? q.volume : 0,
      dayHigh:   Number.isFinite(q.dayHigh) ? q.dayHigh : null,
      dayLow:    Number.isFinite(q.dayLow)  ? q.dayLow  : null,
      timestamp: Number(q.timestamp) || 0,
      receivedAt: now().getTime(),
    });
  }

  wsClient.on('quote', onQuote);
  wsClient.on('disconnected', recordDisconnect);
  wsClient.on('connected', clearFallback);
  wsClient.on('error', (err) => {
    logger.error('[fmp-ws-marketclient] WS error: '
      + (err && err.message ? err.message : String(err)));
    recordDisconnect();
  });

  return {
    async getQuote(ticker) {
      if (inFallback) {
        return restClient.getQuote(ticker);
      }
      const key = String(ticker).toUpperCase();
      const entry = cache.get(key);
      if (!entry || entry.price == null) return null;
      if ((now().getTime() - entry.receivedAt) > maxStalenessMs) {
        return null;
      }
      return { price: entry.price, volume: entry.volume };
    },

    async getDailyBars(ticker) {
      return restClient.getDailyBars(ticker);
    },

    start() {
      if (typeof wsClient.start === 'function') wsClient.start();
    },

    stop() {
      if (typeof wsClient.stop === 'function') wsClient.stop();
    },

    getStatus() {
      const ws = typeof wsClient.getStatus === 'function' ? wsClient.getStatus() : {};
      return {
        source: inFallback ? 'rest-fallback' : 'ws',
        wsConnected: !!ws.connected,
        wsAttemptCount: ws.attemptCount || 0,
        subscribedStreams: Array.isArray(ws.subscribedStreams) ? ws.subscribedStreams : [],
        recentDisconnects: disconnectTimes.length,
      };
    },
  };
}

module.exports = { createFmpWsMarketClient };
