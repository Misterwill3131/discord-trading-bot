# FMP `/stable/` Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Débloquer le bot en migrant `fmp-client.js` (REST) et `fmp-ws-client.js` (WebSocket) de v3/v4 vers `/stable/` et passer les alertes milestone au format compact `🚀 (AAPL 200.00-240.00) +20% — by @analyst`.

**Architecture :** Rewrite ciblé. Trois fichiers de prod (`discord/fmp-client.js`, `discord/fmp-ws-client.js`, `discord/milestone-checker.js`) et leurs tests miroirs. Pas de feature flag — l'ancienne API v3 retourne 403 en prod, donc on supprime le code v3. Le contrat externe des modules (signatures `getQuote/getQuotesBulk/getDailyBars`, événement WS `trade`, fonction `buildAlertMessage`) ne change pas pour limiter le blast radius.

**Tech Stack :** Node 18+ avec `fetch` global et `node:test`, `ws@8` pour le WebSocket, Discord.js v14.

**Spec :** `docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md`

**Worktree :** `.claude/worktrees/fmp-stable-migration` sur la branche `feat/fmp-stable-migration`.

**Commandes utiles :**
- Tous les tests : `npm test`
- Un seul test file : `node --test discord/fmp-client.test.js`
- Un test précis : `node --test --test-name-pattern="getQuote returns" discord/fmp-client.test.js`

---

## Task 0 : Baseline tests (sanity check)

S'assurer que la suite passe avant toute modif. Si elle ne passe pas déjà, on doit corriger ça d'abord — le but du refactor est de mettre à jour le code sans casser ce qui marche.

**Files :** aucun

- [ ] **Step 1 : Lancer la suite complète**

```bash
npm test
```

Expected : tous les tests passent. Si un test échoue déjà avant nos changements, **STOP** et signaler au reviewer humain — on n'introduit pas ces changements sur une suite cassée.

---

## Task 1 : Migrer `getQuote` vers `/stable/quote`

**Files :**
- Modify: `discord/fmp-client.js:36` (constante `FMP_BASE`)
- Modify: `discord/fmp-client.js:101-102` (URL dans `getQuote`)
- Modify: `discord/fmp-client.test.js:57, 67, 75, 93, 106` (5 URLs `v3/quote/...`)

- [ ] **Step 1 : Mettre à jour les 5 URLs v3 vers `/stable/` dans `fmp-client.test.js`**

Replace toutes les occurrences de `'https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=KEY'` par `'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=KEY'`, et idem pour `XXXX`.

Le fichier contient 5 URLs à changer :

```js
// Avant (5 occurrences) :
'https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=KEY'
'https://financialmodelingprep.com/api/v3/quote/XXXX?apikey=KEY'

// Après :
'https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=KEY'
'https://financialmodelingprep.com/stable/quote?symbol=XXXX&apikey=KEY'
```

Concrètement dans le fichier :
- Ligne 57 : route fixture du test `getQuote returns { price, volume }`
- Ligne 67 : route fixture du test `getQuote returns null for empty`
- Ligne 75 : route fixture du test `getQuote caches within TTL`
- Ligne 93 : route fixture du test `getQuote dedupes concurrent`
- Ligne 106 : route fixture du test `getQuote propagates HTTP errors`

- [ ] **Step 2 : Lancer les tests `getQuote` et vérifier qu'ils échouent**

```bash
node --test --test-name-pattern="^getQuote" discord/fmp-client.test.js
```

Expected : Tous les tests `getQuote*` échouent avec `fmp HTTP 404: no route` (le faux fetcher renvoie 404 pour les URLs qu'il ne connaît pas, et le code prod tape toujours sur l'URL v3 obsolète).

- [ ] **Step 3 : Mettre à jour `FMP_BASE` dans `fmp-client.js`**

```js
// discord/fmp-client.js:36
const FMP_BASE = 'https://financialmodelingprep.com/stable';
```

- [ ] **Step 4 : Mettre à jour `getQuote` pour utiliser `?symbol=` au lieu de path-param**

