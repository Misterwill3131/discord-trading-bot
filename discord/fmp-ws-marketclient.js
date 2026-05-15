// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-marketclient.js — Adapter marketClient via WS FMP
// ─────────────────────────────────────────────────────────────────────
// Implémente le contrat marketClient (getQuote, getDailyBars) attendu
// par discord/market-alerts.js, en utilisant :
//   - un wsClient FMP qui stream les trades en temps réel
//   - un restClient FMP REST pour les daily bars (historique)
//
// État interne : Map<TICKER, { lastPrice, lastTs, cumulativeVolumeToday,
// etDateOfCumulative }>. Reset cumulé au changement d'ET-date et
// skip pre-market (avant 09:30 ET).
//
// Spec : docs/superpowers/specs/2026-05-14-fmp-websocket-stocks-design.md
// ─────────────────────────────────────────────────────────────────────

// Compute "YYYY-MM-DD" in America/New_York timezone.
function getETDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

// True if `date` falls within US regular trading hours (Mon-Fri 09:30-16:00 ET).
// Mirrors discord/market-alerts.js:isRTH for consistency.
function isRTH(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function createFmpWsMarketClient({
  apiKey,
  tickers = [],
  wsClient,
  restClient,
  now = () => new Date(),
  logger = console,
  fallbackFailureThreshold = 10,   // disconnects within window before flipping to REST
  fallbackFailureWindowMs = 5 * 60_000,
  maxStalenessMs = 15 * 60_000,    // cached quote is null if older than this
} = {}) {
  if (!wsClient)   throw new Error('wsClient required');
  if (!restClient) throw new Error('restClient required');

  // ticker (UPPERCASE) → { lastPrice, lastTs, cumulativeVolumeToday, etDateOfCumulative }
  const cache = new Map();

  // Track recent disconnect timestamps. When length within the rolling
  // window exceeds the threshold, flip `inFallback` true. The 'connected'
  // event resets fallback to false.
  let disconnectTimes = [];
  let inFallback = false;

  function recordDisconnect() {
    const t = now().getTime();
    // Drop events older than the window
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

  function onTrade({ ticker, price, tradeSize, ts }) {
    const key = String(ticker).toUpperCase();
    const nowDate = now();
    const todayKey = getETDateKey(nowDate);
    const inRTH = isRTH(nowDate);

    let entry = cache.get(key);
    if (!entry) {
      entry = {
        lastPrice: null,
        lastTs: null,
        cumulativeVolumeToday: 0,
        etDateOfCumulative: todayKey,
      };
      cache.set(key, entry);
    }
    // Always update price (pre-market quotes are still useful context).
    entry.lastPrice = Number(price);
    entry.lastTs = Number(ts);
    // Volume: reset if ET-date changed, then only accumulate during RTH.
    if (entry.etDateOfCumulative !== todayKey) {
      entry.cumulativeVolumeToday = 0;
      entry.etDateOfCumulative = todayKey;
    }
    if (inRTH && Number.isFinite(tradeSize)) {
      entry.cumulativeVolumeToday += Number(tradeSize);
    }
  }

  // Defense: attach an 'error' listener on the wsClient EventEmitter.
  // Without this, an emit('error', ...) (e.g. FMP rejects login as
  // "Unauthorized") would be unhandled and crash the entire Node process,
  // taking down all Discord bots that share the process.
  // On any WS error → engage REST fallback. On auth errors specifically,
  // stop the wsClient to avoid spamming reconnects with bad credentials.
  function handleWsError(err) {
    const msg = err && err.message ? err.message : String(err);
    logger.error('[fmp-ws-marketclient] WS error — engaging REST fallback:', msg);
    inFallback = true;
    if (/login rejected|unauthorized|forbidden/i.test(msg)) {
      if (typeof wsClient.stop === 'function') {
        try { wsClient.stop(); } catch (_) { /* noop */ }
      }
    }
  }

  wsClient.on('error', handleWsError);
  wsClient.on('trade', onTrade);
  wsClient.on('disconnected', recordDisconnect);
  wsClient.on('connected', clearFallback);

  return {
    async getQuote(ticker) {
      if (inFallback) {
        return restClient.getQuote(ticker);
      }
      const key = String(ticker).toUpperCase();
      const entry = cache.get(key);
      if (!entry || entry.lastPrice == null) return null;
      // Staleness: if the last trade is older than maxStalenessMs, treat
      // the cache as no-data. Protects illiquid tickers from firing
      // spurious alerts against fresh daily bars.
      if (entry.lastTs != null && (now().getTime() - entry.lastTs) > maxStalenessMs) {
        return null;
      }
      return {
        price: entry.lastPrice,
        volume: entry.cumulativeVolumeToday,
      };
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
        subscribedTickers: Array.isArray(ws.subscribedTickers) ? ws.subscribedTickers : [],
        recentDisconnects: disconnectTimes.length,
      };
    },
  };
}

module.exports = { createFmpWsMarketClient, getETDateKey, isRTH };
