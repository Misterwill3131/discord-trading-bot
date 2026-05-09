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

const { computeIndicators } = require('../trading/indicators');

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

function registerMarketCommands(client, { yahooClient, chartImgClient } = {}) {
  const yc = yahooClient || createYahooClient();
  // chartImgClient peut être null si CHART_IMG_API_KEY est absent — dans ce
  // cas le handler !chart répond avec un message "command unavailable" plutôt
  // que de crasher. Permet au reste du bot de tourner sans la clé.
  const cic = chartImgClient || null;

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
  // Délègue à chart-img.com (Advanced Chart API) — le client encapsule la
  // requête HTTP, la cache 30s et le mapping range→{interval, range}.
  // Si CHART_IMG_API_KEY n'est pas en env, le handler répond avec un
  // message d'indisponibilité plutôt que de crasher.
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

    if (!cic) {
      console.warn('[!chart] CHART_IMG_API_KEY missing — command unavailable');
      try { await message.reply('❌ Chart command unavailable (CHART_IMG_API_KEY not configured)'); } catch (_) {}
      return;
    }

    console.log('[!chart] ' + ticker + ' ' + range + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    let buffer;
    try {
      buffer = await cic.getChart(ticker, range);
    } catch (err) {
      const msg = String(err && err.message || err);
      // 401/403 = clé invalide ou plan expiré — log explicite côté server,
      // message générique côté Discord (n'expose pas le code).
      if (/HTTP 401|HTTP 403/.test(msg)) {
        console.error('[!chart] auth error:', msg);
        try { await message.reply('❌ Chart unavailable, try again later'); } catch (_) {}
        return;
      }
      if (/HTTP 429/.test(msg)) {
        console.error('[!chart] rate limited:', msg);
        try { await message.reply('❌ Rate limited, try again in 30s'); } catch (_) {}
        return;
      }
      console.error('[!chart] chart-img error:', err.stack || msg);
      try { await message.reply('❌ Chart unavailable, try again later'); } catch (_) {}
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
  formatPrice,
  formatVolume,
  createYahooClient,
  registerMarketCommands,
  // exposed for tests
  formatQuoteMessage,
};
