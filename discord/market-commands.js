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

const VALID_RANGES = {
  '1D': { interval: '5m',  ms: 86_400_000 },
  '5D': { interval: '15m', ms: 5 * 86_400_000 },
  '1M': { interval: '1d',  ms: 30 * 86_400_000 },
  '3M': { interval: '1d',  ms: 90 * 86_400_000 },
  '6M': { interval: '1d',  ms: 180 * 86_400_000 },
  '1Y': { interval: '1d',  ms: 365 * 86_400_000 },
};

function parseRange(arg, now = new Date()) {
  const key = arg ? String(arg).toUpperCase() : '1D';
  const cfg = VALID_RANGES[key];
  if (!cfg) return null;
  return {
    interval: cfg.interval,
    period1: new Date(now.getTime() - cfg.ms),
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
    // Lazy require to keep the module loadable even if yahoo-finance2 is not installed
    // in some edge path (tests always inject their own fake).
    yahoo = require('yahoo-finance2').default;
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
    const key = t + '|' + String(range || '1D').toUpperCase();
    const hit = chartCache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    const inflight = withTimeout(
      yahoo.chart(t, { interval: parsed.interval, period1: parsed.period1 }),
      timeoutMs,
    );
    chartCache.set(key, { inflight });
    try {
      const data = await inflight;
      chartCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      chartCache.delete(key);
      throw err;
    }
  }

  return { getQuote, getChart };
}

function renderChartPng(candles, ticker, range) {
  const W = 800, H = 400, PAD = 50;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('$' + ticker + ' — ' + range, PAD, 30);

  const closes = (candles || []).map(c => c.close).filter(c => Number.isFinite(c));
  if (closes.length < 2) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '16px sans-serif';
    ctx.fillText('Not enough data to render chart.', PAD, H / 2);
    return canvas.toBuffer('image/png');
  }

  const minC = Math.min(...closes);
  const maxC = Math.max(...closes);
  const chartW = W - 2 * PAD;
  const chartH = H - 2 * PAD - 20; // room for title
  const chartY0 = PAD + 20;
  const span = (maxC - minC) || 1;

  const x = (i) => PAD + (i / (closes.length - 1)) * chartW;
  const y = (v) => chartY0 + chartH - ((v - minC) / span) * chartH;

  // Subtle horizontal gridlines at min/mid/max.
  // Labels right-aligned inside the left padding zone (PAD-4) so 5-digit
  // prices ne chevauchent pas la zone du graphique.
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  [minC, (minC + maxC) / 2, maxC].forEach(v => {
    ctx.beginPath();
    ctx.moveTo(PAD, y(v));
    ctx.lineTo(W - PAD, y(v));
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px sans-serif';
    ctx.fillText('$' + v.toFixed(2), PAD - 4, y(v) + 4);
  });
  ctx.textAlign = 'left';

  // Price line (green if last >= first, else red)
  const rising = closes[closes.length - 1] >= closes[0];
  ctx.strokeStyle = rising ? '#2fc774' : '#f5515f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  closes.forEach((c, i) => {
    if (i === 0) ctx.moveTo(x(i), y(c));
    else ctx.lineTo(x(i), y(c));
  });
  ctx.stroke();

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
    '> 💰 Prix : $' + price.toFixed(2) + ' ' + arrow + ' ' + changeStr,
    '> 📦 Volume : ' + vol,
    '> 📉 Day : ' + dayLow + ' → ' + dayHigh,
    '> 📆 52W : ' + w52Low + ' → ' + w52High,
    '> 🏦 Market cap : ' + formatMarketCap(quote.marketCap),
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
      try { await message.reply('❌ Usage: !price TICKER (ex: !price AAPL)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace(/\$/g, '').toUpperCase();
    console.log('[!price] ' + ticker + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    try {
      const quote = await yc.getQuote(ticker);
      if (!quote || quote.regularMarketPrice == null) {
        console.log('[!price] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      await message.reply(formatQuoteMessage(quote));
    } catch (err) {
      if (isUnknownTickerError(err)) {
        console.log('[!price] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        console.error('[!price] Rate limited');
        try { await message.reply('❌ Trop de requêtes, patiente 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance indisponible, réessaye dans quelques minutes'); } catch (_) {}
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
      try { await message.reply('❌ Usage: !chart TICKER [RANGE] (ex: !chart AAPL 5D)'); } catch (_) {}
      return;
    }
    const ticker = tickerArg.replace(/\$/g, '').toUpperCase();
    const range = (rangeArg || '1D').toUpperCase();

    if (!parseRange(range)) {
      try { await message.reply('❌ Range invalide. Utilise: 1D, 5D, 1M, 3M, 6M, 1Y'); } catch (_) {}
      return;
    }

    console.log('[!chart] ' + ticker + ' ' + range + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    let candles;
    try {
      const chart = await yc.getChart(ticker, range);
      candles = (chart && chart.quotes) || [];
      if (candles.length === 0) {
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
    } catch (err) {
      if (isUnknownTickerError(err)) {
        try { await message.reply('❌ Ticker $' + ticker + ' introuvable'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        try { await message.reply('❌ Trop de requêtes, patiente 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance indisponible, réessaye dans quelques minutes'); } catch (_) {}
      return;
    }

    let buffer;
    try {
      buffer = renderChartPng(candles, ticker, range);
    } catch (err) {
      console.error('[!chart] render failed', err.stack || err.message);
      try { await message.reply('❌ Erreur génération graphique'); } catch (_) {}
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
