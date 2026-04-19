# Trading Execution — Design

Date : 2026-04-19
Auteur : brainstorming avec Claude
Statut : validé, prêt pour plan d'implémentation

## But

Étendre le bot existant pour **exécuter automatiquement des ordres** sur IBKR à partir des signaux `entry` déjà classifiés par `filters/signal.js`, avec un filtre technique additionnel, un sizing basé sur le risque, et une sortie gérée par trailing stop + take-profit.

Le bot actuel monitore Discord, classifie les messages, génère des images de preuve et envoie à Make.com. Cette extension ajoute un module `trading/` qui consomme les signaux validés pour passer des ordres réels.

## Décisions clés

| Décision | Valeur |
|---|---|
| Broker | Interactive Brokers (IBKR), via `@stoqey/ib` + IB Gateway local |
| Mode de démarrage | Paper account IBKR, puis live |
| Market data (indicateurs) | Alpaca Market Data API (gratuit, pas besoin de compte de trading) |
| Timeframe indicateurs | 5 minutes |
| Déclencheur d'entrée | Signal classifié `entry` avec ticker + prix (critères additionnels à raffiner plus tard) |
| Filtre technique | RSI(14) > 50 **ET** prix > EMA(20) **ET** prix > EMA(9) |
| Type d'ordre | Hybride : market si prix courant ≤ entry × 1.02, sinon limit à entry (TTL 30 min) |
| Sizing | Risk-based : risque par trade = 1 % du capital |
| Stop-loss | Trailing stop 7 % côté serveur IBKR |
| Take-profit | `target_price` extrait du signal |
| Exit Discord | Actif si auteur du message = auteur du signal d'entrée **ET** mot-clé `exit|sortie|stop|cut` → close market |
| Max positions simultanées | 5 |
| Limit order timeout | 30 min avant cancel |

## Architecture

### Nouveau module `trading/`

```
trading/
├── engine.js        # orchestrateur : onEntry, onExit, réconciliation boot
├── broker.js        # client IBKR + classe PaperBroker (sélectionnée par config.mode)
├── marketdata.js    # fetch chandeliers 5min via Alpaca + cache 30s
├── indicators.js    # RSI(14), EMA(20), EMA(9) depuis un array de candles
└── config.js        # params persistés (fichier JSON, pattern utils/config-overrides.js)
```

Pas d'interface abstraite pour le broker tant qu'on n'a qu'IBKR. `PaperBroker` vit dans `broker.js` comme classe interne, sélectionnée par `config.mode`.

### Point d'intégration

Un seul hook dans `discord/handler.js`. Après `logEvent()` du signal :

```js
if (filterType === 'entry'
    && signalTicker
    && pricesData.entry_price != null
    && pricesData.target_price != null) {
  tradingEngine.onEntry({
    ticker: signalTicker,
    entry_price: pricesData.entry_price,
    target_price: pricesData.target_price,
    author: authorName,
    raw_content: content,
    ts: message.createdAt.toISOString(),
  });
}

if (EXIT_KEYWORDS.some(k => lower.includes(k))) {
  tradingEngine.onExit({ ticker, author: authorName });
}
```

