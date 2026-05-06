# Phase 3 — Auto-render des proof videos sur exit gagnant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quand le bot Discord détecte un exit gagnant (pnl positif) avec une entrée matchable, enqueue automatiquement un job de rendu vidéo. Un worker local (machine de l'utilisateur) poll, render via Remotion, et upload le MP4 vers un canal Discord dédié — sans toucher à la légèreté du container Railway.

**Architecture:** 3 composants — bot Railway (DB queue + endpoints HTTP + Discord upload), worker local long-running dans `video/scripts/render-worker.js` (poll + render + multipart upload), et un canal Discord dédié comme output. HTTP polling + Bearer auth. Trigger = exits gagnants matchés. Output = local file ET post Discord.

**Tech Stack:** Node.js, better-sqlite3 (DB), Express + multer (HTTP), discord.js (post Discord), @remotion/bundler + @remotion/renderer (côté worker, déjà dans video/).

---

## File Structure

Fichiers créés ou modifiés en Phase 3 :

```
discord-trading-bot/
├── package.json                         ← MODIFIÉ (ajout multer dep côté bot)
├── .env.example                         ← MODIFIÉ (3 nouvelles env vars)
├── utils/
│   ├── prices.js                        ← MODIFIÉ (ajout extractPnl)
│   └── prices.test.js                   ← MODIFIÉ (tests extractPnl)
├── db/
│   ├── sqlite.js                        ← MODIFIÉ (table + 4 helpers)
│   └── render-jobs.test.js              ← NEW (tests des 4 helpers)
├── routes/
│   ├── render-queue.js                  ← NEW (GET + POST endpoints)
│   └── render-queue.test.js             ← NEW (tests pure helpers)
├── discord/
│   ├── handler.js                       ← MODIFIÉ (hook enqueue)
│   └── handler.test.js                  ← MODIFIÉ (test hook)
├── index.js                             ← MODIFIÉ (register routes)
└── video/
    ├── package.json                     ← MODIFIÉ (script `worker`)
    └── scripts/
        ├── render-worker.js             ← NEW (long-running worker)
        └── render-worker.test.js        ← NEW (tests pure helpers)
```

Tests stratégie : pure helpers testés (extractPnl, DB helpers, jobPropsToRemotion, buildCaption). Routes Express testées via appels directs aux handlers (pas de supertest). Integration end-to-end manuelle.

---

### Task 1 : Util `extractPnl` dans `utils/prices.js`