```js
// discord/fmp-client.js:101-102 (dans getQuote)
const url = base + '/quote?symbol=' + encodeURIComponent(key)
  + '&apikey=' + encodeURIComponent(apiKey);
```

Le reste du corps de `getQuote` (cache, inflight, parsing) ne change pas — `/stable/quote` retourne le même shape `[{symbol, price, volume, ...}]`.

- [ ] **Step 5 : Lancer les tests `getQuote` et vérifier qu'ils passent**

```bash
node --test --test-name-pattern="^getQuote" discord/fmp-client.test.js
```

Expected : tous les tests `getQuote*` passent (6 tests : returns, returns null, caches, dedupes, propagates errors, does NOT cache failures).

- [ ] **Step 6 : Mettre à jour le commentaire d'en-tête de `fmp-client.js`**

Remplace les lignes 1-34 du fichier `discord/fmp-client.js` par :

```js
// ─────────────────────────────────────────────────────────────────────
// discord/fmp-client.js — Client Financial Modeling Prep (FMP) /stable/
// ─────────────────────────────────────────────────────────────────────
// Wrapper minimal autour de l'API FMP pour les alertes prix/volume.
// Conforme au contrat marketClient attendu par discord/market-alerts.js :
//
//   getQuote(ticker)     → { price: number, volume: number }
//   getDailyBars(ticker) → [{ date: Date, open, high, low, close, volume }, ...]
//                          (ordre chronologique CROISSANT — plus ancien en
//                          premier, comme attendu par extractContext())
//
// Endpoints utilisés (FMP /stable/, migré le 2026-05-15) :
//   GET /stable/quote?symbol={s}
//     → [{ symbol, price, volume, dayLow, dayHigh, changePercentage, ... }]
//   GET /stable/batch-quote?symbols={s1},{s2},...
//     → same shape as /stable/quote
//   GET /stable/historical-price-eod/full?symbol={s}
//     → [{ symbol, date: 'YYYY-MM-DD', open, high, low, close, volume }, ...]
//     Array plat (plus de wrapper {historical}). Newest-first chez FMP →
//     on inverse pour l'ordre attendu et on slice à 10 dernières barres.
//
// Auth : query param `apikey=...`. Plan free = ~250 req/jour ; on cache
// agressivement (TTL 30s sur les quotes, idem chart) pour rester sous
// le quota. La pacing finale est gérée par le caller (cadence 5min en
// free-tier au lieu de 60s).
//
// Robustesse :
//   - Timeout 10s par défaut (Promise.race) — évite qu'une coupure réseau
//     bloque le scheduler.
//   - Dedup des appels concurrents pour le même ticker (in-flight Map)
//     → si 2 ticks arrivent en parallèle, un seul HTTP fire.
//   - Pas de retry interne — le caller (market-alerts) catche les erreurs
//     et continue avec le ticker suivant.
//
// Tests : injection via `fetch` (Node 18+ a fetch global ; fallback léger
// pour les tests qui passent un mock).
// ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 7 : Commit**

```bash
git add discord/fmp-client.js discord/fmp-client.test.js
git commit -m "$(cat <<'EOF'
feat(fmp): migrate getQuote to /stable/quote

Switch FMP_BASE to https://financialmodelingprep.com/stable and rewrite
getQuote URL from path-param /api/v3/quote/{s} to query-param
/stable/quote?symbol={s}. Response shape unchanged ([{symbol, price,
volume, ...}]) so the parser stays. Updates 5 test fixtures and header
docstring.

Refs spec docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 : Migrer `getQuotesBulk` vers `/stable/batch-quote`

