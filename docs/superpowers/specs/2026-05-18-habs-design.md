# Habs — Stocktwits Auto-publish Recap (v0.1) — Design Spec

**Date:** 2026-05-18
**Status:** Draft (pending user review)
**Scope:** Auto-publication des recaps Temple of Boom vers Stocktwits via Zapier webhook. Queue SQLite persistante, retry backoff, dedup atomique, kill switch. v0.1 = recap-only, Stocktwits-only, texte-only (sans image, contrainte Zapier). Architecture pluggable pour ajouter X / Instagram / TikTok et asset video en v0.2+.

---

## 1. Goal

Aujourd'hui : le recap quotidien Temple of Boom (image P&L OCR + vidéo Remotion rendue) est posté uniquement dans Discord. Aucune visibilité externe.

Après ce travail : un module `social/habs/` consomme l'événement "recap OCR success" du handler existant, enqueue un job dans une nouvelle table SQLite `social_post_jobs`, et un worker in-process drain la queue en envoyant un POST vers un webhook Zapier. Le Zap côté Zapier (configuré manuellement) publie ensuite sur Stocktwits via l'action native "Create Post". Résilient aux crashes (queue persistante), retry-backoffé, dedup-guardé, kill-switché via `HABS_ENABLED`.

## 2. Architecture (approach #3 — queue SQLite)

Pattern strictement aligné avec `render_jobs` existant (cf `routes/render-queue.js` et `db/sqlite.js`). Mêmes primitives : table SQLite, status machine `pending` → `posting` → `done|failed`, worker tick `setInterval`.

```
social/
  habs/
    index.js              # API publique: start(client), enqueueRecap(opts)
    queue.js              # enqueue/drain SQLite-backed
    worker.js             # tick setInterval, retry backoff state machine
    caption.js            # pipeline: caption-llm.js (LLM) → template fallback
    cashtags.js           # top-3 winners selector from OCR trades
    discord-notify.js     # admin channel failure notification
    platforms/
      zapier-webhook.js   # adapter: POST JSON to Zapier Catch Hook
      _interface.md       # contrat pour futurs adapters (X, IG, TikTok, ...)
  habs.test.js            # smoke integration test
```

Touch existant minimal :
- 1 ajout dans `discord/recap-image-handler.js` : appel `habs.enqueueRecap(...)` après OCR success
- 1 migration dans `db/sqlite.js` : création table + index
- 1 ligne boot dans `index.js` : `require('./social/habs').start(client)` sous garde feature flag

## 3. Schema SQLite

