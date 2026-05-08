// ─────────────────────────────────────────────────────────────────────
// routes/video-studio.js — API endpoints pour /video-studio
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/video-studio/templates  — liste les templates Remotion
//   POST /api/video-studio/render     — enqueue un render_job depuis
//                                       une image gallery + template
//
// Le payload de render :
//   { galleryId, templateId, ctaUrl? }
//
// On lit l'image PNG depuis imageState.imageGallery, on encode en base64,
// on récupère le composition + props par défaut depuis le template JSON,
// et on insère un render_job avec ces infos. Le worker local pull et
// render normalement.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { enqueueRenderJob, getMessagesByTicker } = require('../db/sqlite');
const { computePnlString } = require('../utils/prices');

const TEMPLATES_DIR = path.join(__dirname, '..', 'video', 'templates');

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const id = f.replace(/\.json$/, '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
        return {
          id,
          name: data.name || id,
          composition: data.composition || 'BoomProof',
          description: data.description || '',
          props: data.props || {},
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

function registerVideoStudioRoutes(app, requireAuth, imageState) {
  // ── GET /api/video-studio/templates ───────────────────────────────
  app.get('/api/video-studio/templates', requireAuth, (_req, res) => {
    const templates = loadTemplates();
    // Renvoie sans les props complètes pour réduire le payload (le client
    // n'a besoin que des métadonnées pour afficher le dropdown).
    res.json({
      templates: templates.map(t => ({
        id: t.id, name: t.name, composition: t.composition, description: t.description,
      })),
    });
  });

  // ── POST /api/video-studio/render ─────────────────────────────────
  app.post('/api/video-studio/render', requireAuth, (req, res) => {
    const { galleryId, templateId, ctaUrl } = req.body || {};
    if (!galleryId) return res.status(400).json({ error: 'Missing galleryId' });
    if (!templateId) return res.status(400).json({ error: 'Missing templateId' });

    // Trouve l'image dans la gallery
    const item = imageState.imageGallery.find(e => e.id === galleryId);
    if (!item) return res.status(404).json({ error: 'Gallery item not found' });

    // Trouve le template
    const templates = loadTemplates();
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    // Détecte la composition à utiliser
    // - 'proof' image → BoomProof (a entry+exit)
    // - 'signal' image → BoomEntry (single message)
    // Mais si le template force une composition spécifique, on la respecte.
    const composition = tpl.composition || (item.type === 'proof' ? 'BoomProof' : 'BoomEntry');

    // Construit les props du job. Pour BoomEntry on n'utilise que author/message/timestamp,
    // mais render_jobs schema exige tous les champs entry_/exit_ — on duplique.
    const author = item.author || 'Z';
    const ts = item.ts || new Date().toISOString();
    const ticker = (item.ticker || 'BOOM').toUpperCase();

    // Lookup du message original dans la DB pour extraire le contenu exact
    // et calculer le PnL. La gallery stocke seulement metadata (id, ticker,
    // author, ts, buffer) — pas le texte. On query messages WHERE ticker=
    // dans une fenêtre de ±60s autour de gallery.ts pour matcher.
    let messageStr = `$${ticker} signal`;
    let computedPnl = '+0%';
    try {
      const galleryTime = new Date(ts).getTime();
      const sinceIso = new Date(galleryTime - 60_000).toISOString();
      const rows = getMessagesByTicker(ticker, sinceIso);
      // Match : auteur + ts dans ±60s autour de gallery.ts.
      const match = rows.find(r => {
        const t = new Date(r.ts).getTime();
        return Math.abs(t - galleryTime) < 60_000
          && (r.author || '').toLowerCase() === author.toLowerCase();
      });
      if (match && match.content) {
        messageStr = match.content;
        const pnl = computePnlString(match.content);
        if (pnl) computedPnl = pnl;
      }
    } catch (err) {
      console.warn('[video-studio] DB lookup failed, using defaults:', err.message);
    }

    try {
      const jobId = enqueueRenderJob({
        ticker,
        entry_author: author,
        entry_message: messageStr,
        entry_ts: ts,
        // Pour BoomProof on aurait besoin de exit_* différents, mais ici
        // on render depuis une seule image — on duplique.
        exit_author: author,
        exit_message: messageStr,
        exit_ts: ts,
        pnl: computedPnl,
        proof_image_base64: item.buffer.toString('base64'),
        template_name: templateId,
        composition,
      });
      console.log(`[video-studio] enqueue render_job #${jobId} from gallery ${galleryId} (${item.type}) → composition ${composition}, template ${templateId}, pnl ${computedPnl}`);
      res.json({ jobId, composition, templateId, pnl: computedPnl });
    } catch (err) {
      console.error('[video-studio] enqueue failed:', err);
      res.status(500).json({ error: err.message });
    }

    // Note: ctaUrl est ignoré pour l'instant — le template détermine la
    // CTA URL via ses props. Future: passer un props_override JSON pour
    // override per-job des fields comme ctaUrl, ctaTitle, etc.
    void ctaUrl;
  });
}

module.exports = { registerVideoStudioRoutes };
