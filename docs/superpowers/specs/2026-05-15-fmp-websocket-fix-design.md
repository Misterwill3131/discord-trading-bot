# FMP WebSocket Fix — Design

**Date** : 2026-05-15
**Statut** : Draft — en attente de validation utilisateur

## Problème

PR #66 (`feat(fmp-ws): real-time stocks via FMP WebSocket`) a introduit `discord/fmp-ws-client.js` + `discord/fmp-ws-marketclient.js` mais a utilisé une spécification incorrecte de l'API FMP WebSocket :

1. **Endpoint faux** : `wss://websockets.financialmodelingprep.com` (n'existe pas / cert invalide). Le vrai endpoint est `wss://socket.financialmodelingprep.com`.
2. **Format `subscribe` faux** : `{ event: 'subscribe', data: { ticker: ['aapl', ...] } }` (par-ticker). Le vrai format est `{ event: 'subscribe', data: { stream: 'fmp-us-equities-stream' } }` (par-stream).
3. **Format message faux** : le parser attendait `{ s, t, type: 'T', lp, ls }` (trade ticks). FMP envoie des full quote objects `{ symbol, name, price, dayHigh, dayLow, volume, ... }`.

En prod sur Railway, la connexion crash avec `UNABLE_TO_VERIFY_LEAF_SIGNATURE` au TLS handshake (cert du faux endpoint). PR #67 a empêché le crash bot via un `error` listener, mais la WebSocket reste non-fonctionnelle — le bot tourne 100% sur REST en pratique.

Référence — documentation FMP officielle confirmée visuellement le 2026-05-15 via le dashboard FMP (section Quote Feed Connector → bouton info).

## Objectif

Réécrire `fmp-ws-client.js` et `fmp-ws-marketclient.js` avec la **vraie spécification FMP WebSocket**, en gardant le toggle `MARKET_ALERTS_USE_WS` désactivé par défaut. Le code WebSocket devient fonctionnel mais dormant — prêt à être activé pour un use-case sub-seconde futur. Aucun changement de comportement en prod tant que `MARKET_ALERTS_USE_WS=false`.

## Non-objectifs

- Pas d'activation en prod : le toggle reste `false` par défaut
- Pas de watchdog heartbeat (reconnect si > 90s sans heartbeat) — defer
- Pas de support Socket.IO endpoint (`wss://socketio.financialmodelingprep.com`)
- Pas de `setWatchedTickers()` runtime — les tickers sont fixés au start
- Pas de métriques message rate / bandwidth tracking
- Pas de multi-connection sharding (un WS par stream)
- Pas de filtrage server-side (FMP ne supporte pas)

## Contraintes bande passante

Le format FMP impose un abonnement à un stream entier (pas par ticker). Pour `fmp-us-equities-stream`, ~5000 messages/sec en peak hours × ~1 KB par message = **~120 GB/jour**. Le plan Premium de l'utilisateur a un quota de **50 GB/mois**. Activer le toggle en prod sans précaution dépasserait le quota en quelques heures.

Le filtre client-side par symbol économise CPU/mémoire mais **pas la bande passante** (les paquets arrivent quand même). C'est pour cela qu'on garde `MARKET_ALERTS_USE_WS=false` par défaut et qu'on documente le coût dans `.env.example`.

## Architecture

Structure à deux couches préservée — protocole WS brut séparé de l'adapter marketClient.

```
┌────────────────────────────────────────────────────────────┐
│  discord/fmp-ws-client.js  (Layer 1 — raw protocol)        │
│  - Endpoint: wss://socket.financialmodelingprep.com        │
│  - Login: { event: 'login', data: { apiKey } }             │
│  - Subscribe: { event: 'subscribe', data: { stream } }     │
│  - Emit 'quote' event avec le full quote object FMP        │
│  - Emit 'heartbeat', 'connected', 'disconnected', 'error'  │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  discord/fmp-ws-marketclient.js  (Layer 2 — adapter)       │
│  - Subscribe aux streams configurés au start()             │
│  - Map<UPPERCASE_SYMBOL, { price, volume, dayHigh, ... }>  │
│  - Filtre par symbol contre la liste 'tickers' configurée  │
│  - Expose getQuote(ticker) + getDailyBars(ticker)          │
│  - Fallback REST automatique (logique existante préservée) │
│  - Compatible avec le contrat marketClient existant        │
└────────────────────────────────────────────────────────────┘
```

**Fichiers concernés** :
- *Réécrits* : `discord/fmp-ws-client.js`, `discord/fmp-ws-marketclient.js`, `discord/fmp-ws-client.test.js`, `discord/fmp-ws-marketclient.test.js`
- *Modifié* : `discord/jobs.js` (default `useWs=false`, passage des streams au client)
- *Modifié* : `.env.example` (warning bande passante + nouvelles vars)

## Configuration

```env
# === FMP WEBSOCKET (refactored 2026-05-15) ===========================
# OFF par défaut — REST suffit pour les ticks 5-30 min. Activer
# uniquement si tu as un use-case sub-seconde ET tu acceptes le coût
# bande passante (~120 GB/jour sur fmp-us-equities-stream — bien au-delà
# du quota 50 GB/mois du plan Premium).

MARKET_ALERTS_USE_WS=false

# Streams FMP à subscribe (CSV). Défaut: fmp-us-equities-stream.
# Options: fmp-us-otc-stream, fmp-index-stream, nasdaq-basic-w-nls-plus,
# iex-tops, cboe-index-main, fmp-crypto-stream, fmp-commodity-stream,
# fmp-currency-stream, fmp-uk-equities-stream, fmp-ca-equities-stream.
# Ajouter "-delayed" pour delayed feeds.
FMP_WS_STREAMS=fmp-us-equities-stream

# Staleness max sur le cache WS (ms). getQuote() retourne null si le
# dernier quote pour un ticker date de > MAX_STALENESS_MS.
FMP_WS_MAX_STALENESS_MS=900000

# Endpoint override (rarement utile, par défaut wss://socket.financialmodelingprep.com).
FMP_WS_ENDPOINT=
```

Default `MARKET_ALERTS_USE_WS=false` garantit qu'aucun changement runtime ne survient au merge.

## Layer 1 — `discord/fmp-ws-client.js`

**Responsabilité** : protocole WebSocket brut FMP. Connexion, login, subscribe/unsubscribe, événements.

**Signature** :

```js
const wsClient = createFmpWsClient({
  apiKey,                                    // string, required
  streams = ['fmp-us-equities-stream'],      // array of stream names
  endpoint = 'wss://socket.financialmodelingprep.com',
  WebSocketImpl,                             // injectable for tests
  logger = console,
  reconnectMinMs = 1_000,
  reconnectMaxMs = 30_000,
  reconnectMaxAttempts = 0,                  // 0 = unlimited
});
```

**API publique** :

```js
wsClient.start();              // connect + login + subscribe streams
wsClient.stop();               // unsubscribe + disconnect
wsClient.getStatus();          // { connected, attemptCount, subscribedStreams: [], lastHeartbeatAt }
```

**Events émis** :

```js
wsClient.on('connected', () => { ... });               // login OK
wsClient.on('disconnected', ({ code, reason }) => { ... });
wsClient.on('error', (err) => { ... });
wsClient.on('heartbeat', ({ timestamp }) => { ... });  // FMP push every ~30s
wsClient.on('quote', (quoteObj) => { ... });           // full quote object
```

**Format `quoteObj` (passe-plat brut depuis FMP)** :

```js
{
  symbol: 'AAPL',
  name: 'Apple Inc.',
  price: 198.42,
  changesPercentage: 1.23,
  change: 2.41,
  dayLow: 195.10,
  dayHigh: 199.85,
  yearHigh: 220.50,
  yearLow: 165.30,
  marketCap: 3000000000000,
  volume: 12345678,
  avgVolume: 50000000,
  open: 196.50,
  previousClose: 196.01,
  eps: 6.13,
  pe: 32.4,
  earningsAnnouncement: '2026-07-25T20:00:00.000Z',
  sharesOutstanding: 15000000000,
  timestamp: 1747473420,      // FMP unix seconds
  range: '195.10 - 199.85',
  type: 'stock',
  updatedAt: '2026-05-15T16:30:00.504Z',
}
```

**Flow interne au `start()`** :

1. `new WebSocket(endpoint)` → attendre `open`
2. `send({ event: 'login', data: { apiKey } })`
3. Attendre la réponse login. Status 200 → emit `'connected'`. Status 4xx → emit `'error'` (auth failed), stop (pas de retry).
4. Pour chaque stream : `send({ event: 'subscribe', data: { stream } })`
5. Loop : sur chaque message reçu, dispatch selon `event` :
   - `event: 'login'` → handle response (step 3)
   - `event: 'subscribe'` / `event: 'unsubscribe'` → log status (200/4xx)
   - `event: 'heartbeat'` → emit `'heartbeat'`
   - **Pas de field `event`** (= message normal) → emit `'quote'` avec le payload

**Erreurs et reconnect** :

- Login `status: 400` ou `401` → emit `'error'`, stop (auth failed)
- Disconnect → backoff exponentiel `min(reconnectMaxMs, reconnectMinMs × 2^(attemptCount-1))`, jusqu'à `reconnectMaxAttempts` (0 = illimité)
- Au reconnect : re-login + re-subscribe les mêmes streams (préserve la liste)

## Layer 2 — `discord/fmp-ws-marketclient.js`

**Responsabilité** : adapter le flux WS brut au contrat `marketClient` attendu par `market-alerts.js`.

**Contrat existant à respecter** :

```js
marketClient.getQuote(ticker)      → { price: number, volume: number } | null
marketClient.getDailyBars(ticker)  → [{ date, open, high, low, close, volume }, ...]
```

**Signature** :

```js
const marketClient = createFmpWsMarketClient({
  apiKey,
  tickers = [],                              // tickers d'intérêt (filtre)
  wsClient,                                  // required (créé par caller)
  restClient,                                // required (fallback)
  now = () => new Date(),
  logger = console,
  fallbackFailureThreshold = 10,
  fallbackFailureWindowMs = 5 * 60_000,
  maxStalenessMs = 15 * 60_000,
});
```

**API publique** :

```js
marketClient.getQuote(ticker)        // → { price, volume } | null
marketClient.getDailyBars(ticker)    // → delegates to restClient
marketClient.start()                 // delegates to wsClient.start()
marketClient.stop()                  // delegates to wsClient.stop()
marketClient.getStatus()             // { source, wsConnected, ... }
```

**État interne** :

```js
// Cache des derniers quotes reçus, keyed by UPPERCASE symbol
const cache = new Map();
// cache.set('AAPL', {
//   price: 198.42,
//   volume: 12345678,
//   dayHigh: 199.85,
//   dayLow: 195.10,
//   timestamp: 1747473420,    // FMP timestamp (seconds)
//   receivedAt: Date.now(),   // notre ts pour la staleness
// });

const watchedTickers = new Set(tickers.map(t => String(t).toUpperCase()));
```

**Filtre client-side** :

```js
wsClient.on('quote', (q) => {
  const symbol = String(q.symbol || '').toUpperCase();
  if (!watchedTickers.has(symbol)) return;  // discard

  cache.set(symbol, {
    price:      Number.isFinite(q.price)   ? q.price   : null,
    volume:     Number.isFinite(q.volume)  ? q.volume  : 0,
    dayHigh:    Number.isFinite(q.dayHigh) ? q.dayHigh : null,
    dayLow:     Number.isFinite(q.dayLow)  ? q.dayLow  : null,
    timestamp:  Number(q.timestamp) || 0,
    receivedAt: now().getTime(),
  });
});
```

**`getQuote(ticker)` logic** :

```js
getQuote(ticker) {
  if (inFallback) return restClient.getQuote(ticker);
  const key = String(ticker).toUpperCase();
  const entry = cache.get(key);
  if (!entry || entry.price == null) return null;
  if ((now().getTime() - entry.receivedAt) > maxStalenessMs) return null;
  return { price: entry.price, volume: entry.volume };
}
```

**Fallback REST automatique** (logique préservée de PR #66+#67) :

- Compte les `disconnected` events dans une fenêtre glissante de `fallbackFailureWindowMs`
- Si > `fallbackFailureThreshold` → `inFallback = true`
- `getQuote()` route vers `restClient.getQuote()` jusqu'à reconnexion stable
- Sur `connected` → reset compteur, `inFallback = false`

**Listeners sur wsClient** :

- `'quote'` → update cache (avec filtre)
- `'disconnected'` → `recordDisconnect()`
- `'connected'` → `clearFallback()`
- `'error'` → log + `recordDisconnect()` (préservé de PR #67)

## Wiring — `discord/jobs.js`

Changements minimes :

1. **Default `useWs=false`** :

```js
const useWs = String(process.env.MARKET_ALERTS_USE_WS || 'false').toLowerCase() === 'true';
```

2. **Streams au `createFmpWsClient`** :

```js
const streamsCsv = process.env.FMP_WS_STREAMS || 'fmp-us-equities-stream';
const streams = streamsCsv.split(',').map(s => s.trim()).filter(Boolean);
const wsClient = createFmpWsClient({
  apiKey: fmpKey,
  streams,
  endpoint: process.env.FMP_WS_ENDPOINT || undefined,
});
```

3. **Pas de changement** sur la création du marketClient (interface identique) ni sur `marketAlerts.tick()`.

## Tests

### `discord/fmp-ws-client.test.js` (réécrit)

1. `start()` connecte et envoie login avec apiKey
2. Login response `status: 200` → emit `'connected'`
3. Après `'connected'` → un subscribe est envoyé pour chaque stream configuré
4. Subscribe response `status: 200` → log info (pas d'event spécifique)
5. Subscribe response `status: 401` → emit `'error'`, ne crash pas
6. Message sans field `event` (= quote object) → emit `'quote'` avec payload complet
7. Message `event: 'heartbeat'` → emit `'heartbeat'`
8. Disconnect → emit `'disconnected'`, scheduleReconnect avec backoff exponentiel
9. Au reconnect → re-login + re-subscribe les mêmes streams
10. `stop()` → unsubscribe propre + close
11. `getStatus()` retourne le bon shape

### `discord/fmp-ws-marketclient.test.js` (réécrit)

1. `getQuote(ticker)` retourne null avant le premier quote reçu
2. Quote reçu sur un ticker DANS `watchedTickers` → cache mis à jour → `getQuote()` retourne `{ price, volume }`
3. Quote reçu sur un ticker HORS `watchedTickers` → cache PAS mis à jour (filtre OK)
4. Staleness > `maxStalenessMs` → `getQuote()` retourne null
5. `getDailyBars()` delegate vers restClient
6. 10 disconnects en 5 min → `inFallback = true` → `getQuote()` route vers REST
7. `connected` event → `inFallback = false`, cache normal
8. Error event sur wsClient → log + `recordDisconnect()` (préservé de PR #67)
9. `start()` / `stop()` delegate vers wsClient

## Étapes manuelles (opérateur)

Aucune étape manuelle requise pour ce merge — le toggle reste `false` par défaut, donc aucun changement de comportement runtime.

**Si l'opérateur veut activer la WS plus tard** (sans recommander) :

1. Vérifier la bande passante : `fmp-us-equities-stream` ≈ 120 GB/jour ; sur plan Premium 50 GB/mois, l'activation est risquée.
2. Set `MARKET_ALERTS_USE_WS=true` sur Railway → redeploy.
3. Vérifier dans les logs au démarrage : `[market-alerts] watching N tickers via WS`.
4. Si la connexion FMP fail (limite quota plan, etc.) : `recordDisconnect()` déclenche le fallback REST automatique après ~10 erreurs.

## Risques

| Risque | Mitigation |
|--------|------------|
| Bande passante explose si activé | Bien documenté dans `.env.example`. Toggle OFF par défaut. |
| Connection limit FMP (Maximum connections reached) | Single connection partagée. Si limite atteinte → fallback REST automatique. |
| Régression accidentelle sur le mode REST | Toggle `useWs=false` route 100% sur REST = exactement le comportement actuel post PR #67. Tests vérifient. |
| Re-subscribe au reconnect oublie un stream | Test dédié (point 9 de `fmp-ws-client.test.js`). |
| Login auth fail mais le code retry indéfiniment | Login `status: 401` → emit `'error'` + stop. Pas de retry. |

## Out of scope (deferred si use case émerge)

- Watchdog heartbeat (reconnect si > 90s sans heartbeat)
- Support Socket.IO endpoint
- `setWatchedTickers()` runtime
- Métriques message rate / bandwidth tracking
- Multi-connection sharding (un WS par stream)
- Symbol-level filtre server-side (FMP ne supporte pas)
