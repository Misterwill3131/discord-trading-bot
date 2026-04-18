// ─────────────────────────────────────────────────────────────────────
// utils/persistence.js — DATA_DIR + helpers date/time
// ─────────────────────────────────────────────────────────────────────
// Depuis la migration SQLite (db/sqlite.js), ce module ne gère plus
// la persistence des messages — il reste utilisé pour :
//
//   DATA_DIR   — chemin racine des fichiers de données (Railway `/data`
//                en prod, racine projet en local). Utilisé par sqlite,
//                config-overrides, profit/counter, jobs.
//   MAX_LOG    — cap du cache messageLog en mémoire.
//   todayKey() — clé date "YYYY-MM-DD" fuseau America/New_York, utilisée
//                comme index de regroupement dans plusieurs modules.
//
// Les anciennes fonctions loadDailyFile / saveDailyFile / loadInitial-
// Messages / saveTodayMessages ont été supprimées — remplacées par les
// queries DB (voir db/sqlite.js).
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Sur Railway `/data` est un volume persistant ; en local on écrit à
// côté de index.js. `path.resolve(__dirname, '..')` remonte de utils/
// vers la racine du projet.
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.resolve(__dirname, '..');

// Limite de messages conservés en RAM (cache de state/messages.js). Le
// dashboard /api/messages et les commandes !top/!stats lisent ce cache
// pour ne pas taper la DB à chaque requête chaude.
const MAX_LOG = 200;

// La journée "trading" commence à 23h55 ET : on décale +5min pour que
// les messages entre 23:55 et 00:00 soient classés dans le jour suivant.
function todayKey() {
  return new Date(Date.now() + 5 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

module.exports = {
  DATA_DIR,
  MAX_LOG,
  todayKey,
};
