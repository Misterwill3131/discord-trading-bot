// ─────────────────────────────────────────────────────────────────────
// routes/images.js — Routes de service d'assets images + génération
// ─────────────────────────────────────────────────────────────────────
// Regroupe tout ce qui sert/génère une image PNG :
//
//   Asset serving (lecture seule, lit state/images)
//     GET  /image/latest         — dernière image signal/proof
//     GET  /promo-image/latest   — dernière promo 1080×1080
//     GET  /api/gallery          — métadonnées des 100 dernières
//     GET  /gallery/image/:id    — PNG d'une entrée de galerie
//
//   Génération à la volée (pas d'état)
//     POST /generate             — génère + renvoie PNG (pas de store)
//     GET  /preview              — idem via query string (?author=…&message=…)
//     GET  /api/proof-image      — génère une image "reply" (alerte + recap)
//     OPTIONS /generate-and-store— CORS preflight
//     POST /generate-and-store   — génère + stocke dans state (pour Make)
//
//   Recherche (lit messageLog)
//     GET  /api/find-alert       — cherche les entrées d'un ticker sur N jours
//
//   Health check
//     GET  /health               — status + envoi test vers MAKE_WEBHOOK_URL
//
// Usage :
//   registerImageRoutes(app, requireAuth, imageState, {
//     messageLog,          // référence mutable au log global
//     railwayUrl,          // préfixe pour les URL absolues renvoyées au webhook
//     makeWebhookUrl,      // optionnel — si défini, /health envoie un test
//   });
// ─────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const { generateImage, generateProofImage } = require('../canvas/proof');
const { extractPrices, extractTicker, enrichContent } = require('../utils/prices');
const { getMessagesByTicker } = require('../db/sqlite');

function registerImageRoutes(app, requireAuth, imageState, opts) {
  const messageLog    = opts.messageLog;
  const RAILWAY_URL   = opts.railwayUrl;
  const MAKE_WEBHOOK  = opts.makeWebhookUrl || null;

  // ── Asset serving ──────────────────────────────────────────────────
  app.get('/image/latest', (req, res) => {
    if (!imageState.lastImageBuffer) return res.status(404).json({ error: 'No image available' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(imageState.lastImageBuffer);
  });

  app.get('/promo-image/latest', (req, res) => {
    if (!imageState.lastPromoImageBuffer) return res.status(404).json({ error: 'No promo image available' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(imageState.lastPromoImageBuffer);
  });

  app.get('/api/gallery', requireAuth, (req, res) => {
    // On renvoie uniquement la métadonnée — le buffer est servi via /gallery/image/:id.
    res.json(imageState.imageGallery.map(e => ({
      id: e.id, type: e.type, ticker: e.ticker, author: e.author, ts: e.ts,
    })));
  });

  app.get('/gallery/image/:id', requireAuth, (req, res) => {
    const entry = imageState.imageGallery.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).send('Not found');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(entry.buffer);
  });

  // ── Génération à la volée ──────────────────────────────────────────
  app.options('/generate-and-store', (req, res) => {
    // CORS preflight pour Make.com qui appelle depuis un domaine externe.
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
  });

  app.post('/generate-and-store', (req, res) => {
    const { author = 'Will', content = '', timestamp = new Date().toISOString() } = req.body;
    generateImage(author, content, timestamp).then(imgBuf => {
      imageState.lastImageBuffer = imgBuf;
      imageState.lastImageId = Date.now();
      const imageUrl = RAILWAY_URL + '/image/latest?t=' + imageState.lastImageId;
      res.set('Access-Control-Allow-Origin', '*');
      res.json({ image_url: imageUrl });
    }).catch(err => res.status(500).json({ error: err.message }));
  });

  app.post('/generate', (req, res) => {
    const { username = 'Unknown', content = '', timestamp = new Date().toISOString() } = req.body;
    generateImage(username, content, timestamp).then(imgBuf => {
      res.set('Content-Type', 'image/png');
      res.send(imgBuf);
    }).catch(err => res.status(500).json({ error: err.message }));
  });

  app.get('/preview', async (req, res) => {
    try {
      const author  = req.query.author  || 'Z';
      const message = req.query.message || '$TSLA 150.00-155.00';
      const ts      = req.query.ts      || new Date().toISOString();
      const buf = await generateImage(author, message, ts);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-cache');
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/proof-image', requireAuth, async (req, res) => {
    try {
      const { alertAuthor, alertContent, alertTs, recapAuthor, recapContent, recapTs } = req.query;
      if (!alertContent || !recapContent) return res.status(400).json({ error: 'Missing params' });
      const buf = await generateProofImage(
        alertAuthor || 'Unknown', alertContent, alertTs,
        recapAuthor || 'Unknown', recapContent, recapTs
      );
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-cache');
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Recherche d'alertes ────────────────────────────────────────────
  // Utilisé par la page /proof-generator pour retrouver l'entry d'un ticker.
  // Single query DB via l'index (ticker, ts) — remplace la boucle N-jours.
  app.get('/api/find-alert', requireAuth, (req, res) => {
    const ticker = (req.query.ticker || '').toUpperCase().replace('$', '');
    const days = Math.min(parseInt(req.query.days || '30', 10), 90);
    if (!ticker) return res.json({ alerts: [] });

    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    const rows = getMessagesByTicker(ticker, sinceIso);
    const alerts = rows
      .filter(m => m.passed)
      .slice(0, 20)
      .map(m => ({
        id: m.id,
        ts: m.ts,
        author: m.author,
        content: m.content || m.preview || '',
        ticker: m.ticker,
        type: m.type,
      }));
    res.json({ ticker, alerts });
  });

  // ── Health check ───────────────────────────────────────────────────
  // Plus qu'un simple ping : envoie un vrai signal test vers Make.com
  // (sauf si ?send=0) pour valider le pipeline de bout en bout.
  app.get('/health', async (req, res) => {
    const autoSend = req.query.send !== '0';

    let makeStatus = null;
    let imageUrl = null;
    let makeError = null;

    if (autoSend && MAKE_WEBHOOK) {
      try {
        const testAuthor  = req.query.author  || 'Will';
        const testContent = req.query.message || '$TSLA 150.00-155.00';
        const testSignal  = req.query.signal  || 'entry';
        const buf = await generateImage(testAuthor, testContent, new Date().toISOString());
        imageState.lastImageBuffer = buf;
        imageState.lastImageId = Date.now();
        imageUrl = RAILWAY_URL + '/image/latest?id=' + imageState.lastImageId;

        const makeRes = await fetch(MAKE_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content:     enrichContent(testContent),
            author:      testAuthor,
            channel:     'trading-floor',
            signal_type: testSignal,
            timestamp:   new Date().toISOString(),
            image_url:   imageUrl,
            ticker:      extractTicker(testContent),
            ...extractPrices(testContent),
          }),
        });
        makeStatus = makeRes.status;
        console.log('[/health] Signal envoye a Make, status:', makeStatus);
      } catch (err) {
        makeError = err.message;
        console.error('[/health] Erreur Make:', err.message);
      }
    }

    res.json({
      status:      'online',
      make_sent:   autoSend && !!MAKE_WEBHOOK,
      make_status: makeStatus,
      make_error:  makeError,
      image_url:   imageUrl,
      timestamp:   new Date().toISOString(),
      tip:         'Params optionnels: ?author=Z&message=$AAPL+180&signal=entry | ?send=0 pour desactiver',
    });
  });
}

module.exports = { registerImageRoutes };
