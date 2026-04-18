// ─────────────────────────────────────────────────────────────────────
// canvas/promo.js — Image promo carrée 1080×1080 pour X / Instagram
// ─────────────────────────────────────────────────────────────────────
// Générée après un recap de trade gagnant (entry + target détectés).
// Format carré adapté aux réseaux sociaux : ticker au centre, gain %
// en gros, prix d'entrée/cible en dessous, branding BOOM en haut-gauche.
//
// Exporte :
//   generatePromoImage(ticker, gainPct, entryPrice, targetPrice)
//     → Buffer PNG
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { FONT } = require('./config');

const LOGO_PATH = path.join(__dirname, '..', 'logo_boom.png');

async function generatePromoImage(ticker, gainPct, entryPrice, targetPrice) {
  const W = 1080, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Fond sombre uni.
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // Bande dégradée subtile en haut (violet → bleu → vert).
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,   '#2a1e3a');
  grad.addColorStop(0.5, '#1a2a3a');
  grad.addColorStop(1,   '#1a3a2a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 180);

  // ── Branding BOOM en haut-gauche ──
  ctx.fillStyle = '#D649CC';
  ctx.font = 'bold 28px ' + FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('🔥 BOOM', 60, 50);

  // Logo circulaire sous le texte (best-effort, silencieux si absent).
  try {
    const logoImg = await loadImage(LOGO_PATH);
    ctx.save();
    ctx.beginPath();
    ctx.arc(60 + 20, 50 + 20 + 40, 22, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logoImg, 60, 110, 44, 44);
    ctx.restore();
  } catch (e) {}

  // ── Ticker centré avec dégradé rose→bleu ──
  const tickerDisplay = ticker ? '$' + ticker.toUpperCase() : '$???';
  const tickerGrad = ctx.createLinearGradient(W / 2 - 200, 0, W / 2 + 200, 0);
  tickerGrad.addColorStop(0, '#D649CC');
  tickerGrad.addColorStop(1, '#5865f2');
  ctx.font = 'bold 160px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = tickerGrad;
  ctx.fillText(tickerDisplay, W / 2, 350);

  // ── Gain % (vert si positif, rouge sinon) ──
  const gainStr = gainPct != null
    ? (gainPct >= 0 ? '+' : '') + gainPct.toFixed(0) + '%'
    : '';
  if (gainStr) {
    ctx.font = 'bold 200px ' + FONT;
    ctx.fillStyle = gainPct >= 0 ? '#3ba55d' : '#ed4245';
    ctx.textAlign = 'center';
    ctx.fillText(gainStr, W / 2, 580);
  }

  // ── Entry → Target (si les deux sont connus) ──
  if (entryPrice != null && targetPrice != null) {
    ctx.font = '48px ' + FONT;
    ctx.fillStyle = '#b5bac1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$' + entryPrice + '  →  $' + targetPrice, W / 2, 760);
  }

  // Trait séparateur.
  ctx.strokeStyle = '#3f4147';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 860);
  ctx.lineTo(W - 80, 860);
  ctx.stroke();

  // Lien Discord en bas.
  ctx.font = '32px ' + FONT;
  ctx.fillStyle = '#80848e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('discord.gg/templeofboom', W / 2, 960);

  // Date du jour (coin bas-droit, discret).
  ctx.font = '22px ' + FONT;
  ctx.fillStyle = '#3f4147';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(new Date().toISOString().slice(0, 10), W - 60, H - 40);

  return canvas.toBuffer('image/png');
}

module.exports = { generatePromoImage };
