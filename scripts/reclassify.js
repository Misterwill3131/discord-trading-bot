// ─────────────────────────────────────────────────────────────────────
// scripts/reclassify.js — Reclassify CLI (alternative au bouton UI)
// ─────────────────────────────────────────────────────────────────────
// Utile quand on veut reclasser depuis le serveur sans passer par le
// dashboard (ex: script post-deploy automatisé Railway).
//
// Usage :
//   node scripts/reclassify.js
//
// Affiche les stats (total, updated, transitions) en sortie standard.
// Exit code 0 toujours — à wrapper dans un job CI si besoin de fail.
// ─────────────────────────────────────────────────────────────────────

const { reclassifyAllMessages } = require('../db/reclassify');
const { DB_PATH } = require('../db/sqlite');

console.log('[reclassify] DB:', DB_PATH);
console.log('[reclassify] Running reclassification...');

const t0 = Date.now();
const stats = reclassifyAllMessages();
const elapsed = Date.now() - t0;

console.log('');
console.log('[reclassify] Résumé :');
console.log('  Total       : ' + stats.total);
console.log('  Updated     : ' + stats.updated);
console.log('  Unchanged   : ' + stats.unchanged);
console.log('  Elapsed     : ' + elapsed + 'ms');

const transitionKeys = Object.keys(stats.transitions);
if (transitionKeys.length > 0) {
  console.log('');
  console.log('[reclassify] Transitions :');
  transitionKeys.sort().forEach(k => {
    console.log('  ' + k.padEnd(25) + stats.transitions[k]);
  });
}
