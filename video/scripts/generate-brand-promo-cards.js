#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// generate-brand-promo-cards.js — Regen les images statiques canvas
// utilisées par ValueBeat (BrandPromo) ET DataAct (SignalAlert).
// ─────────────────────────────────────────────────────────────────────
// Lance via : cd video && node scripts/generate-brand-promo-cards.js
// (ou : npm run regen:brand-promo-cards)
//
// Modifie les tableaux ci-dessous pour changer le contenu. Les images
// sont écrites dans video/public/brand-promo/ et signal-alert/.
// Remotion staticFile() les charge directement, pas besoin de rebuild.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { generateImage } = require('../../canvas/proof');

// === BrandPromo / ValueBeat (3 cards rotation) ========================
const BRAND_PROMO_DIR = path.join(__dirname, '..', 'public', 'brand-promo');
const BRAND_PROMO_CARDS = [
  { author: 'Z',      content: '$TSLA 150 entry long', ts: '2026-04-25T09:32:00-04:00' },
  { author: 'Bora',   content: '$NVDA 870 scalp',      ts: '2026-04-25T10:15:00-04:00' },
  { author: 'Viking', content: '$AMD out +8%',         ts: '2026-04-25T11:02:00-04:00' },
];

// === SignalAlert / DataAct (default card pour Studio + CLI render) ====
const SIGNAL_ALERT_DIR = path.join(__dirname, '..', 'public', 'signal-alert');
const SIGNAL_ALERT_DEFAULT = {
  author:  'Z',
  content: '$TSLA 150-155 entry long',
  ts:      '2026-04-25T13:32:00-04:00',
};

async function generateAndSave(dir, filename, author, content, ts) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = await generateImage(author, content, ts, { scale: 2 });
  fs.writeFileSync(path.join(dir, filename), buf);
  console.log(`✓ ${path.relative(path.join(__dirname, '..'), path.join(dir, filename))} (${buf.length} bytes) — ${author}: ${content}`);
}

(async () => {
  console.log('=== BrandPromo / ValueBeat ===');
  for (let i = 0; i < BRAND_PROMO_CARDS.length; i++) {
    const c = BRAND_PROMO_CARDS[i];
    await generateAndSave(BRAND_PROMO_DIR, `card-${i}.png`, c.author, c.content, c.ts);
  }

  console.log('\n=== SignalAlert / DataAct ===');
  await generateAndSave(
    SIGNAL_ALERT_DIR, 'card-default.png',
    SIGNAL_ALERT_DEFAULT.author,
    SIGNAL_ALERT_DEFAULT.content,
    SIGNAL_ALERT_DEFAULT.ts
  );

  console.log('\nDone.');
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
