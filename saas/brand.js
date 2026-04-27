// ─────────────────────────────────────────────────────────────────────
// saas/brand.js — Constantes de marque pour les embeds Discord relayés
// ─────────────────────────────────────────────────────────────────────
// Tout ce qui est visible côté client (embed footer, titre par défaut,
// thumbnail) passe par ces constantes. Lecture lazy depuis env pour que
// les tests puissent surcharger via process.env avant l'import.
//
// Valeurs par défaut volontairement génériques — l'utilisateur DOIT
// définir BRAND_NAME et BRAND_COLOR dans .env pour la prod.
// ─────────────────────────────────────────────────────────────────────

// Nom court qui apparaît dans le footer "via X" et le titre de l'embed.
// Ex: "Boom Trading", "Mighty Forest Signals". Évite les caractères
// spéciaux (apostrophes, emojis) — ils peuvent casser le rendu Discord.
const BRAND_NAME = process.env.BRAND_NAME || 'Trading Signals';

// Couleur de la barre verticale de l'embed Discord. Format hex 0xRRGGBB
// (number, pas string). Discord accepte aussi un int décimal.
// Default cyan-500 Tailwind = 0x06b6d4 — neutre, lisible sur clair/sombre.
function parseColor(s) {
  if (!s) return 0x06b6d4;
  const trimmed = String(s).trim().replace(/^#/, '').replace(/^0x/i, '');
  const n = parseInt(trimmed, 16);
  return Number.isFinite(n) ? n : 0x06b6d4;
}
const BRAND_COLOR = parseColor(process.env.BRAND_COLOR);

// URL absolue d'une image PNG/WEBP (max 80×80 recommandé) affichée en haut
// à droite de l'embed. Optionnelle — si vide ou invalide, pas de
// thumbnail. Doit être hébergée publiquement (CDN, S3, Imgur, ou notre
// propre Express via /static/).
const BRAND_THUMBNAIL_URL = (() => {
  const u = process.env.BRAND_THUMBNAIL_URL || '';
  if (!u) return null;
  return /^https:\/\//.test(u) ? u : null;
})();

// URL d'une image bannière affichée en bas de l'embed (jusqu'à pleine
// largeur). Idéale pour un logo détaillé qui ne lirait pas bien en
// thumbnail miniature. Optionnelle. Animated WEBP supporté.
const BRAND_IMAGE_URL = (() => {
  const u = process.env.BRAND_IMAGE_URL || '';
  if (!u) return null;
  return /^https:\/\//.test(u) ? u : null;
})();

module.exports = {
  BRAND_NAME,
  BRAND_COLOR,
  BRAND_THUMBNAIL_URL,
  BRAND_IMAGE_URL,
};
