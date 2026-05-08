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

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const VIDEO_DIR = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(VIDEO_DIR, 'templates');
const OUT_DIR = path.join(VIDEO_DIR, 'out');
const PORT = process.env.EDITOR_PORT || 3001;

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

app.post('/api/render', (req, res) => {
  const { composition, props, outFilename } = req.body;
  if (!composition) return res.status(400).json({ error: 'Missing composition' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const filename = outFilename || `editor-${jobId}.mp4`;
  const outPath = path.join(OUT_DIR, filename);

  // Écrit les props dans un fichier temp (plus robuste que CLI string).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpPropsPath = path.join(OUT_DIR, `.tmp-editor-${jobId}.json`);
  fs.writeFileSync(tmpPropsPath, JSON.stringify(props || {}));

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
app.get('/api/still', (req, res) => {
  const { composition, frame } = req.query;
  if (!composition) return res.status(400).json({ error: 'Missing composition' });

  const propsRaw = req.query.props || '{}';
  let props;
  try { props = JSON.parse(propsRaw); }
  catch (e) { return res.status(400).json({ error: 'Invalid props JSON: ' + e.message }); }

  const jobId = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpPropsPath = path.join(OUT_DIR, `.tmp-still-${jobId}.json`);
  const outPath = path.join(OUT_DIR, `.tmp-still-${jobId}.png`);
  fs.writeFileSync(tmpPropsPath, JSON.stringify(props));

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
