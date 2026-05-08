# BoomRecap Daily Template — Design

**Goal:** Auto-générer une vidéo récap quotidienne à partir du message Discord "RECAP:" posté chaque jour par ZZ dans `#trading-floor`. La vidéo liste les wins du jour (tickers + gains %) avec une narration cinématique de ~45s, postée automatiquement dans le canal Discord configuré.

**Non-goals (Phase 1) :**
- Pas d'édition manuelle de la liste avant render (le parser fait foi).
- Pas de support multi-recap par jour (1×/jour hard-enforced).
- Pas de canal de sortie séparé pour les recaps (réutilise `RENDER_OUTPUT_CHANNEL_ID`).

---

## 1. Architecture

```
ZZ poste "RECAP: ..." dans #trading-floor (Railway bot)
    ↓
discord/handler.js → detectRecap()
    - Match conditions (auteur whitelist, regex RECAP:)
    - INSERT OR IGNORE INTO daily_recaps(date) → idempotence par date
    ↓
utils/parse-recap.js
    - Extract { date, tickers[], runnersHit, runnersTotal, tagline }
    - Sort tickers desc par gainPct, mark isHero (≥100%)
    ↓
db.enqueueRenderJob({
  composition: 'BoomRecap',
  template_name: 'recap-default',
  recap_data: JSON.stringify({...}),
  ...
})
    ↓
Worker local pull → renderMedia('BoomRecap', props)
    ↓
MP4 uploadé → routes/render-queue → channel Discord
```

**Tech stack** : Remotion 4.x, Zod, better-sqlite3, discord.js v14, @napi-rs/canvas (pour le ticker count animé).

---

## 2. Détection (`discord/handler.js`)

Nouvelle branche dans le handler `messageCreate`, **avant** la détection signal/exit existante (les recaps ne sont pas des signaux trading).

### Conditions de match (toutes doivent être vraies)

| Critère | Valeur |
|---------|--------|
| Channel | Par défaut le canal `TRADING_CHANNEL` existant (où ZZ post déjà). Surchargeable via env var `RECAP_CHANNEL_ID` (channel ID exact, prioritaire sur le filtre name-based) si tu veux dédier un canal séparé pour les recaps. |
| Auteur | ∈ `RECAP_AUTHOR_WHITELIST` (env var, défaut `ZZ`) |
| Contenu | Match `/^\s*RECAP\s*:/i` (RECAP en début, case-insensitive, accepte espace) |
| Tickers | ≥ 3 lignes matchant `/\$([A-Z]{1,6})\s+(\d+(?:\.\d+)?)%/m` |

Si toutes ces conditions sont vraies → continuer. Sinon → ignore (le message suit le flow normal du handler).

### Idempotence par date

Nouvelle table SQLite (migration via `addColumnIfMissing` ne s'applique pas — il faut un `CREATE TABLE IF NOT EXISTS`) :

```sql
CREATE TABLE IF NOT EXISTS daily_recaps (
  date          TEXT PRIMARY KEY,        -- "YYYY-MM-DD" en TZ America/New_York
  message_id    TEXT NOT NULL,            -- Discord msg id qui a triggé
  render_job_id INTEGER,                  -- ref vers render_jobs.id (nullable jusqu'au enqueue)
  tickers_count INTEGER NOT NULL,
  runners_hit   INTEGER,                  -- nullable si pas trouvé dans le message
  runners_total INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_recaps_date ON daily_recaps(date);
```

Logique handler :
1. Calcule `dateKey = formatDateET(message.createdAt)` (réutilise `formatDateET` existant dans `trading/trend-scanner.js`).
2. `INSERT OR IGNORE INTO daily_recaps(date, message_id, tickers_count) VALUES (?, ?, ?)`.
3. Si `result.changes === 0` → recap déjà rendu aujourd'hui, **skip silencieux** (log info, pas d'erreur).
4. Sinon → parse → enqueue render → `UPDATE daily_recaps SET render_job_id = ? WHERE date = ?`.

