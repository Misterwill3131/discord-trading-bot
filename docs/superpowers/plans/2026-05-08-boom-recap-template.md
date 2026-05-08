# BoomRecap Daily Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-générer une vidéo récap quotidienne à partir du message Discord "RECAP:" posté par ZZ dans `#trading-floor`, parser les wins (tickers + gains %), et poster la vidéo MP4 résultante dans le canal Discord configuré, 1×/jour max.

**Architecture:** Le handler Discord existant (`discord/handler.js`) ajoute une branche détection recap (regex + auteur whitelist + idempotence par date via SQLite). Un parser pur (`utils/parse-recap.js`) extrait `{ tickers, runners, tagline }`. Un job render est enqueued avec `composition='BoomRecap'` et `recap_data` JSON. Le worker local rend la nouvelle composition Remotion `BoomRecap.tsx` (6 phases, durée adaptative 30-60s). Le pipeline existant render-queue → Discord upload reste inchangé.

**Tech Stack:** Remotion 4.x + Zod schema + @remotion/google-fonts/Inter + @remotion/transitions, better-sqlite3, discord.js v14, `node:test` pour les tests.

**Spec source:** `docs/superpowers/specs/2026-05-08-boom-recap-template-design.md`

---

## File Structure

### Files créés
- `utils/parse-recap.js` — parser pur du message Discord "RECAP:" → structured data
- `utils/parse-recap.test.js` — tests parser
- `utils/dates.js` — utility `formatDateET` extrait pour réutilisation hors trading/
- `utils/dates.test.js` — tests dates utility
- `video/src/compositions/BoomRecap.tsx` — composition Remotion (6 phases)
- `video/src/components/RecapDateStinger.tsx` — Phase 1
- `video/src/components/RecapHeroStat.tsx` — Phase 2 (counter animé)
- `video/src/components/RecapTickerWaterfall.tsx` — Phase 3 (waterfall + cards)
- `video/src/components/RecapTickerCard.tsx` — sous-composant d'une carte ticker
- `video/src/components/RecapTop3Highlight.tsx` — Phase 4
- `video/src/components/RecapClosingStat.tsx` — Phase 5
- `video/src/components/RecapOutro.tsx` — Phase 6
- `video/templates/recap-default.json` — template JSON par défaut

### Files modifiés
- `db/sqlite.js` — ajout table `daily_recaps`, colonne `render_jobs.recap_data`, helpers `tryClaimRecapDate`, `setRecapRenderJobId`, `getRecapByDate`
- `db/sqlite.test.js` — tests pour les nouveaux helpers
- `discord/handler.js` — branche détection recap avant le flow signal/exit
- `discord/handler.test.js` — tests pour la branche recap
- `video/src/Root.tsx` — registration de `BoomRecap` composition
- `video/scripts/render-worker.ts` — parse `recap_data` quand `composition === 'BoomRecap'`

---

## Task 1: Utility `formatDateET` extrait dans `utils/dates.js`

**Files:**
- Create: `utils/dates.js`
- Create: `utils/dates.test.js`

Le format date NY-timezone est utilisé par le trend-scanner. On l'extrait dans une utility pour pouvoir l'importer depuis le handler sans dépendre de `trading/`.

- [ ] **Step 1: Write the failing test**

Écrire dans `utils/dates.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');

const { formatDateET } = require('./dates');

test('formatDateET returns YYYY-MM-DD in NY timezone — EDT case (May)', () => {
  // 2026-05-08 19:22 UTC = 2026-05-08 15:22 EDT (UTC-4 in DST)
  const d = new Date('2026-05-08T19:22:00Z');
  assert.strictEqual(formatDateET(d), '2026-05-08');
});

test('formatDateET returns YYYY-MM-DD in NY timezone — EST case (January)', () => {
  // 2026-01-15 04:00 UTC = 2026-01-14 23:00 EST (UTC-5)
  const d = new Date('2026-01-15T04:00:00Z');
  assert.strictEqual(formatDateET(d), '2026-01-14');
});

test('formatDateET handles UTC-day-rollover correctly', () => {
  // 2026-05-09 02:00 UTC = 2026-05-08 22:00 EDT
  const d = new Date('2026-05-09T02:00:00Z');
  assert.strictEqual(formatDateET(d), '2026-05-08');
});

test('formatDateET defaults to current time when no arg', () => {
  const result = formatDateET();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test utils/dates.test.js`
Expected: FAIL — `Cannot find module './dates'`

- [ ] **Step 3: Write minimal implementation**

Créer `utils/dates.js` :

```js
// ─────────────────────────────────────────────────────────────────────
// utils/dates.js — Date utilities timezone-aware
// ─────────────────────────────────────────────────────────────────────
// Toutes les dates business du bot sont normalisées sur America/New_York
// (timezone du marché US). On utilise Intl.DateTimeFormat avec en-CA
// pour avoir le format ISO YYYY-MM-DD natif.
// ─────────────────────────────────────────────────────────────────────

// Format YYYY-MM-DD pour une Date donnée, exprimée en TZ America/New_York.
// Utilisé pour les clés journalières (daily_recaps.date, etc.) et pour
// tout matching "même journée trading" indépendamment du fuseau horaire
// du serveur (Railway = UTC).
function formatDateET(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = { formatDateET };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test utils/dates.test.js`
Expected: PASS — 4/4

- [ ] **Step 5: Commit**

```bash
git add utils/dates.js utils/dates.test.js
git commit -m "feat(utils): formatDateET extrait dans utils/dates pour réutilisation"
```

---

## Task 2: Parser `utils/parse-recap.js` — tickers + runners + tagline

**Files:**
- Create: `utils/parse-recap.js`
- Create: `utils/parse-recap.test.js`

Parser pur, sans I/O. Extrait `{ tickers, runnersHit, runnersTotal, tagline, totalGainPct }` du contenu du message Discord.

- [ ] **Step 1: Write the failing tests (cas principaux)**

Écrire dans `utils/parse-recap.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');

const { parseRecap } = require('./parse-recap');

// ─── Cas réel : exemple ZZ du 2026-05-08 ────────────────────────────
const ZZ_RECAP = `RECAP:

$RXT 380% swing
$REPL 133% swing
$AIIO 71%
$TDIC 63% swing
$AIIO 63%
$INOD 53%
$FKNC 53% swing
$DBGI 48% swing
$GDC 42%
$RXT 39%
$PMAX 35%
$MASK 30%
$TRAW 29%
$GDC 23%

Plenty of chances to bank today even if you just stayed in this channel. Our WL gave us 5 out of 6 runners. @everyone`;

test('parseRecap extrait les 14 tickers du recap ZZ', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.ok(result, 'should not return null');
  assert.strictEqual(result.tickers.length, 14);
});

test('parseRecap sort tickers desc par gainPct', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.strictEqual(result.tickers[0].ticker, 'RXT');
  assert.strictEqual(result.tickers[0].gainPct, 380);
  assert.strictEqual(result.tickers[1].ticker, 'REPL');
  assert.strictEqual(result.tickers[1].gainPct, 133);
});

test('parseRecap mark isHero=true pour gainPct >= 100', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  const heros = result.tickers.filter(t => t.isHero);
  assert.strictEqual(heros.length, 2, 'RXT 380 + REPL 133 = 2 hero');
});

test('parseRecap détecte le flag swing', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  const rxt = result.tickers.find(t => t.ticker === 'RXT' && t.gainPct === 380);
  assert.strictEqual(rxt.swing, true);
  const aiio71 = result.tickers.find(t => t.ticker === 'AIIO' && t.gainPct === 71);
  assert.strictEqual(aiio71.swing, false);
});

test('parseRecap extrait runnersHit + runnersTotal', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.strictEqual(result.runnersHit, 5);
  assert.strictEqual(result.runnersTotal, 6);
});

test('parseRecap extrait tagline et strip @everyone', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.match(result.tagline, /Plenty of chances to bank today/);
  assert.doesNotMatch(result.tagline, /@everyone/);
});

test('parseRecap calcule totalGainPct (somme)', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  // 380+133+71+63+63+53+53+48+42+39+35+30+29+23 = 1062
  assert.strictEqual(result.totalGainPct, 1062);
});

test('parseRecap retourne date en TZ NY (YYYY-MM-DD)', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.strictEqual(result.date, '2026-05-08');
});

// ─── Cas négatifs ────────────────────────────────────────────────
test('parseRecap retourne null si moins de 3 tickers', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%';
  assert.strictEqual(parseRecap(content, new Date()), null);
});

test('parseRecap retourne null si pas de RECAP: en début', () => {
  const content = '$RXT 380% swing\n$REPL 133% swing\n$AIIO 71%';
  assert.strictEqual(parseRecap(content, new Date()), null);
});

test('parseRecap accepte "RECAP :" avec espace', () => {
  const content = 'RECAP :\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.ok(result);
  assert.strictEqual(result.tickers.length, 3);
});

test('parseRecap accepte décimales dans gainPct', () => {
  const content = 'RECAP:\n$AAPL 12.5%\n$TSLA 5.1%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.tickers[0].gainPct, 12.5);
});

test('parseRecap fallback tagline défaut si non trouvé', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.tagline, 'Plenty of chances to bank today.');
});

test('parseRecap runnersHit/Total null si pas trouvés', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.runnersHit, null);
  assert.strictEqual(result.runnersTotal, null);
});

test('parseRecap matche "5/6 runners" comme alternative à "out of"', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%\n\nGreat day, 4/5 runners hit.';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.runnersHit, 4);
  assert.strictEqual(result.runnersTotal, 5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test utils/parse-recap.test.js`
