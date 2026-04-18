// ─────────────────────────────────────────────────────────────────────
// utils/config-overrides.js — Surcharges de config runtime
// ─────────────────────────────────────────────────────────────────────
// Permet à l'opérateur de surcharger AUTHOR_ALIASES + allowedChannels
// sans toucher au code source. Valeurs lues depuis la table `settings`
// (clé 'config_overrides') à chaque call — pas de cache, pour que les
// edits soient pris en compte immédiatement au refresh de la page.
//
// Forme attendue :
//   {
//     "authorAliases": { "newuser": "DisplayName", ... },
//     "allowedChannels": ["extra-channel-1", "extra-channel-2"]
//   }
//
// Historiquement stocké dans config-overrides.json dans DATA_DIR. La
// valeur a été migrée en DB via scripts/migrate-settings.js.
// ─────────────────────────────────────────────────────────────────────

const { getSetting } = require('../db/sqlite');

const SETTINGS_KEY = 'config_overrides';

function loadConfigOverrides() {
  return getSetting(SETTINGS_KEY, {}) || {};
}

module.exports = { loadConfigOverrides };
