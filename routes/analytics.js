// ─────────────────────────────────────────────────────────────────────
// routes/analytics.js — Endpoints JSON read-only pour stats & classements
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/analyst-performance?days=N  — chart lines pour la page /stats
//   GET  /api/ticker/:symbol?days=N       — détail complet pour /ticker/:symbol
//   GET  /api/leaderboard?days=N          — classement auteurs pour /leaderboard
//   GET  /api/leaderboard/analyst?author= — détail d'un auteur
//
// Toutes agrègent sur les messages des N derniers jours (90 max) en
// combinant messageLog (jour courant, en mémoire) + fichiers journaliers
// sur disque (jours passés).
//
// Fonctions pures : lisent messageLog et les fichiers, ne mutent rien.
// messageLog est passé par référence, donc les modifications faites par
// le handler Discord sont vues à chaque requête (pas de cache).
// ─────────────────────────────────────────────────────────────────────

const { extractPrices } = require('../utils/prices');
const { BLOCKED_AUTHORS, getDisplayName } = require('../utils/authors');
const { getMessagesByDateKey } = require('../db/sqlite');

// Parcours les N derniers jours via la DB (source de vérité). `visit(msgs,
// dateKey, dayIndex)` reçoit chaque lot une fois. Depuis la migration
// SQLite plus besoin de distinguer jour 0 (mémoire) vs jours passés
// (fichier) — chaque logEvent écrit en DB immédiatement.
function forEachDayOfLog(messageLog, days, visit) {
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    visit(getMessagesByDateKey(dateKey), dateKey, i);
  }
}

// Clamp helper — évite qu'un ?days=99999 fasse lire 99999 fichiers.
function parseDays(raw, max = 90) {
  return Math.min(parseInt(raw || '30', 10), max);
}

