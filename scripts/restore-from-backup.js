// ─────────────────────────────────────────────────────────────────────
// scripts/restore-from-backup.js — Rétablit boom.db depuis boom-backup.db
// ─────────────────────────────────────────────────────────────────────
// À exécuter uniquement quand le bot est arrêté (sinon better-sqlite3
// garde un lock sur le fichier et l'overwrite échouera sur Windows,
// produira un état incohérent sur Linux).
//
// Usage :
//   # Stopper le bot
//   node scripts/restore-from-backup.js
//   # Redémarrer le bot
//
// Source = boom-backup.db à la racine du repo (commité par runGitBackup).
// Dest   = boom.db dans DATA_DIR (volume Railway ou racine en local).
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../utils/persistence');

const BACKUP_PATH = path.resolve(__dirname, '..', 'boom-backup.db');
const LIVE_PATH = path.join(DATA_DIR, 'boom.db');

if (!fs.existsSync(BACKUP_PATH)) {
  console.error('[restore] boom-backup.db introuvable à', BACKUP_PATH);
  process.exit(1);
}

const backupSize = fs.statSync(BACKUP_PATH).size;
const liveExists = fs.existsSync(LIVE_PATH);
const liveSize = liveExists ? fs.statSync(LIVE_PATH).size : 0;

console.log('[restore] Backup : ' + BACKUP_PATH + ' (' + backupSize + ' bytes)');
console.log('[restore] Live   : ' + LIVE_PATH + (liveExists ? ' (' + liveSize + ' bytes)' : ' (absent)'));

// Safety : on sauvegarde le boom.db actuel avant de l'écraser (suffix
// .before-restore.<timestamp>). Permet de rollback si on a restauré
// par erreur.
if (liveExists) {
  const backupOfLive = LIVE_PATH + '.before-restore.' + Date.now();
  fs.copyFileSync(LIVE_PATH, backupOfLive);
  console.log('[restore] Ancien boom.db sauvegardé à', backupOfLive);
}

// Copie atomique (sur la même partition = instantané).
fs.copyFileSync(BACKUP_PATH, LIVE_PATH);
console.log('[restore] OK. Redémarre le bot maintenant.');

// Quick sanity check : count des messages dans la DB restaurée.
try {
  const Database = require('better-sqlite3');
  const db = new Database(LIVE_PATH, { readonly: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  db.close();
  console.log('[restore] DB contient', n, 'messages.');
} catch (e) {
  console.error('[restore] Warning — sanity check failed:', e.message);
}
