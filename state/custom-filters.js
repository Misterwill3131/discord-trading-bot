// ─────────────────────────────────────────────────────────────────────
// state/custom-filters.js — Filtres custom persistés (learned rules)
// ─────────────────────────────────────────────────────────────────────
// Charge `custom-filters.json` (racine du projet) au démarrage et
// expose l'objet en lecture/écriture. Les consommateurs mutent
// directement les champs (push/filter/assign) puis appellent `save()`.
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

const fs = require('fs');
const path = require('path');

const FILTERS_PATH = path.join(__dirname, '..', 'custom-filters.json');

const EMPTY_FILTERS = {
  blocked: [],
  allowed: [],
  blockedAuthors: [],
  allowedAuthors: [],
  falsePositiveCounts: {},
};

function loadCustomFilters() {
  try {
    if (fs.existsSync(FILTERS_PATH)) {
      return JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[filters] Failed to load custom-filters.json:', e.message);
  }
  return Object.assign({}, EMPTY_FILTERS);
}

function saveCustomFilters() {
  try {
    fs.writeFileSync(FILTERS_PATH, JSON.stringify(customFilters, null, 2), 'utf8');
  } catch (e) {
    console.error('[filters] Failed to save custom-filters.json:', e.message);
  }
}

// Objet singleton — référence stable sur toute la durée de vie du process.
// Les consommateurs doivent muter ce même objet, pas créer une nouvelle instance.
const customFilters = loadCustomFilters();

module.exports = {
  customFilters,
  saveCustomFilters,
  FILTERS_PATH,
};
