# Market commands — `!price`, `!chart`, `!indicator`

## Objectif

Ajouter trois commandes Discord globales (fonctionnent dans n'importe quel salon, comme `!profits` / `!news`) pour consulter des données de marché :

- `!price TICKER` — quote complet live (prix, change%, volume, day range, 52W range, market cap)
- `!chart TICKER [RANGE]` — image PNG du graphe intraday/historique, RANGE configurable
- `!indicator TICKER` — RSI(14) + EMA(9) + EMA(20) sur candles 5min

## Non-goals

- Pas de MACD (uniquement les indicateurs déjà dans `trading/indicators.js`).
- Pas d'ASCII sparkline — on rend en PNG uniquement pour `!chart`.
- Pas de subscription live IBKR — on reste sur le mode DELAYED existant pour `!indicator`.
- Pas de cache persistent — cache mémoire TTL 30s uniquement.

## Architecture

### Fichiers touchés

- **Nouveau** : `discord/market-commands.js` (~250 lignes) — exporte `registerMarketCommands(client, { marketData })`
- **Modifié** : `index.js` — enregistre `registerMarketCommands` à côté de `registerDiscordCommands`
- **Modifié** : `package.json` — ajoute la dépendance `yahoo-finance2`

### Dépendances

- **`yahoo-finance2`** (nouveau) — client Node actif et maintenu pour Yahoo Finance. Utilisé pour `!price` et `!chart` (données quasi-temps-réel, gratuit).
- **`canvas`** (existant) — déjà utilisé dans `canvas/proof.js`, réutilisé pour le rendu PNG du graphe.
- **`trading/marketdata.js`** (existant) — utilisé par `!indicator` via IBKR (DELAYED).
- **`trading/indicators.js`** (existant) — `computeIndicators()` appelé par `!indicator`.

### Structure interne de `discord/market-commands.js`

```
discord/market-commands.js
├─ Yahoo helpers (cache TTL 30s, même pattern que marketdata.js)
│  ├─ getYahooQuote(ticker) → quote live
│  └─ getYahooChart(ticker, range) → { meta, candles } OHLCV
├─ Range parsing
│  └─ parseRange(arg) → { interval, period1 } | null
├─ Chart renderer
│  └─ renderChartPng(candles, ticker, range) → Buffer PNG
└─ Handlers messageCreate
   ├─ !price TICKER
   ├─ !chart TICKER [RANGE]
   └─ !indicator TICKER
```

## Data flow

### `!price AAPL`

1. Parse ticker depuis le message.
2. `getYahooQuote('AAPL')` → Yahoo `quote()`.
3. Formate un message Markdown (pas un Discord embed — aligné avec le style de `discord/commands.js`) :
   ```
   📊 **$AAPL — Apple Inc.**
   > 💰 Prix : $174.23 🟢 +1.24%
   > 📦 Volume : 52,340,120
   > 📉 Day : $172.10 → $175.00
   > 📆 52W : $124.17 → $199.62
   > 🏦 Market cap : $2.72T
   ```
   Formatage market cap : `$X.YT` (trillions), `$X.YB` (billions), `$X.YM` (millions).
4. `message.reply(...)`.

### `!chart AAPL 5D`

1. Parse ticker + range (défaut `1D` si absent).
2. Validation range contre `VALID_RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y']`.
3. Map range → `{ interval, period1 }` :
   - `1D` → `interval: '5m'`, `period1: -1 day`
   - `5D` → `interval: '15m'`, `period1: -5 days`
   - `1M` → `interval: '1d'`, `period1: -1 month`
   - `3M` → `interval: '1d'`, `period1: -3 months`
   - `6M` → `interval: '1d'`, `period1: -6 months`
   - `1Y` → `interval: '1d'`, `period1: -1 year`
4. `getYahooChart('AAPL', range)` → array OHLCV.
5. `renderChartPng(candles, ticker, range)` → Buffer PNG (ligne simple avec prix, title, range).
6. `message.reply({ files: [{ attachment: buffer, name: 'AAPL-5D.png' }] })`.

### `!indicator AAPL`

1. Parse ticker.
2. `marketData.fetchCandles('AAPL', '5 mins', 50)` (IBKR).
3. `computeIndicators(candles)` → `{ rsi, ema9, ema20, lastPrice }`.
4. Formate :
   ```
   📈 **$AAPL — Indicators** (données retardées ~15min)
   > Prix : $174.23
   > RSI(14) : 52.3
   > EMA(9) : $174.12
   > EMA(20) : $172.40
   ```
5. `message.reply(...)`.

## Error handling

### 1. Ticker invalide (Yahoo)

- **Détection** : `yahooFinance.quote()` renvoie `undefined` ou throw. On check `!quote || !quote.regularMarketPrice`.
- **Réponse** : `❌ Ticker $XXX introuvable`
- **Log** : `console.log('[!price] Unknown ticker: ' + ticker)` — pas de stack (erreur utilisateur).

### 2. Yahoo down / network error

- **Détection** : `try/catch` autour des appels. Timeout explicite de **10s** via `Promise.race`.
- **Pas de retry** — fail fast.
- **Réponse** : `❌ Yahoo Finance indisponible, réessaye dans quelques minutes`
- **Log** : `console.error('[yahoo]', err.message)` avec stack.

### 3. IBKR non connecté (pour `!indicator`)

- **Détection** : `marketData.fetchCandles()` throw `'IBKR connect timeout'` ou `'no broker with getHistoricalBars'`.
- **Réponse** : `❌ Indicateurs indisponibles (broker offline)`
- **Note** : IBKR reste en DELAYED — on affiche toujours `(données retardées ~15min)` dans le message normal de `!indicator` pour éviter la confusion utilisateur.

### 4. Range invalide sur `!chart`

- **Détection** : si argument présent et pas dans `VALID_RANGES` (case-insensitive).
- **Réponse** : `❌ Range invalide. Utilise: 1D, 5D, 1M, 3M, 6M, 1Y`
- **Absent** : défaut `1D`, pas d'erreur.

### 5. Rate limit Yahoo (429)

- **Détection** : status 429 dans l'erreur retournée par yahoo-finance2.
- **Réponse** : `❌ Trop de requêtes, patiente 30s`
- **Mitigation** : cache TTL 30s limite déjà les appels répétés sur le même ticker.

### 6. Canvas render fail

- **Détection** : `renderChartPng` throw (données corrompues, canvas crash).
- **Réponse** : `❌ Erreur génération graphique`
- **Log** : `console.error('[!chart] render failed', err)` avec stack.

### 7. Commande sans argument

- **Détection** : `!price` / `!chart` / `!indicator` sans ticker.
- **Réponse** : `❌ Usage: !price TICKER` (ex: `!price AAPL`) — idem pour les deux autres.

## Testing

- **`yahoo-finance2` helpers** : pas de module isolé (inline dans `market-commands.js`), donc pas de test unitaire direct. Validation manuelle via les handlers.
- **`renderChartPng`** : test unitaire smoke — array de candles factice, on vérifie que le retour est un `Buffer` non vide. Aligné avec le style de `trading/indicators.test.js`.
- **`parseRange`** : test unitaire — vérifier chaque range valide produit le bon `{ interval, period1 }` et qu'une range invalide retourne `null`.
- **Handlers Discord** : non testés directement (aligné avec `discord/commands.js` actuel — pas de tests sur les handlers messageCreate).

## Out of scope / futures extensions

- Graphe avec indicateurs overlay (RSI/EMA sur le même PNG) — possible plus tard si utile.
- MACD — peut être ajouté séparément dans `trading/indicators.js` + exposé via `!indicator`.
- Alerts automatiques sur seuils RSI (overbought/oversold) — hors scope, relève d'un autre module.
- Support crypto/forex (BTC-USD, EUR=X) — `yahoo-finance2` le supporte nativement, on n'ajoute pas de restriction, mais pas testé explicitement.
