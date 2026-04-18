// ─────────────────────────────────────────────────────────────────────
// routes/messages.js — Endpoints de lecture du messageLog
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/messages    — snapshot filtré (from/to) avec exit_price
//                           enrichi pour les messages 'exit'
//   GET  /api/events      — SSE : broadcast live des nouveaux events
//                           (via state/messages → logEvent)
//   GET  /api/export-csv  — même filtrage, dump CSV pour Excel/Sheets
//
// Aucune mutation côté routes : lectures pures + gestion du cycle de vie
// des clients SSE (enregistrement / nettoyage à la déconnexion).
// ─────────────────────────────────────────────────────────────────────

const { BLOCKED_AUTHORS } = require('../utils/authors');
const { extractPrices } = require('../utils/prices');
const { messageLog, registerSSEClient } = require('../state/messages');

// Applique les filtres ?from= et ?to= (timestamps ISO) sur un array de messages.
function applyDateRange(msgs, query) {
  if (query.from) {
    const from = new Date(query.from).getTime();
    if (!isNaN(from)) msgs = msgs.filter(m => new Date(m.ts).getTime() >= from);
  }
  if (query.to) {
    const to = new Date(query.to).getTime();
    if (!isNaN(to)) msgs = msgs.filter(m => new Date(m.ts).getTime() <= to);
  }
  return msgs;
}

// Échappement CSV RFC 4180 — guillemets autour si virgule/newline/guillemet.
function csvField(val) {
  const s = String(val == null ? '' : val);
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function registerMessageRoutes(app, requireAuth) {
  // ── /api/messages ──────────────────────────────────────────────────
  app.get('/api/messages', requireAuth, (req, res) => {
    // Filtre d'abord sur BLOCKED_AUTHORS : les messages historiques d'auteurs
    // bloqués ne doivent pas polluer dashboard / stats / timeline même
    // s'ils sont antérieurs au blocage.
    let msgs = messageLog.filter(m =>
      !m.author || !BLOCKED_AUTHORS.has(String(m.author).toLowerCase())
    );
    msgs = applyDateRange(msgs, req.query);

    // Enrichit les 'exit' avec exit_price parsé depuis content — permet au
    // client de calculer le P&L sans dupliquer le parser en JS navigateur.
    msgs = msgs.map(m => {
      if (m.type === 'exit') {
        const parsed = extractPrices(m.content || '');
        if (parsed.exit_price != null) {
          return Object.assign({}, m, { exit_price: parsed.exit_price });
        }
      }
      return m;
    });
    res.json(msgs);
  });

  // ── /api/events ────────────────────────────────────────────────────
  // SSE : le client écoute indéfiniment. logEvent() (state/messages.js)
  // pousse à chaque nouveau message. Heartbeat 25s pour survivre aux
  // proxies qui ferment les connexions inactives.
  app.get('/api/events', requireAuth, (req, res) => {
    res.set({
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const unregister = registerSSEClient(res);
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      unregister();
    });
  });

  // ── /api/export-csv ────────────────────────────────────────────────
  // Pas de filtre BLOCKED_AUTHORS ici : l'export est destiné à l'analyse
  // humaine hors dashboard — on laisse tout pour pouvoir voir pourquoi
  // un auteur a été bloqué.
  app.get('/api/export-csv', requireAuth, (req, res) => {
    const msgs = applyDateRange(messageLog, req.query);
    const dateStr = new Date().toISOString().slice(0, 10);

    const rows = ['timestamp,author,channel,ticker,type,reason,confidence,preview'];
    msgs.forEach(m => {
      rows.push([
        csvField(m.ts),
        csvField(m.author),
        csvField(m.channel),
        csvField(m.ticker || ''),
        csvField(m.type || 'filtered'),
        csvField(m.reason),
        csvField(m.confidence != null ? m.confidence : ''),
        csvField(m.preview),
      ].join(','));
    });

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="boom-signals-' + dateStr + '.csv"');
    res.send(rows.join('\n'));
  });
}

module.exports = { registerMessageRoutes };