Les appels sont non bloquants (fire-and-forget avec catch interne dans l'engine). Le handler existant (images, webhook Make) continue en parallèle, inchangé.

`filters/signal.js` — étendre `EXIT_KEYWORDS` avec `cut`.

### Base de données

Une seule table nouvelle dans `db/sqlite.js` :

```sql
CREATE TABLE positions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker           TEXT NOT NULL,
  author           TEXT NOT NULL,
  entry_price      REAL NOT NULL,
  quantity         INTEGER NOT NULL,
  sl_price         REAL,                -- snapshot initial du stop (info seulement)
  tp_price         REAL,                -- snapshot du take-profit
  ibkr_parent_id   TEXT,                -- orderId IBKR du parent (entrée)
  ibkr_tp_id       TEXT,                -- orderId TP enfant
  ibkr_sl_id       TEXT,                -- orderId trailing stop enfant
  status           TEXT NOT NULL,       -- 'pending'|'open'|'closed'|'cancelled'|'error'
  opened_at        TEXT,
  closed_at        TEXT,
  close_reason     TEXT,                -- 'tp'|'sl'|'manual_exit'|'panic'|'cancelled'
  fill_price       REAL,                -- prix moyen d'entrée après fill
  exit_price       REAL,
  pnl              REAL,
  raw_signal       TEXT                 -- JSON du signal original pour audit
);
CREATE INDEX idx_positions_ticker_status ON positions(ticker, status);
CREATE INDEX idx_positions_author_status ON positions(author, status);
```

Les events (signal reçu, filtre raté, ordre envoyé, fill, erreur…) utilisent le `logEvent()` existant avec un champ additionnel `trade_action` (ex: `trade_skipped_rsi`, `trade_ordered`, `trade_filled`, `trade_closed_tp`).

### Dashboard

Une nouvelle page `/trading` avec 3 onglets dans une seule vue (pas 3 routes séparées) :

- **Positions** — liste des positions `open`/`pending`, P&L live (prix courant vs fill), boutons "close" par ligne, **kill-switch** global, **panic button** "close all at market".
- **History** — positions `closed`/`cancelled` avec P&L, stats agrégées (win rate, avg winner/loser).
- **Config** — formulaire pour tous les params de `config.js`, toggle paper/live, whitelist auteurs.

Routes :
- `GET /trading` (page)
- `GET /api/trading/positions`
- `GET /api/trading/history`
- `GET /api/trading/config`
- `POST /api/trading/config` (update params)
- `POST /api/trading/positions/:id/close` (close one)
- `POST /api/trading/panic` (close all)
- `POST /api/trading/kill-switch` (toggle tradingEnabled)

Tout sous `requireAuth` comme les routes existantes.

## Flux détaillé — Entrée

1. Message arrive dans `tradingChannel`, `handler.js` classifie → `entry` avec `ticker` + `entry_price`.
2. Handler appelle `engine.onEntry(signal)` en fire-and-forget.
3. `engine.onEntry` :
   a. Si `config.tradingEnabled === false` → log `trade_skipped_disabled`, return.
   b. Si count(`positions WHERE status IN ('pending','open')`) ≥ `maxConcurrentPositions` → log `trade_skipped_max_positions`, return.
   c. Si position déjà `open` ou `pending` pour ce `ticker` → log `trade_skipped_already_held`, return.
   d. `marketdata.getCandles(ticker, '5Min', 50)` → array de bars.
   e. `indicators.compute(bars)` → `{rsi, ema20, ema9, lastPrice}`.
   f. Si `rsi ≤ 50` ou `lastPrice ≤ ema20` ou `lastPrice ≤ ema9` → log `trade_skipped_technical`, return.
   g. `currentPrice` = `lastPrice` du dernier candle (pas de round-trip IBKR : Alpaca suffit, reste en market data gratuite).
   h. Décide `orderType` : `currentPrice ≤ entry_price × (1 + tolerancePct/100)` → market, sinon limit à `entry_price`.
   i. Calcule `quantity = floor((equity × riskPerTradePct/100) / (entry_price × trailingStopPct/100))`. Si `quantity < 1` → log `trade_skipped_too_small`, return.
   j. Insert row `positions` status=`pending` avec snapshot du signal.
   k. `broker.placeBracket({ticker, qty, orderType, entryPrice, tp: target_price, trailPct: 7})` → retourne `{parentId, tpId, slId}`.
   l. Update la row avec les IBKR order IDs.
4. Sur event `orderStatus` d'IBKR :
   - `Filled` sur le parent → status=`open`, `opened_at`, `fill_price`. Log `trade_filled`.
   - `Cancelled` sur le parent (timeout 30 min) → status=`cancelled`. Log `trade_cancelled`.
   - Enfant TP ou SL filled → status=`closed`, `close_reason`, `exit_price`, `pnl`. Log `trade_closed_*`.
   - `Error` → status=`error`, message stocké dans `raw_signal`. Log `trade_error`.

## Flux détaillé — Sortie Discord

1. Message `exit` classifié par handler.
2. Handler appelle `engine.onExit({ticker, author})`.
3. `engine.onExit` :
   a. Cherche une row `positions` pour `(ticker, author, status='open')`. Si aucune → return silencieux (audit log quand même).
   b. `broker.closePosition(ticker, qty)` → market order inverse.
   c. Cancel les ordres enfants TP + trailing stop (sinon ils exécuteraient aussi).
   d. Update row : status=`closed`, `close_reason='manual_exit'`, `exit_price`, `pnl` sur fill.

## Flux — Réconciliation au boot

Au démarrage du bot, avant d'accepter des signaux :

1. Query DB : `positions WHERE status IN ('pending', 'open')`.
2. `broker.getOpenPositions()` → liste IBKR.
3. Pour chaque row DB : si le ticker n'est plus chez IBKR ou si qty diffère → marquer status=`error`, log `trade_reconcile_mismatch`, **bloquer** `tradingEnabled` tant qu'un humain n'a pas résolu via dashboard.
4. Pour chaque position IBKR pas dans la DB → log warning mais ne pas bloquer (c'est une position ouverte ailleurs que le bot, le bot n'y touche pas).

## Config par défaut

```js
{
  tradingEnabled: false,         // kill-switch, défaut OFF
  mode: 'paper',                 // 'paper' | 'live'
  riskPerTradePct: 1.0,
  tolerancePct: 2.0,
  trailingStopPct: 7.0,
  maxConcurrentPositions: 5,
  limitOrderTimeoutMin: 30,
  authorWhitelist: [],           // vide = pas de filtre auteur supplémentaire
  tfMinutes: 5,
  ibkrHost: '127.0.0.1',
  ibkrPort: 7497,                // 7497 paper, 7496 live
  ibkrClientId: 1,
  alpacaKeyId: '',               // env: ALPACA_KEY_ID
  alpacaSecretKey: '',           // env: ALPACA_SECRET_KEY
}
```

Clés sensibles lues depuis `process.env`, pas depuis le fichier config.

## Tests

- **Unitaires** `trading/indicators.test.js` : vecteurs d'entrée connus → RSI/EMA attendus (comparer à des valeurs de référence type `pandas-ta`).
- **Unitaires** `trading/engine.test.js` : `onEntry` avec broker/marketdata mockés, vérifier les skips (trading disabled, max positions, technical fail, already held, qty<1) et les branches market vs limit.
- **Paper mode** : `broker.PaperBroker` simule fills instantanés au prix courant + fait avancer SL/TP à chaque tick de market data. Permet de lancer le bot en conditions réelles sans argent.
- Pas de tests d'intégration IBKR (nécessiteraient un IB Gateway actif en CI).

## Rollout

1. **Paper 1 semaine** : `mode=paper`, `authorWhitelist` = 1 auteur de confiance. Audit manuel des décisions contre ce qu'un humain aurait fait.
2. **Live réduit** : `mode=live`, `riskPerTradePct=0.25` pendant quelques jours.
3. **Live normal** : `riskPerTradePct=1.0` une fois confiance établie.

Le kill-switch + panic button sont les filets de sécurité en cas de bug.

## Déploiement

Contrainte IBKR : un processus **IB Gateway** (ou TWS) doit tourner en permanence pour que l'API soit accessible. Deux options, à décider en phase d'implémentation :

- **A** : faire tourner le bot + IB Gateway sur une même VM (Railway avec Dockerfile custom, ou VPS type Hetzner/DigitalOcean). IB Gateway peut tourner headless en Docker.
- **B** : bot sur Railway (comme aujourd'hui) + IB Gateway sur une machine perso ou un petit VPS, connexion par IP autorisée.

À trancher quand on écrira le plan d'implémentation.

## Hors scope (pour plus tard)

- Critères additionnels de filtrage (confidence minimum, whitelist auteurs stricte, volume, ATR-based SL).
- Backtest sur l'historique des signaux déjà en DB.
- Options (options chains, pas de support dans ce design — equities US seulement).
- Multi-broker (pas d'abstraction prématurée).
- Notifications Discord des fills/closes (ajoutable dans un second temps via le client Discord déjà en mémoire).
