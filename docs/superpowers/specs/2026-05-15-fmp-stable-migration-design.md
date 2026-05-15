# FMP `/stable/` Migration — Design Spec

**Date :** 2026-05-15
**Branche :** `feat/fmp-stable-migration`
**Supersede :** PR #69 (`feat(fmp-ws): rewrite with correct FMP WebSocket protocol`)
**Bloque :** PR #72 (à rebaser sur main après merge)

## Contexte

Depuis le 31 août 2025, FMP a déprécié ses endpoints v3/v4 pour tout nouveau souscripteur. Les logs de prod montrent que 100 % des appels `fmp-client.js` retournent `403 "Legacy Endpoint"`, ce qui casse en silence le worker `milestone-checker.js` (les alertes de paliers ne se déclenchent jamais en prod) et la connexion WebSocket utilisée par `market-alerts.js`.

La nouvelle surface FMP est exposée sous `/stable/` avec un schéma légèrement différent (params en query plutôt que dans le path, un champ renommé `changesPercentage` → `changePercentage`, et l'endpoint historique retourne un array plat au lieu d'un wrapper `{historical: […]}`).

Cette migration n'est pas optionnelle : sans elle, le bot ne peut plus exécuter sa fonction principale d'alerte sur les watchlists d'analystes.

## Objectifs

1. Remettre en service `milestone-checker.js` en migrant les 3 méthodes de `fmp-client.js` (`getQuote`, `getDailyBars`, `getQuotesBulk`) vers `/stable/`.
2. Remettre en service le WebSocket en pointant vers le nouvel endpoint `wss://financialmodelingprep.com/ws/us-stocks`.
3. Simplifier le message d'alerte milestone vers le format compact demandé par l'utilisateur : `🚀 (AAPL 200.00-240.00) +20% — by @analyst`.

