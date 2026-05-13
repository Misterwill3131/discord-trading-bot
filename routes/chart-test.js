// ─────────────────────────────────────────────────────────────────────
// routes/chart-test.js — Smoke test admin de chart-img.com
// ─────────────────────────────────────────────────────────────────────
//   GET /admin/chart-test?ticker=TSLA&entryPrice=250&exitPrice=260&entryTs=ISO&exitTs=ISO
//
// Renvoie un PNG du chart TradingView 1D avec 2 callouts (entry + exit),
// EXACTEMENT comme le worker render-worker.ts l'appellerait pour un job
// BoomProof. Utile pour valider visuellement avant qu'un vrai trade
// gagnant ne déclenche un render automatique.
//
// Params (tous optionnels, valeurs default pour démo) :
//   ticker     — ex: 'TSLA' (default)
//   exchange   — ex: 'NASDAQ' (default)
//   entryPrice — prix d'entrée pour callout #1 (default 250)
//   exitPrice  — prix de sortie pour callout #2 (default 260)
//   entryTs    — ISO timestamp entry (default today 13:32 NY)
//   exitTs     — ISO timestamp exit  (default today 15:00 NY)
//   range      — '1D'|'5D'|'1M' (default '1D')
//
// Auth-protected (requireAuth).
// ─────────────────────────────────────────────────────────────────────

function todayNY(hh, mm) {
  // Renvoie un ISO 8601 pour aujourd'hui à HH:MM heure NY.
  const now = new Date();
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setHours(hh, mm, 0, 0);
  return ny.toISOString();
}

// Renvoie un ISO 8601 pour le DERNIER trading day à HH:MM NY (skip weekend).
// Si on est mardi 11h → renvoie lundi à HH:MM. Si on est lundi 11h → renvoie
// vendredi. Utile pour les defaults du test admin : on veut une plage temps
// dans le passé visible sur le chart, pas dans le futur (clamping au edge).
function lastTradingDayNY(hh, mm) {
  const now = new Date();
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setDate(ny.getDate() - 1);
  // Si samedi/dimanche, recule jusqu'à vendredi.
  while (ny.getDay() === 0 || ny.getDay() === 6) {
    ny.setDate(ny.getDate() - 1);
  }
  ny.setHours(hh, mm, 0, 0);
  return ny.toISOString();
}

function registerChartTestRoutes(app, requireAuth) {
  app.get('/admin/chart-test', requireAuth, async (req, res) => {
    const apiKey = process.env.CHART_IMG_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'CHART_IMG_API_KEY not configured' });
    }

    // Defaults pensés pour un smoke test propre :
    //   - last trading day (pas le futur → callouts visibles)
    //   - prix TSLA réaliste (~$450) pour rester dans le Y-axis du chart
    //   - 10:00 NY → 15:30 NY (couvre l'open + power hour)
    const {
      ticker = 'TSLA',
      exchange = 'NASDAQ',
      entryPrice = '430',
      exitPrice = '450',
      entryTs = lastTradingDayNY(10, 0),
      exitTs = lastTradingDayNY(15, 30),
      range = '1D',
    } = req.query;

    const { createChartImgClient } = require('../discord/chart-img-client');
    const client = createChartImgClient({
      apiKey,
      width: 1080,
      height: 720,
      theme: 'dark',
    });

    const entryPriceNum = parseFloat(entryPrice);
    const exitPriceNum  = parseFloat(exitPrice);

    const fmtPrice = (n) => {
      if (n >= 100) return '$' + n.toFixed(2);
      if (n >= 1)   return '$' + n.toFixed(2);
      if (n >= 0.01) return '$' + n.toFixed(3);
      return '$' + n.toFixed(4);
    };

    const callouts = [];
    if (Number.isFinite(entryPriceNum)) {
      callouts.push({
        datetime: entryTs,
        price: entryPriceNum,
        text: 'When alerted',
        fontBold: true,
        backgroundColor: 'rgb(59,130,246)',
        textColor: 'rgb(255,255,255)',
      });
    }
    if (Number.isFinite(exitPriceNum)) {
      callouts.push({
        datetime: exitTs,
        price: exitPriceNum,
        text: fmtPrice(exitPriceNum),
        fontBold: true,
        backgroundColor: 'rgb(16,185,129)',
        textColor: 'rgb(0,0,0)',
      });
    }

    const symbol = `${String(exchange).toUpperCase()}:${String(ticker).toUpperCase()}`;

    try {
      const startedAt = Date.now();
      const buf = await client.getChart(symbol, String(range), {
        studies: [],
        callouts,
        session: 'extended',
        timezone: 'America/New_York',
      });
      const elapsedMs = Date.now() - startedAt;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Chart-Elapsed-Ms', elapsedMs);
      res.setHeader('X-Chart-Symbol', symbol);
      res.setHeader('X-Chart-Size-KB', (buf.length / 1024).toFixed(0));
      res.setHeader('Cache-Control', 'no-cache');
      res.send(buf);
    } catch (err) {
      console.error('[chart-test] failed:', err.message);
      res.status(500).json({ error: err.message, symbol });
    }
  });
}

module.exports = { registerChartTestRoutes };
