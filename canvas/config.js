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
  'ZZ':             AV('z-avatar.jpg'),
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
  'Protrader Alerts': AV('Protrader Alerts_avatar.png'),
  'MsKim' : AV('MsKim.png'),
};

// Rôles personnalisés (id Discord → nom affiché + couleur + optionnel
// bgOpacity). Si présent dans cette table, une mention <@&id> est rendue
// comme un pill avec fond color×bgOpacity. Default bgOpacity = 0.18.
// bgOpacity override utile quand la couleur native est très saturée
// (ex: vert pur) et que le pill paraît trop vibrant à 18%.
const CUSTOM_ROLES = {
  '1497256488274624565': { name: 'Swing',    color: '#3498db' },
  '1330929339134640179': { name: 'Momentum', color: '#2ecc71', bgOpacity: 0.144 },
};

// Mentions spéciales Discord (@everyone, @here). Rendues comme pill avec
// la couleur blurple Discord pour matcher l'apparence du client.
const SPECIAL_MENTIONS = {
  everyone: { label: '@everyone', color: '#5865f2' },
  here:     { label: '@here',     color: '#5865f2' },
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
  // Blanc par défaut pour matcher l'apparence Discord (le client utilise
  // la couleur du rôle le plus haut, sinon blanc). Override par auteur
  // possible dans generateImage (ex: Legacy Trading reste rouge).
  USERNAME_COLOR:       '#ffffff',     // Couleur du nom (blanc par défaut)
  USERNAME_FONT_SIZE:   16,            // Taille police nom (px)

  // ── Horodatage ───────────────────────────────────────────────────────────
  TIME_COLOR:           '#80848e',     // Couleur de l'heure
  TIME_FONT_SIZE:       12,            // Taille police heure (px)

  // ── Texte du message ─────────────────────────────────────────────────────
  MESSAGE_COLOR:        '#dcddde',     // Couleur du message
  MESSAGE_FONT_SIZE:    14,            // Taille police message (px)

  // ── Liens markdown [label](url) ──────────────────────────────────────────
  LINK_COLOR:           '#00aff4',     // Couleur du label de lien (Discord)

  // ── Police globale ───────────────────────────────────────────────────────
  // Stack consistent cross-platform via fonts BUNDLÉES (assets/fonts/) :
  //   1. "Noto Sans"       — texte principal (lettres, chiffres, ponctuation)
  //   2. NotoSansSymbols2  — fallback Unicode Symbols (✦, ⭐, ⚡, etc.)
  //   3. sans-serif        — ultime fallback OS si bundles introuvables
  // Registrées par canvas/proof.js au boot via GlobalFonts.registerFromPath().
  // L'ordre EST CRITIQUE : NotoSansSymbols2 a des chiffres tabulaires à
  // espacement très large, mettre cette font avant Noto Sans donnerait
  // des heures style "0 9 : 5 8" au lieu de "09:58".
  FONT:                 '"Noto Sans", NotoSansSymbols2, sans-serif',
};
// ═══════════════════════════════════════════════════════════════════════════

// Alias de compatibilité — utilisé par les appels directs `FONT` dans le code.
const FONT = CONFIG.FONT;

module.exports = { CONFIG, FONT, CUSTOM_AVATARS, CUSTOM_ROLES, SPECIAL_MENTIONS, CUSTOM_EMOJIS };