Expected: FAIL — `Cannot find module './parse-recap'`

- [ ] **Step 3: Write minimal implementation**

Créer `utils/parse-recap.js` :

```js
// ─────────────────────────────────────────────────────────────────────
// utils/parse-recap.js — Parse un message Discord "RECAP:" en data structurée
// ─────────────────────────────────────────────────────────────────────
// Input  : contenu raw d'un message Discord (string), Date du message
// Output : { date, tickers, runnersHit, runnersTotal, tagline, totalGainPct } | null
//
// Retourne null si le message ne ressemble pas à un recap valide
// (pas de "RECAP:" en début, ou < 3 tickers parsables).
//
// Utilisé par discord/handler.js pour décider de déclencher un render
// auto BoomRecap. Pure : pas d'I/O, pas de DB.
// ─────────────────────────────────────────────────────────────────────

const { formatDateET } = require('./dates');

// Match "$TICKER NN% swing?" — tolère décimales et "swing" optionnel.
// Le 'g' flag est requis pour itérer matchAll.
const TICKER_REGEX = /\$([A-Z]{1,6})\s+(\d+(?:\.\d+)?)%\s*(swing)?/gmi;

// Match "5 out of 6 runners", "5/6 runners", "5 of 6 runner".
const RUNNERS_REGEX = /(\d+)\s*(?:out\s+of|\/|of)\s*(\d+)\s*runners?/i;

// Préfixe RECAP en début de message, accepte espace optionnel avant ':'.
const RECAP_PREFIX_REGEX = /^\s*RECAP\s*:/i;

const TAGLINE_DEFAULT = 'Plenty of chances to bank today.';
const MIN_TICKERS = 3;

function parseRecap(content, messageDate) {
  if (!content || typeof content !== 'string') return null;
  if (!RECAP_PREFIX_REGEX.test(content)) return null;

  // 1. Extract tickers
  const matches = [...content.matchAll(TICKER_REGEX)];
  if (matches.length < MIN_TICKERS) return null;

  const tickers = matches.map(m => {
    const gainPct = parseFloat(m[2]);
    return {
      ticker:  m[1].toUpperCase(),
      gainPct,
      swing:   Boolean(m[3]),
      isHero:  gainPct >= 100,
    };
  });

  // 2. Sort desc par gainPct
  tickers.sort((a, b) => b.gainPct - a.gainPct);

  // 3. Compute total
  const totalGainPct = tickers.reduce((sum, t) => sum + t.gainPct, 0);

  // 4. Extract runners ratio
  const runnersMatch = content.match(RUNNERS_REGEX);
  const runnersHit   = runnersMatch ? parseInt(runnersMatch[1], 10) : null;
  const runnersTotal = runnersMatch ? parseInt(runnersMatch[2], 10) : null;

  // 5. Extract tagline : premier paragraphe qui n'est pas RECAP: ni une
  //    ligne ticker, et qui a au moins 30 chars de prose.
  const paragraphs = content.split(/\n\n+/).map(p => p.trim());
  let tagline = TAGLINE_DEFAULT;
  for (const para of paragraphs) {
    if (RECAP_PREFIX_REGEX.test(para)) continue;
    // Skip si le paragraphe est juste des lignes ticker
    const tickerLines = para.split('\n').filter(l => TICKER_REGEX.test(l)).length;
    const totalLines = para.split('\n').length;
    if (tickerLines === totalLines) continue;
    if (para.length < 30) continue;
    // Strip @everyone / @here
    tagline = para.replace(/@(everyone|here)/gi, '').trim();
    break;
  }

  return {
    date: formatDateET(messageDate),
    tickers,
    runnersHit,
    runnersTotal,
    tagline,
    totalGainPct,
  };
}

module.exports = { parseRecap };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test utils/parse-recap.test.js`
Expected: PASS — 14/14

- [ ] **Step 5: Commit**

```bash
git add utils/parse-recap.js utils/parse-recap.test.js
git commit -m "feat(utils): parse-recap parser pour messages 'RECAP:' Discord"
```

---

## Task 3: DB layer — `daily_recaps` table + helpers + `render_jobs.recap_data`

**Files:**
- Modify: `db/sqlite.js` (ajout table + migration colonne + 3 helpers)
- Modify: `db/sqlite.test.js` (3 nouveaux tests)

- [ ] **Step 1: Write the failing tests**

Ajouter dans `db/sqlite.test.js` :

```js
// ── daily_recaps : idempotence par date ─────────────────────────────
test('tryClaimRecapDate retourne true au premier appel pour une date', () => {
  const claimed = tryClaimRecapDate('2026-05-08', 'msg-123', 14);
  assert.strictEqual(claimed, true);
});

test('tryClaimRecapDate retourne false au deuxième appel même date', () => {
  tryClaimRecapDate('2026-05-09', 'msg-456', 10);
  const second = tryClaimRecapDate('2026-05-09', 'msg-789', 12);
  assert.strictEqual(second, false);
});

test('setRecapRenderJobId update render_job_id pour une date', () => {
  tryClaimRecapDate('2026-05-10', 'msg-aaa', 8);
  setRecapRenderJobId('2026-05-10', 999);
  const row = getRecapByDate('2026-05-10');
  assert.strictEqual(row.render_job_id, 999);
});

test('getRecapByDate retourne null pour date inconnue', () => {
  const row = getRecapByDate('1999-01-01');
  assert.strictEqual(row, null);
});

// ── render_jobs.recap_data colonne ──────────────────────────────────
test('enqueueRenderJob accepte recap_data optionnel', () => {
  const recapData = JSON.stringify({ tickers: [{ ticker: 'RXT', gainPct: 380 }] });
  const id = enqueueRenderJob({
    ticker: 'RECAP',
    entry_author: 'ZZ',
    entry_message: 'RECAP test',
    entry_ts: '2026-05-08T19:44:00Z',
    exit_author: 'ZZ',
    exit_message: 'RECAP test',
    exit_ts: '2026-05-08T19:44:00Z',
    pnl: '+0%',
    composition: 'BoomRecap',
    recap_data: recapData,
  });
  assert.ok(id > 0);
  // Verify roundtrip
  const jobs = getPendingRenderJobs(100);
  const job = jobs.find(j => j.id === id);
  assert.strictEqual(job.recap_data, recapData);
});
```

Et l'import au début de `db/sqlite.test.js` (vérifier qu'il y est, sinon ajouter) :

```js
const {
  // ... existing imports ...
  tryClaimRecapDate,
  setRecapRenderJobId,
  getRecapByDate,
} = require('./sqlite');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test db/sqlite.test.js`
Expected: FAIL — `tryClaimRecapDate is not a function`

- [ ] **Step 3: Write the migration + helpers**

Modifier `db/sqlite.js` :

**3a. Ajouter la table** dans le bloc `db.exec(...)` après les tables existantes (chercher après `gallery_items` qui est ~ligne 137) :

```js
  -- Recap quotidien : 1×/jour max, idempotence par date NY-timezone.
  -- Chaque ligne = un message "RECAP:" qui a déclenché un render.
  -- date = clé naturelle (PRIMARY KEY) garantit l'unicité.
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

**3b. Ajouter la migration colonne** dans la section `addColumnIfMissing` (après les migrations `composition` existantes, ~ligne 468) :

```js
// ── render_jobs : recap_data pour BoomRecap composition ───────────────
// JSON stringified de { tickers, runnersHit, runnersTotal, tagline, ... }
// Utilisé uniquement pour composition='BoomRecap'. Le worker parse
// uniquement si non-null. Nullable pour rétrocompat avec les jobs
// BoomProof/BoomEntry existants.
addColumnIfMissing('render_jobs', 'recap_data', 'TEXT');
```

**3c. Mettre à jour le prepared statement INSERT** (chercher `stmtEnqueueRenderJob` ~ligne 1662) :

```js
const stmtEnqueueRenderJob = db.prepare(`
  INSERT INTO render_jobs
    (ticker, entry_author, entry_message, entry_ts,
     exit_author, exit_message, exit_ts, pnl, proof_image_base64,
     template_name, composition, recap_data)
  VALUES
    (@ticker, @entry_author, @entry_message, @entry_ts,
     @exit_author, @exit_message, @exit_ts, @pnl, @proof_image_base64,
     @template_name, @composition, @recap_data)
`);
```

**3d. Mettre à jour SELECT pending** (chercher `stmtGetPendingRenderJobs`) :

```js
const stmtGetPendingRenderJobs = db.prepare(`
  SELECT id, ticker, entry_author, entry_message, entry_ts,
         exit_author, exit_message, exit_ts, pnl, status, created_at,
         proof_image_base64, template_name, composition, recap_data
  FROM render_jobs
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT ?
`);
```

**3e. Ajouter le default `recap_data: null` dans `enqueueRenderJob`** :

```js
function enqueueRenderJob(payload) {
  const result = stmtEnqueueRenderJob.run({
    proof_image_base64: null,
    template_name: null,
    composition: 'BoomProof',
    recap_data: null,
    ...payload,
  });
  return result.lastInsertRowid;
}
```

**3f. Ajouter les 3 helpers daily_recaps** (avant les `module.exports`) :

```js
// ─────────────────────────────────────────────────────────────────────
// daily_recaps : idempotence par date pour les recaps auto-déclenchés
// ─────────────────────────────────────────────────────────────────────

