// ─────────────────────────────────────────────────────────────────────
// video/src/outro-pool.ts — Pool d'images d'outro Temple of Boom
// ─────────────────────────────────────────────────────────────────────
// 8 images PNG carrées (1024×1024) brandées TOB — affichées en fin de
// toutes les compositions vidéo (ChartTemplate, BoomEntry, BoomRecap, etc.)
// pour cohérence visuelle.
//
// Picker SEEDÉ (déterministe) : un même seed produit toujours la même
// image. Avantages :
//   - Re-render du même item → même outro (pas de surprise)
//   - Tests reproductibles
//
// Pour ajouter / retirer des variations, drop des PNG dans
// video/public/outro/ et update OUTRO_IMAGES ci-dessous. Toutes les
// images doivent être square (1024×1024 ou similaire) pour que
// objectFit: 'cover' produise un crop propre vers 9:16 vertical.
// ─────────────────────────────────────────────────────────────────────

import { staticFile } from 'remotion';

export const OUTRO_IMAGES: string[] = [
  staticFile('outro/TOB_Momentum.png'),
  staticFile('outro/TOB_Momentum (1).png'),
  staticFile('outro/TOB_MOMENTUM_Momentum.png'),
  staticFile('outro/TOB_Challenge_Small_Account.png'),
  staticFile('outro/TOB_Elite_Structure.png'),
  staticFile('outro/TOB_General_Banner_1.png'),
  staticFile('outro/TOB_Swing_Banner.png'),
  staticFile('outro/TOB_VIRAL_General.png'),
];

// PRNG déterministe simple (DJB2-like) pour distribuer les indices
// uniformément. Pas crypto-safe — juste pour stabilité.
function pseudoRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  // Map vers [0, 1) — utilise sin pour répartition uniforme.
  const x = Math.sin(hash) * 10000;
  return x - Math.floor(x);
}

// Pique une image du pool depuis un seed (string). Si le seed est vide
// ou null, retourne la première image (default predictable).
export function pickOutroImage(seed: string | null | undefined): string {
  if (!seed) return OUTRO_IMAGES[0];
  const r = pseudoRandom(String(seed));
  const idx = Math.floor(r * OUTRO_IMAGES.length);
  return OUTRO_IMAGES[idx];
}
