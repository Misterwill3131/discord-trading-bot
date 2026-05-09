// ─────────────────────────────────────────────────────────────────────
// canvas/gap-chart.js — Rendu PNG du chart annoté pour les alertes gap
// ─────────────────────────────────────────────────────────────────────
// Visualise le mouvement overnight : ligne de prix + 2 lignes horizontales
// (prevSessionClose, todayOpen) + bande verticale sur la fenêtre overnight
// + label du gap %. Focus visuel : ~12h avant la fin d'hier + ~12h après
// l'open d'aujourd'hui (les bougies overnight 20h-4h n'existent pas dans
// les données Yahoo, donc le "trou" se voit naturellement).
//
// API : renderGapChartPng({ bars, prevSessionClose, todayOpen, gapPct, ticker })
//   - bars : array of { t, o, h, l, c, v } triées chronologiquement (5D 15min)
//   - prevSessionClose : close after-hours d'hier (~20h ET)
//   - todayOpen : open premarket d'aujourd'hui (~4h ET)
//   - gapPct : valeur signée du gap en %
//   - ticker : symbol (string)
// Returns : Buffer PNG, ou null si pas assez de données pour rendre.
// ─────────────────────────────────────────────────────────────────────

const { createCanvas } = require('@napi-rs/canvas');

const W = 800;
const H = 400;
const PAD = { top: 60, right: 90, bottom: 40, left: 70 };

// Convertit un timestamp ms en YYYY-MM-DD ET (pour grouper par jour).
function dateET(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

// Filtre les bars à la fenêtre focus : tous les bars d'aujourd'hui ET
// + tous les bars d'hier ET. Si pas d'hier, fallback sur today seulement.
function filterToFocusWindow(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const todayET = dateET(Date.now());
  const yest = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayET = dateET(yest.getTime());
  return bars.filter(b => {
    if (!Number.isFinite(b.t)) return false;
    const d = dateET(b.t);
    return d === todayET || d === yesterdayET;
  });
}

// Trouve l'index où la date ET change entre 2 bars consécutifs (= la
// fenêtre overnight). Retourne l'index du PREMIER bar du nouveau jour,
// ou -1 si aucune transition (pas d'hier dans les bars).
function findOvernightBoundary(bars) {
  for (let i = 1; i < bars.length; i++) {
    if (dateET(bars[i - 1].t) !== dateET(bars[i].t)) return i;
  }
  return -1;
}

function renderGapChartPng({ bars, prevSessionClose, todayOpen, gapPct, ticker }) {
  const focused = filterToFocusWindow(bars);
  if (focused.length < 2) return null;
  if (!Number.isFinite(prevSessionClose) || !Number.isFinite(todayOpen)) return null;
  if (!Number.isFinite(gapPct)) return null;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // Title
  const direction = gapPct >= 0 ? 'up' : 'down';
  const sign = gapPct >= 0 ? '+' : '';
  const accent = gapPct >= 0 ? '#4ade80' : '#f87171';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(`$${ticker}`, PAD.left, 32);
  ctx.fillStyle = accent;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(`overnight gap ${direction} ${sign}${gapPct.toFixed(2)}%`, PAD.left + 14 + ctx.measureText(`$${ticker}`).width, 32);

  // Price range (include the two key prices so they're always in frame)
  const prices = [];
  for (const b of focused) {
    if (Number.isFinite(b.h)) prices.push(b.h);
    if (Number.isFinite(b.l)) prices.push(b.l);
  }
  prices.push(prevSessionClose, todayOpen);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  const range = maxP - minP || 1;
  const padP = range * 0.08;
  minP -= padP;
  maxP += padP;

  // Coordinate helpers
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xFor = (i) => PAD.left + (i / (focused.length - 1)) * innerW;
  const yFor = (price) => PAD.top + (1 - (price - minP) / (maxP - minP)) * innerH;

  // Y-axis price labels (5 ticks)
  ctx.fillStyle = '#6b7280';
  ctx.strokeStyle = '#2a2c30';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const price = minP + ((maxP - minP) * (4 - i)) / 4;
    const y = yFor(price);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    ctx.fillText('$' + price.toFixed(2), 8, y + 4);
  }

  // Overnight band — shade the column between the last yesterday bar and
  // the first today bar (the "gap window"). If no boundary found, skip.
  const boundary = findOvernightBoundary(focused);
  if (boundary > 0) {
    const x1 = xFor(boundary - 1);
    const x2 = xFor(boundary);
    ctx.fillStyle = gapPct >= 0 ? 'rgba(74, 222, 128, 0.12)' : 'rgba(248, 113, 113, 0.12)';
    ctx.fillRect(x1, PAD.top, x2 - x1, innerH);
    // Vertical dashed line at midpoint to anchor the gap visually.
    ctx.strokeStyle = accent;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const xMid = (x1 + x2) / 2;
    ctx.moveTo(xMid, PAD.top);
    ctx.lineTo(xMid, H - PAD.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    // Gap % label near the band
    ctx.fillStyle = accent;
    ctx.font = 'bold 12px sans-serif';
    const labelText = `gap ${sign}${gapPct.toFixed(2)}%`;
    const labelW = ctx.measureText(labelText).width;
    ctx.fillText(labelText, Math.max(8, xMid - labelW / 2), PAD.top - 8);
  }

  // Horizontal dashed lines : prevSessionClose + todayOpen
  function drawHLine(price, color, label, alignRight) {
    const y = yFor(price);
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '11px sans-serif';
    const txt = `${label} $${price.toFixed(2)}`;
    if (alignRight) {
      const w = ctx.measureText(txt).width;
      ctx.fillText(txt, W - PAD.right - w - 4, y - 5);
    } else {
      ctx.fillText(txt, PAD.left + 6, y - 5);
    }
  }
  drawHLine(prevSessionClose, '#fbbf24', 'Prev close', false);
  drawHLine(todayOpen, '#60a5fa', 'Open', true);

  // Price line (close to close)
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < focused.length; i++) {
    const c = focused[i].c;
    if (!Number.isFinite(c)) continue;
    const x = xFor(i);
    const y = yFor(c);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else          { ctx.lineTo(x, y); }
  }
  ctx.stroke();

  // X-axis labels — show ET date for first bar of yesterday + first bar of today
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px sans-serif';
  const firstDate = dateET(focused[0].t);
  ctx.fillText(firstDate, PAD.left, H - 12);
  if (boundary > 0) {
    const todayDateLabel = dateET(focused[boundary].t);
    const w = ctx.measureText(todayDateLabel).width;
    ctx.fillText(todayDateLabel, Math.min(W - PAD.right - w, xFor(boundary) - w / 2), H - 12);
  }
  // Last date on the right for context
  const lastDate = dateET(focused[focused.length - 1].t);
  const lastW = ctx.measureText(lastDate).width;
  ctx.fillText(lastDate, W - PAD.right - lastW, H - 12);

  return canvas.toBuffer('image/png');
}

module.exports = { renderGapChartPng };