const stmtClaimRecapDate = db.prepare(`
  INSERT OR IGNORE INTO daily_recaps (date, message_id, tickers_count)
  VALUES (?, ?, ?)
`);

const stmtSetRecapRenderJobId = db.prepare(`
  UPDATE daily_recaps SET render_job_id = ? WHERE date = ?
`);

const stmtGetRecapByDate = db.prepare(`
  SELECT date, message_id, render_job_id, tickers_count,
         runners_hit, runners_total, created_at
  FROM daily_recaps WHERE date = ?
`);

// Tente de claimer une date : true au premier call (recap pas encore
// fait aujourd'hui), false sinon. Idempotent : safe à appeler 2× sur
// la même date sans side effect.
function tryClaimRecapDate(date, messageId, tickersCount) {
  const result = stmtClaimRecapDate.run(date, messageId, tickersCount);
  return result.changes > 0;
}

function setRecapRenderJobId(date, renderJobId) {
  stmtSetRecapRenderJobId.run(renderJobId, date);
}

function getRecapByDate(date) {
  return stmtGetRecapByDate.get(date) || null;
}
```

**3g. Exporter les nouvelles fonctions** dans `module.exports` :

```js
module.exports = {
  // ... existing exports ...
  tryClaimRecapDate,
  setRecapRenderJobId,
  getRecapByDate,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test db/sqlite.test.js`
Expected: PASS — all tests including the 5 new ones

- [ ] **Step 5: Commit**

```bash
git add db/sqlite.js db/sqlite.test.js
git commit -m "feat(db): table daily_recaps + render_jobs.recap_data + 3 helpers"
```

---

## Task 4: Handler hook — détection RECAP + enqueue

**Files:**
- Modify: `discord/handler.js` (ajout branche détection recap avant le flow signal/exit)
- Modify: `discord/handler.test.js` (5 nouveaux tests)

- [ ] **Step 1: Write the failing tests**

Ajouter dans `discord/handler.test.js` (après les tests `maybeEnqueueProofRender`) :

```js
const { maybeEnqueueRecap } = require('./handler');
const { getRecapByDate } = require('../db/sqlite');

const ZZ_RECAP = `RECAP:

$RXT 380% swing
$REPL 133% swing
$AIIO 71%

Plenty of chances to bank today. Our WL gave us 2 out of 3 runners.`;

test('maybeEnqueueRecap enqueue un job pour RECAP valide de ZZ', async () => {
  const before = getPendingRenderJobs().length;
  const result = await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-01T19:44:00Z'),
    messageId: 'msg-recap-1',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, true);
  const after = getPendingRenderJobs();
  assert.strictEqual(after.length, before + 1);
  const job = after[after.length - 1];
  assert.strictEqual(job.composition, 'BoomRecap');
  assert.ok(job.recap_data);
  const data = JSON.parse(job.recap_data);
  assert.strictEqual(data.tickers.length, 3);
});

test('maybeEnqueueRecap retourne enqueued=false si auteur hors whitelist', async () => {
  const result = await maybeEnqueueRecap({
    authorName: 'Random',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-02T19:44:00Z'),
    messageId: 'msg-recap-2',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, false);
  assert.strictEqual(result.reason, 'author_not_whitelisted');
});

test('maybeEnqueueRecap retourne enqueued=false si pas de RECAP: en début', async () => {
  const result = await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: '$RXT 380% swing\n$REPL 133% swing\n$AIIO 71%',
    messageCreatedAt: new Date('2026-06-03T19:44:00Z'),
    messageId: 'msg-recap-3',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, false);
  assert.strictEqual(result.reason, 'parse_failed');
});

test('maybeEnqueueRecap retourne enqueued=false si recap déjà fait aujourdhui', async () => {
  // First call : claims the date
  await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-04T19:44:00Z'),
    messageId: 'msg-recap-4a',
    authorWhitelist: ['ZZ'],
  });
  // Second call same date : should skip
  const result = await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-04T20:00:00Z'),
    messageId: 'msg-recap-4b',
    authorWhitelist: ['ZZ'],
  });
  assert.strictEqual(result.enqueued, false);
  assert.strictEqual(result.reason, 'already_claimed');
});

