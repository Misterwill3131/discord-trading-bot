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
const { computeIndicators, calcEMASeries } = require('../trading/indicators');
const { FONT } = require('../canvas/config');

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
  ctx.font = 'bold 20px ' + FONT;
  ctx.fillText('$' + ticker + ' — ' + range, PAD, 30);

  const closes = (candles || []).map(c => c.close).filter(c => Number.isFinite(c));
  if (closes.length < 2) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '16px ' + FONT;
    ctx.fillText('Not enough data to render chart.', PAD, H / 2);
    return canvas.toBuffer('image/png');
  }

  // EMA séries — une valeur par index du close (null avant seed).
  // Séries vides si pas assez de bars pour le period correspondant.
  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);

  // Min/max incluent les EMAs pour que l'échelle fit toutes les lignes.
  const allValues = closes.concat(
    ema9Series.filter(v => v != null),
    ema20Series.filter(v => v != null),
  );
  const minC = Math.min(...allValues);
  const maxC = Math.max(...allValues);
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
    ctx.font = '12px ' + FONT;
    ctx.fillText('$' + v.toFixed(2), PAD - 4, y(v) + 4);
  });
  ctx.textAlign = 'left';

  // Helper pour dessiner une série où certains points peuvent être null
  // (cas des EMAs avant leur seed). On "pen-up" sur null pour éviter un
  // segment fantôme entre le premier index non-null et l'index 0.
  function drawSeries(series, color, lineWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v == null) { penDown = false; continue; }
      if (!penDown) { ctx.moveTo(x(i), y(v)); penDown = true; }
      else { ctx.lineTo(x(i), y(v)); }
    }
    ctx.stroke();
  }

  // EMA20 d'abord (fond), puis EMA9, puis close en dernier (premier plan).
  if (ema20Series.some(v => v != null)) drawSeries(ema20Series, '#4ac4ff', 1.5);
  if (ema9Series.some(v => v != null))  drawSeries(ema9Series,  '#ffd700', 1.5);

  // Price line (green if last >= first, else red)
  const rising = closes[closes.length - 1] >= closes[0];
  const priceColor = rising ? '#2fc774' : '#f5515f';
  drawSeries(closes, priceColor, 2);

  // Légende en bas-gauche : ■ Close  ■ EMA9  ■ EMA20
  ctx.font = '12px ' + FONT;
  ctx.textAlign = 'left';
  const legendItems = [
    { label: 'Close', color: priceColor },
    { label: 'EMA9',  color: '#ffd700' },
    { label: 'EMA20', color: '#4ac4ff' },
  ];
  const SWATCH = 8, GAP = 4, ITEM_GAP = 14;
  let cx = PAD;
  const cy = H - 12; // baseline près du bord inférieur
  legendItems.forEach((it) => {
    ctx.fillStyle = it.color;
    ctx.fillRect(cx, cy - SWATCH + 1, SWATCH, SWATCH);
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(it.label, cx + SWATCH + GAP, cy);
    cx += SWATCH + GAP + ctx.measureText(it.label).width + ITEM_GAP;
  });

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

function registerMarketCommands(client, { yahooClient } = {}) {
  const yc = yahooClient || createYahooClient();

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
    const range = (rangeArg || '1D').toUpperCase();

    if (!parseRange(range)) {
      try { await message.reply('❌ Invalid range. Use: 1D, 5D, 1M, 3M, 6M, 1Y'); } catch (_) {}
      return;
    }

    console.log('[!chart] ' + ticker + ' ' + range + ' requested by ' + message.author.username
      + ' in #' + (message.channel.name || message.channel.id));

    let candles;
    try {
      const chart = await yc.getChart(ticker, range);
      candles = (chart && chart.quotes) || [];
      if (candles.length === 0) {
        // Ticker valide mais pas de données (jour férié, hors séance, ticker
        // très illiquide). On distingue du cas "ticker introuvable" qui passe
        // par le catch.
        try { await message.reply('❌ No data available for $' + ticker + ' on ' + range); } catch (_) {}
        return;
      }
    } catch (err) {
      if (isUnknownTickerError(err)) {
        console.log('[!chart] Unknown ticker: ' + ticker);
        try { await message.reply('❌ Ticker $' + ticker + ' not found'); } catch (_) {}
        return;
      }
      if (isRateLimitError(err)) {
        console.error('[!chart] Rate limited');
        try { await message.reply('❌ Rate limited, try again in 30s'); } catch (_) {}
        return;
      }
      console.error('[yahoo]', err.stack || err.message);
      try { await message.reply('❌ Yahoo Finance unavailable, try again in a few minutes'); } catch (_) {}
      return;
    }

    let buffer;
    try {
      buffer = renderChartPng(candles, ticker, range);
    } catch (err) {
      console.error('[!chart] render failed', err.stack || err.message);
      try { await message.reply('❌ Chart rendering failed'); } catch (_) {}
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

    const lines = [
      '📈 **$' + ticker + ' — Indicators**',
      '> Price: $' + ind.lastPrice.toFixed(2),
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
  createYahooClient,
  renderChartPng,
  registerMarketCommands,
  // exposed for tests
  formatQuoteMessage,
};
