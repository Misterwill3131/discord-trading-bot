# Analyst Watchlist + Milestone Alerts — Design

**Date** : 2026-05-14
**Statut** : Draft — en attente de validation utilisateur

## Problème

Dans le canal Discord `trading-floor`, plusieurs sources postent des messages :
- **Analystes humains** qui mentionnent des tickers (parfois avec un prix d'entrée, parfois non)
- **Bots TrendVision** qui postent des alertes scanner (volume, squeeze, halts, etc.)

Il n'existe aujourd'hui aucun mécanisme pour **suivre la performance** des tickers cités par les analystes. Si un analyste mentionne `$AAPL @ $200` et que le titre fait +50 % deux semaines plus tard, personne ne le voit en temps réel — l'information se noie dans le flux du canal.

## Objectif

Construire un système de **watchlist auto-alimentée** par les mentions d'analystes, avec **alertes Discord automatiques** aux paliers de gain cumulé (+20 %, +50 %, +100 %, +200 %, +300 %, +500 %, +1000 %). Chaque palier ne fire **qu'une seule fois par ticker**, et un cooldown d'**1 heure minimum** entre alertes du même ticker empêche le spam.

**TrendVision est secondaire** — ses messages sont stockés pour audit mais ne seedent pas la watchlist dans cette première version.

## Non-objectifs

- Pas de tracking de baisse (−20 %, −50 %) — focus moonshots uniquement
- Pas d'alerte sur retracement (gain qui repasse sous un palier déjà tiré)
- Pas de seeding par les bots TrendVision (analyste-only)
- Pas de dashboard web — uniquement alertes Discord
- Pas de multi-canal — un seul canal source (`TRADING_CHANNEL`)
- Pas de re-mention reset — la 1ère mention fixe définitivement le prix initial

## User flow

1. **Analyste** poste dans `#trading-floor` : `Watch $AAPL @ $200, looks ready to break out`
2. Le **listener** (`discord/analyst-watchlist.js`) :
   - Stocke le message dans `tracked_messages` (audit)
   - Extrait `AAPL` (ticker) et `$200` (prix)
   - Insère `(AAPL, 200, message_id, channel_id, ...)` dans `analyst_watchlist` — INSERT OR IGNORE garantit que la 1ère mention gagne
3. **30 minutes plus tard** (et toutes les 30 min pendant les heures de marché US), le **cron** (`discord/milestone-checker.js`) :
   - Lit toutes les entrées actives de `analyst_watchlist`
   - Fetch le prix actuel via FMP en **1 seul appel bulk**
   - Pour chaque ticker, calcule le gain cumulé et trouve le prochain palier non-tiré
   - Si un palier est atteint et le cooldown 1h est respecté → INSERT atomique dans `milestone_alerts` puis reply Discord sous le message d'origine
4. **Discord reply** dans `#trading-floor`, sous le message original :
   ```
   🚀 $AAPL hit +20% milestone — now $240.00 (entry $200.00, gain +20.00%) — first flagged by @analyst_user
   ```
5. **30 jours plus tard**, si aucun palier supplémentaire n'a été franchi, l'entrée est soft-archivée (`archived_at = now()`) et ne consomme plus de quota FMP.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Discord — canal trading-floor                                  │
│  ┌────────────────┐         ┌─────────────────────┐             │
│  │ Analystes      │         │ Bots TrendVision    │             │
│  │ (humains)      │         │ (whale, volume...)  │             │
│  └────────┬───────┘         └─────────┬───────────┘             │
└───────────┼───────────────────────────┼─────────────────────────┘
            │ messageCreate event       │
            ▼                           ▼
┌────────────────────────────────────────────────────────────────┐
│  discord/analyst-watchlist.js                                  │
│  - Filter : substring match TRADING_CHANNEL                    │
│  - Stocke TOUT dans tracked_messages (audit)                   │
│  - Si non-bot + ticker : extract prix, fetch FMP si fallback,  │
│    INSERT OR IGNORE dans analyst_watchlist (1ère mention gagne)│
└────────────┬───────────────────────────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────────────────────────────┐
│  SQLite (db/sqlite.js)                                         │
│  - tracked_messages    : audit (analystes + bots)              │
│  - analyst_watchlist   : tickers actifs avec prix initial      │
│  - milestone_alerts    : log des paliers tirés (UNIQUE dedup)  │
└────────────────────────────────────────────────────────────────┘
             ▲                                          ▲
             │ read                                     │ write
             │                                          │
┌────────────┴──────────────────────────────────────────┴────────┐
│  discord/milestone-checker.js  (tick 30 min, RTH only)         │
│  - Archive expirés (TTL 30j)                                   │
│  - Read actifs → bundle quote FMP (1 call)                     │
│  - Compute gain %, find next milestone                         │
│  - Check cooldown 1h                                           │
│  - Mark-then-send : INSERT atomique → reply Discord            │
└────────────────────────────────────────────────────────────────┘
             ▲
             │ driven by
┌────────────┴───────────────────────────────────────────────────┐
│  discord/jobs.js  — driver de tick existant                    │
│  Ajoute : milestoneChecker.tick(client, now)                   │
└────────────────────────────────────────────────────────────────┘
```

**Fichiers concernés** :
- *Nouveaux* : `discord/analyst-watchlist.js`, `discord/analyst-watchlist.test.js`, `discord/milestone-checker.js`, `discord/milestone-checker.test.js`
- *Modifiés* : `db/sqlite.js` (3 tables + helpers), `discord/jobs.js` (1 tick), `index.js` (1 listener), `.env.example` (4 nouvelles vars)

## Modèle de données (SQLite)

### `tracked_messages` — audit complet de tous les messages stockés

```sql
CREATE TABLE IF NOT EXISTS tracked_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id        TEXT NOT NULL UNIQUE,        -- Discord snowflake
  channel_id        TEXT NOT NULL,
  author_id         TEXT NOT NULL,
  author_username   TEXT,
  is_bot            INTEGER NOT NULL DEFAULT 0,  -- 0 = humain, 1 = bot
  content           TEXT,
  embed_json        TEXT,                        -- JSON serialisé
  extracted_ticker  TEXT,                        -- nullable
  extracted_price   REAL,                        -- nullable
  created_at        INTEGER NOT NULL             -- UNIX timestamp (ms)
);
CREATE INDEX idx_tracked_messages_ticker ON tracked_messages(extracted_ticker);
CREATE INDEX idx_tracked_messages_created ON tracked_messages(created_at);
```

### `analyst_watchlist` — tickers actifs avec prix de référence

```sql
CREATE TABLE IF NOT EXISTS analyst_watchlist (
  ticker                  TEXT PRIMARY KEY,      -- UPPERCASE, ex: 'AAPL'
  initial_price           REAL NOT NULL,
  initial_price_source    TEXT NOT NULL,         -- 'message' | 'market'
  source_message_id       TEXT NOT NULL,
  source_channel_id       TEXT NOT NULL,         -- pour reply
  mentioned_by_user_id    TEXT NOT NULL,
  mentioned_by_username   TEXT,
  first_seen_at           INTEGER NOT NULL,
  last_milestone_pct      INTEGER,               -- nullable, max palier tiré
  last_alert_at           INTEGER,               -- nullable, pour cooldown
  archived_at             INTEGER                -- nullable, set quand TTL expire
);
CREATE INDEX idx_watchlist_active ON analyst_watchlist(archived_at);
```

### `milestone_alerts` — log des paliers tirés (dedup atomique)

```sql
CREATE TABLE IF NOT EXISTS milestone_alerts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker              TEXT NOT NULL,
  milestone_pct       INTEGER NOT NULL,          -- 20, 50, 100, ...
  initial_price       REAL NOT NULL,
  current_price       REAL NOT NULL,
  gain_pct            REAL NOT NULL,
  fired_at            INTEGER NOT NULL,
  discord_message_id  TEXT,                      -- ID du reply posté
  UNIQUE (ticker, milestone_pct)                 -- ← anti-spam atomique
);
```

**Garanties par le schéma** :
- `analyst_watchlist.PRIMARY KEY (ticker)` → 1ère mention gagne via INSERT OR IGNORE
- `milestone_alerts.UNIQUE (ticker, milestone_pct)` → un palier ne peut jamais fire 2 fois (mark-then-send atomique)
- Soft-delete via `archived_at` plutôt que DELETE → préserve l'historique pour audit

## Listener — `discord/analyst-watchlist.js`

Responsabilités :
1. **Filtre channel** : substring match sur `process.env.TRADING_CHANNEL` (défaut `trading-floor`)
2. **Audit** : insère TOUS les messages dans `tracked_messages` (analystes + bots)
3. **Extraction** :
   - Ticker via `extractTicker` réutilisé de `discord/screener-ingest.js` (blacklist déjà tunée)
   - Prix via regex `\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)` — prend le 1er match
   - Sanity range prix : 0.01 < prix ≤ 100 000
4. **Seed conditionnel** :
   - Si bot → skip seed
   - Si pas de ticker → skip seed
   - Si prix dans message → utilise prix message, source = `'message'`
   - Sinon → fetch via `fmp.getQuote(ticker)`, source = `'market'`
   - Si FMP fail → log warning et skip seed (pas de prix garbage)
5. **INSERT OR IGNORE** dans `analyst_watchlist` — 1ère mention gagne, atomique

Exporte : `register(client)`, `handleMessage(message)`, `extractPrice(text)` (pour tests).

## Cron job — `discord/milestone-checker.js`

Responsabilités (tick toutes les 30 min, **RTH only** = `isRTH(now)` de `market-alerts.js`) :

1. **Archive TTL** : `UPDATE analyst_watchlist SET archived_at = now WHERE archived_at IS NULL AND first_seen_at < now - 30d`
2. **Read actifs** : `SELECT * FROM analyst_watchlist WHERE archived_at IS NULL`
3. **Bundle quote FMP** : `fmp.getQuotesBulk([ticker1, ticker2, ...])` — 1 seul appel API
4. **Per-entry** :
   - `gain_pct = (current_price - initial_price) / initial_price * 100`
   - `target = nextMilestone(gainPct, last_milestone_pct)` → premier palier > `last_milestone_pct` ET ≤ `gainPct`
   - Si `target == null` → continue
   - Si `now - last_alert_at < 1h` → continue (cooldown)
   - **Mark-then-send atomique** : `INSERT OR IGNORE INTO milestone_alerts (ticker, milestone_pct, ...)`. Si l'insert a tagué 0 ligne (UNIQUE constraint a déjà cette combo) → continue, déjà tiré. Détection via `changes()` ou retour de `better-sqlite3`.
   - **Reply Discord** : `channel.messages.fetch(source_message_id).then(m => m.reply(text))` avec `allowedMentions: { parse: [] }`
   - **Update watchlist** : `last_milestone_pct = target, last_alert_at = now`
5. **Tolérance aux fails** : si FMP fail (bulk) → log et skip ce tick. Si reply Discord fail → pas de rollback du `milestone_alerts` insert (mark-then-send : perdre 1 alerte vaut mieux qu'en spammer 60).

Format du message (English, cohérent avec `market-alerts.js`) :

```
🚀 **$AAPL** hit **+20%** milestone — now $240.00 (entry $200.00, gain +20.00%) — first flagged by @analyst_user
```

Exporte : `tick(client, now)`, `nextMilestone(gainPct, lastFiredPct)`, `buildAlertMessage(...)` (pour tests).

**Note FMP** : `fmp.getQuotesBulk(tickers)` peut nécessiter d'être ajoutée à `discord/fmp-client.js` si elle n'existe pas — endpoint FMP `/api/v3/quote/{ticker1},{ticker2},...`. Limit ~250 tickers/call.

## Wiring

### `discord/jobs.js`

Ajout d'un dispatch dans la boucle tick existante :

```js
const milestoneChecker = require('./milestone-checker');
// dans la boucle tick existante (cadence configurable via env)
milestoneChecker.tick(client, now).catch(err =>
  console.error('[jobs] milestone tick error:', err.message)
);
```

### `index.js`

Enregistre le listener au démarrage du client Discord (cohérent avec `screener-ingest.register(client)` existant) :

```js
const analystWatchlist = require('./discord/analyst-watchlist');
client.once('ready', () => {
  analystWatchlist.register(client);
});
```

## Configuration — `.env.example`

```env
# === ANALYST WATCHLIST + MILESTONE ALERTS ============================
# Watchlist auto-alimentée par les mentions de tickers d'analystes dans
# TRADING_CHANNEL. Polling marché 30 min — alerte Discord aux paliers de
# gain cumulé. Réutilise TRADING_CHANNEL (substring match).
#
# Paliers de gain (% cumulé) qui déclenchent une alerte. CSV d'entiers
# positifs. Défaut couvre les multibaggers classiques (1.2x → 11x).
MILESTONE_THRESHOLDS=20,50,100,200,300,500,1000

