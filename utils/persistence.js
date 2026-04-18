// ─────────────────────────────────────────────────────────────────────
// utils/persistence.js — I/O disque pour les messages journaliers
// ─────────────────────────────────────────────────────────────────────
// Centralise la lecture/écriture des fichiers `messages-YYYY-MM-DD.json`
// et expose DATA_DIR (utilisé par d'autres modules pour des fichiers
// profit, filtres, backups, etc.).
//
// Exporte :
//   DATA_DIR              — /data sur Railway, racine du projet en local
//   MAX_LOG               — nombre max de messages gardés en mémoire
//   todayKey()            — clé date "YYYY-MM-DD" fuseau America/New_York
//   loadDailyFile(key)    — lit messages-{key}.json (retourne [] si absent)
//   saveDailyFile(k, arr) — écrit messages-{key}.json
//   loadInitialMessages() — messages du jour, tronqués à MAX_LOG
//   saveTodayMessages(a)  — raccourci saveDailyFile(todayKey(), a)
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Sur Railway `/data` est un volume persistant ; en local on écrit à
// côté de index.js. `path.resolve(__dirname, '..')` remonte de utils/
// vers la racine du projet.
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.resolve(__dirname, '..');

// Limite de messages conservés en RAM. Le dashboard charge MAX_LOG au
// démarrage, les plus anciens sont tombés lors d'un nouveau logEvent.
const MAX_LOG = 200;

// La journée "trading" commence à 23h55 ET : on décale +5min pour que
// les messages entre 23:55 et 00:00 soient classés dans le jour suivant.
function todayKey() {
  return new Date(Date.now() + 5 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function loadDailyFile(dateKey) {
  try {
    const filePath = path.join(DATA_DIR, 'messages-' + dateKey + '.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('[daily] Failed to load messages-' + dateKey + '.json:', e.message);
  }
  return [];
}

function saveDailyFile(dateKey, messages) {
  try {
    const filePath = path.join(DATA_DIR, 'messages-' + dateKey + '.json');
    fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  } catch (e) {
    console.error('[daily] Failed to save messages-' + dateKey + '.json:', e.message);
  }
}

// Appelée une seule fois au démarrage pour peupler messageLog.
function loadInitialMessages() {
  try {
    const today = loadDailyFile(todayKey());
    return today.slice(0, MAX_LOG);
  } catch (e) {
    // En cas d'erreur inattendue on démarre sur un log vide — le bot
    // continue à logger les nouveaux messages normalement.
  }
  return [];
}

function saveTodayMessages(msgs) {
  saveDailyFile(todayKey(), msgs);
}

module.exports = {
  DATA_DIR,
  MAX_LOG,
  todayKey,
  loadDailyFile,
  saveDailyFile,
  loadInitialMessages,
  saveTodayMessages,
};
