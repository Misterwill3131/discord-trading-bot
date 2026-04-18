// ─────────────────────────────────────────────────────────────────────
// scripts/migrate-messages.js — Import messages-*.json → SQLite
// ─────────────────────────────────────────────────────────────────────
// One-shot : à exécuter manuellement avec `node scripts/migrate-messages.js`
// sur la machine qui a accès à DATA_DIR (Railway SSH ou local).
//
// Idempotent : INSERT OR IGNORE sur PK déduplique. Relancer le script
// après de nouveaux messages ne crée pas de doublons (pratique pour une
// mise en production progressive).
//
// Ne supprime PAS les fichiers JSON — ils restent en backup, le bot
// cesse simplement de les lire après le switch (Phase 3).
//
// Affiche un rapport : fichiers parcourus, total JSON, insérés, dupliqués.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../utils/persistence');
const { insertMessagesBulk, countMessages, DB_PATH } = require('../db/sqlite');

console.log('[migrate] DATA_DIR:', DATA_DIR);
console.log('[migrate] DB path :', DB_PATH);
console.log('[migrate] Count avant migration:', countMessages());

// Liste des fichiers messages-YYYY-MM-DD.json dans DATA_DIR.
let files = [];
try {
  files = fs.readdirSync(DATA_DIR)
    .filter(f => /^messages-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // ordre chronologique, plus ancien d'abord
} catch (e) {
  console.error('[migrate] Impossible de lister DATA_DIR:', e.message);
  process.exit(1);
}

console.log('[migrate] Fichiers trouvés:', files.length);
if (!files.length) {
  console.log('[migrate] Rien à migrer.');
  process.exit(0);
}

let totalRead = 0;
let totalInserted = 0;

// Process fichier par fichier avec une transaction par lot — réduit
// l'usage mémoire vs tout charger d'un coup.
for (const file of files) {
  const fp = path.join(DATA_DIR, file);
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    console.error('[migrate]', file, '- parse error:', e.message);
    continue;
  }
  if (!Array.isArray(entries)) {
    console.error('[migrate]', file, '- format invalide (pas un array), skip');
    continue;
  }

  totalRead += entries.length;
  const inserted = insertMessagesBulk(entries);
  totalInserted += inserted;
  const dupes = entries.length - inserted;
  console.log('[migrate] ' + file + ' : ' + entries.length + ' JSON, '
    + inserted + ' inséré(s), ' + dupes + ' dupliqué(s) ignoré(s)');
}

console.log('\n[migrate] Résumé :');
console.log('  Fichiers        : ' + files.length);
console.log('  Entries JSON    : ' + totalRead);
console.log('  Nouveaux insérés: ' + totalInserted);
console.log('  Dupliqués       : ' + (totalRead - totalInserted));
console.log('  Total DB final  : ' + countMessages());