test('maybeEnqueueRecap link render_job_id dans daily_recaps row', async () => {
  await maybeEnqueueRecap({
    authorName: 'ZZ',
    content: ZZ_RECAP,
    messageCreatedAt: new Date('2026-06-05T19:44:00Z'),
    messageId: 'msg-recap-5',
    authorWhitelist: ['ZZ'],
  });
  const row = getRecapByDate('2026-06-05');
  assert.ok(row);
  assert.ok(row.render_job_id > 0);
  assert.strictEqual(row.message_id, 'msg-recap-5');
  assert.strictEqual(row.tickers_count, 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/handler.test.js`
Expected: FAIL — `maybeEnqueueRecap is not a function`

- [ ] **Step 3: Implement `maybeEnqueueRecap` in handler.js**

Dans `discord/handler.js`, après la fonction `maybeEnqueueProofRender` (~ligne 200) :

```js
// Phase Recap — quand un message "RECAP:" arrive d'un auteur whitelisté,
// parse les tickers + enqueue un BoomRecap render job. Idempotent :
// max 1 recap par jour (TZ NY) via daily_recaps.date PRIMARY KEY.
//
// Retourne { enqueued: bool, reason?: string, jobId?: number }
async function maybeEnqueueRecap({
  authorName, content, messageCreatedAt, messageId,
  authorWhitelist,
}) {
  // 1. Auteur whitelist
  const whitelistLower = (authorWhitelist || []).map(s => s.toLowerCase());
  if (!whitelistLower.includes((authorName || '').toLowerCase())) {
    return { enqueued: false, reason: 'author_not_whitelisted' };
  }

  // 2. Parse le contenu
  const parsed = parseRecap(content, messageCreatedAt);
  if (!parsed) {
    return { enqueued: false, reason: 'parse_failed' };
  }

  // 3. Idempotence par date — INSERT OR IGNORE retourne false si déjà claim
  const claimed = tryClaimRecapDate(parsed.date, messageId, parsed.tickers.length);
  if (!claimed) {
    return { enqueued: false, reason: 'already_claimed' };
  }

  // 4. Enqueue render job. ticker='RECAP' (placeholder pas significatif),
  //    entry_*/exit_* dupliqués vers le top ticker (le worker ignore tout
  //    ça pour BoomRecap, il lit recap_data à la place).
  const topTicker = parsed.tickers[0].ticker;
  const tsIso = messageCreatedAt.toISOString();
  try {
    const jobId = enqueueRenderJob({
      ticker: 'RECAP',
      entry_author: authorName,
      entry_message: `RECAP for ${parsed.date}`,
      entry_ts: tsIso,
      exit_author: authorName,
      exit_message: `${parsed.tickers.length} wins, ${parsed.runnersHit ?? '?'}/${parsed.runnersTotal ?? '?'} runners`,
      exit_ts: tsIso,
      pnl: `+${Math.round(parsed.totalGainPct)}%`,
      composition: 'BoomRecap',
      template_name: 'recap-default',
      recap_data: JSON.stringify(parsed),
    });
    setRecapRenderJobId(parsed.date, jobId);
    console.log(`[recap] detected for ${parsed.date}, enqueued render_job #${jobId} (${parsed.tickers.length} tickers, top=$${topTicker} +${parsed.tickers[0].gainPct}%)`);
    return { enqueued: true, jobId };
  } catch (err) {
    console.error('[recap] enqueue failed:', err.message);
    return { enqueued: false, reason: 'enqueue_error' };
  }
}
```

**3b. Ajouter les imports** en haut de `discord/handler.js` (chercher la section requires existante ~ligne 25-36) :

```js
const { parseRecap } = require('../utils/parse-recap');
const {
  // ... existing imports ...
  tryClaimRecapDate,
  setRecapRenderJobId,
} = require('../db/sqlite');
```

**3c. Wire-up dans le handler `messageCreate`** — après le check des commandes (`!top`/`!stats`) et avant le filtre BLOCKED_AUTHORS (~ligne 240) :

```js
    // ── Recap auto : si "RECAP:" + auteur whitelisted, render auto ────
    // Idempotent par date NY (max 1×/jour). Ne consume pas le message,
    // on continue le flow normal après si pas matché.
    const recapWhitelist = (process.env.RECAP_AUTHOR_WHITELIST || 'ZZ')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const recapResult = await maybeEnqueueRecap({
      authorName,
      content,
      messageCreatedAt: message.createdAt,
      messageId: message.id,
      authorWhitelist: recapWhitelist,
    });
    if (recapResult.enqueued) {
      // Recap matché et enqueued — log déjà fait dans maybeEnqueueRecap.
      // On ne return PAS car le recap n'est pas un signal trading mais le
      // message n'a pas non plus de signification trading (pas un signal
      // ni un exit). Le flow classifySignal va run et probablement skip.
    }
```

**3d. Exporter `maybeEnqueueRecap`** dans `module.exports` :

```js
module.exports = {
  registerTradingHandler,
  handleTopCommand,
  handleStatsCommand,
  findOriginalAlert,
  formatAnalystEntryEmail,
  maybeEnqueueProofRender,
  maybeEnqueueRecap,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test discord/handler.test.js`
Expected: PASS — all tests including the 5 new ones (14/14 total)

- [ ] **Step 5: Commit**

```bash
git add discord/handler.js discord/handler.test.js
git commit -m "feat(handler): détection auto recap → enqueue BoomRecap render job"
```

---

## Task 5: BoomRecap composition skeleton (Zod schema, calculateMetadata, AbsoluteFill)

**Files:**
- Create: `video/src/compositions/BoomRecap.tsx`
- Modify: `video/src/Root.tsx` (registration)

Skeleton avec les 6 phases en placeholder. Les composants détaillés sont créés dans Tasks 7-12.

- [ ] **Step 1: Create the skeleton composition**

Créer `video/src/compositions/BoomRecap.tsx` :

```tsx
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { z } from 'zod';
import { zTextarea, zColor } from '@remotion/zod-types';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';

const { fontFamily } = loadInter('normal', {
  weights: ['400', '600', '700', '900'],
});

// ─── Zod schema ─────────────────────────────────────────────────────
const recapTickerSchema = z.object({
  ticker:  z.string().describe("Symbol sans le $"),
  gainPct: z.number().describe("Pourcentage de gain (positif)"),
  swing:   z.boolean().default(false),
  isHero:  z.boolean().default(false).describe("≥100% → glow doré"),
});

export const boomRecapSchema = z.object({
  date:          z.string().describe("YYYY-MM-DD ou label custom"),
  dateLabel:     z.string().default("RECAP"),
  tickers:       z.array(recapTickerSchema).min(1).max(20),
  runnersHit:    z.number().nullable().default(null),
  runnersTotal:  z.number().nullable().default(null),
  totalGainPct:  z.number(),
  tagline:       zTextarea().default("Plenty of chances to bank today."),
  ctaText:       z.string().default("Join the channel"),
  ctaUrl:        z.string().default(""),
  accentColor:   zColor().default("#fbbf24"),  // doré pour hero
  successColor:  zColor().default("#10b981"),  // vert pour wins normaux
  bgColor:       zColor().default("#0a0a0f"),
  musicVolume:   z.number().min(0).max(1).default(0.6),
  sfxEnabled:    z.boolean().default(true),
  showTop3Phase: z.boolean().default(true),
  lifestyleSeed: z.number().default(0),
});

export type BoomRecapProps = z.infer<typeof boomRecapSchema>;

// ─── Frame budget par phase ─────────────────────────────────────────
// Ces valeurs sont les durées NOMINALES. calculateMetadata adapte
// dynamiquement la phase 3 (waterfall) selon le nombre de tickers.
export const RECAP_FRAMES = {
  STINGER:    60,   // 2s
  HERO_STAT:  90,   // 3s
  // WATERFALL = dynamique (12-24f par ticker)
  TOP3:      180,   // 6s (skipped si showTop3Phase=false)
  CLOSING:   240,   // 8s
  OUTRO:      90,   // 3s
};

const FPS = 30;
const MIN_FRAMES = 900;   // 30s
const MAX_FRAMES = 1800;  // 60s

// ─── Computed durations helper (réutilisé par calculateMetadata + le composant) ──
export function computeWaterfallFrames(tickers: BoomRecapProps['tickers']) {
  return tickers.reduce((sum, t) => sum + (t.isHero ? 24 : 12), 0);
}

export function computeTotalFrames(props: BoomRecapProps) {
  const waterfall = computeWaterfallFrames(props.tickers);
  const top3 = props.showTop3Phase ? RECAP_FRAMES.TOP3 : 0;
  const total = RECAP_FRAMES.STINGER + RECAP_FRAMES.HERO_STAT + waterfall
              + top3 + RECAP_FRAMES.CLOSING + RECAP_FRAMES.OUTRO;
  return Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, total));
}

// ─── Composition ────────────────────────────────────────────────────
export const BoomRecap: React.FC<BoomRecapProps> = (props) => {
  const { bgColor, musicVolume, sfxEnabled } = props;

  const waterfallFrames = computeWaterfallFrames(props.tickers);
  const top3Frames = props.showTop3Phase ? RECAP_FRAMES.TOP3 : 0;

  let cursor = 0;
  const stingerStart  = cursor; cursor += RECAP_FRAMES.STINGER;
  const heroStart     = cursor; cursor += RECAP_FRAMES.HERO_STAT;
  const waterfallStart = cursor; cursor += waterfallFrames;
  const top3Start     = cursor; cursor += top3Frames;
  const closingStart  = cursor; cursor += RECAP_FRAMES.CLOSING;
  const outroStart    = cursor;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily }}>
      {/* Phase 1: DateStinger — Task 7 le remplit */}
      <Sequence from={stingerStart} durationInFrames={RECAP_FRAMES.STINGER}>
        <PhasePlaceholder label="DATE STINGER" props={props} />
      </Sequence>

      {/* Phase 2: HeroStat — Task 8 */}
      <Sequence from={heroStart} durationInFrames={RECAP_FRAMES.HERO_STAT}>
        <PhasePlaceholder label="HERO STAT" props={props} />
      </Sequence>

      {/* Phase 3: TickerWaterfall — Task 9 */}
      <Sequence from={waterfallStart} durationInFrames={waterfallFrames}>
        <PhasePlaceholder label="WATERFALL" props={props} />
      </Sequence>

      {/* Phase 4: Top3Highlight — Task 10 (conditional) */}
      {props.showTop3Phase && (
        <Sequence from={top3Start} durationInFrames={RECAP_FRAMES.TOP3}>
          <PhasePlaceholder label="TOP 3" props={props} />
        </Sequence>
      )}

      {/* Phase 5: ClosingStat — Task 11 */}
      <Sequence from={closingStart} durationInFrames={RECAP_FRAMES.CLOSING}>
        <PhasePlaceholder label="CLOSING" props={props} />
      </Sequence>

      {/* Phase 6: Outro — Task 12 */}
      <Sequence from={outroStart} durationInFrames={RECAP_FRAMES.OUTRO}>
        <PhasePlaceholder label="OUTRO" props={props} />
      </Sequence>

      {/* Background music (Task 12 finalise le mix) */}
      <Audio src={staticFile('audio/proof-track.mp3')} volume={musicVolume} />
    </AbsoluteFill>
  );
};

// Placeholder visuel simple — affiche le label de la phase + résumé.
// Remplacé phase par phase dans Tasks 7-12.
const PhasePlaceholder: React.FC<{ label: string; props: BoomRecapProps }> = ({ label, props }) => (
  <AbsoluteFill style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 80,
    fontWeight: 900,
    textAlign: 'center',
    padding: 40,
  }}>
    <div>
      <div style={{ color: props.accentColor }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 600, color: '#888', marginTop: 20 }}>
        {props.dateLabel} • {props.date}
      </div>
      <div style={{ fontSize: 24, fontWeight: 400, color: '#666', marginTop: 10 }}>
        {props.tickers.length} tickers, +{Math.round(props.totalGainPct)}% total
      </div>
    </div>
  </AbsoluteFill>
);
```

- [ ] **Step 2: Wire up in Root.tsx**

Modifier `video/src/Root.tsx` :

**2a. Import en haut** :

```tsx
import { BoomRecap, boomRecapSchema, computeTotalFrames } from './compositions/BoomRecap';
```

**2b. Ajouter les defaults** (après `boomProofDefaults`) :

```tsx
const boomRecapDefaults = {
  date: '2026-05-08',
  dateLabel: 'RECAP',
  tickers: [
    { ticker: 'RXT',  gainPct: 380, swing: true,  isHero: true  },
    { ticker: 'REPL', gainPct: 133, swing: true,  isHero: true  },
    { ticker: 'AIIO', gainPct: 71,  swing: false, isHero: false },
    { ticker: 'TDIC', gainPct: 63,  swing: true,  isHero: false },
    { ticker: 'INOD', gainPct: 53,  swing: false, isHero: false },
  ],
  runnersHit:    5,
  runnersTotal:  6,
  totalGainPct:  700,
  tagline:       "Plenty of chances to bank today.",
  ctaText:       "Join the channel",
  ctaUrl:        "https://templeofboom.com/join",
  accentColor:   "#fbbf24",
  successColor:  "#10b981",
  bgColor:       "#0a0a0f",
  musicVolume:   0.6,
  sfxEnabled:    true,
  showTop3Phase: true,
  lifestyleSeed: 0,
};
```

**2c. Ajouter la `<Composition>`** dans le return (après BoomEntry) :

```tsx
      <Composition
        id="BoomRecap"
        component={BoomRecap}
        fps={30}
        width={1080}
        height={1920}
        schema={boomRecapSchema}
        defaultProps={boomRecapDefaults}
        calculateMetadata={({ props }) => ({
          durationInFrames: computeTotalFrames(props as any),
        })}
      />