**Edits (`messageUpdate`)** : non-trigger en Phase 1. Si ZZ corrige son recap après le post initial, le bot ne re-render pas. L'utilisateur peut forcer un re-render manuel via `/video-studio` (post-Phase 1).

---

## 3. Parser (`utils/parse-recap.js`)

Module standalone, testable, sans dépendance Discord.

### API

```js
parseRecap(content: string, messageDate: Date): RecapData | null
```

Retourne `null` si moins de 3 tickers parsables (le handler skip).

### Regex et règles d'extraction

**Tickers** :
```js
const TICKER_REGEX = /\$([A-Z]{1,6})\s+(\d+(?:\.\d+)?)%\s*(swing)?/gmi;
```
Itère sur tous les matches, déduplique par `(ticker, gainPct)` exact (au cas où ZZ liste 2× le même $RXT 39% par erreur).

**Runners ratio** :
```js
const RUNNERS_REGEX = /(\d+)\s*(?:out\s+of|\/|of)\s*(\d+)\s*runners?/i;
```
Exemples qui matchent : "5 out of 6 runners", "5/6 runners", "5 of 6 runner".

**Tagline** :
- Split le contenu en paragraphes (`/\n\n+/`).
- Le tagline = premier paragraphe qui :
  - Ne contient PAS `RECAP:`
  - Ne match PAS `TICKER_REGEX` (pas une ligne ticker)
  - A ≥ 30 caractères
  - Strip les `@everyone`/`@here` du résultat final.

Si pas trouvé → tagline défaut : `"Plenty of chances to bank today."`

**Tri + isHero** :
- Sort `tickers` desc par `gainPct`.
- `isHero = gainPct >= 100`.

### Sortie attendue (exemple ZZ)

```js
{
  date: "2026-05-08",
  tickers: [
    { ticker: "RXT",  gainPct: 380, swing: true,  isHero: true  },
    { ticker: "REPL", gainPct: 133, swing: true,  isHero: true  },
    { ticker: "AIIO", gainPct: 71,  swing: false, isHero: false },
    { ticker: "TDIC", gainPct: 63,  swing: true,  isHero: false },
    { ticker: "AIIO", gainPct: 63,  swing: false, isHero: false },
    // ... 14 total
  ],
  runnersHit:   5,
  runnersTotal: 6,
  tagline: "Plenty of chances to bank today even if you just stayed in this channel.",
  totalGainPct: 1062,  // somme de tous les gainPct (380+133+71+63+63+53+53+48+42+39+35+30+29+23)
}
```

---

## 4. Composition `BoomRecap` (`video/src/compositions/BoomRecap.tsx`)

### Schema Zod (props)

```ts
const RecapTickerSchema = z.object({
  ticker:  z.string().describe("Symbol sans le $"),
  gainPct: z.number().describe("Pourcentage de gain (positif)"),
  swing:   z.boolean().default(false),
  isHero:  z.boolean().default(false).describe("≥100% → glow doré + animation lente"),
});

const BoomRecapSchema = z.object({
  date:          z.string().describe("YYYY-MM-DD ou label custom"),
  dateLabel:     z.string().default("RECAP").describe("Texte affiché à côté de la date"),
  tickers:       z.array(RecapTickerSchema).min(1).max(20),
  runnersHit:    z.number().nullable().default(null),
  runnersTotal:  z.number().nullable().default(null),
  totalGainPct:  z.number(),
  tagline:       zTextarea().default("Plenty of chances to bank today."),
  ctaText:       z.string().default("Join the channel"),
  ctaUrl:        z.string().default(""),

  // Customization (template-overridable)
  accentColor:    zColor().default("#fbbf24"),  // doré pour les hero wins
  successColor:   zColor().default("#10b981"),  // vert pour wins normaux
  bgColor:        zColor().default("#0a0a0f"),
  fontFamily:     z.string().default("Inter"),
  musicVolume:    z.number().min(0).max(1).default(0.6),
  sfxEnabled:     z.boolean().default(true),
  showTop3Phase:  z.boolean().default(true),
  lifestyleSeed:  z.number().default(0),
});
```

