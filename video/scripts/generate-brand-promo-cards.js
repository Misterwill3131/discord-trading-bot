#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// generate-brand-promo-cards.js — Regen les images statiques utilisées
// par ValueBeat (BrandPromo composition).
// ─────────────────────────────────────────────────────────────────────
// Lance via : cd video && node scripts/generate-brand-promo-cards.js
// (ou depuis la racine : node video/scripts/generate-brand-promo-cards.js)
//
// Modifie le tableau CARDS ci-dessous pour changer le contenu.
// Les images sont écrites dans video/public/brand-promo/card-N.png.
// Remotion staticFile() les charge directement, pas besoin de rebuild.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { generateImage } = require('../../canvas/proof');

const OUT_DIR = path.join(__dirname, '..', 'public', 'brand-promo');

const CARDS = [
  { author: 'Z',      content: '$TSLA 150 entry long', ts: '2026-04-25T09:32:00-04:00' },
  { author: 'Bora',   content: '$NVDA 870 scalp',      ts: '2026-04-25T10:15:00-04:00' },
  { author: 'Viking', content: '$AMD out +8%',         ts: '2026-04-25T11:02:00-04:00' },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (let i = 0; i < CARDS.length; i++) {
    const c = CARDS[i];
    const buf = await generateImage(c.author, c.content, c.ts, { scale: 2 });
    const filename = `card-${i}.png`;
    fs.writeFileSync(path.join(OUT_DIR, filename), buf);
    console.log(`✓ ${filename} (${buf.length} bytes) — ${c.author}: ${c.content}`);
  }
  console.log(`\nDone. ${CARDS.length} cards in ${OUT_DIR}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
