// ─────────────────────────────────────────────────────────────────────
// routes/render-queue.js — Queue de rendu vidéo Phase 3
// ─────────────────────────────────────────────────────────────────────
// 2 endpoints HTTP exposés par le bot, consommés par le worker local :
//   GET  /api/render-queue            — liste les jobs pending
//   POST /api/render-queue/:id/done   — ACK avec MP4 (multipart) ou error (JSON)
//
// Auth : Bearer token via env RENDER_WORKER_TOKEN.
// ─────────────────────────────────────────────────────────────────────

const multer = require('multer');
const {
  getPendingRenderJobs,
  markRenderJobDone,
  markRenderJobFailed,
} = require('../db/sqlite');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max (vidéos sont ~1-3 MB)
});

// Convertit une ligne DB (snake_case) en payload API (camelCase pour le worker
// qui passe directement les props à Remotion qui attend camelCase).
function jobToApiShape(row) {
  return {
    id: row.id,
    ticker: row.ticker,
    entryAuthor: row.entry_author,
    entryMessage: row.entry_message,
    entryTimestamp: row.entry_ts,
    exitAuthor: row.exit_author,
    exitMessage: row.exit_message,
    exitTimestamp: row.exit_ts,
    pnl: row.pnl,
    // Base64 PNG de l'image canvas-rendered (entry+exit Discord conversation
    // avec role pills / emojis custom). null si la génération a échoué côté
    // bot — le worker fallback sur les Discord cards Remotion natives.
    proofImageBase64: row.proof_image_base64 || null,
  };
}

// Nom de fichier du MP4 sortant : YYYY-MM-DD_HHMM_TICKER_proof.mp4
// Date dérivée du exit_ts en timezone America/New_York pour cohérence
// avec ce que le canvas affiche.
function buildVideoFilename(ticker, exitTs) {
  const d = new Date(exitTs);
  // Force NY tz via toLocaleString
  const fmt = d.toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // fmt is like "2026-04-25, 16:30" → normalize to "2026-04-25_1630"
  const [datePart, timePart] = fmt.split(', ');
  const timeNoColon = timePart.replace(':', '');
  return `${datePart}_${timeNoColon}_${ticker.toUpperCase()}_proof.mp4`;
}

// Middleware d'auth via Bearer token.
function requireWorkerAuth(req, res, next) {
  const expected = process.env.RENDER_WORKER_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'RENDER_WORKER_TOKEN not configured on bot' });
  }
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Helper : poste une vidéo dans le canal Discord configuré, retourne msg id.
async function postVideoToChannel(client, mp4Buffer, caption, filename) {
  const channelId = process.env.RENDER_OUTPUT_CHANNEL_ID;
  if (!channelId) throw new Error('RENDER_OUTPUT_CHANNEL_ID not set');
  const channel = await client.channels.fetch(channelId);
  const sent = await channel.send({
    content: caption,
    files: [{ attachment: mp4Buffer, name: filename }],
  });
  return sent.id;
}

function registerRenderQueueRoutes(app, discordClient) {
  // GET /api/render-queue — liste les jobs pending
  app.get('/api/render-queue', requireWorkerAuth, (req, res) => {
    try {
      const rows = getPendingRenderJobs(10);
      res.json({ jobs: rows.map(jobToApiShape) });
    } catch (err) {
      console.error('[render-queue] GET error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/render-queue/:id/done
  // Soit multipart avec file `mp4` + field `caption` (succès),
  // Soit JSON avec `{ error: "..." }` (échec côté worker).
  app.post('/api/render-queue/:id/done', requireWorkerAuth, upload.single('mp4'), async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId) return res.status(400).json({ error: 'Invalid job id' });

    // Cas échec : body JSON `{ error }`
    if (req.body && req.body.error && !req.file) {
      markRenderJobFailed(jobId, req.body.error);
      return res.json({ status: 'failed', error: req.body.error });
    }

    // Cas succès : multipart avec mp4
    if (!req.file) {
      return res.status(400).json({ error: 'Missing mp4 file or error field' });
    }
    const caption = req.body.caption || `Proof video #${jobId}`;
    const filename = buildVideoFilename(
      req.body.ticker || 'PROOF',
      req.body.exitTs || new Date().toISOString()
    );

    try {
      const msgId = await postVideoToChannel(discordClient, req.file.buffer, caption, filename);
      markRenderJobDone(jobId, msgId);
      res.json({ status: 'done', discord_msg_id: msgId });
    } catch (err) {
      console.error('[render-queue] Discord upload failed:', err);
      markRenderJobFailed(jobId, 'Discord upload: ' + err.message);
      res.status(500).json({ status: 'failed', error: err.message });
    }
  });
}

module.exports = {
  registerRenderQueueRoutes,
  jobToApiShape,
  buildVideoFilename,
};