### Phases (timeline indicative pour ~14 tickers à 30fps)

Les frame ranges ci-dessous sont **illustratifs** pour le cas exemple ZZ (14 tickers, 2 hero). La durée réelle est calculée dynamiquement par `calculateMetadata` (voir sous-section suivante).

| Phase | Frames (exemple 14 tickers) | Durée | Contenu |
|-------|------------------------------|-------|---------|
| 1. DateStinger | 0-60 | 2s | Flash blanc, "MAY 8 · RECAP" + logo BOOM, impact bass |
| 2. HeroStat | 60-150 | 3s | Compteur 0% → totalGainPct%, sub-bass riser, "TOTAL GAINS TODAY" |
| 3. TickerWaterfall | 150-342 | ~6.4s | Cartes tombent (2 hero × 24f + 12 normal × 12f = 192f) |
| 4. Top3Highlight | 342-522 | 6s | Zoom dolly sur les 3 plus gros, lifestyle photos, particle burst (skipped si `showTop3Phase=false`) |
| 5. ClosingStat | 522-762 | 8s | "X / Y RUNNERS" gros, tagline, CTA |
| 6. Outro | 762-852 | 3s | Logo BOOM seul, slow zoom, freeze |

Pour 14 tickers, la durée totale = 852f / 30fps = ~28s. Comme c'est sous le minimum 30s, `calculateMetadata` clamp à 900f. Si plus de tickers → la phase 3 s'étend, et la durée totale grandit jusqu'au max 60s (1800f).

### Adaptation dynamique de la durée

`calculateMetadata` ajuste `durationInFrames` selon le nombre de tickers :

```ts
calculateMetadata: ({ props }) => {
  const tickers = props.tickers.length;
  const heroCount = props.tickers.filter(t => t.isHero).length;

  // Phase 3 : chaque ticker prend 12-24 frames (0.4-0.8s)
  // Hero (≥100%) : 24f, normal (<100%) : 12f
  const waterfallFrames = (heroCount * 24) + ((tickers - heroCount) * 12);

  const phase4Frames = props.showTop3Phase ? 180 : 0;
  const totalFrames = 60 + 90 + waterfallFrames + phase4Frames + 240 + 90;

  // Clamp entre 30s (900f) et 60s (1800f)
  return {
    durationInFrames: Math.max(900, Math.min(1800, totalFrames)),
    fps: 30,
    width: 1080,
    height: 1920,
  };
}
```

### Style des cartes ticker (Phase 3)

```tsx
<TickerCard
  ticker={t.ticker}
  gainPct={t.gainPct}
  swing={t.swing}
  isHero={t.isHero}
  startFrame={offset}
  durationFrames={t.isHero ? 24 : 12}
/>
```

- Hero (`isHero=true`) : carte 1080×140, glow doré pulsant, shake léger (Remotion `spring` avec stiffness élevé), durée 0.8s.
- Normal : carte 1080×100, fond vert + bordure subtile, slide-in depuis la droite, durée 0.4s.
- Stack vertical : chaque carte se positionne sous la précédente avec `marginTop = sumPreviousHeights`. Quand le stack dépasse 1600px, scroll vers le haut (camera move).

### Audio mapping

| Phase | SFX/Music |
|-------|-----------|
| 1 | `impact-bass.mp3` à frame 0, fade-in `proof-track.mp3` |
| 2 | `riser.mp3` (à créer si absent), counter tick par 5% gain |
| 3 | `whoosh-1.mp3` sur normal cards, `chaching.mp3` sur hero cards, side-chain ducking sur la track |
| 4 | Ducking total music, `whoosh-2.mp3` sur le dolly-in |
| 5 | Big hit `impact-bass.mp3` sur le "X/Y RUNNERS" reveal |
| 6 | Music outro fade-out sur 90 frames |

