import { staticFile } from 'remotion';

// Liste ordonnée d'images lifestyle pour le hook intro (3s rapid cuts).
// Le composant LifestyleHook utilise les 4 premières par défaut.
// L'utilisateur peut remplacer les fichiers PNG dans video/public/lifestyle/
// sans toucher à ce mapping (chemins relatifs = mêmes noms de fichier).
export const LIFESTYLE_IMAGES: string[] = [
  staticFile('lifestyle/yacht-1.png'),
  staticFile('lifestyle/supercar-red.png'),
  staticFile('lifestyle/penthouse-view.png'),
  staticFile('lifestyle/watch-luxury.png'),
  staticFile('lifestyle/yacht-2.png'),
  staticFile('lifestyle/supercar-yellow.png'),
  staticFile('lifestyle/penthouse-night.png'),
  staticFile('lifestyle/money-stack.png'),
  staticFile('lifestyle/private-jet.png'),
  staticFile('lifestyle/skyline-night.png'),
];