# Délai minimum (heures) entre 2 alertes du même ticker, même si plusieurs
# paliers sont franchis pendant la fenêtre.
MILESTONE_COOLDOWN_HOURS=1

# TTL : après N jours sans nouveau palier, on archive l'entrée
# (soft-delete — audit préservé).
WATCHLIST_TTL_DAYS=30

# Cadence du polling FMP (minutes). 30 = un tick toutes les 30 min,
# uniquement pendant les heures de marché US régulières (RTH).
MILESTONE_POLL_INTERVAL_MIN=30
```

Toutes ces variables sont **optionnelles** — défauts sensés. Le module reste actif tant que `TRADING_CHANNEL` (déjà obligatoire) est défini.

## Tests

### `discord/analyst-watchlist.test.js`

- `extractPrice` : `$200` → 200 ; `$1,234.56` → 1234.56 ; `$0` → null ; `$200000` → null ; `"AAPL"` (no prix) → null
- `handleMessage` :
  - Non-bot + ticker + prix dans message → seed avec source=`'message'`
  - Non-bot + ticker sans prix → fetch FMP mocké, seed avec source=`'market'`
  - Bot + ticker → pas de seed (mais audit OK)
  - Mauvais channel → no-op complet
  - Re-mention du même ticker → INSERT OR IGNORE, 1ère entrée préservée
  - FMP fail → pas de seed, pas de crash
- DB SQLite en mémoire (pattern existant `db/sqlite.test.js`)

### `discord/milestone-checker.test.js`

Table de cas pour `nextMilestone(gainPct, lastFiredPct)` :

| gainPct | lastFired | Résultat |
|---------|-----------|----------|
| 15      | null      | null     |
| 25      | null      | 20       |
| 25      | 20        | null     |
| 60      | 20        | 50       |
| 250     | 100       | 200      |
| 1500    | 500       | 1000     |

Tests `tick(client, now)` :
- Watchlist vide → no FMP call
- 1 ticker à +25 %, lastFired=null → fire 20, update DB
- 1 ticker à +60 %, lastFired=20, dans cooldown 1h → no-op
- 1 ticker à +60 %, lastFired=20, cooldown OK → fire 50
- Hors RTH → tick no-op (pas de FMP call)
- FMP bulk fail → log + no crash, no fire
- Discord reply fail → milestone_alerts inséré (mark-then-send), no retry au tick suivant
- Entry first_seen_at > 30j → archivé au tick suivant, plus dans le polling

`buildAlertMessage` : snapshot test du format exact.

### `db/sqlite.test.js` (étendu)

- Les 3 nouvelles tables sont créées idempotemment au boot
- `INSERT OR IGNORE` sur `analyst_watchlist` préserve la 1ère mention
- `UNIQUE (ticker, milestone_pct)` sur `milestone_alerts` bloque les doublons
- Soft-archive : `archived_at` set sans DELETE

## Étapes manuelles (côté utilisateur)

1. **Aucune action requise dans Discord Developer Portal** — l'intent `Message Content Intent` est déjà actif pour `TRADING_CHANNEL`.
2. **Variables d'env Railway** : ajouter (optionnellement) `MILESTONE_THRESHOLDS`, `MILESTONE_COOLDOWN_HOURS`, `WATCHLIST_TTL_DAYS`, `MILESTONE_POLL_INTERVAL_MIN`. Skippable si les défauts conviennent.
3. **Quota FMP** : vérifier que le plan supporte ~12 bulk quote calls/jour (1/30min × 6h RTH). 250 tickers/call max — largement suffisant.

## Risques identifiés

| Risque | Mitigation |
|--------|------------|
| Faux positif sur extraction ticker (mot anglais en majuscules) | Blacklist `TICKER_BLACKLIST` réutilisée de `screener-ingest.js`, déjà tunée |
| Faux positif sur extraction prix ($1000000, codes ZIP, années) | Sanity range 0.01 < prix ≤ 100 000 |
| Spam si plusieurs paliers franchis rapidement | Cooldown 1h + UNIQUE constraint |
| Race condition entre 2 ticks (ex: scheduler bug) | Mark-then-send atomique via UNIQUE (ticker, milestone_pct) |
| Reply échoue (message source supprimé, perms) | Log + skip — `milestone_alerts` reste inséré donc pas de retry |
| FMP quota épuisé | Bulk quote (1 call/tick), RTH-only filter, TTL 30j (archive auto) |
| DB grossit indéfiniment | TTL soft-archive → polling skip les vieux ; `tracked_messages` audit-only, peut être purgé séparément si besoin |

## Out of scope (phase ultérieure si utile)

- Slash command `/watchlist` pour lister les entrées actives
- Slash command `/watchlist remove <ticker>` pour archiver manuellement
- Seeding par les bots TrendVision (ajouter un toggle `WATCHLIST_INCLUDE_BOTS=true`)
- Paliers négatifs (baisse)
- Re-mention reset (rolling initial_price)
- Multi-canal source
- Dashboard web temple-of-boom intégration