`musicVolume` et `sfxEnabled` controlables via le schema (déjà standard dans BoomProof).

---

## 5. Template JSON (`video/templates/recap-default.json`)

```json
{
  "name": "Daily Recap (Default)",
  "composition": "BoomRecap",
  "description": "Récap quotidien des wins (auto-trigger sur 'RECAP:' Discord)",
  "props": {
    "dateLabel": "RECAP",
    "accentColor": "#fbbf24",
    "successColor": "#10b981",
    "bgColor": "#0a0a0f",
    "musicVolume": 0.6,
    "sfxEnabled": true,
    "showTop3Phase": true,
    "ctaText": "Join the channel",
    "ctaUrl": "https://templeofboom.com/join"
  }
}
```

---

## 6. DB schema (`db/sqlite.js`)

### Nouvelle table

Ajout dans le bloc `db.exec(...)` après les tables existantes (avant les migrations `addColumnIfMissing`) :

```sql
CREATE TABLE IF NOT EXISTS daily_recaps (
  date          TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,
  render_job_id INTEGER,
  tickers_count INTEGER NOT NULL,
  runners_hit   INTEGER,
  runners_total INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_recaps_date ON daily_recaps(date);
```

### Nouvelles fonctions exportées

- `tryClaimRecapDate(date, messageId, tickersCount)` — INSERT OR IGNORE, retourne `true` si claimed (premier de la journée), `false` si déjà fait.
- `setRecapRenderJobId(date, renderJobId)` — UPDATE après enqueue.
- `getRecapByDate(date)` — pour le dashboard /video-studio (lister les recaps déjà rendus).

### Migration `render_jobs.recap_data`

Le payload du recap (tickers array + runners + tagline) est stocké comme JSON string dans une nouvelle colonne du `render_jobs` :

```js
addColumnIfMissing('render_jobs', 'recap_data', 'TEXT');
```

Nullable. Le worker le parse uniquement si `composition === 'BoomRecap'`.

---

## 7. Worker (`video/scripts/render-worker.ts`)

Ajout dans `RenderJob` type :
```ts
recap_data?: string | null;  // JSON-stringified RecapData
recapData?: { /* parsed */ };  // populated by jobPropsToRemotion
```

Dans `jobPropsToRemotion`, si `composition === 'BoomRecap'` :
- Parse `recap_data` JSON.
- Remplace les props default par les props parsées.
- Inclut `tickers`, `totalGainPct`, `runnersHit`, `runnersTotal`, `tagline`, `date` du parsed data.

---

## 8. Tests

### `utils/parse-recap.test.js`

- ✅ Parse l'exemple complet de ZZ → 14 tickers, runners 5/6, tagline correct.
- ✅ "$RXT 380% swing" → `{ ticker: "RXT", gainPct: 380, swing: true, isHero: true }`.
- ✅ "$AIIO 71%" → swing=false, isHero=false.
- ✅ Décimales : "$XYZ 12.5%" → gainPct=12.5.
- ✅ Moins de 3 tickers → null.
- ✅ Pas de "RECAP:" en début → null.
- ✅ Runners non trouvés → `runnersHit: null, runnersTotal: null`.
- ✅ Tagline non trouvée → fallback "Plenty of chances to bank today."
- ✅ Sort desc par gainPct.
- ✅ totalGainPct = somme de tous les gainPct.

### `discord/handler.test.js` (extension)

- ✅ Recap match déclenche `tryClaimRecapDate` + `enqueueRenderJob`.
- ✅ Re-trigger même date → `tryClaimRecapDate` retourne false → pas de second enqueue.
- ✅ Auteur non whitelist → skip.
- ✅ Channel hors trading-floor → skip (déjà couvert par filtre existant).
- ✅ Moins de 3 tickers → skip silencieux.

### `db/sqlite.test.js` (extension)

