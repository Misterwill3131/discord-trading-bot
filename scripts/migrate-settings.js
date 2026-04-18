// ─────────────────────────────────────────────────────────────────────
// scripts/migrate-settings.js — Import configs JSON → table settings
// ─────────────────────────────────────────────────────────────────────
// Migre :
//   custom-filters.json    → settings['custom_filters']
//   config-overrides.json  → settings['config_overrides']
//
// Idempotent : UPSERT (overwrite). Relancer remplace les valeurs en DB
// par celles des fichiers (utile si tu édites le JSON à la main et veux
// resyncer).
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../utils/persistence');
const { setSetting, DB_PATH } = require('../db/sqlite');

console.log('[migrate-settings] DATA_DIR:', DATA_DIR);
console.log('[migrate-settings] DB path :', DB_PATH);

const targets = [
  // custom-filters.json est écrit à la racine du projet (pas dans DATA_DIR) —
  // historique : il existait avant la notion de DATA_DIR.
  { file: path.join(__dirname, '..', 'custom-filters.json'), key: 'custom_filters' },
  { file: path.join(DATA_DIR, 'config-overrides.json'),      key: 'config_overrides' },
];

let migrated = 0;
for (const { file, key } of targets) {
  if (!fs.existsSync(file)) {
    console.log('[migrate-settings]', path.basename(file), '- absent, skip');
    continue;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    setSetting(key, data);
    migrated++;
    console.log('[migrate-settings] ' + path.basename(file) + ' → settings[' + key + ']');
  } catch (e) {
    console.error('[migrate-settings]', path.basename(file), 'error:', e.message);
  }
}

console.log('\n[migrate-settings] Résumé : ' + migrated + '/' + targets.length + ' fichiers migrés');