```

- [ ] **Step 3: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS — pas d'erreur TS

- [ ] **Step 4: Smoke test via Remotion bundler**

Run: `cd video && npx remotion compositions`
Expected: liste affiche `BoomRecap` parmi les compositions disponibles, avec durée 900-1800 frames selon les defaults (5 tickers, 2 hero → 60+90+72+180+240+90 = 732f → clamp à 900f).

- [ ] **Step 5: Commit**

```bash
git add video/src/compositions/BoomRecap.tsx video/src/Root.tsx
git commit -m "feat(video): BoomRecap composition skeleton (schema + calculateMetadata + placeholders)"
```

---

## Task 6: Template JSON + worker recap_data integration

**Files:**
- Create: `video/templates/recap-default.json`
- Modify: `video/scripts/render-worker.ts`

- [ ] **Step 1: Create template JSON**

Créer `video/templates/recap-default.json` :

```json
{
  "name": "Daily Recap (Default)",
  "composition": "BoomRecap",
  "description": "Récap quotidien des wins (auto-trigger sur 'RECAP:' Discord). Doré pour hero wins ≥100%, vert pour wins standards. ~30-45s adapté au nombre de tickers.",
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

- [ ] **Step 2: Modify render-worker.ts to parse recap_data**

Modifier `video/scripts/render-worker.ts` :

**2a. Étendre le type `RenderJob`** (chercher l'`export type RenderJob`) :

```ts
export type RenderJob = {
  // ... existing fields ...
  recap_data?: string | null;
};
```

**2b. Modifier `jobPropsToRemotion`** pour parser `recap_data` quand `composition === 'BoomRecap'` :

```ts
export function jobPropsToRemotion(job: RenderJob) {
  const { id: _id, composition: _comp, proofImageBase64, templateName, recap_data, ...rest } = job;
  const templateProps = loadTemplateProps(templateName) || {};

  // Pour BoomRecap : parse recap_data JSON et remplace les props.
  // Le worker ignore les entry_*/exit_* fields qui sont des placeholders
  // pour BoomRecap (la table render_jobs les exige NOT NULL pour rétrocompat).
  if (job.composition === 'BoomRecap' && recap_data) {
    try {
      const parsed = JSON.parse(recap_data);
      return {
        ...templateProps,
        ...parsed,  // overrides avec date, tickers, runners, tagline, totalGainPct
      };
    } catch (err) {
      console.error('[worker] Failed to parse recap_data:', (err as Error).message);
      // Continue avec template-only props (defaults sortiront depuis le schema Zod)
      return { ...templateProps };
    }
  }

  // Else : flow existant (BoomProof, BoomEntry, etc.)
  const dataUrl = proofImageBase64
    ? `data:image/png;base64,${proofImageBase64}`
    : null;
  return {
    ...templateProps,
    ...rest,
    proofImageDataUrl: dataUrl,
    entryImageDataUrl: dataUrl,
  };
}
```

- [ ] **Step 3: Verify worker typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS — pas d'erreur TS

- [ ] **Step 4: Run worker tests**

Run: `cd video && npm test`
Expected: PASS — tests existants toujours OK (25/25)

- [ ] **Step 5: Commit**

```bash
git add video/templates/recap-default.json video/scripts/render-worker.ts
git commit -m "feat(video): template recap-default.json + worker parse recap_data"
```

---

## Task 7: Phase 1 — `RecapDateStinger`

**Files:**
- Create: `video/src/components/RecapDateStinger.tsx`
- Modify: `video/src/compositions/BoomRecap.tsx` (replace placeholder)

- [ ] **Step 1: Create the component**

Créer `video/src/components/RecapDateStinger.tsx` :

```tsx
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  date: string;          // "2026-05-08"
  dateLabel: string;     // "RECAP"
  accentColor: string;
  sfxEnabled: boolean;
};

// Format "MAY 8" depuis "2026-05-08"
function formatHumanDate(iso: string): string {
  const [, mm, dd] = iso.split('-');
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monthIdx = parseInt(mm, 10) - 1;
  const dayNum = parseInt(dd, 10);
  return `${monthNames[monthIdx]} ${dayNum}`;
}

export const RecapDateStinger: React.FC<Props> = ({ date, dateLabel, accentColor, sfxEnabled }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Flash blanc 0-6 frames
  const flashOpacity = interpolate(frame, [0, 3, 8], [1, 1, 0], {
    extrapolateRight: 'clamp',
  });

  // Texte arrive en spring après le flash
  const textProgress = spring({
    frame: frame - 6,
    fps,
    config: { damping: 12, stiffness: 100 },
  });
  const textScale = interpolate(textProgress, [0, 1], [0.5, 1]);
  const textOpacity = interpolate(frame, [4, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#000',
    }}>
      {/* Flash blanc d'ouverture */}
      <AbsoluteFill style={{
        backgroundColor: '#fff',
        opacity: flashOpacity,
      }} />

      {/* Date + label centré */}
      <div style={{
        transform: `scale(${textScale})`,
        opacity: textOpacity,
        textAlign: 'center',
        zIndex: 2,
      }}>
        <div style={{
          color: '#fff',
          fontSize: 96,
          fontWeight: 900,
          letterSpacing: -2,
          lineHeight: 1,
        }}>
          {formatHumanDate(date)}
        </div>
        <div style={{
          color: accentColor,
          fontSize: 64,
          fontWeight: 700,
          letterSpacing: 4,
          marginTop: 16,
        }}>
          {dateLabel}
        </div>
      </div>

      {/* SFX impact bass au frame 0 */}
      {sfxEnabled && (
        <Audio
          src={staticFile('audio/impact-bass.mp3')}
          volume={1.0}
          startFrom={0}
        />
      )}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Replace placeholder in BoomRecap.tsx**

Dans `video/src/compositions/BoomRecap.tsx` :

**2a. Import** en haut (après les autres imports) :

```tsx
import { RecapDateStinger } from '../components/RecapDateStinger';
```

**2b. Remplacer la Sequence Phase 1** :

```tsx
      {/* Phase 1: DateStinger */}
      <Sequence from={stingerStart} durationInFrames={RECAP_FRAMES.STINGER}>
        <RecapDateStinger
          date={props.date}
          dateLabel={props.dateLabel}
          accentColor={props.accentColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>
```

- [ ] **Step 3: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Render preview frame to validate visually**

Run: `cd video && npx remotion still BoomRecap stinger-preview.png --frame=15`
Expected: PNG `stinger-preview.png` créé. Ouvrir : montre "MAY 8" + "RECAP" centré sur fond noir.

- [ ] **Step 5: Commit**

```bash
git add video/src/components/RecapDateStinger.tsx video/src/compositions/BoomRecap.tsx
git commit -m "feat(video): RecapDateStinger phase 1 (flash + date + SFX impact)"
```

---

## Task 8: Phase 2 — `RecapHeroStat` (counter animé)

**Files:**
- Create: `video/src/components/RecapHeroStat.tsx`
- Modify: `video/src/compositions/BoomRecap.tsx`

- [ ] **Step 1: Create the component**

Créer `video/src/components/RecapHeroStat.tsx` :

```tsx
import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame } from 'remotion';

type Props = {
  totalGainPct: number;
  accentColor: string;
  sfxEnabled: boolean;
};

export const RecapHeroStat: React.FC<Props> = ({ totalGainPct, accentColor, sfxEnabled }) => {
  const frame = useCurrentFrame();

  // Counter qui monte de 0 à totalGainPct sur 60 frames (2s)
  // ease-out cubic pour ralentir vers la fin
  const t = Math.min(1, frame / 60);
  const easeOut = 1 - Math.pow(1 - t, 3);
  const displayedValue = Math.round(totalGainPct * easeOut);

  // Subtitle slide-in après le counter
  const subtitleOpacity = interpolate(frame, [55, 75], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Subtle pulse sur le number final
  const pulseScale = frame > 60
    ? 1 + 0.04 * Math.sin((frame - 60) / 6)
    : 1;

  return (
    <AbsoluteFill style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      backgroundColor: '#0a0a0f',
    }}>
      <div style={{
        color: accentColor,
        fontSize: 220,
        fontWeight: 900,
        letterSpacing: -8,
        lineHeight: 1,
        textShadow: `0 0 60px ${accentColor}66`,
        transform: `scale(${pulseScale})`,
      }}>
        +{displayedValue}%
      </div>
      <div style={{
        color: '#aaa',
        fontSize: 36,
        fontWeight: 700,
        letterSpacing: 4,
        marginTop: 24,
        opacity: subtitleOpacity,
      }}>
        TOTAL GAINS TODAY
      </div>

      {sfxEnabled && (
        <Audio
          src={staticFile('audio/whoosh-1.mp3')}
          volume={0.7}
          startFrom={0}
        />
      )}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Replace placeholder in BoomRecap.tsx**

```tsx
import { RecapHeroStat } from '../components/RecapHeroStat';
```

```tsx
      {/* Phase 2: HeroStat */}
      <Sequence from={heroStart} durationInFrames={RECAP_FRAMES.HERO_STAT}>
        <RecapHeroStat
          totalGainPct={props.totalGainPct}
          accentColor={props.accentColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>
```

- [ ] **Step 3: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Render preview frame**

Run: `cd video && npx remotion still BoomRecap hero-preview.png --frame=120`
Expected: PNG montre "+700%" en gros doré centré (avec defaults Root.tsx).

- [ ] **Step 5: Commit**

```bash
git add video/src/components/RecapHeroStat.tsx video/src/compositions/BoomRecap.tsx
git commit -m "feat(video): RecapHeroStat phase 2 (counter animé +X% total)"
```

---

## Task 9: Phase 3 — `RecapTickerWaterfall` + `RecapTickerCard`

**Files:**
- Create: `video/src/components/RecapTickerCard.tsx`
- Create: `video/src/components/RecapTickerWaterfall.tsx`
- Modify: `video/src/compositions/BoomRecap.tsx`

- [ ] **Step 1: Create RecapTickerCard component (sous-composant carte)**

Créer `video/src/components/RecapTickerCard.tsx` :

```tsx
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  ticker: string;
  gainPct: number;
  swing: boolean;
  isHero: boolean;
  startFrame: number;       // frame absolu où la carte apparaît
  durationFrames: number;   // durée pendant laquelle elle anime (12 ou 24)
  accentColor: string;      // doré pour hero
  successColor: string;     // vert pour standard
  yPosition: number;        // px depuis le top
};

export const RecapTickerCard: React.FC<Props> = ({
  ticker, gainPct, swing, isHero,
  startFrame, durationFrames,
  accentColor, successColor, yPosition,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = frame - startFrame;
  if (localFrame < 0) return null;  // pas encore apparu

  // Spring slide-in depuis la droite
  const slideProgress = spring({
    frame: localFrame,
    fps,
    config: { damping: isHero ? 8 : 12, stiffness: isHero ? 120 : 200 },
  });
  const translateX = interpolate(slideProgress, [0, 1], [600, 0]);
  const opacity = interpolate(localFrame, [0, 4], [0, 1], {
    extrapolateRight: 'clamp',
  });

  // Hero pulse glow continu
  const glowIntensity = isHero
    ? 0.5 + 0.3 * Math.sin(localFrame / 4)
    : 0;

  const bgColor = isHero ? `${accentColor}22` : `${successColor}18`;
  const borderColor = isHero ? accentColor : successColor;
  const textColor = isHero ? accentColor : successColor;
  const cardHeight = isHero ? 140 : 100;

  return (
    <div style={{
      position: 'absolute',
      top: yPosition,
      left: 60,
      right: 60,
      height: cardHeight,
      transform: `translateX(${translateX}px)`,
      opacity,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 40px',
      backgroundColor: bgColor,
      border: `2px solid ${borderColor}`,
      borderRadius: 16,
      boxShadow: isHero ? `0 0 ${40 + glowIntensity * 40}px ${accentColor}88` : 'none',
    }}>
      <div style={{
        color: '#fff',
        fontSize: isHero ? 64 : 48,
        fontWeight: 900,
        letterSpacing: -1,
      }}>
        ${ticker}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div style={{
          color: textColor,
          fontSize: isHero ? 64 : 48,
          fontWeight: 900,
        }}>
          +{gainPct}%
        </div>
        {swing && (
          <div style={{
            color: '#888',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 2,
          }}>
            SWING
          </div>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Create RecapTickerWaterfall (orchestrateur)**

Créer `video/src/components/RecapTickerWaterfall.tsx` :

```tsx
import { AbsoluteFill, Audio, staticFile } from 'remotion';
import { RecapTickerCard } from './RecapTickerCard';

type TickerData = {
  ticker: string;
  gainPct: number;
  swing: boolean;
  isHero: boolean;
};

type Props = {
  tickers: TickerData[];
  accentColor: string;
  successColor: string;
  sfxEnabled: boolean;
};

const CARD_HEIGHT_HERO = 140;
const CARD_HEIGHT_NORMAL = 100;
const CARD_GAP = 16;
const TOP_OFFSET = 100;
const HERO_DURATION = 24;
const NORMAL_DURATION = 12;

export const RecapTickerWaterfall: React.FC<Props> = ({
  tickers, accentColor, successColor, sfxEnabled,
}) => {
  // Calcule offset cumulés (frame de début + position Y)
  let frameCursor = 0;
  let yCursor = TOP_OFFSET;
  const positioned = tickers.map(t => {
    const startFrame = frameCursor;
    const durationFrames = t.isHero ? HERO_DURATION : NORMAL_DURATION;
    const yPosition = yCursor;
    const cardHeight = t.isHero ? CARD_HEIGHT_HERO : CARD_HEIGHT_NORMAL;

    frameCursor += durationFrames;
    yCursor += cardHeight + CARD_GAP;

    return { ...t, startFrame, durationFrames, yPosition };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0f' }}>
      {positioned.map((t, i) => (
        <RecapTickerCard
          key={`${t.ticker}-${t.gainPct}-${i}`}
          ticker={t.ticker}
          gainPct={t.gainPct}
          swing={t.swing}
          isHero={t.isHero}
          startFrame={t.startFrame}
          durationFrames={t.durationFrames}
          accentColor={accentColor}
          successColor={successColor}
          yPosition={t.yPosition}
        />
      ))}

      {/* SFX whoosh sur chaque ticker drop */}
      {sfxEnabled && positioned.map((t, i) => (
        <Audio
          key={`sfx-${i}`}
          src={staticFile(t.isHero ? 'audio/chaching.mp3' : 'audio/whoosh-2.mp3')}
          volume={t.isHero ? 0.8 : 0.5}
          startFrom={t.startFrame}
        />
      ))}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Replace placeholder in BoomRecap.tsx**

```tsx
import { RecapTickerWaterfall } from '../components/RecapTickerWaterfall';
```

```tsx
      {/* Phase 3: TickerWaterfall */}
      <Sequence from={waterfallStart} durationInFrames={waterfallFrames}>
        <RecapTickerWaterfall
          tickers={props.tickers}
          accentColor={props.accentColor}
          successColor={props.successColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>
```

- [ ] **Step 4: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Render preview at mid-waterfall**

Run: `cd video && npx remotion still BoomRecap waterfall-preview.png --frame=200`
Expected: PNG montre les 2 hero RXT + REPL en cards dorées + AIIO en card verte commençant à apparaître.

- [ ] **Step 6: Commit**

```bash
git add video/src/components/RecapTickerCard.tsx video/src/components/RecapTickerWaterfall.tsx video/src/compositions/BoomRecap.tsx
git commit -m "feat(video): RecapTickerWaterfall phase 3 (cards stack + hero glow)"
```

---

## Task 10: Phase 4 — `RecapTop3Highlight`

**Files:**
- Create: `video/src/components/RecapTop3Highlight.tsx`
- Modify: `video/src/compositions/BoomRecap.tsx`

- [ ] **Step 1: Create the component**

Créer `video/src/components/RecapTop3Highlight.tsx` :

```tsx
import { AbsoluteFill, Audio, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

type TickerData = {
  ticker: string;
  gainPct: number;
  swing: boolean;
  isHero: boolean;
};

type Props = {
  tickers: TickerData[];   // top 3 sortés desc déjà
  accentColor: string;
  lifestyleSeed: number;
  sfxEnabled: boolean;
};

const PHASE_DURATION = 180;  // 6s
const CARD_DURATION = 60;    // 2s par carte

// Pool de 30 photos lifestyle (reuse l'existant)
const LIFESTYLE_POOL = Array.from({ length: 30 }, (_, i) =>
  staticFile(`lifestyle/${String(i + 1).padStart(2, '0')}.jpg`)
);

function pickLifestyle(seed: number, idx: number): string {
  const offset = (seed + idx * 7) % LIFESTYLE_POOL.length;
  return LIFESTYLE_POOL[offset];
}

export const RecapTop3Highlight: React.FC<Props> = ({
  tickers, accentColor, lifestyleSeed, sfxEnabled,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const top3 = tickers.slice(0, 3);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {top3.map((t, i) => {
        const cardStart = i * CARD_DURATION;
        const localFrame = frame - cardStart;
        if (localFrame < 0 || localFrame >= CARD_DURATION) return null;

        const opacity = interpolate(localFrame, [0, 6, CARD_DURATION - 8, CARD_DURATION], [0, 1, 1, 0]);
        const dollyZoom = 1 + 0.15 * (localFrame / CARD_DURATION);  // slow zoom-in

        return (
          <AbsoluteFill key={i} style={{ opacity }}>
            {/* Background lifestyle photo */}
            <Img
              src={pickLifestyle(lifestyleSeed, i)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: `scale(${dollyZoom})`,
                filter: 'brightness(0.4) saturate(1.2)',
              }}
            />

            {/* Centered text overlay */}
            <AbsoluteFill style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              padding: 60,
            }}>
              <div style={{
                color: '#fff',
                fontSize: 42,
                fontWeight: 700,
                letterSpacing: 6,
                marginBottom: 20,
                opacity: 0.7,
              }}>
                #{i + 1} TODAY
              </div>
              <div style={{
                color: '#fff',
                fontSize: 200,
                fontWeight: 900,
                letterSpacing: -6,
                lineHeight: 1,
              }}>
                ${t.ticker}
              </div>
              <div style={{
                color: accentColor,
                fontSize: 160,
                fontWeight: 900,
                letterSpacing: -4,
                marginTop: 20,
                textShadow: `0 0 80px ${accentColor}aa`,
              }}>
                +{t.gainPct}%
              </div>
              {t.swing && (
                <div style={{
                  color: '#fff',
                  fontSize: 28,
                  fontWeight: 700,
                  letterSpacing: 4,
                  marginTop: 16,
                  padding: '8px 24px',
                  background: `${accentColor}33`,
                  borderRadius: 8,
                }}>
                  SWING
                </div>
              )}
            </AbsoluteFill>
          </AbsoluteFill>
        );
      })}

      {sfxEnabled && top3.map((_, i) => (
        <Audio
          key={`sfx-${i}`}
          src={staticFile('audio/whoosh-1.mp3')}
          volume={0.6}
          startFrom={i * CARD_DURATION}
        />
      ))}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Replace placeholder in BoomRecap.tsx**

```tsx
import { RecapTop3Highlight } from '../components/RecapTop3Highlight';
```

```tsx
      {/* Phase 4: Top3Highlight (conditional) */}
      {props.showTop3Phase && (
        <Sequence from={top3Start} durationInFrames={RECAP_FRAMES.TOP3}>
          <RecapTop3Highlight
            tickers={props.tickers}
            accentColor={props.accentColor}
            lifestyleSeed={props.lifestyleSeed}
            sfxEnabled={props.sfxEnabled}
          />
        </Sequence>
      )}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Render preview**

Run: `cd video && npx remotion still BoomRecap top3-preview.png --frame=380`
Expected: PNG montre RXT en hero card sur fond lifestyle photo darkené (avec defaults Root.tsx).

- [ ] **Step 5: Commit**

```bash
git add video/src/components/RecapTop3Highlight.tsx video/src/compositions/BoomRecap.tsx
git commit -m "feat(video): RecapTop3Highlight phase 4 (lifestyle bg + dolly zoom)"
```

---

## Task 11: Phase 5 — `RecapClosingStat` (X/Y runners + tagline + CTA)

**Files:**
- Create: `video/src/components/RecapClosingStat.tsx`
- Modify: `video/src/compositions/BoomRecap.tsx`

- [ ] **Step 1: Create the component**

Créer `video/src/components/RecapClosingStat.tsx` :

```tsx
import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  runnersHit: number | null;
  runnersTotal: number | null;
  tagline: string;
  ctaText: string;
  ctaUrl: string;
  accentColor: string;
  sfxEnabled: boolean;
};

export const RecapClosingStat: React.FC<Props> = ({
  runnersHit, runnersTotal, tagline, ctaText, ctaUrl,
  accentColor, sfxEnabled,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Spring big reveal pour le runners ratio
  const ratioSpring = spring({
    frame: frame - 6,
    fps,
    config: { damping: 8, stiffness: 80 },
  });
  const ratioScale = interpolate(ratioSpring, [0, 1], [0.4, 1]);
  const ratioOpacity = interpolate(frame, [4, 16], [0, 1], { extrapolateRight: 'clamp' });

  // Tagline arrive plus tard
  const taglineOpacity = interpolate(frame, [60, 80], [0, 1], { extrapolateRight: 'clamp' });

  // CTA en dernier
  const ctaOpacity = interpolate(frame, [120, 140], [0, 1], { extrapolateRight: 'clamp' });

  const hasRunners = runnersHit !== null && runnersTotal !== null;

  return (
    <AbsoluteFill style={{
      backgroundColor: '#0a0a0f',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 60,
    }}>
      {hasRunners && (
        <div style={{
          textAlign: 'center',
          transform: `scale(${ratioScale})`,
          opacity: ratioOpacity,
        }}>
          <div style={{
            color: '#fff',
            fontSize: 280,
            fontWeight: 900,
            letterSpacing: -10,
            lineHeight: 1,
          }}>
            <span style={{ color: accentColor }}>{runnersHit}</span>
            <span style={{ color: '#666', fontSize: 200 }}> / </span>
            <span style={{ color: '#fff' }}>{runnersTotal}</span>
          </div>
          <div style={{
            color: '#aaa',
            fontSize: 42,
            fontWeight: 700,
            letterSpacing: 6,
            marginTop: 20,
          }}>
            RUNNERS HIT
          </div>
        </div>
      )}

      <div style={{
        color: '#ddd',
        fontSize: 38,
        fontWeight: 600,
        textAlign: 'center',
        maxWidth: 900,
        marginTop: 60,
        opacity: taglineOpacity,
        lineHeight: 1.3,
      }}>
        {tagline}
      </div>

      {ctaUrl && (
        <div style={{
          marginTop: 80,
          opacity: ctaOpacity,
          textAlign: 'center',
        }}>
          <div style={{
            color: accentColor,
            fontSize: 56,
            fontWeight: 900,
            padding: '20px 48px',
            background: `${accentColor}22`,
            border: `3px solid ${accentColor}`,
            borderRadius: 16,
            display: 'inline-block',
            boxShadow: `0 0 60px ${accentColor}66`,
          }}>
            {ctaText}
          </div>
          <div style={{
            color: '#888',
            fontSize: 24,
            fontWeight: 600,
            marginTop: 16,
          }}>
            {ctaUrl}
          </div>
        </div>
      )}

      {sfxEnabled && (
        <Audio
          src={staticFile('audio/impact-bass.mp3')}
          volume={0.9}
          startFrom={6}
        />
      )}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Replace placeholder in BoomRecap.tsx**

```tsx
import { RecapClosingStat } from '../components/RecapClosingStat';
```

```tsx
      {/* Phase 5: ClosingStat */}
      <Sequence from={closingStart} durationInFrames={RECAP_FRAMES.CLOSING}>
        <RecapClosingStat
          runnersHit={props.runnersHit}
          runnersTotal={props.runnersTotal}
          tagline={props.tagline}
          ctaText={props.ctaText}
          ctaUrl={props.ctaUrl}
          accentColor={props.accentColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>
```

- [ ] **Step 3: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Render preview at end of closing**

Run: `cd video && npx remotion still BoomRecap closing-preview.png --frame=720`
Expected: PNG montre "5/6" en gros doré avec tagline et CTA visibles.

- [ ] **Step 5: Commit**

```bash
git add video/src/components/RecapClosingStat.tsx video/src/compositions/BoomRecap.tsx
git commit -m "feat(video): RecapClosingStat phase 5 (runners ratio + tagline + CTA)"
```

---

## Task 12: Phase 6 — `RecapOutro` + audio mix finalisation

**Files:**
- Create: `video/src/components/RecapOutro.tsx`
- Modify: `video/src/compositions/BoomRecap.tsx`

- [ ] **Step 1: Create the component**

Créer `video/src/components/RecapOutro.tsx` :

```tsx
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

type Props = {
  accentColor: string;
};

export const RecapOutro: React.FC<Props> = ({ accentColor }) => {
  const frame = useCurrentFrame();

  // Slow zoom-in continu sur le logo
  const scale = 1 + 0.1 * (frame / 90);

  // Fade-in puis hold
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      backgroundColor: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        transform: `scale(${scale})`,
        opacity,
        textAlign: 'center',
      }}>
        <div style={{
          color: accentColor,
          fontSize: 160,
          fontWeight: 900,
          letterSpacing: -8,
          textShadow: `0 0 100px ${accentColor}aa`,
          lineHeight: 1,
        }}>
          BOOM
        </div>
        <div style={{
          color: '#666',
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: 8,
          marginTop: 20,
        }}>
          DAILY RECAP
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Replace placeholder in BoomRecap.tsx**

```tsx
import { RecapOutro } from '../components/RecapOutro';
```

```tsx
      {/* Phase 6: Outro */}
      <Sequence from={outroStart} durationInFrames={RECAP_FRAMES.OUTRO}>
        <RecapOutro accentColor={props.accentColor} />
      </Sequence>
```

**Audio fade-out final** : modifier la balise `<Audio>` du background music pour fade-out sur les dernières frames :

```tsx
      <Audio
        src={staticFile('audio/proof-track.mp3')}
        volume={(f) => {
          const totalFrames = computeTotalFrames(props);
          const fadeStart = totalFrames - 60;
          if (f < fadeStart) return musicVolume;
          return interpolate(f, [fadeStart, totalFrames], [musicVolume, 0], { extrapolateRight: 'clamp' });
        }}
      />
```

Note : il faut importer `interpolate` en haut du fichier (`import { ..., interpolate } from 'remotion'`).

- [ ] **Step 3: Verify typecheck**

Run: `cd video && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Render preview frame**

Run: `cd video && npx remotion still BoomRecap outro-preview.png --frame=850`
Expected: PNG montre "BOOM" + "DAILY RECAP" centrés en doré sur fond noir.

- [ ] **Step 5: Render full video end-to-end**

Run: `cd video && npx remotion render BoomRecap boom-recap-full.mp4`
Expected:
- Render complète (~30s) sans erreur
- MP4 généré avec les 6 phases visibles
- Durée ~30s (5 tickers + showTop3=true → 900f minimum après clamp)

- [ ] **Step 6: Commit**

```bash
git add video/src/components/RecapOutro.tsx video/src/compositions/BoomRecap.tsx
git commit -m "feat(video): RecapOutro phase 6 + audio fade-out, render E2E OK"
```

---

## Task 13: Test E2E backend (sans render)

**Files:**
- Modify: `discord/handler.test.js` (test E2E avec stub Discord client)

Vérifier que le pipeline complet handler → parse → DB → enqueue tient ensemble.

- [ ] **Step 1: Add E2E test**

Ajouter à la fin de `discord/handler.test.js` :

```js
// ─── E2E : registerTradingHandler avec un message recap ─────────────
test('registerTradingHandler enqueue un BoomRecap quand ZZ post un RECAP:', async () => {
  // Mock minimal d'un Discord client + message
  const handlers = {};
  const fakeClient = {
    on: (event, fn) => { handlers[event] = fn; },
  };
  const fakeMessage = {
    content: ZZ_RECAP,
    author: { username: 'ZZ', bot: false },
    webhookId: null,
    channel: {
      name: 'trading-floor',
      messages: { fetch: async () => null },
      send: async () => ({ id: 'sent-123' }),
    },
    createdAt: new Date('2026-07-01T19:44:00Z'),
    id: 'e2e-msg-1',
    reference: null,
    reply: async () => {},
  };

  const { registerTradingHandler } = require('./handler');
  registerTradingHandler(fakeClient, {
    tradingChannel: 'trading-floor',
    railwayUrl: 'https://test.example',
    makeWebhookUrl: 'https://test.example/webhook',
    tradingEngine: null,
    sendEmailAlert: null,
  });

  // Set whitelist via env (note : process.env modifs entre tests OK ici)
  const prevWhitelist = process.env.RECAP_AUTHOR_WHITELIST;
  process.env.RECAP_AUTHOR_WHITELIST = 'ZZ';

  const before = getPendingRenderJobs().length;
  await handlers.messageCreate(fakeMessage);
  const after = getPendingRenderJobs();

  // Restore env
  if (prevWhitelist === undefined) delete process.env.RECAP_AUTHOR_WHITELIST;
  else process.env.RECAP_AUTHOR_WHITELIST = prevWhitelist;

  // Devrait avoir enqueued exactement 1 job BoomRecap
  const newJobs = after.slice(before);
  const recapJobs = newJobs.filter(j => j.composition === 'BoomRecap');
  assert.strictEqual(recapJobs.length, 1, 'should enqueue exactly one BoomRecap job');
  assert.ok(recapJobs[0].recap_data, 'recap_data should be populated');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test discord/handler.test.js`
Expected: PASS — tous les tests + le E2E

- [ ] **Step 3: Run full test suite to ensure no regression**

Run: `cd /c/Users/willi/Documents/GitHub/discord-trading-bot && npm test`
Expected: PASS — 516+/517+ (le 1 fail "cleanup tmpDir" Windows-only OK)

- [ ] **Step 4: Run video tests**

Run: `cd video && npm test`
Expected: PASS — 25/25 (les tests existants ne doivent pas régresser)

- [ ] **Step 5: Commit**

```bash
git add discord/handler.test.js
git commit -m "test(handler): E2E recap registration → enqueue BoomRecap"
```

---

## Task 14: Manuel — vérifier env vars Railway + test live

**Pas de code dans cette task — étapes manuelles utilisateur.**

⚠️ **Manual steps requis avant que la fonctionnalité soit live** :

- [ ] **Step 1: Vérifier `RECAP_AUTHOR_WHITELIST` sur Railway** (optionnel)

Sur Railway → service `discord-trading-bot` → Variables :
- Si absent → défaut `ZZ` appliqué automatiquement, **rien à faire**.
- Si tu veux étendre : ajouter `RECAP_AUTHOR_WHITELIST=ZZ,Z,Protrader Alerts` (CSV, espaces autour des virgules tolérés).

- [ ] **Step 2: Vérifier `RENDER_OUTPUT_CHANNEL_ID`**

Le MP4 se postera dans ce canal. Doit déjà exister (utilisé par BoomProof). Vérifier que le bot Railway a accès :
- Le bot est membre du serveur contenant le canal
- Permissions canal : `View Channel`, `Send Messages`, `Attach Files`

- [ ] **Step 3: Worker local doit tourner**

```powershell
$env:BOT_URL = 'https://templeofboom.up.railway.app'
$env:RENDER_WORKER_TOKEN = 'e5511e0dc33a3b03cd322b222f7398a09fe49a2eeb1e1c1cb20f78435dd922a0'
cd C:\Users\willi\Documents\GitHub\discord-trading-bot\video
npm run worker
```

Vérifier dans le terminal : `[worker] polling /api/render-queue every 30s`.

- [ ] **Step 4: Push + déployer**

```bash
git push
```
Railway auto-redéploie sur push (~2-5 min).

- [ ] **Step 5: Test live avec un faux recap**

Depuis le compte ZZ (ou un compte whitelisté), poster dans `#trading-floor` :

```
RECAP:

$AAPL 50% swing
$TSLA 30%
$NVDA 25%

Plenty of chances to bank today. Our WL gave us 3 out of 4 runners.
```

Vérifier dans les logs Railway :
- `[recap] detected for 2026-XX-XX, enqueued render_job #N (3 tickers, top=$AAPL +50%)`

Vérifier sur le PC local (terminal worker) :
- `[worker] processing job N (RECAP +105%)`
- Render Remotion (~20-40s)
- `[worker] uploaded MP4 to bot, msg_id=...`

Vérifier dans Discord, canal `RENDER_OUTPUT_CHANNEL_ID` :
- MP4 ~30s posté avec date/wins/runners/CTA visibles

- [ ] **Step 6: Test idempotence**

Re-poster un autre RECAP: dans `#trading-floor` la même journée. Vérifier dans les logs Railway :
- Pas de `[recap] detected` second log
- Pas de second job enqueued

Pour un re-render forcé (ex: ZZ a corrigé son recap) :
```sql
DELETE FROM daily_recaps WHERE date = '2026-XX-XX';
```
Via `/db-viewer` (dashboard) ou Railway shell. Ensuite, repost le message Discord.

---

## Critères de complétion

- ✅ Suite de tests passe : `npm test` + `cd video && npm test` (sauf Windows-only flake `cleanup tmpDir`)
- ✅ Manual test live (Task 14) : un RECAP: posté par ZZ → MP4 dans le canal Discord ~5 min plus tard
- ✅ Idempotence vérifiée : 2× RECAP même jour → 1 seul render
- ✅ Aucune régression sur BoomProof / BoomEntry (les renders existants continuent de fonctionner)

---

## Notes pour le développeur

**Frequent commits :** chaque task se termine par un commit. Si tu as des doutes sur un point, commit en intermédiaire avant de demander.

**Phased extraction validée :** ce plan suit la convention "un module par phase, syntax+smoke check entre" (cf. memory note utilisateur). Tu peux t'arrêter après Task 6 et avoir un pipeline fonctionnel avec visuels placeholder pour valider l'E2E avant d'attaquer les visuels (Tasks 7-12).

**English vs French :** les commits/code/comments restent en français (convention codebase). Les strings user-facing dans Discord doivent être en anglais — pour BoomRecap c'est OK : tout le contenu vient du message Discord (déjà en anglais) ou des labels hardcodés en anglais (`TOTAL GAINS TODAY`, `RUNNERS HIT`, `DAILY RECAP`).

**Style Remotion :** suivre les patterns BoomProof/BoomEntry existants — un composant par phase dans `video/src/components/`, schema Zod expressif, calculateMetadata pour duration adaptive.
