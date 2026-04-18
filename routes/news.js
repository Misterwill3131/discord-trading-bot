// ─────────────────────────────────────────────────────────────────────
// routes/news.js — Endpoints dashboard pour les news
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/recent-news   — snapshot des 50 derniers items
//   GET  /api/news-events   — SSE : stream live des nouveaux items
//
// Le poller (news/poller.js) encapsule son état — on accède via des
// accesseurs (getRecentNews, registerSSEClient) plutôt que de toucher
// aux structures internes.
// ─────────────────────────────────────────────────────────────────────

const { getRecentNews, registerSSEClient } = require('../news/poller');

function registerNewsRoutes(app, requireAuth) {
  app.get('/api/recent-news', requireAuth, (req, res) => {
    res.json(getRecentNews());
  });

  app.get('/api/news-events', requireAuth, (req, res) => {
    // SSE : Content-Type obligatoire pour que EventSource côté client l'accepte.
    // X-Accel-Buffering: no pour désactiver le buffering nginx éventuel
    // (sinon les events restent coincés jusqu'à ce que le buffer soit plein).
    res.set({
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const unregister = registerSSEClient(res);

    // Heartbeat 25s : garde la connexion vivante via proxies qui ferment
    // les connexions inactives au bout de 30-60s.
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      unregister();
    });
  });
}

module.exports = { registerNewsRoutes };
