// ─────────────────────────────────────────────────────────────────────
// editor/server.js — Backend du Boom Studio editor
// ─────────────────────────────────────────────────────────────────────
// Lance via : npm run editor (depuis video/)
// Sert l'UI sur http://localhost:3001 + API REST pour :
//   GET  /api/templates        → liste tous les templates
//   GET  /api/template/:id     → contenu d'un template (.json)
//   POST /api/template/:id     → sauvegarde un template (.json)
//   POST /api/render           → spawn remotion render en background,
//                                stream les logs via SSE
//   GET  /api/still            → render une still frame en PNG, retourne
//                                une data URL (preview rapide)
//   GET  /out/<filename>       → sert les MP4 rendus
// ─────────────────────────────────────────────────────────────────────

// Load env vars depuis video/.env.local (gitignored) si présent.
// Permet au user de stocker ANTHROPIC_API_KEY persistent sans avoir à
// l'exporter à chaque session PowerShell.
// override: true car dotenv 17.x ne remplace pas par défaut les vars
// déjà en process.env (même si vides).
require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env.local'),
  override: true,
  quiet: true,
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { generateImage, generateProofImage } = require('../../canvas/proof');

// Anthropic SDK : optionnel — on charge à la demande pour ne pas crasher
// le serveur si la clé n'est pas configurée.
let _anthropicClient = null;
function getAnthropicClient() {
  if (_anthropicClient) return _anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropicClient = new Anthropic.default({ apiKey });
  return _anthropicClient;
}

const VIDEO_DIR = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(VIDEO_DIR, 'templates');
const OUT_DIR = path.join(VIDEO_DIR, 'out');
const PORT = process.env.EDITOR_PORT || 3001;

// ─────────────────────────────────────────────────────────────────────
// enrichPropsWithCanvasImage — génère l'image canvas Discord depuis les
// props author/message/timestamp et l'injecte comme data URL.
// Évite que le preview/render utilise le static fallback (TSLA default).
// ─────────────────────────────────────────────────────────────────────
async function enrichPropsWithCanvasImage(composition, props) {
  const enriched = { ...props };
  try {
    if (composition === 'BoomEntry' && !enriched.entryImageDataUrl) {
      if (enriched.author && enriched.message && enriched.timestamp) {
        const buf = await generateImage(enriched.author, enriched.message, enriched.timestamp, { scale: 2 });
        enriched.entryImageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      }
    } else if (composition === 'BoomProof' && !enriched.proofImageDataUrl) {
      if (enriched.entryAuthor && enriched.entryMessage && enriched.entryTimestamp
          && enriched.exitAuthor && enriched.exitMessage && enriched.exitTimestamp) {
        const buf = await generateProofImage(
          enriched.entryAuthor, enriched.entryMessage, enriched.entryTimestamp,
          enriched.exitAuthor, enriched.exitMessage, enriched.exitTimestamp,
          { scale: 2 }
        );
        enriched.proofImageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      }
    }
  } catch (err) {
    console.warn('[editor] canvas image generation failed:', err.message);
  }
  return enriched;
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname)); // sert index.html, style.css, app.js
app.use('/out', express.static(OUT_DIR));

