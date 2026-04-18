// ─────────────────────────────────────────────────────────────────────
// canvas/config.js — Constantes visuelles pour la génération d'images
// ─────────────────────────────────────────────────────────────────────
// Regroupe toute la customisation graphique : dimensions, couleurs,
// polices, avatars personnalisés par analyste.
//
// Modifier ces valeurs impacte UNIQUEMENT les images générées (pas le
// dashboard web, qui a son propre CSS dans pages/common.js).
//
// Exporte :
//   CONFIG          — dimensions, couleurs, tailles de police
//   FONT            — alias de CONFIG.FONT pour backward compat
//   CUSTOM_AVATARS  — username Discord → chemin image avatar local
//   CUSTOM_EMOJIS   — nom emoji → chemin image locale
// ─────────────────────────────────────────────────────────────────────

const path = require('path');

// Helper : construit un chemin absolu vers /avatar/<fichier> (racine projet).
// `__dirname` ici = <projet>/canvas, donc on remonte d'un niveau.
const AV = (f) => path.join(__dirname, '..', 'avatar', f);

// Avatars personnalisés par nom canonique affiché (après AUTHOR_ALIASES).
// Ajouter ici : nom exact tel qu'affiché → fichier dans /avatar/.
// Sans match : les initiales de l'auteur sont rendues sur fond BG_COLOR.
const CUSTOM_AVATARS = {
  'Z':              AV('z-avatar.jpg'),
  'AR':             AV('AR_AVATAR.png'),
  'beppels':        AV('beppels_avatar.png'),
  'L':              AV('L_avatar.png'),
  'RF':             AV('RF_AVATAR.png'),
  'Viking':         AV('Viking_avatar.png'),
  'ProTrader':      AV('ProTrader_avatar.png'),
  'Gaz':            AV('Gaz_avatar.png'),
  'CapitalGains':   AV('CapitalGains_avatar.png'),
  'THE REVERSAL':   AV('THE REVERSAL_avatar.png'),
  'kestrel':        AV('kestrel_avatar.png'),
  'the1albatross':  AV('the1albatross_avatar.png'),
  'Bora':           AV('Bora_avatar.png'),
  'Michael':        AV('Michael_avatar.png'),
  'thedutchess1':   AV('thedutchess1_avatar.png'),
  'Legacy Trading': AV('Legacy Trading_avatar.png'),
};

// Emojis personnalisés utilisés par le bot Discord (ex. greatcall).
const CUSTOM_EMOJIS = {
  'greatcall': AV('great_call.png'),
};

// ═══════════════════════════════════════════════════════════════════════════
//  🎨 CUSTOMISATION — Modifier ici l'apparence des images générées
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // ── Dimensions ──────────────────────────────────────────────────────────
  IMAGE_W:              740,           // Largeur image (px)
  IMAGE_H:              80,            // Hauteur image (px)

  // ── Couleurs fond ────────────────────────────────────────────────────────
  BG_COLOR:             '#1e1f22',     // Fond principal de la carte

  // ── Avatar ───────────────────────────────────────────────────────────────
  AVATAR_SIZE:          44,            // Diamètre du cercle avatar (px)
  AVATAR_COLOR:         '#5865f2',     // Couleur cercle sans photo (blurple)
  AVATAR_TEXT_COLOR:    '#ffffff',     // Couleur initiales

  // ── Badge BOOM ───────────────────────────────────────────────────────────
  BADGE_BG:             '#36393f',     // Fond du badge
  BADGE_BORDER:         '#4f5660',     // Bordure du badge
  BADGE_TEXT:           'BOOM',        // Texte affiché dans le badge
  BADGE_TEXT_COLOR:     '#ffffff',     // Couleur texte badge
  BADGE_FONT_SIZE:      10,            // Taille police badge (px)
  BADGE_HEIGHT:         16,            // Hauteur du badge (px)
  BADGE_RADIUS:         3,             // Arrondi coins badge (px)

  // ── Flamme (badge) ───────────────────────────────────────────────────────
  FLAME_BOTTOM:         '#e65c00',     // Couleur bas flamme (orange foncé)
  FLAME_MID:            '#ff8c00',     // Couleur milieu flamme (orange)
  FLAME_TOP:            '#ffd000',     // Couleur sommet flamme (jaune-or)

  // ── Nom utilisateur ──────────────────────────────────────────────────────
  USERNAME_COLOR:       '#D649CC',     // Couleur du nom (violet/rose)
  USERNAME_FONT_SIZE:   16,            // Taille police nom (px)

  // ── Horodatage ───────────────────────────────────────────────────────────
  TIME_COLOR:           '#80848e',     // Couleur de l'heure
  TIME_FONT_SIZE:       12,            // Taille police heure (px)

  // ── Texte du message ─────────────────────────────────────────────────────
  MESSAGE_COLOR:        '#dcddde',     // Couleur du message
  MESSAGE_FONT_SIZE:    14,            // Taille police message (px)

  // ── Police globale ───────────────────────────────────────────────────────
  FONT:                 'Noto Sans, sans-serif',
};
// ═══════════════════════════════════════════════════════════════════════════

// Alias de compatibilité — utilisé par les appels directs `FONT` dans le code.
const FONT = CONFIG.FONT;

module.exports = { CONFIG, FONT, CUSTOM_AVATARS, CUSTOM_EMOJIS };
