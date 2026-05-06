# Phase 3 — Auto-render des proof videos quand le bot voit un exit gagnant — design

## Contexte

Phase 2.5 a livré la composition `SignalAlertProof` qu'on rend manuellement via CLI (`cd video && npm run render:proof -- --props='{...}'`). Phase 3 automatise ce rendu : quand le bot détecte un exit gagnant en Discord ET trouve l'entrée correspondante, il enqueue un job que le worker local consomme pour produire le MP4 et le poster dans un canal Discord dédié.

**Cas d'usage typique** : un trader poste `$TSLA out +20%`. Le bot match cet exit avec l'entrée originale `$TSLA 150 entry long` postée 3h plus tôt. Le bot enqueue un job avec les deux messages + pnl. Quand le worker local tourne, il poll, récupère le job, render le MP4, poste dans `#auto-proof-videos` via le bot. L'utilisateur télécharge depuis Discord et publie sur ses réseaux.

## Architecture

### Vue d'ensemble (3 composants)

```
┌─────────────────────┐       ┌─────────────────────┐       ┌─────────────────────┐
│   Bot (Railway)     │       │  Worker (machine    │       │  Discord            │
│   discord/handler   │       │  locale, on-demand) │       │  #auto-proof-       │
│   ─────────────     │       │  ──────────────     │       │  videos             │
│                     │       │                     │       │                     │
│  classifySignal     │       │  scripts/video-     │       │                     │
│   detects exit      │       │   render-worker.js  │       │                     │
│   + matching entry  │       │                     │       │                     │
│        │            │       │  loop {             │       │                     │
│        ▼            │       │   poll /api/        │       │                     │
│  enqueue job in     │◄──────│    render-queue     │       │                     │
│  render_jobs table  │   1.  │    (via Bearer auth)│       │                     │
│                     │       │   for each job:     │       │                     │
│  GET /api/render-   │       │    bundle (cached)  │       │                     │
│   queue → list      │       │    renderMedia()    │       │                     │
│                     │       │    save MP4 local   │       │                     │
│  POST /api/render-  │       │    POST /done       │       │                     │
│   queue/:id/done    │       │     w/ multipart    │       │                     │
│   ── reads buffer ──│──────►│    (mp4 + caption)  │       │                     │
│        │            │   2.  │                     │       │                     │
│        ▼            │       │  }                  │       │                     │
│  channel.send({     │       │                     │       │                     │
│   files: [buf],     │───────┼─────────────────────┼──────►│  📈 $TSLA · Z       │
│   content: caption  │   3.  │                     │       │  +20% proof video   │
│  })                 │       │                     │       │                     │
└─────────────────────┘       └─────────────────────┘       └─────────────────────┘
```

Les flèches représentent des appels HTTP (1 et 2) ou Discord API (3). Le bot reste autorité sur Discord et la DB ; le worker fait juste le rendu lourd (Chromium + Remotion bundle) en isolation locale.

### Avantages

- **Railway léger** : aucune dépendance Remotion/Chromium côté bot. Container reste ~200 MB.
- **Worker autonome** : peut être éteint des jours, les jobs s'accumulent en DB et sont traités quand il revient.
- **Pas de credentials Discord côté worker** : seul le bot poste sur Discord.
- **Retraitable** : si un job échoue, son status passe à `failed` avec message d'erreur stocké, l'utilisateur peut le re-enqueue manuellement.

## Composants

### 1. Bot — table SQLite `render_jobs`

Nouvelle table dans `boom.db` (gérée par `db/sqlite.js`) :

```sql
CREATE TABLE IF NOT EXISTS render_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker          TEXT NOT NULL,
  entry_author    TEXT NOT NULL,
  entry_message   TEXT NOT NULL,
  entry_ts        TEXT NOT NULL,    -- ISO 8601
  exit_author     TEXT NOT NULL,
  exit_message    TEXT NOT NULL,
  exit_ts         TEXT NOT NULL,    -- ISO 8601
  pnl             TEXT NOT NULL,    -- ex: "+20%"
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'failed'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  done_at         TEXT,
  error           TEXT,
  discord_msg_id  TEXT              -- id du message Discord après upload (pour traçabilité)
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status, created_at);
```

Les helpers exportés depuis `db/sqlite.js` :
- `enqueueRenderJob(payload)` — INSERT avec status `pending`, retourne l'id
- `getPendingRenderJobs(limit = 10)` — SELECT WHERE status='pending' ORDER BY created_at LIMIT
- `markRenderJobDone(id, discordMsgId)` — UPDATE status='done', done_at=now, discord_msg_id
- `markRenderJobFailed(id, errorMessage)` — UPDATE status='failed', done_at=now, error

