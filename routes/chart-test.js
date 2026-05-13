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

// Renvoie un ISO 8601 pour "il y a N heures" — timezone-agnostic et
// garanti dans la fenêtre 1D rolling de chart-img (~24h).
// Plus robuste que reconstruire le NY tz à la main avec setHours()
// qui opère en local tz du process Node (sur Railway = UTC, donc
// setHours(14, 0) donnait 14:00 UTC = 10:00 NY, AVANT le start du chart).
function hoursAgoISO(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function registerChartTestRoutes(app, requireAuth) {
  app.get('/admin/chart-test', requireAuth, async (req, res) => {
    const apiKey = process.env.CHART_IMG_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'CHART_IMG_API_KEY not configured' });
    }

    // Defaults pensés pour un smoke test propre :
    //   - timestamps "il y a N heures" — garanti dans la fenêtre 1D
    //     rolling (~24h) du chart-img peu importe la timezone du serveur
    //   - entry 20h ago (début de la fenêtre, après l'open NY d'hier)
    //   - exit  2h ago  (récent, idéalement dans le AM session du jour)
    //   - prix TSLA réaliste ~$450 pour rester dans le Y-axis du chart
    const {
      ticker = 'TSLA',
      exchange = 'NASDAQ',
      entryPrice = '434',
      exitPrice = '450',
      entryTs = hoursAgoISO(20),
      exitTs = hoursAgoISO(2),
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

    // Offset 0.3% — flèches collées à la candle, à peine décalées pour
    // éviter le chevauchement direct avec le body.
    const ARROW_OFFSET = 0.003;
    const arrows = [];
    if (Number.isFinite(entryPriceNum)) {
      arrows.push({
        datetime: entryTs,
        price: entryPriceNum * (1 - ARROW_OFFSET),
        text: 'When alerted',
        direction: 'up',
        fontBold: true,
      });
    }
    if (Number.isFinite(exitPriceNum)) {
      arrows.push({
        datetime: exitTs,
        price: exitPriceNum * (1 + ARROW_OFFSET),
        text: fmtPrice(exitPriceNum),
        direction: 'down',
        fontBold: true,
      });
    }

    const symbol = `${String(exchange).toUpperCase()}:${String(ticker).toUpperCase()}`;

    try {
      const startedAt = Date.now();
      const buf = await client.getChart(symbol, String(range), {
        studies: [],
        arrows,
        // 'regular' (9:30-16:00 ET) plutôt que 'extended' pour éviter
        // l'ombrage darker sur pre/after-market (visuellement bruyant
        // dans la vidéo). Trade-off : trades pre-market non visibles.
        session: 'regular',
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
