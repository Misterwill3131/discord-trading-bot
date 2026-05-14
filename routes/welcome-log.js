// ─────────────────────────────────────────────────────────────────────
// routes/welcome-log.js — GET /welcome-log
// ─────────────────────────────────────────────────────────────────────
// Lit l'état mémoire du welcome listener (state/welcome-log) à chaque
// requête et rend un tableau HTML. Auth-protégé via requireAuth.
// ─────────────────────────────────────────────────────────────────────

const { renderWelcomeLogPage } = require('../pages/welcome-log');
const { getWelcomeLog } = require('../state/welcome-log');

function registerWelcomeLogRoutes(app, requireAuth) {
  app.get('/welcome-log', requireAuth, (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(renderWelcomeLogPage(getWelcomeLog()));
  });
}

module.exports = { registerWelcomeLogRoutes };