Migration dans `db/sqlite.js` (ajoutée à l'array `migrations` existant) :

```sql
CREATE TABLE IF NOT EXISTS social_post_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  platform            TEXT NOT NULL,                    -- v0.1: 'stocktwits'
  asset_type          TEXT NOT NULL DEFAULT 'text',     -- v0.1: 'text'; future: 'image' | 'video'
  asset_url           TEXT,                             -- NULL pour v0.1 (Zapier Stocktwits = text only)
  asset_path          TEXT,                             -- optionnel local temp path
  caption             TEXT NOT NULL,
  cashtags_json       TEXT NOT NULL DEFAULT '[]',       -- JSON array, ex: ["AAPL","TSLA","NVDA"]
  source_kind         TEXT NOT NULL DEFAULT 'recap',    -- v0.1: 'recap'
  source_message_id   TEXT NOT NULL,                    -- Discord message.id (idempotency)
  ocr_hash            TEXT NOT NULL,                    -- sha256(JSON.stringify(trades))
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending|posting|done|failed
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  next_attempt_at     TEXT,                             -- ISO timestamp; NULL = ready
  post_url            TEXT,                             -- response webhook URL si Zapier le retourne
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_post_jobs_dedup
  ON social_post_jobs (platform, source_message_id, ocr_hash);

CREATE INDEX IF NOT EXISTS idx_social_post_jobs_pending
  ON social_post_jobs (status, next_attempt_at) WHERE status IN ('pending', 'posting');
```

Points clés :
- **Dedup index** `(platform, source_message_id, ocr_hash)` : INSERT fail silencieusement si déjà présent → idempotent au crash bot mid-process et au re-upload de la même image.
- **`asset_type` colonne** déjà présente (default `'text'`) pour future video v0.2 — zéro schema migration ensuite.
- **`source_kind` colonne** = `'recap'` pour v0.1 ; permet ajout `'milestone'`, `'proof'` plus tard sans nouvelle table.
- **`next_attempt_at`** : NULL ou passé = ready. Worker query `WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))`.

## 4. Data flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Admin poste P&L screenshot dans TOB_RECAP_IMAGE_CHANNEL_ID       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. discord/recap-image-handler.js (existant, modif mineure)         │
│    - OCR success via Claude Vision                                  │
│    - APRÈS enqueue render_job (existant), AJOUTER :                 │
│      habs.enqueueRecap({                                            │
│        ocrResult,               // { trades, dateLabel, ... }       │
│        messageId: message.id,                                       │
│      }).catch(err => console.warn('[habs]', err.message));          │
│    - Non-blocking : si Habs HS, recap Discord continue normal       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. social/habs/queue.js — enqueueRecap()                            │
│    - ocr_hash = sha256(JSON.stringify(trades))                      │
│    - cashtags = top 3 winners via cashtags.js                       │
│    - caption = via caption.js (LLM primary → template fallback)     │
│    - INSERT social_post_jobs (...) ON CONFLICT → no-op log          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ (async, decoupled)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. social/habs/worker.js — tick setInterval(5s)                     │
│    - SELECT pending jobs WHERE next_attempt_at ready                │
│    - UPDATE status='posting', attempts++                            │
│    - dispatch sur platforms/<platform>.js                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. social/habs/platforms/zapier-webhook.js                          │
│    POST <HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL>                        │
│    Content-Type: application/json                                   │
│    Body: {                                                          │
│      "body": "<caption avec $CASHTAGS inline>",                     │
│      "source": "habs-recap",                                        │
│      "job_id": <id>,                                                │
│      "date_label": "2026-05-18",                                    │
│      "stats": { trade_count, win_count, loss_count, top_ticker,     │
│                 top_pct }                                           │
│    }                                                                │
│    Return: { ok: true, url? } | { ok: false, retriable, error }    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  ▼ ok                       ▼ fail
        UPDATE status='done',         attempts < 3 ?
        posted_at, post_url           yes → UPDATE next_attempt_at
                                            = now + [1s,5s,30s][attempts-1]
                                      no  → UPDATE status='failed'
                                          + discord-notify.js post
                                            "❌ Habs stocktwits #id: <err>"
```

Notes :
- **Decoupling**. `recap-image-handler` enqueue uniquement, ne bloque pas sur publish. Si Habs HS, recap Discord intact.
- **Worker tick 5s** = trade-off latence vs simplicité. Recap = événement humain (1-2/jour), 5s acceptable. Implémenté via `setInterval` dans `index.js` au boot.
- **`retriable` flag**. L'adapter distingue erreurs transitoires (network, 5xx, 408, 429) des permanentes (4xx autres → typiquement webhook URL invalide, payload mal formé). Permanent = pas de retry, fail direct.
- **Zapier réponse**. POST vers Catch Hook retourne typiquement `{ status: 'success', id: 'xxx' }` (200 OK). Habs considère 2xx = ok ; Zapier exécute son Zap async derrière, on ne poll pas le résultat final Stocktwits. Le `post_url` reste NULL sauf si Zapier nous retourne quelque chose d'exploitable.

## 5. Configuration / secrets

Env vars nouveaux :

```
# Zapier Catch Hook URL pour le Zap Stocktwits. Required.
HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/xxx/yyy

# Discord channel ID pour failure notifications. Fallback console.error si unset.
HABS_ADMIN_CHANNEL_ID=

# Worker tick interval (ms). Default 5000.
HABS_WORKER_INTERVAL_MS=5000

# Kill switch global. 'false' désactive Habs entièrement (queue + worker no-op).
HABS_ENABLED=true

# LLM caption model override (sinon hérite de CAPTION_LLM_MODEL).
HABS_CAPTION_MODEL=
```

Boot dans `index.js` (sous garde feature flag) :

```js
if (process.env.HABS_ENABLED !== 'false' && process.env.HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL) {
  require('./social/habs').start(client);
} else {
  console.log('[habs] disabled (HABS_ENABLED=false ou pas de HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL)');
}
```

Graceful disable : pas de webhook URL → Habs noop, recap Discord intact.

## 6. Caption template (Variant 1 — sober journal, Stocktwits-compliant)

```
Trade journal — {date_label}

{n} closes today · {win_count}W / {loss_count}L

Top moves:
${t1} +{p1}%
${t2} +{p2}%
${t3} +{p3}%

What's everyone watching into tomorrow?
```

**Conformité Stocktwits Rules** (vérifiée contre [stocktwits.com/about/rules](https://stocktwits.com/about/rules/)) :

- ✅ Pas de lien externe (pas d'URL temple-of-boom.com)
- ✅ Pas de mention brand / Discord / "join" / "live calls"
- ✅ Style "journal entry" explicitement encouragé par Stocktwits Best Practices
- ✅ Cashtags = tickers réellement tradés (pas de spam-tagging)
- ✅ Engagement closer ("What's everyone watching into tomorrow?") = community discussion aligned
- ✅ 0% promo content → ratio 10% promo cap trivialement respecté

**Pipeline génération** :
1. Habs appelle `caption-llm.js` avec nouveau `platform='stocktwits'` ajouté à `PLATFORM_PROMPTS`. Prompt précise : trader journal style, no URL, no brand, ≤300 chars.
2. Si LLM retourne null (Anthropic API down, no `ANTHROPIC_API_KEY`, etc.) → fallback template ci-dessus avec substitution string vanilla.
3. Validation post-génération : reject la caption si contient `http`, `https`, `discord.gg`, ou mention `temple of boom` (case-insensitive). Reject → fallback template.

**Edge cases du template** :
- Trades = 0 : enqueueRecap fail silently (n'enregistre rien), log warn. Pas de post Stocktwits sans data.
- Trades = 1 : "Top moves:" section affiche 1 seule ligne. Reste du template inchangé.
- Trades = 2 : 2 lignes dans "Top moves:".
- Trades ≥ 3 : top 3 par gain % descendant. Si plusieurs trades à égalité, tie-break par ordre OCR (1er apparaît en premier).
- Trades all losing : `win_count=0`. "Top moves:" affiche les 3 moins pires (ou tous si <3). Caption template reste honnête (no spin).
- `dateLabel` absent OCR : fallback sur date NY courante (`utils/dates.js` ou équivalent existant).

**LLM prompt à ajouter dans `utils/caption-llm.js` `PLATFORM_PROMPTS.stocktwits`** :

```
You write Stocktwits post captions for a trader's daily journal.

CONTEXT: A personal trader sharing their closed positions for the day on Stocktwits.

REQUIREMENTS:
- 150-300 characters total
- Trade journal voice, first-person OR neutral observational
- Reference tickers as $CASHTAG (Stocktwits auto-parses these)
- Highlight: total trades, win/loss split, top 3 picks with %
- End with a community-engagement question, NOT a CTA
- NEVER include URLs, links, or domain names
- NEVER mention "Temple of Boom", "Discord", "join", "subscribe", "live calls"
- NEVER use promotional language ("amazing", "huge wins", "follow me for more")
- Tone: humble, observational, factual

Match the style of a retail trader posting their own day's recap, not a marketing account.
```

## 7. Testing

```
social/habs/queue.test.js
  - enqueueRecap dedup : même message_id + ocr_hash → INSERT no-op (vérifie pas de doublon en DB)
  - enqueueRecap : caption + cashtags générés depuis OCR data fixture
  - asset_type='text', asset_url=NULL pour Stocktwits v0.1

social/habs/worker.test.js
  - tick drain pending jobs (mock platform adapter)
  - retry backoff : fail #1 → next_attempt_at = now + 1s
                    fail #2 → now + 5s
                    fail #3 → status='failed' + admin notify mock called
  - permanent error (non-retriable) → status='failed' immédiatement, no retry
  - status='posting' lock prevent double-tick race (deux ticks parallèles ne posten pas 2x)

social/habs/caption.test.js
  - template fallback when LLM throws
  - top-3 winners selection (sorted desc by gain %)
  - cashtag extraction = top 3 only
  - validation reject URLs / brand mentions → fallback template

social/habs/platforms/zapier-webhook.test.js
  - POST payload shape (body, source, job_id, date_label, stats)
  - retriable classification : 5xx + network + 408 + 429 → retriable
                               4xx autres → permanent
  - mock fetch, zéro réseau réel

social/habs.test.js  (integration)
  - end-to-end : enqueueRecap → tick worker → fetch mock 200 → status='done'
  - fail path : fetch mock 500 → 3 retries → status='failed' + Discord notify mock called
```

Fixture OCR result : réutilise les fixtures existantes de `discord/recap-image-handler.test.js` si disponibles.

Pas de mock Stocktwits API directe — on s'arrête au webhook Zapier (boundary externe). Le Zap Zapier en lui-même est testé manuellement une fois lors du setup, pas en CI.

## 8. Extensibility (hooks pour futur)

| Future need | Hook prévu |
|---|---|
| Ajout X / IG / TikTok | Nouveau `platforms/<name>.js` + value `platform` distinct. Chaque plateforme = soit son propre Zap webhook (Zapier-route), soit direct API (si plateforme l'autorise). Zero schema change. |
| Asset video | `asset_type='video'`. Adapter check support plateforme, fallback text-only ou skip selon platform. |
| Autre source (milestone, proof, news, trend) | `source_kind='milestone'` etc. Chaque producteur appelle `habs.enqueue<Source>()`. Worker code path unchanged. |
| Approval gate manuel (mode B brainstorming) | Ajout colonne `requires_approval` boolean. Discord command `/habs approve <id>`. Worker skip jobs sans approval. |
| Rate limit per platform | Query `last_post_at` du `platform`, enforce min interval. |
| DLQ / replay manuel | Discord command `/habs retry-failed` pour replay des jobs `status='failed'`. |

## 9. Out-of-scope v0.1 (explicit)

Pour éviter scope creep, ces items sont **explicitement exclus** de v0.1 :

- ❌ Asset image / video (Stocktwits via Zapier = text only)
- ❌ Image hosting (Vercel Blob / Cloudinary / Discord CDN public)
- ❌ Direct Stocktwits API (registrations gelées en 2026, Zapier le seul shippable)
- ❌ Multi-plateforme (X, IG, TikTok, Reddit, Bluesky) — schema ready, code pas
- ❌ Approval gate Discord (mode auto-publish only)
- ❌ Dashboard UI pour status posts
- ❌ Retry au-delà de 3 attempts (DLQ pour v0.2 si besoin)
- ❌ Backfill historique recap (seuls les nouveaux recaps post-deploy sont publiés)

## 10. Risks et mitigations

| Risk | Mitigation |
|---|---|
| Stocktwits ban malgré template compliant | Variant 1 designed contre toutes les rules vérifiées. Validation post-LLM reject les URL/brand mentions. Monitor les premiers 50 posts. Kill switch `HABS_ENABLED=false` instantané. |
| Zapier free tier limit (100 tasks/mo) | 1 recap/jour = ~30 tasks/mo. OK sur free tier. Upgrade plan Zapier si scaling. |
| LLM caption hallucinations | Template fallback déjà décidé. LLM output validé (length, no URLs, no banned strings) avant insert. Reject → fallback template. |
| OCR data malformed | enqueueRecap fail silently (catch dans recap-handler) → log warn, recap Discord intact (decoupled). |
| Multiple bot instances poste 2x | UNIQUE index `(platform, source_message_id, ocr_hash)` bloque INSERT dup au niveau DB. |
| Zapier webhook URL leak | Stocker uniquement dans env Railway, pas en DB / pas en logs. Pas committer le secret. |
| Zapier Zap down côté Zapier (eg. OAuth Stocktwits expiré) | Adapter détecte 4xx → status='failed' + Discord notify. Admin reconnecte Stocktwits dans Zapier UI. |

## 11. Manual setup steps (à exécuter par l'opérateur)

Documenté dans `docs/habs-setup.md` (à créer en même temps que l'implémentation) :

1. **Compte Zapier** : créer ou utiliser compte existant. Free tier suffisant pour v0.1.
2. **Compte Stocktwits** : créer le compte qui postera les recaps. Username représentatif (ex: trader handle, pas "TempleOfBoomOfficial").
3. **Premier post manuel Stocktwits** : faire un post manuel "test" avant de connecter Zapier. Stocktwits restreint les premiers 50 posts pour promo, vaut mieux avoir des posts organiques avant Habs.
4. **Créer le Zap dans Zapier** :
   - Trigger : *Webhooks by Zapier > Catch Hook*. Copier la webhook URL.
   - Action : *Stocktwits > Create Post*. Connecter le compte Stocktwits (OAuth flow géré par Zapier dans l'UI).
   - Mapper le champ `Post Body` au champ `body` du webhook payload.
   - Tester avec un sample payload.
   - Publish le Zap.
5. **Variables Railway** : ajouter `HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL=<URL copiée>`, `HABS_ADMIN_CHANNEL_ID=<Discord channel ID>`, `HABS_ENABLED=true`.
6. **Deploy bot** : `git push`, attendre redeploy Railway. Vérifier logs boot : `[habs] enabled, worker started`.
7. **First trigger réel** : admin poste un recap dans `TOB_RECAP_IMAGE_CHANNEL_ID`. Surveiller le log bot + Stocktwits feed du compte. Premier post Habs visible dans ~5-15s.
8. **Monitoring premiers 50 posts** : check Stocktwits account daily. Pas d'avertissement modération = on est good.

## 12. Acceptance criteria

v0.1 ship-ready quand :
- [ ] Migration `social_post_jobs` appliquée sans erreur sur SQLite local + Railway prod
- [ ] Tests unit + integration passent (`npm test`)
- [ ] Recap manuel posté dans Discord → job `status='done'` dans DB dans les 15s
- [ ] Post visible sur Stocktwits feed du compte configuré
- [ ] Re-post de la même image Discord → INSERT bloqué par dedup index (log "already queued")
- [ ] Webhook URL invalide simulé → 3 retries puis Discord notif dans `HABS_ADMIN_CHANNEL_ID`
- [ ] `HABS_ENABLED=false` → boot logs "disabled", aucune enqueue, recap Discord intact
- [ ] `docs/habs-setup.md` créé et complet

