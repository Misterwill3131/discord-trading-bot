import { staticFile } from 'remotion';

// Pool de 30 images lifestyle pour le hook intro (3s rapid cuts).
// Le composant LifestyleHook pique 4 images au hasard (déterministe via seed),
// donc chaque vidéo rendue avec un seed différent voit une combinaison unique.
// L'utilisateur peut remplacer les fichiers PNG dans video/public/lifestyle/
// sans toucher à ce mapping (chemins relatifs = mêmes noms de fichier).
export const LIFESTYLE_IMAGES: string[] = [
  // Yachts
  staticFile('lifestyle/yacht-1.png'),
  staticFile('lifestyle/yacht-2.png'),
  staticFile('lifestyle/yacht-3.png'),
  staticFile('lifestyle/yacht-4.png'),
  // Supercars
  staticFile('lifestyle/supercar-red.png'),
  staticFile('lifestyle/supercar-yellow.png'),
  staticFile('lifestyle/supercar-blue.png'),
  staticFile('lifestyle/supercar-black.png'),
  staticFile('lifestyle/supercar-white.png'),
  // Penthouses / homes
  staticFile('lifestyle/penthouse-night.png'),
  staticFile('lifestyle/penthouse-view.png'),
  staticFile('lifestyle/penthouse-pool.png'),
  staticFile('lifestyle/penthouse-balcony.png'),
  staticFile('lifestyle/mansion-1.png'),
  staticFile('lifestyle/mansion-2.png'),
  // Aviation
  staticFile('lifestyle/private-jet.png'),
  staticFile('lifestyle/private-jet-interior.png'),
  staticFile('lifestyle/private-jet-runway.png'),
  staticFile('lifestyle/helicopter.png'),
  // Skylines
  staticFile('lifestyle/skyline-night.png'),
  staticFile('lifestyle/skyline-dubai.png'),
  staticFile('lifestyle/skyline-day.png'),
  // Watches
  staticFile('lifestyle/watch-luxury.png'),
  staticFile('lifestyle/watch-2.png'),
  staticFile('lifestyle/watch-3.png'),
  staticFile('lifestyle/watch-4.png'),
  // Money / wealth
  staticFile('lifestyle/money-stack.png'),
  staticFile('lifestyle/money-pile.png'),
  staticFile('lifestyle/gold-bars.png'),
  // Misc luxury
  staticFile('lifestyle/champagne.png'),
];

// Helper : pique N images uniques du pool, indexées de manière déterministe via seed.
// Utilisé par LifestyleHook pour produire 4 cuts variés selon le contexte du render
// (ex: ticker + timestamp). Implémentation : pas de Math.random() pour éviter le
// flicker entre frames — on utilise Remotion's `random()` qui est seedable.
export function pickImages(seed: string, count: number): string[] {
  // Implémentation Fisher-Yates partielle avec seed (déterministe).
  const total = LIFESTYLE_IMAGES.length;
  const indices = Array.from({ length: total }, (_, i) => i);
  const picked: string[] = [];
  let pool = indices;
  for (let i = 0; i < count && pool.length > 0; i++) {
    const r = pseudoRandom(`${seed}-${i}`);
    const idx = Math.floor(r * pool.length);
    picked.push(LIFESTYLE_IMAGES[pool[idx]]);
    pool = pool.filter((_, j) => j !== idx);
  }
  return picked;
}

// PRNG déterministe basé sur un hash simple de la string seed.
// Pas crypto-safe — juste pour répartir les indices uniformément.
function pseudoRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash = hash & hash; // Force 32-bit
  }
  // Map vers [0, 1) — utilise les bits bas de hash * grand premier.
  const x = Math.sin(hash) * 10000;
  return x - Math.floor(x);
}