- ✅ `tryClaimRecapDate` premier appel → true.
- ✅ Deuxième appel même date → false.
- ✅ `setRecapRenderJobId` met à jour la ligne.

### `video/src/compositions/BoomRecap.test.ts` (typecheck only)

- ✅ Schema Zod valide les props ZZ d'exemple.
- ✅ `calculateMetadata` clamp entre 900-1800 frames.
- ✅ Hero glow appliqué uniquement sur isHero=true.

---

## 9. Étapes manuelles côté utilisateur

⚠️ **À faire après le déploiement** (flagged explicitement) :

1. **Vérifier `RECAP_AUTHOR_WHITELIST` env var sur Railway** :
   - Si absent → défaut `ZZ` appliqué automatiquement (pas besoin d'action).
   - Si tu veux d'autres auteurs : Railway → Variables → `RECAP_AUTHOR_WHITELIST=ZZ,Z,Protrader Alerts`.

2. **Vérifier `RECAP_CTA_URL` env var** (optionnel) : URL CTA utilisée si pas surchargée par le template. Défaut hardcoded : `https://templeofboom.com/join`. À ajuster selon ton URL de landing actuelle.

3. **Tester en posant un faux recap** dans `#trading-floor` depuis le compte ZZ (ou un autre auteur whitelisté). Vérifier dans les logs Railway :
   - `[recap] detected for 2026-05-XX, enqueued render_job #N`
   - Le MP4 devrait apparaître dans le canal `RENDER_OUTPUT_CHANNEL_ID` après ~2-5 min (selon la queue worker).

4. **Si re-render forcé nécessaire** (ex: ZZ a corrigé son recap) :
   - DELETE manuel : `DELETE FROM daily_recaps WHERE date = 'YYYY-MM-DD'` via `/db-viewer` ou Railway shell.
   - Ré-déclenche le post Discord (ou utiliser `/video-studio` lorsque l'édition manuelle des recaps depuis le dashboard sera implémentée — voir section 10 "out of scope Phase 1").

5. **Worker local doit tourner** (déjà documenté dans le handoff) : sans le worker actif, les recaps s'enqueue mais ne se rendent pas.

---

## 10. Out of scope (Phase 2+)

Choses délibérément exclues pour rester focus sur la Phase 1 :

- Édition manuelle du recap parsé avant render (le parser fait foi en Phase 1).
- Re-render automatique sur `messageUpdate`.
- Canal de sortie séparé (`RECAP_OUTPUT_CHANNEL_ID`).
- Multi-recap par jour (1×/jour hard-coded).
- Recap hebdomadaire/mensuel.
- Recap voice-over auto-généré (TTS).
- A/B testing de templates.

---

## 11. Critères de succès

- ✅ Quand ZZ poste un message qui commence par `RECAP:` dans `#trading-floor` avec ≥3 tickers, une vidéo MP4 est postée automatiquement dans le canal Discord configuré dans les ~5 min suivantes.
- ✅ Si ZZ poste un 2ème message recap le même jour (édit, re-post, doublon), aucun second render n'est déclenché.
- ✅ La vidéo affiche correctement les tickers triés desc par gainPct, avec glow doré sur les ≥100%.
- ✅ Le ratio runners (ex: "5/6") s'affiche dans la phase Closing.
- ✅ Tests unitaires passent : parse-recap (~10 tests), handler extensions (~5 tests), db extensions (~3 tests).

---

## 12. Estimation

- Spec : ce doc.
- Plan : ~30 min à écrire.
- Implémentation :
  - Parser + tests : ~1h
  - DB layer + tests : ~30 min
  - Handler hook + tests : ~30 min
  - BoomRecap composition Remotion : ~3-4h (le plus gros)
  - Template JSON : ~10 min
  - Worker integration : ~30 min
  - E2E test (avec un faux recap posté en local) : ~30 min

**Total estimé : 7-8h de coding** (sans compter les itérations sur le visuel de la composition).
