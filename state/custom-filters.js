// ─────────────────────────────────────────────────────────────────────
// state/custom-filters.js — Filtres custom persistés (learned rules)
// ─────────────────────────────────────────────────────────────────────
// Charge les filtres depuis la table `settings` (clé 'custom_filters')
// au démarrage et expose l'objet en lecture/écriture. Les consommateurs
// mutent directement les champs (push/filter/assign) puis appellent
// `saveCustomFilters()` pour persister.
//
// IMPORTANT : ne PAS faire `const { blocked } = customFilters` côté
// consommateur — c'est un snapshot, tu manqueras les updates. Utilise
// toujours `customFilters.blocked` pour avoir la valeur courante.
//
// Schéma :
//   blocked              — phrases à rejeter (false-positives corrigés)
//   allowed              — phrases à accepter (false-negatives corrigés)
//   blockedAuthors       — usernames Discord à rejeter
//   allowedAuthors       — usernames à forcer OK même si contenu filtré
//   allowedChannels      — canaux additionnels (hors TRADING_CHANNEL)
//   falsePositiveCounts  — {word: n} pour auto-blocker après 3 FP
// ─────────────────────────────────────────────────────────────────────

const { getSetting, setSetting } = require('../db/sqlite');

const SETTINGS_KEY = 'custom_filters';

const EMPTY_FILTERS = {
  blocked: [],
  allowed: [],
  blockedAuthors: [],
  allowedAuthors: [],
  falsePositiveCounts: {},
};

// Objet singleton — référence stable sur toute la durée de vie du process.
// Les consommateurs doivent muter ce même objet, pas créer une nouvelle instance.
const customFilters = Object.assign(
  {},
  EMPTY_FILTERS,
  getSetting(SETTINGS_KEY, {}) || {},
);

function saveCustomFilters() {
  try {
    setSetting(SETTINGS_KEY, customFilters);
  } catch (e) {
    console.error('[custom-filters] Failed to save:', e.message);
  }
}

module.exports = {
  customFilters,
  saveCustomFilters,
};
