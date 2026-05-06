// Génère 10 PNGs placeholder dans video/public/lifestyle/.
// Chaque PNG est 1920×1080, gradient bleu nuit + label texte.
// L'utilisateur peut remplacer par de vraies photos luxe plus tard.

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const IMAGES = [
  { filename: 'yacht-1.png',          label: 'YACHT 1',          hue: 200 },
  { filename: 'yacht-2.png',          label: 'YACHT 2',          hue: 210 },
  { filename: 'supercar-red.png',     label: 'SUPERCAR RED',     hue: 0 },
  { filename: 'supercar-yellow.png',  label: 'SUPERCAR YELLOW',  hue: 50 },
  { filename: 'penthouse-view.png',   label: 'PENTHOUSE VIEW',   hue: 280 },
  { filename: 'penthouse-night.png',  label: 'PENTHOUSE NIGHT',  hue: 260 },
  { filename: 'watch-luxury.png',     label: 'WATCH',            hue: 30 },
  { filename: 'money-stack.png',      label: 'MONEY',            hue: 120 },
  { filename: 'private-jet.png',      label: 'PRIVATE JET',      hue: 220 },
  { filename: 'skyline-night.png',    label: 'SKYLINE',          hue: 240 },
];

const OUT_DIR = path.join(__dirname, '..', 'video', 'public', 'lifestyle');
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const img of IMAGES) {
  const W = 1920, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Gradient bg
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, `hsl(${img.hue}, 50%, 15%)`);
  grad.addColorStop(1, `hsl(${img.hue + 20}, 60%, 8%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 120px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(img.label, W / 2, H / 2);

  ctx.font = '32px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('Placeholder — remplacer par une vraie photo', W / 2, H / 2 + 100);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(OUT_DIR, img.filename), buf);
  console.log(`  ✓ ${img.filename}`);
}

console.log(`Done. ${IMAGES.length} placeholders dans ${OUT_DIR}`);