**Files:**
- Modify: `utils/prices.js` (ajout d'une fonction)
- Modify: `utils/prices.test.js` (ajout de tests)

- [ ] **Step 1: Écrire les tests qui échouent**

Ouvre `utils/prices.test.js` et ajoute ce bloc à la fin du fichier (après les tests existants) :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { extractPnl } = require('./prices');

test('extractPnl returns positive pnl from "+20%"', () => {
  assert.strictEqual(extractPnl('$TSLA out +20%'), '+20%');
});

test('extractPnl returns negative pnl from "-5%"', () => {
  assert.strictEqual(extractPnl('$AAPL out -5%'), '-5%');
});

test('extractPnl handles decimal pnl "+12.5%"', () => {
  assert.strictEqual(extractPnl('$NVDA out +12.5%'), '+12.5%');
});

test('extractPnl returns null when no pnl present', () => {
  assert.strictEqual(extractPnl('$TSLA 150 entry long'), null);
});

test('extractPnl returns null for empty string', () => {
  assert.strictEqual(extractPnl(''), null);
});

test('extractPnl returns null for null/undefined', () => {
  assert.strictEqual(extractPnl(null), null);
  assert.strictEqual(extractPnl(undefined), null);
});

test('extractPnl picks first match if multiple', () => {
  assert.strictEqual(extractPnl('out +10% target was +15%'), '+10%');
});

test('extractPnl ignores plain numbers without %', () => {
  assert.strictEqual(extractPnl('$TSLA 150 entry'), null);
});
```

Note : si `utils/prices.test.js` n'existe pas encore, crée-le avec le même header que les autres test files (`require('node:test')` etc).

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `node --test utils/prices.test.js`

Expected: les 8 tests échouent avec `extractPnl is not a function`.

- [ ] **Step 3: Implémenter `extractPnl`**

Ouvre `utils/prices.js`. Ajoute cette fonction après les fonctions existantes (avant `module.exports`) :

```js
// Extrait un pnl explicite (+X% ou -X%) du contenu d'un message.
// Retourne la première match trouvée, ou null si aucune.
// Exemples :
//   "$TSLA out +20%"       → "+20%"
//   "$AAPL out -5%"        → "-5%"
//   "$NVDA out +12.5%"     → "+12.5%"
//   "$TSLA 150 entry long" → null
function extractPnl(content) {
  if (!content || typeof content !== 'string') return null;
  const match = content.match(/[+-]\d+(\.\d+)?%/);
  return match ? match[0] : null;
}
```

Et ajoute `extractPnl` à l'export `module.exports = {...}` à la fin du fichier.

- [ ] **Step 4: Relancer les tests pour vérifier qu'ils passent**

Run: `node --test utils/prices.test.js`

Expected: les 8 nouveaux tests passent.

- [ ] **Step 5: Lancer toute la suite pour pas de régression**

Run: `npm test`

Expected: tous les tests existants passent, plus les 8 nouveaux.

- [ ] **Step 6: Commit**

```bash
git add utils/prices.js utils/prices.test.js
git commit -m "feat(utils): extractPnl pour parser '+X%' / '-X%' depuis messages

Utilisé par Phase 3 pour décider si un exit déclenche un job de
render vidéo (uniquement si pnl positif). Regex /[+-]\d+(\.\d+)?%/
match le premier signed-percentage du contenu."
```

---

### Task 2 : Table `render_jobs` + 4 helpers dans `db/sqlite.js`

**Files:**
- Modify: `db/sqlite.js` (ajout table + helpers + statements)
- Create: `db/render-jobs.test.js` (tests des 4 helpers)

- [ ] **Step 1: Écrire les tests qui échouent**

Crée `db/render-jobs.test.js` :

```js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the DB for tests by pointing DATA_DIR elsewhere
// before we require anything that touches db/sqlite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-jobs-test-'));
process.env.DATA_DIR = tmpDir;

const {
  enqueueRenderJob,
  getPendingRenderJobs,
  markRenderJobDone,
  markRenderJobFailed,
} = require('./sqlite');

const samplePayload = {
  ticker: 'TSLA',
  entry_author: 'Z',
  entry_message: '$TSLA 150 entry long',
  entry_ts: '2026-04-25T13:32:00-04:00',
  exit_author: 'Z',
  exit_message: '$TSLA out +20%',
  exit_ts: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
};

test('enqueueRenderJob inserts a row and returns its id', () => {
  const id = enqueueRenderJob(samplePayload);
  assert.ok(typeof id === 'number' && id > 0, 'expected positive numeric id');
});

test('getPendingRenderJobs returns enqueued jobs', () => {
  enqueueRenderJob({ ...samplePayload, ticker: 'NVDA' });
  const pending = getPendingRenderJobs();
  assert.ok(pending.length >= 1);
  const last = pending.find(j => j.ticker === 'NVDA');
  assert.ok(last);
  assert.strictEqual(last.entry_author, 'Z');
  assert.strictEqual(last.status, 'pending');
});

test('markRenderJobDone updates status and discord_msg_id', () => {
  const id = enqueueRenderJob({ ...samplePayload, ticker: 'AMD' });
  markRenderJobDone(id, 'discord_msg_xyz');
  const pending = getPendingRenderJobs();
  assert.ok(!pending.find(j => j.id === id), 'expected job to be removed from pending list');
});

test('markRenderJobFailed updates status and error', () => {
  const id = enqueueRenderJob({ ...samplePayload, ticker: 'AAPL' });
  markRenderJobFailed(id, 'Render timeout');
  const pending = getPendingRenderJobs();
  assert.ok(!pending.find(j => j.id === id));
});

test('getPendingRenderJobs respects limit param', () => {
  for (let i = 0; i < 15; i++) {
    enqueueRenderJob({ ...samplePayload, ticker: 'BULK' + i });
  }
  const limited = getPendingRenderJobs(5);
  assert.ok(limited.length <= 5);
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `node --test db/render-jobs.test.js`

Expected: tous les tests échouent avec `enqueueRenderJob is not a function` (les 4 helpers ne sont pas encore exportés).

- [ ] **Step 3: Ajouter la table CREATE TABLE dans `db/sqlite.js`**

Ouvre `db/sqlite.js`. Cherche les autres `CREATE TABLE` (par exemple `CREATE TABLE IF NOT EXISTS messages...`). Après le dernier CREATE TABLE existant (et avant les `db.prepare(...)` statements), ajoute :

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS render_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT NOT NULL,
    entry_author    TEXT NOT NULL,
    entry_message   TEXT NOT NULL,
    entry_ts        TEXT NOT NULL,
    exit_author     TEXT NOT NULL,
    exit_message    TEXT NOT NULL,
    exit_ts         TEXT NOT NULL,
    pnl             TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    done_at         TEXT,
    error           TEXT,
    discord_msg_id  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status, created_at);
`);
```

- [ ] **Step 4: Ajouter les prepared statements**

Dans la même section où sont les autres `db.prepare(...)`, ajoute :

```js
const stmtEnqueueRenderJob = db.prepare(`
  INSERT INTO render_jobs
    (ticker, entry_author, entry_message, entry_ts,
     exit_author, exit_message, exit_ts, pnl)
  VALUES
    (@ticker, @entry_author, @entry_message, @entry_ts,
     @exit_author, @exit_message, @exit_ts, @pnl)
`);

const stmtGetPendingRenderJobs = db.prepare(`
  SELECT id, ticker, entry_author, entry_message, entry_ts,
         exit_author, exit_message, exit_ts, pnl, status, created_at
  FROM render_jobs
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT ?
`);

const stmtMarkRenderJobDone = db.prepare(`
  UPDATE render_jobs
  SET status = 'done', done_at = datetime('now'), discord_msg_id = ?
  WHERE id = ?
`);

const stmtMarkRenderJobFailed = db.prepare(`
  UPDATE render_jobs
  SET status = 'failed', done_at = datetime('now'), error = ?
  WHERE id = ?
`);
```

- [ ] **Step 5: Ajouter les 4 fonctions helpers**

Toujours dans `db/sqlite.js`, dans la section des autres helpers (avant `module.exports`), ajoute :

```js
function enqueueRenderJob(payload) {
  const result = stmtEnqueueRenderJob.run(payload);
  return result.lastInsertRowid;
}

function getPendingRenderJobs(limit = 10) {
  return stmtGetPendingRenderJobs.all(limit);
}

function markRenderJobDone(id, discordMsgId) {
  stmtMarkRenderJobDone.run(discordMsgId || null, id);
}

function markRenderJobFailed(id, errorMessage) {
  stmtMarkRenderJobFailed.run(errorMessage || 'unknown error', id);
}
```

- [ ] **Step 6: Exporter les helpers**

Dans le `module.exports = {...}` à la fin de `db/sqlite.js`, ajoute les 4 noms :

```js
module.exports = {
  // ... existing exports
  enqueueRenderJob,
  getPendingRenderJobs,
  markRenderJobDone,
  markRenderJobFailed,
};
```

- [ ] **Step 7: Relancer les tests**

Run: `node --test db/render-jobs.test.js`

Expected: 5/5 tests passent.

- [ ] **Step 8: Lancer toute la suite**

Run: `npm test`

Expected: tous les tests existants passent + nouveaux. Le compte total monte de 5.

- [ ] **Step 9: Commit**

```bash
git add db/sqlite.js db/render-jobs.test.js
git commit -m "feat(db): table render_jobs + 4 helpers (enqueue, getPending, markDone, markFailed)

Phase 3 utilise cette table pour la queue de rendu vidéo. Index sur
(status, created_at) pour le polling efficace côté worker."
```

---

### Task 3 : Endpoints HTTP `routes/render-queue.js` + multer + register

**Files:**
- Modify: `package.json` (ajout multer dep)
- Create: `routes/render-queue.js`
- Create: `routes/render-queue.test.js`
- Modify: `index.js` (register le module)

- [ ] **Step 1: Ajouter `multer` aux dépendances**

```bash
npm install multer
```

Vérifie que `package.json` a maintenant `"multer": "..."` dans `dependencies`.

- [ ] **Step 2: Écrire les tests des helpers purs**

Crée `routes/render-queue.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');

const { jobToApiShape, buildVideoFilename } = require('./render-queue');

test('jobToApiShape converts snake_case DB row to camelCase API payload', () => {
  const dbRow = {
    id: 42,
    ticker: 'TSLA',
    entry_author: 'Z',
    entry_message: '$TSLA 150 entry long',
    entry_ts: '2026-04-25T13:32:00-04:00',
    exit_author: 'Z',
    exit_message: '$TSLA out +20%',
    exit_ts: '2026-04-25T16:30:00-04:00',
    pnl: '+20%',
  };
  const api = jobToApiShape(dbRow);
  assert.strictEqual(api.id, 42);
  assert.strictEqual(api.ticker, 'TSLA');
  assert.strictEqual(api.entryAuthor, 'Z');
  assert.strictEqual(api.entryMessage, '$TSLA 150 entry long');
  assert.strictEqual(api.entryTimestamp, '2026-04-25T13:32:00-04:00');
  assert.strictEqual(api.exitAuthor, 'Z');
  assert.strictEqual(api.exitMessage, '$TSLA out +20%');
  assert.strictEqual(api.exitTimestamp, '2026-04-25T16:30:00-04:00');
  assert.strictEqual(api.pnl, '+20%');
  // No leaked DB-only fields
  assert.strictEqual(api.entry_author, undefined);
  assert.strictEqual(api.status, undefined);
});

test('buildVideoFilename produces YYYY-MM-DD_HHMM_TICKER_proof.mp4', () => {
  const filename = buildVideoFilename('TSLA', '2026-04-25T16:30:00-04:00');
  // exit_ts is in NY tz (-04:00). 16:30 NY = 20:30 UTC. The function uses NY tz formatting.
  assert.match(filename, /^2026-04-25_\d{4}_TSLA_proof\.mp4$/);
});

test('buildVideoFilename uppercases ticker', () => {
  const filename = buildVideoFilename('tsla', '2026-04-25T16:30:00-04:00');
  assert.match(filename, /TSLA_proof\.mp4$/);
});
```

- [ ] **Step 3: Lancer les tests, vérifier qu'ils échouent**

Run: `node --test routes/render-queue.test.js`

Expected: échec — `jobToApiShape is not a function`, `buildVideoFilename is not a function`, ou import error.

- [ ] **Step 4: Créer `routes/render-queue.js`**

Crée `routes/render-queue.js` avec ce contenu :

```js
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
```

- [ ] **Step 5: Register le module dans `index.js`**

Ouvre `index.js`. Trouve où les autres routes sont enregistrées (par exemple `registerImageRoutes(app, ...)`). Après la dernière `register*Routes(...)` call, ajoute :

```js
const { registerRenderQueueRoutes } = require('./routes/render-queue');
registerRenderQueueRoutes(app, client);
```

(`client` ici est le Discord client déjà initialisé plus haut dans `index.js`. Vérifie son nom de variable.)

- [ ] **Step 6: Relancer les tests**

Run: `node --test routes/render-queue.test.js`

Expected: 3/3 tests passent.

Run: `npm test`

Expected: toute la suite passe.

- [ ] **Step 7: Vérifier le boot du bot (smoke test)**

Run: `node -e "require('./routes/render-queue')"`

Expected: aucune erreur (le module charge proprement).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json routes/render-queue.js routes/render-queue.test.js index.js
git commit -m "feat(routes): /api/render-queue endpoints + Discord upload helper

GET liste les jobs pending (Bearer auth via RENDER_WORKER_TOKEN).
POST /done accepte soit un mp4 multipart (succès → bot post Discord
via RENDER_OUTPUT_CHANNEL_ID, marque done) soit un body JSON avec
error (échec côté worker → marque failed).

Helpers purs (jobToApiShape, buildVideoFilename) testés. Routes
testées manuellement via E2E."
```

---

### Task 4 : Hook dans `discord/handler.js` pour enqueue sur exit gagnant

**Files:**
- Modify: `discord/handler.js`
- Modify: `discord/handler.test.js`

- [ ] **Step 1: Lire le code existant pour identifier où enqueue**

Open `discord/handler.js` et localise la section qui traite les exits (autour de `filterType === 'exit'` et `findOriginalAlert(...)`). Tu dois identifier la variable qui contient le résultat de `findOriginalAlert` (probablement `originalAlert`), la variable de la classification (`filterType`), et les variables de l'auteur/contenu/timestamp courants.

- [ ] **Step 2: Écrire le test qui échoue**

Ouvre `discord/handler.test.js`. Ajoute (au choix : à la fin du fichier ou dans une nouvelle suite) :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// DB isolation
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-render-test-'));
process.env.DATA_DIR = tmpDir;

const { getPendingRenderJobs } = require('../db/sqlite');
const { maybeEnqueueProofRender } = require('./handler');

test('maybeEnqueueProofRender enqueues job on winning exit with valid entry', () => {
  const before = getPendingRenderJobs().length;
  maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'TSLA',
    pnl: '+20%',
    originalAlert: {
      author: 'Z',
      content: '$TSLA 150 entry long',
      ts: '2026-04-25T13:32:00-04:00',
    },
    authorName: 'Z',
    content: '$TSLA out +20%',
    messageCreatedAt: new Date('2026-04-25T16:30:00-04:00'),
  });
  const after = getPendingRenderJobs();
  assert.strictEqual(after.length, before + 1);
  const job = after[after.length - 1];
  assert.strictEqual(job.ticker, 'TSLA');
  assert.strictEqual(job.pnl, '+20%');
});

test('maybeEnqueueProofRender skips losing exit', () => {
  const before = getPendingRenderJobs().length;
  maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'AAPL',
    pnl: '-5%',
    originalAlert: { author: 'Z', content: '...', ts: '2026-04-25T13:00:00-04:00' },
    authorName: 'Z',
    content: '$AAPL out -5%',
    messageCreatedAt: new Date('2026-04-25T15:00:00-04:00'),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});

test('maybeEnqueueProofRender skips when no originalAlert', () => {
  const before = getPendingRenderJobs().length;
  maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'NVDA',
    pnl: '+10%',
    originalAlert: null,
    authorName: 'Bora',
    content: '$NVDA out +10%',
    messageCreatedAt: new Date(),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});

test('maybeEnqueueProofRender skips when originalAlert.ts is null (reply case)', () => {
  const before = getPendingRenderJobs().length;
  maybeEnqueueProofRender({
    filterType: 'exit',
    signalTicker: 'AMD',
    pnl: '+15%',
    originalAlert: { author: 'Viking', content: '...', ts: null },
    authorName: 'Viking',
    content: '$AMD out +15%',
    messageCreatedAt: new Date(),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});

test('maybeEnqueueProofRender skips entry signals (filterType=entry)', () => {
  const before = getPendingRenderJobs().length;
  maybeEnqueueProofRender({
    filterType: 'entry',
    signalTicker: 'TSLA',
    pnl: null,
    originalAlert: null,
    authorName: 'Z',
    content: '$TSLA 150 entry long',
    messageCreatedAt: new Date(),
  });
  assert.strictEqual(getPendingRenderJobs().length, before);
});
```

- [ ] **Step 3: Lancer le test, vérifier qu'il échoue**

Run: `node --test discord/handler.test.js`

Expected: échec — `maybeEnqueueProofRender is not a function`.

- [ ] **Step 4: Implémenter `maybeEnqueueProofRender` dans `discord/handler.js`**

Ouvre `discord/handler.js`. Au sommet du fichier (avec les autres requires), ajoute :

```js
const { enqueueRenderJob } = require('../db/sqlite');
```

Ensuite, dans le fichier (avant le module.exports), ajoute la fonction :

```js
// Phase 3 — quand un exit gagnant arrive avec une entrée matchable,
// enqueue un job pour que le worker local rende la proof video.
function maybeEnqueueProofRender({
  filterType, signalTicker, pnl, originalAlert,
  authorName, content, messageCreatedAt,
}) {
  if (filterType !== 'exit') return;
  if (!originalAlert) return;
  if (!originalAlert.ts) return;        // skip replies sans parent ts
  if (!pnl || pnl.startsWith('-')) return;  // pnl manquant ou négatif

  try {
    enqueueRenderJob({
      ticker: signalTicker,
      entry_author: originalAlert.author,
      entry_message: originalAlert.content,
      entry_ts: originalAlert.ts,
      exit_author: authorName,
      exit_message: content,
      exit_ts: messageCreatedAt.toISOString(),
      pnl,
    });
  } catch (err) {
    console.error('[render-queue] enqueue failed:', err.message);
  }
}
```

Et exporte-la :

```js
module.exports = {
  // ... existing exports
  maybeEnqueueProofRender,
};
```

- [ ] **Step 5: Brancher l'appel dans le flux principal du handler**

Dans la fonction `messageCreate` du handler (ou la fonction principale qui process les messages), localise la section où `originalAlert` et `pnl` sont disponibles ensemble (généralement après `findOriginalAlert(...)` et avant le POST Make.com). Ajoute :

```js
maybeEnqueueProofRender({
  filterType,
  signalTicker,
  pnl,
  originalAlert,
  authorName: message.author.username,
  content,
  messageCreatedAt: message.createdAt,
});
```

Adapte les noms de variables au code existant (par exemple `filterType` peut s'appeler `signal.type` selon le contexte). L'idée : appeler la fonction avec les valeurs disponibles à ce moment.

- [ ] **Step 6: Relancer les tests**

Run: `node --test discord/handler.test.js`

Expected: les 5 tests passent.

Run: `npm test`

Expected: toute la suite passe.

- [ ] **Step 7: Commit**

```bash
git add discord/handler.js discord/handler.test.js
git commit -m "feat(handler): hook enqueue render job sur exit gagnant matchable

maybeEnqueueProofRender filtre filterType==='exit' + pnl positif +
originalAlert.ts non-null. Si toutes les conditions OK, insère une
ligne dans render_jobs (status='pending'). Le worker local poll et
traite. Pas de throughput côté handler — l'INSERT est synchronous
mais quasi-instantané."
```

---

### Task 5 : Worker `video/scripts/render-worker.js` + npm script

**Files:**
- Modify: `video/package.json` (ajout `worker` script)
- Create: `video/scripts/render-worker.js`
- Create: `video/scripts/render-worker.test.ts`

- [ ] **Step 1: Écrire les tests des helpers purs**

Crée `video/scripts/render-worker.test.ts` :

```ts
import { describe, expect, test } from 'vitest';
import { jobPropsToRemotion, buildCaption, formatTimeNY } from './render-worker';

const sampleJob = {
  id: 42,
  ticker: 'TSLA',
  entryAuthor: 'Z',
  entryMessage: '$TSLA 150 entry long',
  entryTimestamp: '2026-04-25T13:32:00-04:00',
  exitAuthor: 'Z',
  exitMessage: '$TSLA out +20%',
  exitTimestamp: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
};

describe('jobPropsToRemotion', () => {
  test('passes all 8 fields through', () => {
    const props = jobPropsToRemotion(sampleJob);
    expect(props.ticker).toBe('TSLA');
    expect(props.entryAuthor).toBe('Z');
    expect(props.entryMessage).toBe('$TSLA 150 entry long');
    expect(props.entryTimestamp).toBe('2026-04-25T13:32:00-04:00');
    expect(props.exitAuthor).toBe('Z');
    expect(props.exitMessage).toBe('$TSLA out +20%');
    expect(props.exitTimestamp).toBe('2026-04-25T16:30:00-04:00');
    expect(props.pnl).toBe('+20%');
  });

  test('does not include id', () => {
    const props = jobPropsToRemotion(sampleJob) as Record<string, unknown>;
    expect(props.id).toBeUndefined();
  });
});

describe('buildCaption', () => {
  test('formats with ticker, author, pnl, and time range', () => {
    const cap = buildCaption(sampleJob);
    expect(cap).toContain('$TSLA');
    expect(cap).toContain('Z');
    expect(cap).toContain('+20%');
    expect(cap).toContain('proof video');
    expect(cap).toContain('Entry');
    expect(cap).toContain('Exit');
  });
});

describe('formatTimeNY', () => {
  test('returns NY 24h time from ISO string', () => {
    // 2026-04-25T13:32:00-04:00 = 13:32 NY
    const t = formatTimeNY('2026-04-25T13:32:00-04:00');
    expect(t).toBe('13:32');
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `cd video && npm test`

Expected: nouveaux tests fail (les fonctions `jobPropsToRemotion`, `buildCaption`, `formatTimeNY` n'existent pas encore). Les tests existants (4 + 3 = 7 ou 8) passent toujours.

- [ ] **Step 3: Créer le worker script**

Crée `video/scripts/render-worker.ts` avec ce contenu :

```ts
// ─────────────────────────────────────────────────────────────────────
// video/scripts/render-worker.ts — Long-running worker pour Phase 3
// ─────────────────────────────────────────────────────────────────────
// Poll le bot (GET /api/render-queue), render chaque job via Remotion
// (renderMedia programmatique), POST le MP4 multipart au bot pour
// upload Discord (POST /api/render-queue/:id/done).
//
// Lance avec : cd video && npm run worker
// Env vars requises : BOT_URL, RENDER_WORKER_TOKEN
// ─────────────────────────────────────────────────────────────────────

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Job tel que renvoyé par le bot (camelCase déjà fait par jobToApiShape).
export type RenderJob = {
  id: number;
  ticker: string;
  entryAuthor: string;
  entryMessage: string;
  entryTimestamp: string;
  exitAuthor: string;
  exitMessage: string;
  exitTimestamp: string;
  pnl: string;
};

// Props passées à la composition SignalAlertProof (sans le id côté DB).
export function jobPropsToRemotion(job: RenderJob) {
  const { id: _id, ...props } = job;
  return props;
}

// Format heure NY 24h "HH:MM" depuis ISO timestamp.
export function formatTimeNY(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}

// Caption Discord (multi-line). Exemple :
//   📈 $TSLA · Z · +20% — proof video
//   Entry 13:32 · Exit 16:30
export function buildCaption(job: RenderJob): string {
  return [
    `📈 $${job.ticker} · ${job.entryAuthor} · ${job.pnl} — proof video`,
    `Entry ${formatTimeNY(job.entryTimestamp)} · Exit ${formatTimeNY(job.exitTimestamp)}`,
  ].join('\n');
}

// Filename : YYYY-MM-DD_HHMM_TICKER_proof.mp4 (NY tz).
function buildLocalFilename(job: RenderJob): string {
  const d = new Date(job.exitTimestamp);
  const fmt = d.toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [datePart, timePart] = fmt.split(', ');
  const timeNoColon = timePart.replace(':', '');
  return `${datePart}_${timeNoColon}_${job.ticker.toUpperCase()}_proof.mp4`;
}

// ─── Fonctions HTTP côté bot ─────────────────────────────────────────

async function fetchPendingJobs(botUrl: string, token: string): Promise<RenderJob[]> {
  const res = await fetch(`${botUrl}/api/render-queue`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/render-queue failed: ${res.status}`);
  const body = await res.json() as { jobs: RenderJob[] };
  return body.jobs;
}

async function ackJobSuccess(
  botUrl: string, token: string, jobId: number,
  mp4Path: string, caption: string, ticker: string, exitTs: string,
) {
  const form = new FormData();
  const buf = fs.readFileSync(mp4Path);
  form.append('mp4', new Blob([buf], { type: 'video/mp4' }), path.basename(mp4Path));
  form.append('caption', caption);
  form.append('ticker', ticker);
  form.append('exitTs', exitTs);

  const res = await fetch(`${botUrl}/api/render-queue/${jobId}/done`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`POST /done failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ackJobFailed(
  botUrl: string, token: string, jobId: number, errorMessage: string,
) {
  const res = await fetch(`${botUrl}/api/render-queue/${jobId}/done`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ error: errorMessage }),
  });
  if (!res.ok) {
    console.error(`[worker] failed to ACK error for job ${jobId}: ${res.status}`);
  }
}

// ─── Loop principal ─────────────────────────────────────────────────

async function processJob(
  job: RenderJob, bundleLocation: string, outDir: string,
  botUrl: string, token: string,
) {
  console.log(`[worker] processing job ${job.id} (${job.ticker} ${job.pnl})`);
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'SignalAlertProof',
    inputProps: jobPropsToRemotion(job),
  });
  const filename = buildLocalFilename(job);
  const outPath = path.join(outDir, filename);

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: jobPropsToRemotion(job),
  });

  console.log(`[worker] rendered ${outPath}`);

  await ackJobSuccess(
    botUrl, token, job.id, outPath,
    buildCaption(job), job.ticker, job.exitTimestamp,
  );
  console.log(`[worker] job ${job.id} ACKed (Discord uploaded)`);
}

