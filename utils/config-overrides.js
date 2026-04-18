// ─────────────────────────────────────────────────────────────────────
// utils/config-overrides.js — Config additionnelle côté DATA_DIR
// ─────────────────────────────────────────────────────────────────────
// Permet à l'opérateur de surcharger AUTHOR_ALIASES + allowedChannels
// SANS toucher au code source, en déposant un fichier JSON dans DATA_DIR
// (persisté sur le volume Railway → survit aux redeploys).
//
// Forme attendue du fichier :
//   {
//     "authorAliases": { "newuser": "DisplayName", ... },
//     "allowedChannels": ["extra-channel-1", "extra-channel-2"]
//   }
//
// Si le fichier n'existe pas ou contient du JSON invalide, on renvoie
// un objet vide — jamais d'exception remontée au caller.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./persistence');

const CONFIG_OVERRIDES_PATH = path.join(DATA_DIR, 'config-overrides.json');

function loadConfigOverrides() {
  try {
    if (fs.existsSync(CONFIG_OVERRIDES_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_OVERRIDES_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[config] Failed to load config-overrides.json:', e.message);
  }
  return {};
}

module.exports = { loadConfigOverrides, CONFIG_OVERRIDES_PATH };