### 2. Bot — hook dans `discord/handler.js`

Au moment où le bot détecte un exit (après `classifySignal` et `findOriginalAlert`), juste avant le POST Make.com webhook, on ajoute :

```js
// Si c'est un exit gagnant ET qu'on a trouvé l'entrée correspondante
// AVEC un timestamp réel (pas null), enqueue un job de rendu vidéo proof.
if (
  filterType === 'exit' &&
  originalAlert &&
  originalAlert.ts &&        // skip si ts null (cas reply Discord sans fetch parent)
  pnl &&
  !pnl.startsWith('-')
) {
  enqueueRenderJob({
    ticker: signalTicker,
    entry_author: originalAlert.author,
    entry_message: originalAlert.content,
    entry_ts: originalAlert.ts,
    exit_author: authorName,
    exit_message: content,
    exit_ts: message.createdAt.toISOString(),
    pnl: pnl,  // ex: "+20%"
  });
}
```

**Note** : `findOriginalAlert()` retourne `ts: null` pour les exits qui sont des replies Discord (le parent message n'est pas fetché). Pour la Phase 3 on skip simplement ces cas — la vidéo proof a besoin d'un entry timestamp réel pour calculer la diff "X hours later" dans `TimePassAct`. Une amélioration future (Phase 4) pourrait étendre `findOriginalAlert` pour fetcher le parent via `message.fetchReference()` et récupérer son `createdAt`, mais c'est hors scope ici.

Le `pnl` est extrait du message d'exit via regex `/[+-]?\d+(\.\d+)?%/`. On ajoute une fonction utilitaire `extractPnl(content)` dans `utils/prices.js` (à côté de `extractTicker`, `extractPrices`).

`originalAlert` est ce que retourne `findOriginalAlert()` (déjà existant) — un objet `{ author, content, ts }`.

### 3. Bot — endpoints HTTP

Nouveau fichier `routes/render-queue.js` enregistré depuis `index.js`. Deux routes :

**`GET /api/render-queue`**
- Header requis : `Authorization: Bearer <RENDER_WORKER_TOKEN>`
- Si auth fail → 401 JSON `{ error: 'Unauthorized' }`
- Retourne JSON : `{ jobs: [{ id, ticker, entryAuthor, entryMessage, entryTs, exitAuthor, exitMessage, exitTs, pnl }, ...] }` (status pending uniquement, max 10)
- Note : on convertit snake_case (DB) en camelCase (JSON API/Remotion props)

**`POST /api/render-queue/:id/done`**
- Header requis : `Authorization: Bearer <RENDER_WORKER_TOKEN>`
- Body : `multipart/form-data` avec :
  - `mp4` (file binary, le rendu)
  - `caption` (string, ex: `"📈 $TSLA · Z · +20% — proof video"`)
- Si erreur côté worker (render failed) : POST avec body `application/json` `{ error: "message" }` au lieu de multipart → bot marque le job failed
- Sinon : bot reçoit le buffer, post dans le canal Discord configuré, ACK le job avec `discord_msg_id`
- Réponse 200 `{ status: 'done', discord_msg_id: '...' }` ou 200 `{ status: 'failed', error: '...' }`

Le multipart parsing se fait via `multer` (nouvelle dep). Si `multer` est jugé trop lourd, on peut utiliser `busboy` directement (déjà transitif).

### 4. Bot — Discord upload

Nouvelle fonction dans `routes/render-queue.js` :

```js
async function postVideoToChannel(client, channelId, mp4Buffer, caption, filename) {
  const channel = await client.channels.fetch(channelId);
  const sent = await channel.send({
    content: caption,
    files: [{
      attachment: mp4Buffer,
      name: filename,  // ex: "TSLA_proof_2026-04-25_1530.mp4"
    }],
  });
  return sent.id;
}
```

`channelId` vient de l'env var `RENDER_OUTPUT_CHANNEL_ID`. Si pas définie, le job est marqué `failed` avec error `"RENDER_OUTPUT_CHANNEL_ID not set"`.

### 5. Worker — `video/scripts/render-worker.js`

Le worker vit **à l'intérieur du sous-projet `video/`** (et non à la racine `scripts/`) pour réutiliser ses deps Remotion existantes (`@remotion/bundler`, `@remotion/renderer`). Cela évite de dupliquer ces deps côté bot, qui doit rester léger (pas de Chromium sur Railway). Lancement : `cd video && npm run worker` (nouveau script à ajouter à `video/package.json`).

Long-running script. Cycle de vie :

1. **Boot** :
   - Lire env vars : `BOT_URL` (ex: `https://boom-bot-production.up.railway.app`), `RENDER_WORKER_TOKEN`
   - Bundle la composition Remotion une fois via `@remotion/bundler` :
     ```js
     const bundleLocation = await bundle({
       entryPoint: path.join(__dirname, '..', 'video', 'src', 'index.ts'),
     });
     ```
   - Log `[worker] ready, bundle at <path>`

2. **Loop** (toutes les 30s) :
   - GET `${BOT_URL}/api/render-queue` avec Bearer auth
   - Pour chaque job du payload :
     - Render via `renderMedia({ composition, serveUrl: bundleLocation, codec: 'h264', inputProps: jobPropsToRemotion(job), outputLocation: localPath })`
     - `localPath` = `video/out/auto/${YYYY-MM-DD}_${HHMM}_${ticker}_proof.mp4` (date depuis exit_ts)
     - Si succès :
       - Lire le fichier en buffer
       - Construire la caption : `"📈 $${ticker} · ${entryAuthor} · ${pnl} — proof video\nEntry ${formatTime(entry_ts)} · Exit ${formatTime(exit_ts)}"`
       - POST multipart à `${BOT_URL}/api/render-queue/${id}/done` avec mp4 + caption
       - Log `[worker] job ${id} done, discord_msg_id=...`
     - Si erreur (Remotion render fail) :
       - POST JSON à `/done` avec `{ error: err.message }`
       - Log `[worker] job ${id} failed: ${err.message}`

3. **Sleep 30s, retry**

Si `BOT_URL` est down (réseau, Railway redeploy), le worker log un warning et continue le polling. Pas d'arrêt brutal.

### 6. Configuration (env vars)

| Variable | Côté | Description | Exemple |
|---|---|---|---|
| `RENDER_WORKER_TOKEN` | Bot + Worker | Secret partagé pour Bearer auth. À générer fort (ex: `openssl rand -hex 32`). | `a3f...` |
| `RENDER_OUTPUT_CHANNEL_ID` | Bot | ID du canal Discord où poster les vidéos. | `1234567890` |
| `BOT_URL` | Worker | URL publique du bot Railway. | `https://boom-bot-production.up.railway.app` |

Les 3 vars sont **requises** pour Phase 3. Si une manque côté bot, l'enqueue continue mais les routes `/api/render-queue` retournent 503. Si une manque côté worker, le worker log fatal et exit.

## Data flow exemple

1. **9:32am NY** : Z poste `$TSLA 150 entry long` dans `#trading-floor`. Bot classify → `entry`, save en DB.
2. **12:30pm NY** : Z poste `$TSLA out +20%` (reply au message d'entrée). Bot classify → `exit`, `findOriginalAlert` retourne le message de 9:32am.
3. **Bot enqueue job** dans `render_jobs` :
   ```json
   {
     "id": 47,
     "ticker": "TSLA",
     "entry_author": "Z",
     "entry_message": "$TSLA 150 entry long",
     "entry_ts": "2026-04-25T13:32:00-04:00",
     "exit_author": "Z",
     "exit_message": "$TSLA out +20%",
     "exit_ts": "2026-04-25T16:30:00-04:00",
     "pnl": "+20%",
     "status": "pending"
   }
   ```
4. **Worker (allumé chez l'utilisateur)** : poll `/api/render-queue`, récupère le job 47.
5. **Worker render** `SignalAlertProof` avec inputProps dérivés du job. Sortie : `video/out/auto/2026-04-25_1230_TSLA_proof.mp4` (~1.5 MB).
6. **Worker POST** `/api/render-queue/47/done` multipart avec le MP4 + caption `"📈 $TSLA · Z · +20% — proof video\nEntry 13:32 · Exit 16:30"`.
7. **Bot** lit le buffer, post dans `#auto-proof-videos` Discord channel via `client.channels.fetch().send()`. Discord retourne `msg_id = "987654321"`.
8. **Bot UPDATE** `render_jobs` SET status='done', discord_msg_id='987654321', done_at=now WHERE id=47.
9. **Bot répond** au worker `200 { status: 'done', discord_msg_id: '987654321' }`.
10. **Utilisateur ouvre Discord** → voit la vidéo dans `#auto-proof-videos` → télécharge → publie sur TikTok/Reels.

## Tests

### Bot side

Nouveaux tests dans `db/sqlite.test.js` (ou un nouveau fichier `db/render-jobs.test.js`) :

- `enqueueRenderJob` insère et retourne un id
- `getPendingRenderJobs` retourne les jobs `pending`, exclut `done`/`failed`
- `markRenderJobDone` met à jour status + discord_msg_id
- `markRenderJobFailed` met à jour status + error

Nouveaux tests dans `routes/render-queue.test.js` (nouveau fichier) :

- `GET /api/render-queue` sans auth → 401
- `GET /api/render-queue` avec auth → 200 + JSON
- `POST /api/render-queue/:id/done` sans auth → 401
- `POST /api/render-queue/:id/done` avec multipart MP4 → 200 + Discord post mocké
- `POST /api/render-queue/:id/done` avec JSON error → marque failed

Nouveau test dans `discord/handler.test.js` :

- Quand un exit gagnant arrive avec entrée matchable → `render_jobs` reçoit une nouvelle ligne pending

### Worker side

Tests minimaux dans `scripts/video-render-worker.test.js` (nouveau fichier) :

- `jobPropsToRemotion(job)` convertit camelCase JSON → SignalAlertProofProps
- `buildCaption(job)` génère la caption attendue
- Pas de test E2E avec vrai render (lourd) — on fait confiance au render manuel testé en Phase 2.5

### Verification end-to-end (manuel)

1. Lance le worker : `node video/scripts/render-worker.js`
2. Dans Discord (canal `#trading-floor`), poste `$TSLA 150 entry long` (auteur Z) → puis 30s plus tard `$TSLA out +20%` en reply
3. Vérifie que `render_jobs` contient un job pending (via `/api/db-viewer` ou query direct)
4. Attends 30s — worker poll, render, upload
5. Va dans `#auto-proof-videos` → tu dois voir la vidéo MP4 avec caption
6. `render_jobs` row devient `status='done'`, `discord_msg_id` rempli
7. `video/out/auto/` contient le MP4 local

## Hors scope (Phase 3)

- **Re-enqueue automatique des jobs failed** (ex: après un crash worker) — manuel pour l'instant
- **Throttling** : si 50 exits gagnants arrivent en 5 minutes, le worker les traite séquentiellement (un par un). Pas de parallélisme. C'est OK vu le volume attendu (~5-15/jour).
- **Multi-worker** : un seul worker à la fois. Si 2 workers polled simultanément, ils pourraient se piler dessus (race condition sur `getPendingRenderJobs`). Acceptable pour le MVP, à corriger avec un `SELECT ... LIMIT 1 FOR UPDATE`-like si besoin.
- **Auto-render des entries** (SignalAlert) — pas en Phase 3, peut-être en Phase 4 si l'utilisateur veut plus de volume.
- **Filtres** (auteurs whitelist, pnl seuil) — Phase 4. Phase 3 = tout exit gagnant matchable.
- **Web UI** pour gérer les jobs (re-render, supprimer) — pas dans cette phase.
- **Métriques** (combien de jobs/jour, temps moyen de rendu) — pas dans cette phase.
- **Notifications** (alerte si worker offline > 1h) — pas dans cette phase.

## Vérification

Au sortir de Phase 3 :

1. **Bot tests** : `npm test` à la racine — tous les tests existants passent + nouveaux tests render-queue.
2. **Bot deploy Railway** : nouveau code se déploie sans crash, `render_jobs` table créée par migration au boot.
3. **Env vars** : `RENDER_WORKER_TOKEN` et `RENDER_OUTPUT_CHANNEL_ID` configurés sur Railway. `BOT_URL` et `RENDER_WORKER_TOKEN` configurés localement (par ex. dans `.env.local`).
4. **Worker boot** : `node video/scripts/render-worker.js` log `[worker] ready, polling http://...` sans erreur.
5. **Test exit gagnant** : poste un message `$TSLA 150 entry long` (Z) puis `$TSLA out +20%` (reply). Job apparaît dans DB. Worker poll, render, upload. Vidéo apparaît dans le canal Discord. Job devient done.
6. **Test exit perdant** : poste `$AAPL 100 entry long` puis `$AAPL out -5%`. Aucun job créé (pnl négatif filtré).
7. **Test sans entry matchable** : poste juste `$NVDA out +10%` (pas d'entry préalable). Aucun job (findOriginalAlert null).
8. **Test worker down** : éteins le worker, poste un exit gagnant. Job reste pending. Rallume le worker. Au prochain poll, il traite le job.
9. **Test render failure** : injecte une exception dans renderMedia (par exemple props invalides). Worker POST `/done` avec error. Job devient `failed` avec error stocké. Pas de Discord post.
