// ─────────────────────────────────────────────────────────────────────
// utils/authors.js — Gestion des auteurs Discord
// ─────────────────────────────────────────────────────────────────────
// Centralise les alias (username Discord → nom affiché stable) et la
// liste des auteurs bloqués dont les messages ne doivent jamais appa-
// raître dans le bot (ni dashboard, ni image proof, ni stats).
//
// Exporte :
//   BLOCKED_AUTHORS (Set<string>)     — usernames en minuscules
//   AUTHOR_ALIASES  (Record<string>)  — "traderzz1m" → "Z" etc.
//   getDisplayName(username)          — canonicalise via AUTHOR_ALIASES
// ─────────────────────────────────────────────────────────────────────

// Comparaison case-insensitive : toujours stocker les entrées en
// minuscules. Le code appelant doit `.toLowerCase()` l'username avant
// de tester `.has()`.
const BLOCKED_AUTHORS = new Set([
  'trendvision',
  'frogoracle',
]);

// Certains analystes publient sous plusieurs usernames (rename, compte
// secondaire). On regroupe tout sous un nom canonique pour que les
// stats ne double-comptent pas.
const AUTHOR_ALIASES = {
  'sanibel2026':       'AR',
  'therealbora':       'Bora',
  'traderzz1m':        'Z',
  'ZZ':                'Z',
  'viking9496':        'Viking',
  'legacytrading506':  'Legacy Trading',
  'rf0496_76497':      'RF',
  'wulftrader':        'L',
  'beppels':           'beppels',
  'gnew123_83101':     'Gaz',
  'capital__gains':    'CapitalGains',
  'gblivin141414':     'Michael',
  'protraderjs':       'ProTrader',
  'disciplined04':     'THE REVERSAL',
  'k.str.l':           'kestrel',
  'the1albatross':     'the1albatross',
  'thedutchess1':      'thedutchess1',
};

function getDisplayName(username) {
  return AUTHOR_ALIASES[username] || username;
}

module.exports = {
  BLOCKED_AUTHORS,
  AUTHOR_ALIASES,
  getDisplayName,
};