**Files :**
- Modify: `discord/fmp-client.js:181-182` (URL dans `getQuotesBulk`)
- Modify: `discord/fmp-client.test.js:209, 222, 234` (assertions sur l'URL capturée)

- [ ] **Step 1 : Mettre à jour les assertions URL dans `fmp-client.test.js`**

Trois tests `getQuotesBulk*` capturent l'URL et asserte sur son contenu :

```js
// Test "getQuotesBulk fetches a single URL with comma-joined tickers" (ligne 209) :
// Avant :
assert.ok(capturedUrl.includes('/quote/AAPL,TSLA'));
// Après :
assert.ok(capturedUrl.includes('/batch-quote?symbols=AAPL,TSLA'));
```

```js
// Test "getQuotesBulk uppercases ticker symbols before request" (ligne 222) :
// Avant :
assert.ok(capturedUrl.includes('AAPL,TSLA'));
// Après (inchangé — l'assertion porte sur la portion comma-joined) :
assert.ok(capturedUrl.includes('AAPL,TSLA'));
// (pas de modif nécessaire — laisser tel quel)
```

```js
// Test "getQuotesBulk dedups duplicate tickers in input" (ligne 234) :
// Inchangé — regex /AAPL/g
```

Le seul vrai changement d'assertion est sur la ligne 209.

- [ ] **Step 2 : Lancer les tests `getQuotesBulk` et vérifier qu'ils échouent**

```bash
node --test --test-name-pattern="^getQuotesBulk" discord/fmp-client.test.js
```

Expected : Le test "fetches a single URL with comma-joined tickers" échoue (`includes('/batch-quote?symbols=AAPL,TSLA')` retourne false car le code prod produit toujours `/quote/AAPL,TSLA`). Les autres tests passent encore (leurs assertions tolèrent les deux formats).

- [ ] **Step 3 : Mettre à jour `getQuotesBulk` dans `fmp-client.js`**

```js
// discord/fmp-client.js:181-182 (dans getQuotesBulk)
const url = base + '/batch-quote?symbols=' + list.map(encodeURIComponent).join(',')
  + '&apikey=' + encodeURIComponent(apiKey);
```

Le reste de `getQuotesBulk` (parsing array, filtrage non-finite price, retour map keyed par symbol) reste identique.

- [ ] **Step 4 : Lancer les tests `getQuotesBulk` et vérifier qu'ils passent**

```bash
node --test --test-name-pattern="^getQuotesBulk" discord/fmp-client.test.js
```

Expected : tous les 7 tests `getQuotesBulk*` passent (fetches comma-joined, uppercases, dedups, empty input, missing in response, skips non-finite, throws on HTTP error).

- [ ] **Step 5 : Commit**

```bash
git add discord/fmp-client.js discord/fmp-client.test.js
git commit -m "$(cat <<'EOF'
feat(fmp): migrate getQuotesBulk to /stable/batch-quote

Switch from comma-joined path /api/v3/quote/{s1,s2} to query-param
/stable/batch-quote?symbols={s1,s2}. Response shape identical (array
of quote objects keyed by symbol). Updates the URL-assertion in the
test that checks the request path.

Refs spec docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 : Migrer `getDailyBars` vers `/stable/historical-price-eod/full`

Cette task est plus invasive car la réponse change de shape : `{historical: [...]}` (v3) → array plat (`/stable/`). Le slice à 10 entrées est aussi explicitement appliqué côté client (FMP /stable/ n'accepte pas `timeseries` selon la doc visible).

**Files :**
- Modify: `discord/fmp-client.js:135-157` (URL et parsing dans `getDailyBars`)
- Modify: `discord/fmp-client.test.js:117, 140, 150` (URLs et response shapes)

- [ ] **Step 1 : Mettre à jour les URLs et shapes dans les 3 tests `getDailyBars`**

Test 1 — "getDailyBars returns chronological-ascending array with parsed dates" (lignes 114-136). Remplace tout le bloc de la route fake :

```js
// Avant (lignes 117-126) :
'https://financialmodelingprep.com/api/v3/historical-price-full/AAPL?timeseries=10&apikey=KEY':
  jsonOk({
    symbol: 'AAPL',
    historical: [
      { date: '2026-04-27', open: 100, high: 105, low: 99, close: 103, volume: 200 },
      { date: '2026-04-24', open: 95,  high: 100, low: 94, close: 98,  volume: 180 },
      { date: '2026-04-23', open: 92,  high: 96,  low: 91, close: 94,  volume: 170 },
    ],
  }),

// Après :
'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL&apikey=KEY':
  jsonOk([
    { symbol: 'AAPL', date: '2026-04-27', open: 100, high: 105, low: 99, close: 103, volume: 200 },
    { symbol: 'AAPL', date: '2026-04-24', open: 95,  high: 100, low: 94, close: 98,  volume: 180 },
    { symbol: 'AAPL', date: '2026-04-23', open: 92,  high: 96,  low: 91, close: 94,  volume: 170 },
  ]),
```

Test 2 — "getDailyBars returns [] when historical array is missing" (lignes 138-146). Remplace l'URL et la réponse :

```js
// Avant (ligne 140-141) :
'https://financialmodelingprep.com/api/v3/historical-price-full/XXXX?timeseries=10&apikey=KEY':
  jsonOk({ symbol: 'XXXX' }),

// Après — pour /stable/ une réponse "vide" est un array vide :
'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=XXXX&apikey=KEY':
  jsonOk([]),
```

Test 3 — "getDailyBars caches within TTL" (lignes 148-163). Remplace l'URL et la réponse :

```js
// Avant (ligne 150-151) :
'https://financialmodelingprep.com/api/v3/historical-price-full/AAPL?timeseries=10&apikey=KEY':
  jsonOk({ symbol: 'AAPL', historical: [{ date: '2026-04-24', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }),

// Après :
'https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL&apikey=KEY':
  jsonOk([{ symbol: 'AAPL', date: '2026-04-24', open: 1, high: 1, low: 1, close: 1, volume: 1 }]),
```

- [ ] **Step 2 : Lancer les tests `getDailyBars` et vérifier qu'ils échouent**

```bash
node --test --test-name-pattern="^getDailyBars" discord/fmp-client.test.js
```

Expected : tous les 3 tests `getDailyBars*` échouent (URL ne match plus, et même si elle matchait le parser cherche `json.historical` qui n'existe plus).

- [ ] **Step 3 : Mettre à jour `getDailyBars` dans `fmp-client.js`**

Remplace le corps de `getDailyBars` (lignes 126-167) — l'URL et le parsing de la réponse. Le slice à 10 est explicite côté client :

```js
  async function getDailyBars(ticker) {
    const key = String(ticker).toUpperCase();
    const hit = barsCache.get(key);
    if (hit) {
      if (hit.data && (now() - hit.ts) < ttlMs) return hit.data;
      if (hit.inflight) return hit.inflight;
    }
    // /stable/ ne supporte pas un param "timeseries" ; on slice côté
    // client aux 10 dernières barres pour matcher l'ancien contrat.
    const url = base + '/historical-price-eod/full?symbol=' + encodeURIComponent(key)
      + '&apikey=' + encodeURIComponent(apiKey);
    const inflight = (async () => {
      const json = await httpJson(url);
      // /stable/historical-price-eod/full retourne un array PLAT
      // (plus de wrapper {historical: [...]} comme v3). Toujours
      // newest-first chez FMP → on slice les 10 premiers (newest)
      // puis on inverse pour l'ordre chronologique croissant.
      const hist = Array.isArray(json) ? json.slice(0, 10) : [];
      const bars = [];
      for (let i = hist.length - 1; i >= 0; i--) {
        const b = hist[i];
        const date = parseFmpDate(b && b.date);
        if (!date) continue;
        bars.push({
          date,
          open:   Number.isFinite(b.open)   ? b.open   : null,
          high:   Number.isFinite(b.high)   ? b.high   : null,
          low:    Number.isFinite(b.low)    ? b.low    : null,
          close:  Number.isFinite(b.close)  ? b.close  : null,
          volume: Number.isFinite(b.volume) ? b.volume : 0,
        });
      }
      return bars;
    })();
    barsCache.set(key, { inflight });
    try {
      const data = await inflight;
      barsCache.set(key, { ts: now(), data });
      return data;
    } catch (err) {
      barsCache.delete(key);
      throw err;
    }
  }
```

- [ ] **Step 4 : Lancer les tests `getDailyBars` et vérifier qu'ils passent**

```bash
node --test --test-name-pattern="^getDailyBars" discord/fmp-client.test.js
```

Expected : tous les 3 tests `getDailyBars*` passent.

- [ ] **Step 5 : Lancer la suite complète fmp-client pour vérifier non-régression**

```bash
node --test discord/fmp-client.test.js
```

Expected : tous les tests `fmp-client.test.js` passent (~18 tests : parseFmpDate, createFmpClient, getQuote*, getDailyBars*, getQuotesBulk*).

- [ ] **Step 6 : Commit**

```bash
git add discord/fmp-client.js discord/fmp-client.test.js
git commit -m "$(cat <<'EOF'
feat(fmp): migrate getDailyBars to /stable/historical-price-eod/full

Switch from /api/v3/historical-price-full/{s}?timeseries=10 to
/stable/historical-price-eod/full?symbol={s}. The /stable/ endpoint
returns a flat array instead of a {historical: [...]} wrapper, and
doesn't accept the timeseries param — so we slice client-side to the
10 newest bars before reversing for chronological-ascending order.

Refs spec docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 : Fix WebSocket endpoint vers `wss://financialmodelingprep.com/ws/us-stocks`

**Files :**
- Modify: `discord/fmp-ws-client.js:14` (constante `DEFAULT_ENDPOINT`)
- Modify: `discord/fmp-ws-client.test.js:42` (assertion sur l'URL du WS construit)

- [ ] **Step 1 : Mettre à jour l'assertion d'URL dans le test "start() opens the WS"**

```js
// discord/fmp-ws-client.test.js:42
// Avant :
assert.strictEqual(WS.last().url, 'wss://websockets.financialmodelingprep.com');
// Après :
assert.strictEqual(WS.last().url, 'wss://financialmodelingprep.com/ws/us-stocks');
```

Le test "endpoint can be overridden via the `endpoint` option" (ligne 51-59) n'a pas besoin de changement — il utilise une URL custom passée en option.

- [ ] **Step 2 : Lancer le test et vérifier qu'il échoue**

```bash
node --test --test-name-pattern="^start\\(\\) opens the WS" discord/fmp-ws-client.test.js
```

Expected : le test échoue avec `Expected: 'wss://financialmodelingprep.com/ws/us-stocks', Actual: 'wss://websockets.financialmodelingprep.com'`.

- [ ] **Step 3 : Mettre à jour `DEFAULT_ENDPOINT` dans `fmp-ws-client.js`**

```js
// discord/fmp-ws-client.js:14
const DEFAULT_ENDPOINT = 'wss://financialmodelingprep.com/ws/us-stocks';
```

- [ ] **Step 4 : Mettre à jour le commentaire d'en-tête de `fmp-ws-client.js`**

Remplace les lignes 1-12 par :

```js
// ─────────────────────────────────────────────────────────────────────
// discord/fmp-ws-client.js — Client WebSocket FMP (raw protocol)
// ─────────────────────────────────────────────────────────────────────
// Long-lived WebSocket connection to Financial Modeling Prep streaming
// API for real-time stock trades. Emits a typed 'trade' event for each
// last-trade message; ignores quote-update (Q) and trade-break (B)
// messages. Reconnect with exponential backoff handled in Task 3.
//
// Protocol (verified from FMP /stable/ docs 2026-05-15) :
//   wss://financialmodelingprep.com/ws/us-stocks   (was wss://websockets.financialmodelingprep.com)
//   Login:       { event: 'login',     data: { apiKey } }
//   Subscribe:   { event: 'subscribe', data: { ticker: ['aapl', ...] } }   (lowercase)
//   Unsubscribe: { event: 'unsubscribe', data: { ticker: [...] } }
//   Trade msg:   { s: '<ticker>', t: <ms>, type: 'T', lp: <price>, ls: <size> }
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md
// ─────────────────────────────────────────────────────────────────────
```

- [ ] **Step 5 : Lancer la suite complète fmp-ws-client.test.js et vérifier qu'elle passe**

```bash
node --test discord/fmp-ws-client.test.js
```

Expected : tous les tests passent (~20 tests dont start/subscribe/trade/reconnect).

- [ ] **Step 6 : Commit**

```bash
git add discord/fmp-ws-client.js discord/fmp-ws-client.test.js
git commit -m "$(cat <<'EOF'
fix(fmp-ws): point WebSocket at /stable/ endpoint /ws/us-stocks

The legacy wss://websockets.financialmodelingprep.com endpoint rejects
the login event for plans subscribed after Aug 31 2025. FMP's /stable/
WebSocket lives at wss://financialmodelingprep.com/ws/us-stocks and
uses the same login/subscribe protocol — only the URL changes.

Closes #69 (its swap to wss://socket.financialmodelingprep.com was
also obsolete — the real endpoint is /ws/us-stocks under the apex).

Refs spec docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 : Format compact `buildAlertMessage`

**Files :**
- Modify: `discord/milestone-checker.js:38-51` (fonction `buildAlertMessage`)
- Modify: `discord/milestone-checker.js:147-155` (appel dans `tick`, retirer `gainPct`)
- Modify: `discord/milestone-checker.test.js:52-91` (3 tests directs sur `buildAlertMessage`)

Les autres tests de `milestone-checker.test.js` (ceux qui appellent `tick` et asserte sur `_replies[0].content`) ont des assertions partielles (`includes('+20%')`) qui restent valides avec le nouveau format. Pas besoin de les toucher.

- [ ] **Step 1 : Mettre à jour les 3 tests directs sur `buildAlertMessage`**

Test 1 — "buildAlertMessage produces the canonical English reply" (lignes 52-65) :

```js
// Avant :
test('buildAlertMessage produces the canonical English reply', () => {
  const msg = buildAlertMessage({
    ticker: 'AAPL',
    milestonePct: 20,
    initialPrice: 200,
    currentPrice: 240,
    gainPct: 20,
    mentionedByUsername: 'alice',
  });
  assert.strictEqual(
    msg,
    '🚀 **$AAPL** hit **+20%** milestone — now $240.00 (entry $200.00, gain +20.00%) — first flagged by @alice'
  );
});

// Après :
test('buildAlertMessage produces the canonical compact reply', () => {
  const msg = buildAlertMessage({
    ticker: 'AAPL',
    milestonePct: 20,
    initialPrice: 200,
    currentPrice: 240,
    mentionedByUsername: 'alice',
  });
  assert.strictEqual(msg, '🚀 (AAPL 200.00-240.00) +20% — by @alice');
});
```

Test 2 — "buildAlertMessage uses fallback username when missing" (lignes 67-77) :

```js
// Avant :
test('buildAlertMessage uses fallback username when missing', () => {
  const msg = buildAlertMessage({
    ticker: 'TSLA',
    milestonePct: 100,
    initialPrice: 100,
    currentPrice: 200,
    gainPct: 100,
    mentionedByUsername: null,
  });
  assert.ok(msg.endsWith('first flagged by @analyst'));
});

// Après :
test('buildAlertMessage uses fallback username when missing', () => {
  const msg = buildAlertMessage({
    ticker: 'TSLA',
    milestonePct: 100,
    initialPrice: 100,
    currentPrice: 200,
    mentionedByUsername: null,
  });
  assert.ok(msg.endsWith('by @analyst'));
});
```

Test 3 — "buildAlertMessage formats decimal prices to 2 places" (lignes 79-91) :

```js
// Avant :
test('buildAlertMessage formats decimal prices to 2 places', () => {
  const msg = buildAlertMessage({
    ticker: 'HOOD',
    milestonePct: 50,
    initialPrice: 12.345,
    currentPrice: 18.555,
    gainPct: 50.31,
    mentionedByUsername: 'bob',
  });
  assert.ok(msg.includes('$18.56'));
  assert.ok(msg.includes('entry $12.35'));
  assert.ok(msg.includes('gain +50.31%'));
});

// Après — le nouveau format omet l'affichage explicite du gainPct ;
// l'assertion porte sur le format `(TICKER X.XX-Y.YY)` et le `+N%` :
test('buildAlertMessage formats decimal prices to 2 places', () => {
  const msg = buildAlertMessage({
    ticker: 'HOOD',
    milestonePct: 50,
    initialPrice: 12.345,
    currentPrice: 18.555,
    mentionedByUsername: 'bob',
  });
  assert.strictEqual(msg, '🚀 (HOOD 12.35-18.56) +50% — by @bob');
});
```

- [ ] **Step 2 : Lancer les 3 tests `buildAlertMessage` et vérifier qu'ils échouent**

```bash
node --test --test-name-pattern="^buildAlertMessage" discord/milestone-checker.test.js
```

Expected : les 3 tests `buildAlertMessage*` échouent (le format actuel produit le long texte avec `hit **+20%** milestone — now ...`, pas le compact).

- [ ] **Step 3 : Mettre à jour `buildAlertMessage` dans `milestone-checker.js`**

Remplace les lignes 38-51 du fichier `discord/milestone-checker.js` par :

```js
// toFixed2 uses Math.round(n*100)/100 before .toFixed(2) to get
// consistent half-up rounding (IEEE 754 .toFixed rounds half-to-even,
// which yields '18.55' for 18.555 in Node.js).
function toFixed2(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

// Format compact : `🚀 (AAPL 200.00-240.00) +20% — by @alice`.
// Le `gainPct` est déductible du couple initial/current, donc on ne
// l'affiche plus explicitement. Mention `@username` en plain text — le
// caller met allowedMentions:[] pour empêcher Discord de ping
// l'utilisateur à chaque palier.
function buildAlertMessage({
  ticker, milestonePct, initialPrice, currentPrice, mentionedByUsername,
}) {
  const name = mentionedByUsername || 'analyst';
  return '🚀 ('
    + ticker + ' '
    + toFixed2(initialPrice) + '-'
    + toFixed2(currentPrice) + ') +'
    + milestonePct + '% — by @' + name;
}
```

- [ ] **Step 4 : Retirer `gainPct` de l'appel dans `tick`**

Remplace les lignes 147-155 du fichier `discord/milestone-checker.js`. Avant :

```js
const text = buildAlertMessage({
  ticker: entry.ticker,
  milestonePct: target,
  initialPrice: entry.initial_price,
  currentPrice: quote.price,
  gainPct,
  mentionedByUsername: entry.mentioned_by_username,
});
```

Après :

```js
const text = buildAlertMessage({
  ticker: entry.ticker,
  milestonePct: target,
  initialPrice: entry.initial_price,
  currentPrice: quote.price,
  mentionedByUsername: entry.mentioned_by_username,
});
```

- [ ] **Step 5 : Lancer la suite complète `milestone-checker.test.js` et vérifier qu'elle passe**

```bash
node --test discord/milestone-checker.test.js
```

Expected : tous les tests `milestone-checker.test.js` passent. Les 3 tests `buildAlertMessage*` valident le nouveau format ; les tests `tick*` valident toujours `.includes('+20%')` qui reste vrai (le `+20%` est bien dans la chaîne `+20%` du nouveau format).

- [ ] **Step 6 : Lancer la suite complète du repo pour validation finale**

```bash
npm test
```

Expected : toute la suite passe — aucune régression sur les autres modules.

- [ ] **Step 7 : Commit**

```bash
git add discord/milestone-checker.js discord/milestone-checker.test.js
git commit -m "$(cat <<'EOF'
feat(milestone): compact alert format

Switch buildAlertMessage from the verbose English template:
  🚀 **\$AAPL** hit **+20%** milestone — now \$240.00 (entry \$200.00, gain +20.00%) — first flagged by @alice
to the compact form requested by the operator:
  🚀 (AAPL 200.00-240.00) +20% — by @alice

The gainPct parameter is removed from the function signature (deductible
from the prices). The dedicated-channel source link (📎) is still
appended in tick() when MILESTONE_ALERTS_CHANNEL_ID is set.

Refs spec docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 : Push, ouvrir la PR et fermer #69

**Files :** aucun

- [ ] **Step 1 : Push de la branche vers `origin`**

```bash
git push -u origin feat/fmp-stable-migration
```

Expected : la branche est créée sur GitHub. Si une protection refuse le push (force ou main), **STOP** et signaler — on n'override jamais une protection sans accord explicite.

- [ ] **Step 2 : Ouvrir la PR avec `gh pr create`**

```bash
gh pr create --title "feat(fmp): migrate to /stable/ + new milestone alert format" --body "$(cat <<'EOF'
## Summary

- Migre `fmp-client.js` de `/api/v3` vers `/stable/` (3 méthodes : `getQuote`, `getQuotesBulk`, `getDailyBars`)
- Fixe l'endpoint WebSocket vers `wss://financialmodelingprep.com/ws/us-stocks`
- Passe les alertes milestone au format compact : `🚀 (AAPL 200.00-240.00) +20% — by @analyst`

**Pourquoi** : FMP a déprécié v3/v4 pour les plans souscrits après le 31 août 2025. Les logs Railway montraient 100% des appels REST en `403 "Legacy Endpoint"`, ce qui cassait silencieusement `milestone-checker.tick()`. L'endpoint WS legacy (et celui ouvert dans #69) retournent aussi `login rejected: Unauthorized`.

**Spec** : `docs/superpowers/specs/2026-05-15-fmp-stable-migration-design.md`

**Supersede** : #69 (son endpoint `wss://socket.financialmodelingprep.com` est aussi obsolète)
**Bloque** : #72 (à rebaser sur main après merge — ses 6 méthodes FMP additionnelles devront être migrées au pattern documenté ici)

## Test plan

- [x] `npm test` passe en local après chaque task TDD
- [ ] Une fois mergé : déployer sur Railway et seed manuellement un ticker de test
- [ ] Attendre 1 tick RTH (30 min) et vérifier qu'une alerte au format compact apparaît dans le canal
- [ ] Vérifier zéro erreur `403 "Legacy Endpoint"` dans les logs Railway sur 24h
- [ ] Vérifier l'événement `connected` WS dans les logs (login accepté)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected : la commande retourne l'URL de la PR créée.

- [ ] **Step 3 : Fermer PR #69 avec un commentaire de supersession**

```bash
gh pr close 69 --comment "Superseded by the FMP /stable/ migration PR (this PR's swap to wss://socket.financialmodelingprep.com is also obsolete — the real /stable/ WebSocket endpoint is wss://financialmodelingprep.com/ws/us-stocks, addressed in the new PR)."
```

Expected : PR #69 est fermée et la close note pointe vers la nouvelle PR.

- [ ] **Step 4 : Vérifier l'état final**

```bash
gh pr list --state open --json number,title,headRefName
```

Expected : la nouvelle PR `feat/fmp-stable-migration` apparaît, PR #69 n'apparaît plus, PR #72 toujours présente (à rebaser après merge).

---

## Post-merge (hors plan, pour mémoire)

1. Rebase de `claude/fmp-slash-commands` (#72) sur `main` mis à jour.
2. Migrer les 6 nouvelles méthodes ajoutées par #72 (`getRatiosTtm`, `getPriceTargetSummary`, `getEarningsSurprises`, `getInsiderTrades`, `getSenateTrades`, `getHouseTrades`) au pattern `/stable/?symbol=...` documenté dans le spec.
3. Smoke en prod 24h pour valider l'absence de 403.
