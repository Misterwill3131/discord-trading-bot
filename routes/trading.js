// ─────────────────────────────────────────────────────────────────────
// routes/trading.js — Dashboard API pour le moteur de trading
// ─────────────────────────────────────────────────────────────────────
// Endpoints :
//   GET  /trading                      → page HTML
//   GET  /api/trading/positions        → positions open/pending
//   GET  /api/trading/history?limit=N  → historique closed/cancelled
//   GET  /api/trading/config           → config courant
//   POST /api/trading/config           → update partiel du config
//   POST /api/trading/positions/:id/close → close une position par id DB
//   POST /api/trading/panic            → close all positions + disable
//   POST /api/trading/kill-switch      → toggle tradingEnabled
//
// Toutes les routes sous `requireTradingAuth` (auth/trading-session.js) —
// indépendant de l'auth dashboard principale. Paramètre `requireAuth` de
// la fonction = nom historique, mais le caller passe `requireTradingAuth`.
// ─────────────────────────────────────────────────────────────────────

const {
  getOpenPositions,
  getPositionHistory,
} = require('../db/sqlite');
const { loadTradingConfig, saveTradingConfig } = require('../trading/config');
const { renderTradingPage } = require('../pages/trading');

function registerTradingRoutes(app, requireAuth, { tradingEngine, tradingBroker }) {
  app.get('/trading', requireAuth, (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(renderTradingPage());
  });

  app.get('/api/trading/positions', requireAuth, (_req, res) => {
    res.json({ positions: getOpenPositions() });
  });

  app.get('/api/trading/history', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    const all = getPositionHistory(limit);
    const closed = all.filter(p => p.status !== 'pending' && p.status !== 'open');
    res.json({ history: closed });
  });

  app.get('/api/trading/config', requireAuth, (_req, res) => {
    res.json({ config: loadTradingConfig() });
  });

  app.post('/api/trading/config', requireAuth, (req, res) => {
    const allowedKeys = [
      'tradingEnabled', 'mode', 'riskPerTradePct', 'tolerancePct',
      'trailingStopPct', 'maxConcurrentPositions', 'limitOrderTimeoutMin',
      'authorWhitelist', 'tfMinutes', 'takeProfitMode',
    ];
    const partial = {};
    for (const k of allowedKeys) {
      if (k in (req.body || {})) partial[k] = req.body[k];
    }

    // Le broker (Paper/IBKR) est instancié au boot et ne peut pas être
    // swappé à chaud — un changement de mode doit donc forcer un restart
    // du process pour que le bon broker soit créé au prochain démarrage.
    const before = loadTradingConfig();
    const updated = saveTradingConfig(partial);
    const modeChanged = partial.mode !== undefined && partial.mode !== before.mode;
    res.json({ config: updated, restartingForMode: modeChanged });

    if (modeChanged) {
      console.log('[trading] mode changed ' + before.mode + ' → ' + updated.mode + ', exiting for restart');
      // Laisse 500ms pour que la réponse HTTP parte avant que le process meure.
      // Railway redémarre automatiquement le service avec la nouvelle config.
      setTimeout(() => process.exit(0), 500);
    }
  });

  app.post('/api/trading/positions/:id/close', requireAuth, async (req, res) => {
    if (!tradingBroker) return res.status(503).json({ error: 'broker not ready' });
    const id = parseInt(req.params.id, 10);
    const positions = getOpenPositions();
    const row = positions.find(p => p.id === id);
    if (!row) return res.status(404).json({ error: 'position not found' });
    try {
      if (row.ibkr_tp_id) await tradingBroker.cancelOrder(row.ibkr_tp_id).catch(() => {});
      if (row.ibkr_sl_id) await tradingBroker.cancelOrder(row.ibkr_sl_id).catch(() => {});
      await tradingBroker.closePosition(row.ticker, row.quantity);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/trading/panic', requireAuth, async (_req, res) => {
    if (!tradingBroker) return res.status(503).json({ error: 'broker not ready' });
    const positions = getOpenPositions();
    // Group by ticker, summing quantities so we close the full exposure per ticker.
    const qtyByTicker = new Map();
    for (const p of positions) {
      qtyByTicker.set(p.ticker, (qtyByTicker.get(p.ticker) || 0) + (p.quantity || 0));
    }
    const errors = [];
    for (const [ticker, qty] of qtyByTicker.entries()) {
      try { await tradingBroker.closePosition(ticker, qty); }
      catch (e) { errors.push({ ticker, err: e.message }); }
    }
    saveTradingConfig({ tradingEnabled: false });
    res.json({ ok: errors.length === 0, tickersClosed: Array.from(qtyByTicker.keys()), errors });
  });

  app.post('/api/trading/kill-switch', requireAuth, (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    const updated = saveTradingConfig({ tradingEnabled: enabled });
    res.json({ config: updated });
  });
}

module.exports = { registerTradingRoutes };