Hors scope (suivront dans la rebase de #72) :
- Les 6 méthodes ajoutées par #72 (`getRatiosTtm`, `getPriceTargetSummary`, `getEarningsSurprises`, `getInsiderTrades`, `getSenateTrades`, `getHouseTrades`).
- Les 3 slash commands `/analyze /insider /politicians`.

## Endpoints `/stable/` confirmés (FMP docs, 2026-05-15)

| Méthode | v3/v4 actuel | `/stable/` (nouveau) | Auth |
|---|---|---|---|
| `getQuote(t)` | `GET /api/v3/quote/{t}` | `GET /stable/quote?symbol={t}` | `&apikey=...` |
| `getQuotesBulk([t])` | `GET /api/v3/quote/{t1},{t2}` | `GET /stable/batch-quote?symbols={t1},{t2}` | `&apikey=...` |
| `getDailyBars(t)` | `GET /api/v3/historical-price-full/{t}?timeseries=10` | `GET /stable/historical-price-eod/full?symbol={t}` | `&apikey=...` |
| WebSocket | `wss://websockets.financialmodelingprep.com` | `wss://financialmodelingprep.com/ws/us-stocks` | login event |

## Changements de schéma

**1. Quote (single + batch)** — `/stable/quote` et `/stable/batch-quote` retournent un array d'objets :

```json
[
  {
    "symbol": "AAPL",
    "name": "Apple Inc.",
    "price": 232.8,
    "changePercentage": 2.1008,
    "change": 4.79,
    "volume": 44489128,
    "dayLow": 226.65,
    "dayHigh": 233.13,
    "yearHigh": 260.1,
    "yearLow": 164.08,
    "marketCap": 3500823120000,
    "priceAvg50": 240.2278,
    "priceAvg200": 219.98755,
    "exchange": "NASDAQ",
    "open": 227.2,
    "previousClose": 228.01,
    "timestamp": 1738702801
  }
]
```

Différence vs v3 : `changesPercentage` est renommé `changePercentage` (sans le `s`). Le code actuel n'utilise pas ce champ donc impact minimal, mais à noter pour les tests.

**2. Historical EOD** — `/stable/historical-price-eod/full` retourne un array plat (plus de wrapper `{historical: [...]}`) :

```json
[
  {
    "symbol": "AAPL",
    "date": "2025-02-04",
    "open": 227.2,
    "high": 233.13,
    "low": 226.65,
    "close": 232.8,
    "volume": 44489128,
    "change": 5.6,
    "changePercent": 2.46479,
    "vwap": 230.86
  }
]
```

L'ordre reste newest-first (à confirmer empiriquement, mais cohérent avec le comportement historique FMP).

Notes :
- Le path utilise un slash : `historical-price-eod/full`, **pas** `historical-price-eod-full`. La doc fait référence à `historical-price-eod-light` (avec un dash) dans l'URL de la page de docs mais le vrai endpoint API contient un slash.
- La variante `light` ne retourne que `{symbol, date, price, volume}` (pas d'OHLC). On utilise `full` car `getDailyBars` doit fournir OHLCV.
- Pas de param `timeseries` documenté ; on slice côté client à 10 entrées pour matcher le contrat existant.

**3. WebSocket** — Le sample frame de `wss://financialmodelingprep.com/ws/us-stocks` est identique au format consommé par le code actuel :

```json
{ "s": "aapl", "t": 1645216790788174600, "type": "Q", "ap": 152.46, "as": 200, "bp": 152.31, "bs": 100, "lp": 152.17, "ls": 100 }
```

Le protocole login/subscribe historique (`{event: 'login', data: {apiKey}}` puis `{event: 'subscribe', data: {ticker: ['aapl']}}`) reste valide.

## Architecture

### `discord/fmp-client.js`

Une seule constante change en haut du fichier : `FMP_BASE`.

```js
const FMP_BASE = 'https://financialmodelingprep.com/stable';
```

Pour chaque méthode, la construction d'URL passe de path-param à query-param :

```js
// getQuote
const url = base + '/quote?symbol=' + encodeURIComponent(key)
  + '&apikey=' + encodeURIComponent(apiKey);

// getQuotesBulk
const url = base + '/batch-quote?symbols=' + list.map(encodeURIComponent).join(',')
  + '&apikey=' + encodeURIComponent(apiKey);

// getDailyBars
const url = base + '/historical-price-eod/full?symbol=' + encodeURIComponent(key)
  + '&apikey=' + encodeURIComponent(apiKey);
```

`getDailyBars` doit également adapter le parsing de la réponse :

```js
const json = await httpJson(url);
const hist = Array.isArray(json) ? json : [];  // array plat, plus de json.historical
// reste identique : reverse pour ordre chronologique croissant, mapper en {date, OHLCV}
```

Le slice à 10 entrées est appliqué après le reverse pour matcher le `timeseries=10` historique :

```js
const bars = [];
const limit = Math.min(hist.length, 10);
for (let i = hist.length - 1; i >= hist.length - limit; i--) {
  // mapping inchangé
}
```

Tous les autres aspects (cache TTL 30 s, dedup inflight, timeout 10 s, error handling) sont inchangés. Pas de feature flag — drop complet du code v3.

### `discord/fmp-ws-client.js`

Une seule constante change :

```js
const DEFAULT_ENDPOINT = 'wss://financialmodelingprep.com/ws/us-stocks';
```

Le reste du fichier (login, subscribe `{ticker: [...]}`, parsing des frames, reconnect backoff) reste inchangé. Le commentaire d'en-tête est mis à jour pour refléter le nouvel endpoint et la date de vérification.

### `discord/milestone-checker.js`

Seule la fonction `buildAlertMessage` change. Le `gainPct` paramètre est retiré de la signature (déduisible côté lecteur via `initialPrice` et `currentPrice`) :

```js
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

Output : `🚀 (AAPL 200.00-240.00) +20% — by @alice`.

Le mode canal dédié (`MILESTONE_ALERTS_CHANNEL_ID` set) continue d'append `\n📎 https://discord.com/channels/<guild>/<channel>/<message>` après la ligne compacte. Le mode reply (legacy) post simplement la ligne compacte sans lien.

Le caller dans `tick()` :

```js
const text = buildAlertMessage({
  ticker: entry.ticker,
  milestonePct: target,
  initialPrice: entry.initial_price,
  currentPrice: quote.price,
  mentionedByUsername: entry.mentioned_by_username,
  // gainPct retiré
});
```

### Tests à mettre à jour

| Fichier | Changements |
|---|---|
| `discord/__tests__/fmp-client.test.js` | URLs attendues (`/stable/quote?symbol=…` etc.), shape réponse pour `getDailyBars` (array plat) |
| `discord/__tests__/milestone-checker.test.js` | Expectations sur le texte de `buildAlertMessage` |
| `discord/__tests__/fmp-ws-client.test.js` | Expectation `DEFAULT_ENDPOINT` |

Pas de nouveau test ajouté — la couverture existante suffit pour ce refactor (test-replace, pas test-add).

## Flux de données (inchangé)

1. `analyst-watchlist.js` détecte un message d'analyste sur `#trading-floor`, INSERT OR IGNORE dans `analyst_watchlist` avec `initial_price` capturé (FMP en fallback Yahoo).
2. Toutes les 30 min en RTH, `milestone-checker.tick()` :
   - Lit la watchlist active depuis SQLite
   - `marketClient.getQuotesBulk(tickers)` → `/stable/batch-quote` (au lieu de v3)
   - Calcule `gainPct` pour chaque ticker
   - Appelle `nextMilestone()` pour trouver le prochain palier non-tiré
   - Mark-then-send : INSERT OR IGNORE dans `milestone_alerts`, puis post Discord
   - Format de message : nouveau format compact (au lieu de la phrase complète)
   - Update `analyst_watchlist.last_milestone_pct` et `last_alert_at`
3. (Indépendant) `market-alerts.js` consomme `fmp-ws-client.js` pour les spikes temps réel — bénéficie du fix WS dans cette PR.

## Stratégie de PRs

1. Cette PR (`feat/fmp-stable-migration`) merge en premier.
2. À la fermeture, on close #69 manuellement avec un commentaire de supersession (le fix WS est inclus ici).
3. PR #72 (`claude/fmp-slash-commands`) rebase sur main après merge — ses 6 nouvelles méthodes `fmp-client` doivent être adaptées au pattern `/stable/` documenté ici.

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| L'ordre des entrées historiques (newest-first vs oldest-first) n'est pas explicitement documenté pour `/stable/historical-price-eod/full` | On garde le même `reverse` que la v3. Si l'ordre est inversé en réalité, un test smoke post-merge en prod le révélera et un patch d'1 ligne suffira. |
| Le protocole WS exact (auth, format login) n'a pas pu être vérifié dans la doc (section bloquée par le filtre de sécurité du browser MCP) | On garde le protocole historique. Si le login échoue toujours après le swap d'endpoint, on capture les frames côté client (WSL local + apiKey en clair temporaire) pour debugger en suivi. |
| Le slice à 10 entrées côté client peut récupérer une payload large si l'endpoint full ne supporte pas un paramètre de limit | Acceptable pour le free-tier (250 req/jour). Si quota touché, on peut switcher à `historical-price-eod/light` + recompute OHLC depuis intraday — décision out-of-scope. |

## Critères de succès

- Tous les tests existants passent après refactor (pas de régression).
- Un seed manuel d'une watchlist en prod (post-deploy) déclenche une alerte au format compact au prochain palier atteint.
- Aucune erreur `403 "Legacy Endpoint"` dans les logs Railway pendant 24 h après merge.
- PR #69 fermée par supersession ; PR #72 rebasée et prête à itérer.