// ── GET /api/templates ──────────────────────────────────────────────
app.get('/api/templates', (_req, res) => {
  try {
    const files = fs.readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
    const templates = files.map(f => {
      const id = f.replace(/\.json$/, '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
        return {
          id,
          name: data.name || id,
          composition: data.composition || '?',
          description: data.description || '',
        };
      } catch (e) {
        return { id, name: id, composition: '?', description: 'invalid JSON', error: true };
      }
    });
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/template/:id ────────────────────────────────────────────
app.get('/api/template/:id', (req, res) => {
  const id = sanitizeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const filepath = path.join(TEMPLATES_DIR, id + '.json');
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/template/:id ────────────────────────────────────────────
app.post('/api/template/:id', (req, res) => {
  const id = sanitizeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id (alphanumeric + dashes only)' });
  const body = req.body;
  if (!body || !body.composition || !body.props) {
    return res.status(400).json({ error: 'Missing composition or props' });
  }
  const filepath = path.join(TEMPLATES_DIR, id + '.json');
  fs.writeFileSync(filepath, JSON.stringify(body, null, 2) + '\n');
  res.json({ ok: true, path: filepath });
});

// ── POST /api/render ──────────────────────────────────────────────────
// Body: { composition: 'BoomEntry', props: {...}, outFilename?: 'foo.mp4' }
// Retourne un job id immédiatement, le stream de logs est sur /api/render-stream/:jobId
const renderJobs = new Map(); // jobId → { logs: [], done: bool, exitCode, outPath }

app.post('/api/render', async (req, res) => {
  const { composition, props, outFilename } = req.body;
  if (!composition) return res.status(400).json({ error: 'Missing composition' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const filename = outFilename || `editor-${jobId}.mp4`;
  const outPath = path.join(OUT_DIR, filename);

  // Génère l'image canvas Discord à partir du message/author/timestamp
  // si pas déjà fournie via entryImageDataUrl/proofImageDataUrl.
  const enriched = await enrichPropsWithCanvasImage(composition, props || {});

  // Écrit les props dans un fichier temp (plus robuste que CLI string).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpPropsPath = path.join(OUT_DIR, `.tmp-editor-${jobId}.json`);
  fs.writeFileSync(tmpPropsPath, JSON.stringify(enriched));

  const job = { logs: [], done: false, exitCode: null, outPath, filename };
  renderJobs.set(jobId, job);

  const child = spawn(
    'npx',
    ['remotion', 'render', composition, outPath, `--props=${tmpPropsPath}`],
    { cwd: VIDEO_DIR, shell: true }
  );

  const onData = (data) => {
    const text = data.toString();
    job.logs.push(text);
    // Cap logs to last 200 entries to avoid memory bloat
    if (job.logs.length > 200) job.logs.shift();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', (code) => {
    job.done = true;
    job.exitCode = code;
    try { fs.unlinkSync(tmpPropsPath); } catch (_) {}
  });

  res.json({ jobId, filename });
});

// ── GET /api/render-stream/:jobId ────────────────────────────────────
// Server-Sent Events stream des logs + status final.
app.get('/api/render-stream/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = renderJobs.get(jobId);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let cursor = 0;
  const interval = setInterval(() => {
    while (cursor < job.logs.length) {
      res.write(`data: ${JSON.stringify({ log: job.logs[cursor] })}\n\n`);
      cursor++;
    }
    if (job.done) {
      res.write(`data: ${JSON.stringify({ done: true, exitCode: job.exitCode, filename: job.filename })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 200);

  req.on('close', () => clearInterval(interval));
});

// ── GET /api/still ───────────────────────────────────────────────────
// Query: composition, frame, props (JSON string in query)
// Retourne le PNG en base64 data URL (rapide vs full render).
app.get('/api/still', async (req, res) => {
  const { composition, frame } = req.query;
  if (!composition) return res.status(400).json({ error: 'Missing composition' });

  const propsRaw = req.query.props || '{}';
  let props;
  try { props = JSON.parse(propsRaw); }
  catch (e) { return res.status(400).json({ error: 'Invalid props JSON: ' + e.message }); }

  // Génère l'image canvas Discord à partir des props (auteur/message/timestamp).
  const enriched = await enrichPropsWithCanvasImage(composition, props);

  const jobId = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpPropsPath = path.join(OUT_DIR, `.tmp-still-${jobId}.json`);
  const outPath = path.join(OUT_DIR, `.tmp-still-${jobId}.png`);
  fs.writeFileSync(tmpPropsPath, JSON.stringify(enriched));

  const args = ['remotion', 'still', composition, outPath, `--frame=${frame || 0}`, `--props=${tmpPropsPath}`];
  const result = spawnSync('npx', args, { cwd: VIDEO_DIR, shell: true });

  try { fs.unlinkSync(tmpPropsPath); } catch (_) {}

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : 'unknown error';
    try { fs.unlinkSync(outPath); } catch (_) {}
    return res.status(500).json({ error: 'still render failed', stderr: stderr.slice(-500) });
  }

  try {
    const buf = fs.readFileSync(outPath);
    res.json({ dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
    fs.unlinkSync(outPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ai/suggest ──────────────────────────────────────────────
// Body: { field: 'stingerText', currentValue: '🚨 LIVE', context: { ... },
//         count?: 5 }
// Retourne : { suggestions: ['...', '...', '...'] }
// Utilise Claude Haiku pour rapidité + coût bas (~$0.001 par appel).
app.post('/api/ai/suggest', async (req, res) => {
  const client = getAnthropicClient();
  if (!client) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY non configurée. Set la variable d\'env et restart le server.',
    });
  }

  const { field, currentValue, context, count } = req.body;
  if (!field) return res.status(400).json({ error: 'Missing field name' });

  const N = Math.min(Math.max(count || 5, 1), 8);
  const ctx = context || {};

  // Description du champ pour orienter l'IA.
  const FIELD_DESCRIPTIONS = {
    stingerText: 'le flash d\'ouverture (très court, 1-2 mots, accrocheur, type "🚨 LIVE", "BREAKING", "ALPHA")',
    teaseAction: 'le verbe d\'action après le pseudo de l\'analyste, format court genre "just called this.", "is going long.", "spotted alpha." (3-5 mots max, avec point final)',
    teaseSubtext: 'le sous-texte du tease, format CTA mini-court genre "Watch live →", "Don\'t miss this →", "Premium signal →" (3-5 mots max)',
    cardLabel: 'le label rouge au-dessus de la card Discord, format ALL CAPS court genre "🚨 LIVE SIGNAL", "ENTRY", "ALPHA CALL" (1-3 mots max)',
    ctaTitle: 'le titre énorme du CTA final, format ALL CAPS punchy 1 mot genre "JOIN", "FOLLOW", "ENTER", "JUMP IN", "CLAIM"',
    ctaUrl: 'l\'URL ou handle, format domaine genre "discord.gg/boom", "x.com/boomtrade" (NE PAS suggérer de variations, garder vide)',
    ctaSubtitle: 'le sous-titre du CTA, format short call-to-action genre "Get every signal live", "Trade alongside us", "Curated alpha for serious traders" (4-7 mots)',
  };

  const fieldDesc = FIELD_DESCRIPTIONS[field] || 'un champ texte de la vidéo marketing';

  // Si ctaUrl, refuse — on ne veut pas que l'IA invente des URLs.
  if (field === 'ctaUrl') {
    return res.json({ suggestions: ['discord.gg/boom', 'discord.gg/templeofboom'] });
  }

  const systemPrompt = `Tu aides à générer du texte court pour une vidéo de marketing trading qui annonce un signal live ou une exit gagnante. Le brand est "Boom" / "Temple of Boom" (Discord trading signals). Le style : punchy, direct, énergie urgence (signaux live) ou célébration (exits). Cible audience traders TikTok/Reels.

Tu vas suggérer ${N} variations courtes pour ${fieldDesc}.

Tu DOIS répondre en JSON pur (sans markdown fence, sans préambule), format :
{"suggestions":["v1","v2","v3"]}

Chaque suggestion doit être PRÊTE À UTILISER (pas de quotes externes, pas de descriptions). Sois créatif mais reste cohérent avec le contexte.`;

  const userPrompt = `Contexte du template :
- Composition : ${ctx.composition || 'BoomEntry'}
- Ticker : ${ctx.ticker || '?'}
- Auteur signal : ${ctx.author || ctx.entryAuthor || '?'}
- Couleur d'accent : ${ctx.accentColor || '#ef4444'} (${getColorMood(ctx.accentColor)})
- Valeur actuelle du champ "${field}" : ${currentValue ? `"${currentValue}"` : 'vide'}

Suggère ${N} variations courtes pour le champ "${field}".`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    let text = msg.content.map(c => c.type === 'text' ? c.text : '').join('').trim();
    // Strip markdown fence si Claude en a ajouté un (```json ... ```).
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return res.status(500).json({ error: 'AI response not valid JSON', raw: text.slice(0, 500) }); }
    if (!Array.isArray(parsed.suggestions)) {
      return res.status(500).json({ error: 'AI response missing suggestions array', raw: text.slice(0, 500) });
    }
    res.json({ suggestions: parsed.suggestions.slice(0, N) });
  } catch (err) {
    console.error('[ai] error:', err.message);
    res.status(500).json({ error: 'AI call failed: ' + err.message });
  }
});

// Helper: décrit le mood d'une couleur hex (rouge → urgence, vert → win, etc.)
function getColorMood(hex) {
  if (!hex) return 'neutre';
  const h = hex.toLowerCase();
  if (h.includes('ef4444') || h.startsWith('#e') || h.startsWith('#f')) return 'rouge intense / urgence / alarme';
  if (h.includes('10b981') || h.includes('22c55e')) return 'vert / win / gain';
  if (h.includes('fbbf24') || h.includes('eab308')) return 'doré / prestige / luxe';
  if (h.includes('3498db') || h.includes('06b6d4')) return 'bleu / calme / institutional';
  if (h.includes('a855f7') || h.includes('8b5cf6')) return 'violet / hype / Y2K';
  return 'neutre';
}

// ── Helper ─────────────────────────────────────────────────────────────
function sanitizeId(id) {
  if (!id || typeof id !== 'string') return null;
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  return id;
}

// ── Boot ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 Boom Editor: http://localhost:${PORT}\n`);
  console.log(`   Templates dir : ${TEMPLATES_DIR}`);
  console.log(`   Output dir    : ${OUT_DIR}\n`);
});
