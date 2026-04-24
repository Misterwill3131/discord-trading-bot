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
    if (hit && (now() - hit.ts) < ttlMs) return hit.data;
    const data = await withTimeout(yahoo.quote(key), timeoutMs);
    quoteCache.set(key, { ts: now(), data });
    return data;
  }

  async function getChart(ticker, range) {
    const parsed = parseRange(range, new Date(now()));
    if (!parsed) throw new Error('Invalid range: ' + range);
    const t = String(ticker).toUpperCase();
    const key = t + '|' + String(range || '1D').toUpperCase();
    const hit = chartCache.get(key);
    if (hit && (now() - hit.ts) < ttlMs) return hit.data;
    const data = await withTimeout(
      yahoo.chart(t, { interval: parsed.interval, period1: parsed.period1 }),
      timeoutMs,
    );
    chartCache.set(key, { ts: now(), data });
    return data;
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

module.exports = { parseRange, formatMarketCap, createYahooClient, renderChartPng };
