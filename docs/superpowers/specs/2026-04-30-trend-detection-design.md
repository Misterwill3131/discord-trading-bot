# Trend detection — scan auto + commande `!trend`

## Objectif

Ajouter au bot un module de détection de tendances sur stocks/indices, avec :

- **Commande à la demande** `!trend TICKER` — analyse instantanée d'un ticker (direction actuelle, événements récents, indicateurs).
- **Scan automatique** — boucle qui analyse une watchlist par serveur, toutes les 5 min pendant les heures de marché US régulières, et poste des alertes Discord sur trois types de signaux : **transition de direction**, **breakout**, **reversal**.

Module gratuit pour tous les serveurs (pas d'intégration SaaS / paywall en v1).

## Non-goals

- Pas d'intégration IBKR — toutes les données viennent de Yahoo (cohérent avec `market-commands`).
- Pas de daily timeframe — intraday seulement (candles 5 min). Daily/multi-timeframe pourra être ajouté plus tard.
- Pas de premarket / after-hours en v1 — heures régulières uniquement (9:30–16:00 ET, lun-ven).
- Pas de gating SaaS — accessible à toute guild où le bot est invité.
- Pas de mention de rôle / `@everyone` dans les alertes — message simple dans le salon configuré.
- Pas de gestion des jours fériés US — on accepte de scanner pour rien le 4 juillet (coût négligeable).
- Pas de DM aux utilisateurs — alertes uniquement dans un salon configurable par serveur.

## Architecture

### Fichiers touchés

- **Nouveau** : `trading/trend-engine.js` (~200 lignes) — fonctions pures `detectDirection`, `detectBreakout`, `detectReversal`, `detectAll`. Reçoit des candles, retourne un verdict. Aucune dépendance Discord/DB.
- **Nouveau** : `trading/trend-engine.test.js` — tests unitaires sur fixtures de candles construites à la main.
- **Nouveau** : `trading/trend-scanner.js` (~250 lignes) — boucle de scan (`startTrendScanner`, `runScanCycle`), helpers `isUSMarketOpen`, dispatch des alertes par guild.
- **Nouveau** : `trading/trend-scanner.test.js` — tests légers avec mocks Yahoo + Discord.
- **Nouveau** : `discord/trend-commands.js` (~250 lignes) — handlers `messageCreate` pour `!trend ...`. Exporte `registerTrendCommands(client, db)`.
- **Nouveau** : `db/trend-store.js` (~180 lignes) — accesseurs SQLite : `addToWatchlist`, `removeFromWatchlist`, `getWatchlist`, `getDistinctTickers`, `getGuildsWatching`, `setChannel`, `getChannel`, `deleteChannel`, `getState`, `updateDirection`, `updateEvent`.
- **Modifié** : `db/sqlite.js` — ajout des trois `CREATE TABLE IF NOT EXISTS` (`trend_watchlist`, `trend_channel`, `trend_state`) à côté des tables existantes (pattern actuel du projet).
- **Modifié** : `index.js` — appel `registerTrendCommands(client, db)` et `startTrendScanner(client, db)` après le `ready` event.
- **Modifié** : `.env.example` — nouveaux paramètres ajustables (voir section Env vars).

### Dépendances

- **`trading/indicators.js`** (existant) — `calcRSI`, `calcEMA`, `calcEMASeries`. Utilisé par `trend-engine`.
- **`trading/marketdata.js`** (existant) — fetch candles Yahoo + cache TTL. Utilisé par `trend-scanner` et `trend-commands`.
- **`better-sqlite3`** (existant) — persistance.
- **`discord.js`** (existant).

Aucune nouvelle dépendance npm.

### Principe de séparation

`trend-engine` est 100% pur (entrée : candles ; sortie : verdict). `trend-scanner` et `discord/trend-commands` l'utilisent tous les deux — la commande `!trend AAPL` et le scan auto **partagent exactement la même logique de détection**.

## Schéma DB

Trois tables ajoutées au `boom-backup.db` via `CREATE TABLE IF NOT EXISTS` dans `db/sqlite.js` (pattern existant du projet — pas de fichier de migration séparé).

```sql
-- Watchlist par guild
CREATE TABLE trend_watchlist (
  guild_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, ticker)
);
CREATE INDEX idx_trend_watchlist_ticker ON trend_watchlist(ticker);

-- Channel d'alerte par guild
CREATE TABLE trend_channel (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  set_at INTEGER NOT NULL
);

-- État global par ticker (partagé entre toutes les guilds)
CREATE TABLE trend_state (
  ticker TEXT PRIMARY KEY,
  direction TEXT,                       -- 'uptrend' | 'downtrend' | 'sideways' | NULL
  direction_changed_at INTEGER,
  last_breakout_at INTEGER,
  last_bullish_reversal_at INTEGER,
  last_bearish_reversal_at INTEGER,
  last_scan_at INTEGER
);
```

**Pourquoi `trend_state` global et pas per-guild** : la direction d'AAPL est une vérité de marché, pas une vérité per-guild. Si AAPL passe de sideways à uptrend à 11:25 ET, c'est un événement unique dispatché à toutes les guilds qui watch AAPL. Évite la divergence et économise le storage.

**Dédup** : également global. Un breakout AAPL = une seule alerte (par guild qui watch), pas re-déclenchée pendant `TREND_DEDUP_MINUTES` (défaut 60 min).

## Règles de détection

Toutes les règles s'appliquent à des candles 5 min, dernière fenêtre disponible (≥ 30 bougies pour avoir les indicateurs nets).

### Direction (state — alerte sur transition)

- **Uptrend** : `prix > EMA20` ET `EMA9 > EMA20` ET pente d'EMA20 positive sur les 6 dernières bougies (`ema20[-1] > ema20[-7]`).
- **Downtrend** : `prix < EMA20` ET `EMA9 < EMA20` ET pente d'EMA20 négative sur les 6 dernières bougies.
- **Sideways** : sinon.

Alerte uniquement quand la direction change vs la valeur stockée dans `trend_state.direction`.

### Breakout (événement)

- Prix de la dernière bougie > **plus haut des 20 bougies précédentes** (`TREND_BREAKOUT_LOOKBACK_BARS`).
- ET volume de la dernière bougie > **`TREND_BREAKOUT_VOLUME_MULT` × moyenne des 20 volumes précédents** (défaut 1.5×).
- Dédup : pas de re-alerte breakout sur le même ticker pendant `TREND_DEDUP_MINUTES` (défaut 60).

### Reversal (événement)

- **Bearish reversal** : `max(RSI sur les 3 dernières bougies) > TREND_RSI_OVERBOUGHT` (défaut 70) ET EMA9 vient de croiser sous EMA20 (croisement entre l'avant-dernière et la dernière bougie).
- **Bullish reversal** : `min(RSI sur les 3 dernières bougies) < TREND_RSI_OVERSOLD` (défaut 30) ET EMA9 vient de croiser au-dessus EMA20.
- Dédup : pas de re-alerte reversal du même type sur le même ticker pendant `TREND_DEDUP_MINUTES`.

### Verdict combiné

`detectAll(candles)` retourne :

```js
{
  direction: 'uptrend' | 'downtrend' | 'sideways' | null,
  events: [
    { type: 'breakout', high: 173.50, volume: 2_100_000, avgVolume: 1_200_000 },
    { type: 'bullish_reversal', rsi: 32, ema9: 172.05, ema20: 171.95 },
    // ...
  ],
  snapshot: { price, ema9, ema20, rsi }
}
```

`null` si pas assez de candles pour calculer.

## Scanner

### Démarrage

`trend-scanner.js` exporte `startTrendScanner(client, db)`. Appelé une fois depuis `index.js` après l'event `ready` du client Discord.

### Scheduling

Un seul `setInterval` qui tick toutes les **60 secondes**. À chaque tick :

```
1. Si !isUSMarketOpen(now)              → return.
2. Si minute(now) % TREND_SCAN_INTERVAL_MIN !== 0 → return.
3. Sinon                                 → runScanCycle().
```

`setInterval(60s)` plutôt que `setInterval(5min)` : robuste aux dérives, redémarrages, et changements DST.

### `isUSMarketOpen(now)`

Helper qui :
- Convertit `now` en composantes ET via `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })` (gère DST).
- Vérifie jour de semaine ∈ [lun, mar, mer, jeu, ven].
- Vérifie 9:30 ≤ heure < 16:00.
- Pas de gestion jours fériés en v1.

Testé indépendamment via fixtures de timestamps (au moins 1 cas DST mars + 1 cas DST novembre).

### `runScanCycle()`

```
1. tickers = db.getDistinctTickers()  // SELECT DISTINCT ticker FROM trend_watchlist
2. Pour chaque ticker (en série, pas en parallèle) :
   a. try {
        candles = await fetchYahooCandles(ticker, '5m', last 100 bars)
        verdict = detectAll(candles)
        state = db.getState(ticker)
        alerts = []

        // Direction
        if (verdict.direction && verdict.direction !== state.direction) {
          alerts.push({ type: 'direction', from: state.direction, to: verdict.direction })
          db.updateDirection(ticker, verdict.direction, now)
        }

        // Events (avec dédup)
        for (const ev of verdict.events) {
          const lastTs = state[`last_${ev.type}_at`]
          if (!lastTs || now - lastTs >= dedupMs) {
            alerts.push({ type: 'event', ...ev })
            db.updateEvent(ticker, ev.type, now)
          }
        }

        // Dispatch
        if (alerts.length) {
          guilds = db.getGuildsWatching(ticker)
          for (const guildId of guilds) {
            const channelId = db.getChannel(guildId)
            if (!channelId) continue
            for (const alert of alerts) {
              await postAlert(client, channelId, ticker, alert, verdict.snapshot, guildId)
            }
          }
        }
      } catch (err) {
        log.error(`trend scan ${ticker}: ${err.message}`)
      }
   b. await sleep(200)  // throttle léger
3. log: "trend scan: N tickers, M alerts, T ms"
```

### Dispatch d'une alerte (`postAlert`)

```
- channel = await client.channels.fetch(channel_id)
- Si channel introuvable / deleted →
    db.deleteChannel(guildId), log warning, return
- Si bot n'a pas la permission d'écrire (DiscordAPIError 50013) →
    log warning, return (ne supprime pas le channel : permission peut être restaurée)
- Sinon →
    channel.send(formatAlert(...))
```

### Robustesse

- **Erreur Yahoo sur un ticker** : `try/catch` autour de chaque ticker. Log + skip + continue.
- **Bot redémarré en plein milieu d'une session** : `trend_state` est en DB → reprise sans re-alerte du même état.
- **Throttling Yahoo** : `await sleep(200)` entre tickers. Pour 20 tickers : 4s sur un budget de 5 min, large.

## Commandes Discord

Préfixe text `!trend ...` (cohérent avec `!price` / `!chart` / `!indicator`).

### Lecture (tous membres)

#### `!trend TICKER`

Analyse complète à la demande. Réutilise `detectAll` exactement comme le scanner.

```
📊 $AAPL — Apple Inc.
Direction: 📈 uptrend (since 11:25 ET)
Price: $174.23 · EMA9 $173.10 · EMA20 $172.50 · RSI 58

Recent events (last 24h):
• 🚀 Breakout at 11:25 ET — $173.50 high broken on 1.8× volume
• (no reversals)
```

Marche pour n'importe quel ticker, pas seulement ceux de la watchlist. La section "Recent events" est lue depuis `trend_state` (qui ne stocke que **le timestamp le plus récent** de chaque type d'événement — donc au plus 3 lignes : un breakout, un bullish reversal, un bearish reversal). Si le ticker n'est pas dans `trend_state`, affiche `(no recent events tracked — add to watchlist for monitoring)`.

#### `!trend watchlist`

Liste les tickers de la watchlist de la guild + état actuel de chacun :

```
Watchlist (5 tickers):
📈 $AAPL  — uptrend
📉 $TSLA  — downtrend
➡️ $NVDA  — sideways
📈 $SPY   — uptrend
➡️ $QQQ   — sideways
```

#### `!trend status`

```
Trend bot status (this server):
• Alert channel: #trends ✅
• Watchlist: 5 tickers
• Scanner: running (next scan in 2m)
• Market: open
```

### Modification (permission `ManageGuild` requise)

#### `!trend watch TICKER`

Ajoute le ticker à la watchlist de la guild.

- Validation : `await fetchYahooCandles(ticker, '5m', 1)` → si Yahoo retourne `not found`, refus avec `❌ Unknown ticker $XXX`.
- Si déjà présent : `ℹ️ $AAPL already in watchlist`.
- Sinon : `✅ Added $AAPL to watchlist (5 tickers total)`.

#### `!trend unwatch TICKER`

Retire le ticker.
- Si pas présent : `ℹ️ $AAPL not in watchlist`.
- Sinon : `✅ Removed $AAPL`.

#### `!trend channel #salon`

Set le channel d'alerte pour la guild.
- Si argument absent : affiche le channel actuel ou `⚠️ No alert channel set. Use !trend channel #channel`.
- Si argument valide : `✅ Trend alerts will be posted to #salon`.

### Permissions

Les handlers de modification vérifient `message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)`. Si non : `❌ You need Manage Server permission to use this command.`

Toutes les commandes user-facing sont en **anglais** (convention bot existante).

## Format des alertes

Markdown plain (pas de Discord embed), aligné avec le style des commandes existantes.

### Direction transition

```
📈 **$AAPL** — uptrend
Was: sideways · Now: uptrend
Price: $174.23 · EMA9 $173.10 · EMA20 $172.50 · RSI 58
```

Emoji selon nouvelle direction : 📈 uptrend, 📉 downtrend, ➡️ sideways. Le texte de transition (`Was: X · Now: Y`) montre toujours le `from`/`to` pour le contexte.

### Breakout

```
🚀 **$AAPL** — breakout
Broke 20-bar high $173.50 on 1.8× volume
Price: $174.23 · Volume: 2.1M (avg 1.2M)
```

Volume formaté avec suffixes K/M.

### Bullish reversal

```
🔄 **$AAPL** — bullish reversal
RSI was oversold (28), EMA9 crossed above EMA20
Price: $172.10 · RSI 32 · EMA9 $172.05 · EMA20 $171.95
```

### Bearish reversal

```
🔄 **$AAPL** — bearish reversal
RSI was overbought (74), EMA9 crossed below EMA20
Price: $185.40 · RSI 68 · EMA9 $185.50 · EMA20 $185.60
```

## Erreurs & edge cases

| Cas | Comportement |
|-----|-------------|
| Yahoo timeout / erreur sur un ticker | Log + skip ce ticker, continue le scan |
| Ticker invalide ajouté via `!trend watch` | Validation bloquante via fetch test |
| Channel deleted entre deux scans | Catch erreur Discord, `DELETE FROM trend_channel`, log warning |
| Bot perdu permission d'écrire | Log warning, ne supprime pas le channel (permission peut revenir) |
| Pas assez de candles | `trend-engine` retourne `{ direction: null, events: [] }` → pas d'alerte |
| Bot redémarre en plein milieu d'une session | `trend_state` persisté → pas de re-alerte du même état |
| DST switch | `isUSMarketOpen` utilise `Intl.DateTimeFormat` timezone `America/New_York` |
| Watchlist vide pour toutes les guilds | `runScanCycle` short-circuit (pas de tickers, pas de fetch) |
| Bot pas dans la guild (kicked) entre deux scans | `client.channels.fetch` lèvera, attrapé, channel non supprimé (peut revenir) |

## Tests

### `trading/trend-engine.test.js`

Fixtures de candles construites à la main, en JS pur :

- `detectDirection` : cas uptrend net, downtrend net, sideways, transition uptrend→sideways, transition sideways→downtrend.
- `detectBreakout` : breakout valide (prix + volume), breakout sans volume (rejeté), pas de breakout, breakout au seuil exact.
- `detectReversal` : bullish valide, bearish valide, RSI extrême sans crossover (rejeté), crossover sans RSI extrême (rejeté).
- `detectAll` : combinaison direction + events.

### `trading/trend-scanner.test.js`

Léger, avec mocks :
- `isUSMarketOpen` : 1 cas pendant heures, 1 hors heures, 1 weekend, 1 DST mars, 1 DST novembre.
- `runScanCycle` : avec un fake DB et des stubs Yahoo/Discord, vérifier que les alertes sont dispatchées correctement et la dédup respectée.

Pas de test live contre Yahoo. Pas d'intégration end-to-end.

## Env vars

Ajoutées à `.env.example` :

```
# Trend module
TREND_SCAN_INTERVAL_MIN=5
TREND_BREAKOUT_LOOKBACK_BARS=20
TREND_BREAKOUT_VOLUME_MULT=1.5
TREND_DEDUP_MINUTES=60
TREND_RSI_OVERBOUGHT=70
TREND_RSI_OVERSOLD=30
```

Toutes optionnelles avec valeurs par défaut. Aucun secret. Le module fonctionne dès le boot.

## Étapes manuelles utilisateur

Une fois le code mergé et déployé :

1. **Sur chaque serveur Discord où tu veux activer le scan** :
   - Faire `!trend channel #ton-salon` (avec permission `Manage Server`).
   - Ajouter des tickers : `!trend watch SPY`, `!trend watch AAPL`, etc.
2. **Optionnel sur Railway / hébergeur** : ajouter les env vars `TREND_*` si tu veux ajuster les seuils par défaut. Sinon les défauts s'appliquent.

Aucune migration manuelle de DB nécessaire (la migration tourne au boot).
Aucune action sur le Discord Developer Portal (pas de nouveau scope/intent — `MessageContent` et `Guilds` déjà actifs).