async function main() {
  const botUrl = process.env.BOT_URL;
  const token = process.env.RENDER_WORKER_TOKEN;
  if (!botUrl || !token) {
    console.error('[worker] FATAL: BOT_URL and RENDER_WORKER_TOKEN env vars required');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'out', 'auto');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[worker] bundling Remotion project...');
  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, '..', 'src', 'index.ts'),
  });
  console.log(`[worker] ready, polling ${botUrl}/api/render-queue every 30s`);

  while (true) {
    try {
      const jobs = await fetchPendingJobs(botUrl, token);
      if (jobs.length === 0) {
        await sleep(30_000);
        continue;
      }
      console.log(`[worker] ${jobs.length} pending job(s)`);
      for (const job of jobs) {
        try {
          await processJob(job, bundleLocation, outDir, botUrl, token);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[worker] job ${job.id} failed: ${msg}`);
          await ackJobFailed(botUrl, token, job.id, msg);
        }
      }
    } catch (err) {
      console.error('[worker] poll failed:', err instanceof Error ? err.message : err);
      await sleep(30_000);
    }
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Entrée du script (uniquement si exécuté directement, pas en test).
if (process.argv[1] && process.argv[1].endsWith('render-worker.ts')) {
  main().catch(err => {
    console.error('[worker] FATAL:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Ajouter le script `worker` dans `video/package.json`**

Dans `video/package.json`, dans la section `scripts`, ajoute après `render:proof` :

```json
"worker": "tsx scripts/render-worker.ts"
```

`tsx` est déjà disponible si `vitest` est installé (transitif), sinon ajoute-le :

```bash
cd video && npm install --save-dev tsx
```

Le bloc final ressemble à :

```json
"scripts": {
  "studio": "remotion studio",
  "render": "remotion render BrandPromo out/brand-promo.mp4",
  "render:signal": "remotion render SignalAlert out/signal-alert.mp4",
  "render:proof": "remotion render SignalAlertProof out/signal-alert-proof.mp4",
  "worker": "tsx scripts/render-worker.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

- [ ] **Step 5: Lancer les tests**

Run: `cd video && npm test`

Expected: les nouveaux tests (3 ou 4 tests `jobPropsToRemotion`, `buildCaption`, `formatTimeNY`) passent. Les tests existants (composition tests = 7) passent toujours. Total = 10/10.

- [ ] **Step 6: Vérifier le typecheck**

Run: `cd video && npm run typecheck`

Expected: clean.

- [ ] **Step 7: Smoke test du worker (sans vraie connexion bot)**

```bash
cd video && BOT_URL="http://invalid-host-9999.local" RENDER_WORKER_TOKEN="dummy" npm run worker
```

Expected: le worker boot, log `[worker] ready, polling ...`, puis échoue le premier poll avec une erreur réseau (`fetch failed` ou `getaddrinfo`). Ne crash pas — il retry après 30s. Tu Ctrl+C pour arrêter.

- [ ] **Step 8: Commit**

```bash
git add video/scripts/render-worker.ts video/scripts/render-worker.test.ts video/package.json video/package-lock.json
git commit -m "feat(video): worker long-running pour rendu auto + multipart upload bot

video/scripts/render-worker.ts poll /api/render-queue toutes les 30s
via Bearer auth, render chaque job via Remotion programmatique
(bundle une fois au boot), upload le MP4 multipart au bot via
POST /done. Si render fail, ACK le bot avec body JSON {error}.

Helpers (jobPropsToRemotion, buildCaption, formatTimeNY) testés
unit. Lancement : cd video && npm run worker."
```

---

### Task 6 : `.env.example` + vérification end-to-end manuelle

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Documenter les nouvelles env vars dans `.env.example`**

Ouvre `.env.example` (ou crée-le s'il n'existe pas). Ajoute à la fin :

```bash
# ── Phase 3 — Auto-render des proof videos ──────────────────────
# Token partagé entre bot et worker pour Bearer auth sur les
# endpoints /api/render-queue. Génère avec : openssl rand -hex 32
RENDER_WORKER_TOKEN=

# ID du canal Discord où le bot poste les vidéos rendues.
# Clic-droit sur le canal Discord → Copy Channel ID (mode dev requis).
RENDER_OUTPUT_CHANNEL_ID=

# URL publique du bot (pour le worker local).
# Côté bot Railway, cette var n'est PAS utilisée (le bot connaît son
# propre URL). Côté worker local : c'est l'URL de Railway.
BOT_URL=https://boom-bot-production.up.railway.app
```

- [ ] **Step 2: Commit l'env doc**

```bash
git add .env.example
git commit -m "docs: documenter les 3 env vars Phase 3 (RENDER_WORKER_TOKEN, ...)"
```

- [ ] **Step 3: Vérification E2E manuelle (instructions)**

Cette étape est manuelle — elle nécessite que le bot tourne (Railway ou local) et qu'un message Discord soit posté. Pas d'automatisation.

**Setup :**

1. Génère un secret : `openssl rand -hex 32` → copie la valeur
2. Configure côté bot (Railway ou local) :
   - `RENDER_WORKER_TOKEN=<secret>`
   - `RENDER_OUTPUT_CHANNEL_ID=<id du canal Discord privé pour les vidéos>`
3. Configure côté local (machine où tourne le worker) :
   - `RENDER_WORKER_TOKEN=<même secret>`
   - `BOT_URL=<url du bot, ex Railway>`
4. Bot redeploy (Railway pick up les nouveaux env vars)
5. Lance le worker : `cd video && npm install && npm run worker`. Log `[worker] ready, polling https://...`

**Test 1 — Exit gagnant matchable :**

1. Dans Discord, sur le canal `#trading-floor`, poste comme un trader : `$TSLA 150 entry long` (en tant que toi-même OU n'importe quel auteur classifié comme analyste). Attends que le bot le classify (vérifier dans `#bot-logs` ou DB qu'il est passé).
2. ~30 secondes plus tard, post `$TSLA out +20%` (en reply au message d'entrée OU en simple message si le bot peut matcher via DB).
3. Vérifier que `render_jobs` contient une nouvelle ligne `pending` :
   - Via dashboard `/db-viewer` : `SELECT * FROM render_jobs ORDER BY id DESC LIMIT 5;`
   - Ou via Discord channel d'admin : `!queue` si tu en ajoutes une (hors scope ici)
4. Attends 30s (next worker poll cycle).
5. Worker log : `[worker] processing job N (TSLA +20%)` puis `rendered ...mp4` puis `job N ACKed (Discord uploaded)`.
6. Va dans `#auto-proof-videos` (le canal configuré dans RENDER_OUTPUT_CHANNEL_ID). Tu dois y voir :
   - Un post avec caption : `📈 $TSLA · Z · +20% — proof video\nEntry 13:32 · Exit 16:30`
   - Un fichier joint `.mp4` (~1-2 MB)
   - Téléchargement → la vidéo proof avec lifestyle hook + entry card + chart + exit card
7. Vérifier en DB : `render_jobs` row passé en `status='done'` avec `discord_msg_id` rempli.
8. Vérifier sur disque local : `video/out/auto/2026-04-25_*_TSLA_proof.mp4` existe.

**Test 2 — Exit perdant ignoré :**

1. Post `$AAPL 100 entry long` puis `$AAPL out -5%`.
2. Vérifier qu'AUCUN job n'est créé dans `render_jobs`.
3. Le worker ne fait rien.

**Test 3 — Exit sans entry matchable :**

1. Post juste `$XYZ out +30%` sans avoir posté d'entry préalable pour XYZ.
2. Vérifier qu'AUCUN job n'est créé.

**Test 4 — Render fail :**

1. Modifie temporairement `video/src/compositions/SignalAlertProof.tsx` pour throw une erreur (par exemple ajoute `throw new Error('test')` dans le component).
2. Relance le worker (le bundle se refait).
3. Post un exit gagnant.
4. Worker log : `[worker] job N failed: test` puis ACK.
5. DB : `render_jobs` row passé en `status='failed'` avec `error='test'` (ou similaire).
6. Aucun upload Discord.
7. **Important** : reverte la modif de SignalAlertProof.tsx avant de continuer.

- [ ] **Step 4: Pas de commit pour Step 3 (vérification manuelle, pas de code)**

---

## Vérification finale

Après Task 6 :

- [ ] `npm test` à la racine — tous les tests existants passent + 8 nouveaux (extractPnl) + 5 (DB helpers) + 3 (route helpers) + 5 (handler hook) = ~21 nouveaux. Total ~414 / 414.
- [ ] `cd video && npm test` — 10/10 (7 existants + 3 helpers worker).
- [ ] `cd video && npm run typecheck` — clean.
- [ ] Bot redéployé sur Railway sans crash.
- [ ] Migration DB : table `render_jobs` créée au boot (vérifier via `/db-viewer` ou SQL direct).
- [ ] Env vars présents : `RENDER_WORKER_TOKEN`, `RENDER_OUTPUT_CHANNEL_ID` côté bot. `BOT_URL` + `RENDER_WORKER_TOKEN` côté worker local.
- [ ] Worker boot proprement : `cd video && npm run worker` log `[worker] ready, polling ...`.
- [ ] Test 1 (E2E) verde : exit gagnant → vidéo apparaît dans canal Discord configuré.
- [ ] Tests 2-3 (negatives) : aucun job créé.
- [ ] Test 4 (render fail) : status passe à `failed` avec error stocké.

Si tous les checks passent : Phase 3 livrée. Phase 4 (filtres, SignalAlert auto, métriques, web UI) viendront dans une session future selon les besoins.
