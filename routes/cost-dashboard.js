// ─────────────────────────────────────────────────────────────────────
// routes/cost-dashboard.js — Endpoints JSON pour la page /cost-dashboard
// ─────────────────────────────────────────────────────────────────────
//   GET /api/cost-stats — bundle complet : summary + daily + breakdown +
//                         recent events. Tout en 1 call pour simplicité.
//
// Lecture-seule. La source des données est la table cost_events alimentée
// par utils/cost-tracker.js depuis tous les call-sites API (Anthropic,
// ElevenLabs, chart-img, render).
//
// Permissions : auth-protégé via requireAuth comme les autres dashboards.
// ─────────────────────────────────────────────────────────────────────

const costTracker = require('../utils/cost-tracker');

function registerCostDashboardRoutes(app, requireAuth) {
  app.get('/api/cost-stats', requireAuth, (_req, res) => {
    try {
      // Bundle : on rapatrie tout d'un coup pour 1 round-trip côté client.
      // Le dashboard a besoin de :
      //   - summary (KPIs today / 7d / 30d / all-time)
      //   - daily totals derniers 30 jours pour le bar chart
      //   - breakdown last 30 days par service
      //   - 30 derniers events pour le tail debug
      const now = Date.now();
      const last30dStart = now - 30 * 86_400_000;
      const summary = costTracker.summary();
      const daily = costTracker.dailyTotals({ days: 30 });
      const statsLast30d = costTracker.statsByService({ startMs: last30dStart, endMs: now });
      const recent = costTracker.recent({ limit: 30 });

      // allCallsCount = COUNT(*) sur cost_events. statsLast30d.callCount
      // ne couvre que la fenêtre 30d, donc on relit séparément pour le KPI
      // "events tracked" all-time.
      let allCallsCount = 0;
      try {
        const { db } = require('../db/sqlite');
        const row = db.prepare('SELECT COUNT(*) AS n FROM cost_events').get();
        allCallsCount = row && row.n ? row.n : 0;
      } catch (_) { /* swallow */ }

      res.json({
        summary,
        daily,
        statsLast30d,
        recent,
        allCallsCount,
        generatedAt: now,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerCostDashboardRoutes };
