// ─────────────────────────────────────────────────────────────────────
// routes/backup-log.js — GET /backup-log
// ─────────────────────────────────────────────────────────────────────
// Lit l'état mémoire du scheduler (jobs.js) à chaque requête et rend
// un tableau HTML. Pas de cache — les 30 entries max tiennent largement.
// ─────────────────────────────────────────────────────────────────────

const { renderBackupLogPage } = require('../pages/backup-log');
const { getBackupLog } = require('../discord/jobs');

function registerBackupLogRoutes(app, requireAuth) {
  app.get('/backup-log', requireAuth, (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(renderBackupLogPage(getBackupLog()));
  });
}

module.exports = { registerBackupLogRoutes };