function registerAnalyticsRoutes(app, requireAuth, messageLog) {
  // ── /api/analyst-performance ─────────────────────────────────────
  // Top 5 auteurs par volume, avec nombre de signaux ventilés par jour.
  // Consommé par la page /stats (dernier chart du bas).
  app.get('/api/analyst-performance', requireAuth, (req, res) => {
    const days = parseDays(req.query.days);
    const dateLabels = [];
    const authorDayMap = {}; // { author: { 'YYYY-MM-DD': count } }

    // Parcours ASC (plus ancien → plus récent) pour construire dateLabels
    // dans l'ordre attendu par le chart côté client.
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().slice(0, 10);
      dateLabels.push(dateKey);
      const msgs = getMessagesByDateKey(dateKey);
      msgs.forEach(m => {
        if (!m.passed || !m.author) return;
        if (!authorDayMap[m.author]) authorDayMap[m.author] = {};
        authorDayMap[m.author][dateKey] = (authorDayMap[m.author][dateKey] || 0) + 1;
      });
    }

    // Top 5 par total — on jette le reste (graphique lisible max ~5 séries).
    const totals = Object.keys(authorDayMap).map(a => {
      let total = 0;
      Object.values(authorDayMap[a]).forEach(v => total += v);
      return { author: a, total };
    }).sort((a, b) => b.total - a.total).slice(0, 5);

    const colors = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#D649CC'];
    const datasets = totals.map((t, i) => ({
      author: t.author,
      color: colors[i % colors.length],
      data: dateLabels.map(d => (authorDayMap[t.author] || {})[d] || 0),
    }));

    res.json({ labels: dateLabels, datasets });
  });

  // ── /api/ticker/:symbol ──────────────────────────────────────────
  // Detail complet pour la page /ticker/:symbol. Renvoie un gros objet
  // utilisé par ~8 visualisations différentes (breakdown, top authors,
  // heatmap, premières valeurs entry/exit, liste signaux, etc).
  app.get('/api/ticker/:symbol', requireAuth, (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase().replace('$', '');
    const days = parseDays(req.query.days);
    if (!symbol) return res.json({ ticker: '', days, total: 0, signals: [] });

    // Collecte tous les messages qui mentionnent ce ticker sur la période.
    const collected = [];
    forEachDayOfLog(messageLog, days, (msgs) => {
      msgs.forEach(m => {
        if (!m.ticker) return;
        if (String(m.ticker).toUpperCase() !== symbol) return;
        collected.push(m);
      });
    });

    // Tri DESC (plus récent d'abord) — utilisé pour l'aperçu des signaux.
    collected.sort((a, b) => (a.ts || '') < (b.ts || '') ? 1 : -1);

    const breakdown = { entry: 0, exit: 0, neutral: 0, filter: 0 };
    const authorCounts = {};
    const hourly = new Array(24).fill(0);
    const weekday = new Array(7).fill(0);
    let firstSeen = null;
    let lastSeen = null;

    collected.forEach(m => {
      if (!m.passed) breakdown.filter++;
      else if (m.type === 'entry') breakdown.entry++;
      else if (m.type === 'exit') breakdown.exit++;
      else breakdown.neutral++;

      if (m.author && !BLOCKED_AUTHORS.has(String(m.author).toLowerCase())) {
        const key = getDisplayName(m.author);
        authorCounts[key] = (authorCounts[key] || 0) + 1;
      }

      if (m.ts) {
        const d = new Date(m.ts);
        if (!isNaN(d)) {
          hourly[d.getHours()]++;
          weekday[d.getDay()]++;
        }
        if (!firstSeen || m.ts < firstSeen) firstSeen = m.ts;
        if (!lastSeen  || m.ts > lastSeen)  lastSeen  = m.ts;
      }
    });

    const topAuthors = Object.keys(authorCounts)
      .map(name => ({ name, count: authorCounts[name] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Premier prix d'entrée + premier prix de sortie (chronologiquement
    // les plus anciens). Pour les exits on re-parse le content quand
    // entry_price n'est pas stocké (legacy logs avant le champ exit_price).
    let firstEntryPrice = null, firstEntryTs = null;
    let firstExitPrice  = null, firstExitTs  = null;
    const byTsAsc = collected.slice().sort((a, b) => (a.ts || '') > (b.ts || '') ? 1 : -1);
    for (const m of byTsAsc) {
      if (firstEntryPrice == null && m.passed && m.type === 'entry' && m.entry_price != null) {
        firstEntryPrice = m.entry_price;
        firstEntryTs = m.ts;
      }
      if (firstExitPrice == null && m.passed && m.type === 'exit') {
        const parsed = extractPrices(m.content || '');
        const price = parsed.exit_price != null ? parsed.exit_price : parsed.entry_price;
        if (price != null) {
          firstExitPrice = price;
          firstExitTs = m.ts;
        }
      }
      if (firstEntryPrice != null && firstExitPrice != null) break;
    }

    // Cap à 200 signaux renvoyés pour le tableau historique — au-delà la
    // page rame et l'utilisateur ne scrolle jamais jusque-là.
    const signals = collected.slice(0, 200).map(m => ({
      id: m.id,
      ts: m.ts,
      author: m.author,
      channel: m.channel,
      type: m.type,
      passed: m.passed,
      reason: m.reason,
      preview: m.preview,
      content: m.content,
    }));

    res.json({
      ticker: symbol,
      days,
      total: collected.length,
      firstSeen,
      lastSeen,
      firstEntryPrice,
      firstEntryTs,
      firstExitPrice,
      firstExitTs,
      distinctAuthors: Object.keys(authorCounts).length,
      breakdown,
      topAuthors,
      heatmap: { hourly, weekday },
      signals,
    });
  });

  // ── /api/leaderboard ─────────────────────────────────────────────
  // Classement auteurs par nombre de signaux VALIDES (ticker + prix entry
  // + prix target). Exclut les signaux sans prix ou filtrés.
  app.get('/api/leaderboard', requireAuth, (req, res) => {
    const days = parseDays(req.query.days);
    const authorStats = {};

    forEachDayOfLog(messageLog, days, (msgs) => {
      msgs.forEach(m => {
        if (!m.passed || !m.author) return;
        if (!m.ticker) return;
        // Skip self-referenced tickers : analyste qui signe avec son nom
        // (ex. auteur "ZZ" + ticker détecté "ZZ"). Compare aussi contre
        // le display name pour catcher les alias (ex. traderzz1m → ZZ).
        const display = getDisplayName(m.author);
        const t = m.ticker.toUpperCase();
        if (t === m.author.toUpperCase() || t === display.toUpperCase()) return;
        const prices = extractPrices(m.content || '');
        if (prices.entry_price === null || prices.target_price === null) return;
        // Group by display name → les alias (ex. traderzz1m + ZZ → ZZ)
        // sont comptés comme un seul analyste.
        if (!authorStats[display]) authorStats[display] = { signals: 0, tickers: {} };
        authorStats[display].signals++;
        authorStats[display].tickers[m.ticker] = (authorStats[display].tickers[m.ticker] || 0) + 1;
      });
    });

    const rows = Object.keys(authorStats).map(author => {
      const s = authorStats[author];
      let topTicker = null, topCount = 0;
      Object.keys(s.tickers).forEach(t => {
        if (s.tickers[t] > topCount) { topCount = s.tickers[t]; topTicker = t; }
      });
      return { author, signals: s.signals, topTicker };
    }).sort((a, b) => b.signals - a.signals);

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days + 1);
    const period = fromDate.toISOString().slice(0, 10) + ' → ' + new Date().toISOString().slice(0, 10);
    res.json({ rows, period });
  });

  // ── /api/leaderboard/analyst ─────────────────────────────────────
  // Vue détaillée : tous les signaux valides d'UN auteur précis (clic
  // sur une ligne du leaderboard → drawer).
  app.get('/api/leaderboard/analyst', requireAuth, (req, res) => {
    const author = (req.query.author || '').trim();
    const days = parseDays(req.query.days);
    if (!author) return res.json({ signals: [] });

    const signals = [];
    forEachDayOfLog(messageLog, days, (msgs) => {
      msgs.forEach(m => {
        if (!m.passed || !m.author) return;
        // Match par display name → ?author=ZZ retrouve aussi traderzz1m.
        if (getDisplayName(m.author) !== author) return;
        if (!m.ticker) return;
        // Skip self-referenced tickers (cohérent avec /api/leaderboard).
        const t = m.ticker.toUpperCase();
        if (t === m.author.toUpperCase() || t === author.toUpperCase()) return;
        const prices = extractPrices(m.content || '');
        if (prices.entry_price === null || prices.target_price === null) return;
        signals.push({
          ts: m.ts,
          ticker: m.ticker,
          content: m.content || '',
          channel: m.channel || '',
          entry_price: prices.entry_price,
          target_price: prices.target_price,
          stop_price: prices.stop_price || null,
        });
      });
    });

    // Plus récent d'abord.
    signals.sort((a, b) => (b.ts || '') < (a.ts || '') ? -1 : 1);
    res.json({ author, signals });
  });
}

module.exports = { registerAnalyticsRoutes };
