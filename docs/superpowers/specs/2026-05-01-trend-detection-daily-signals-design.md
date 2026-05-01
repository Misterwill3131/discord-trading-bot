# Trend module — daily-reference signals (PDH/PDL/gap/volume)

## Objectif

Étendre le module trend (livré 2026-04-30) avec **5 nouveaux types d'events** basés sur la comparaison "aujourd'hui vs hier" :

- **`pdh_break`** — close intraday > plus haut d'hier (Previous Day High)
- **`pdl_break`** — close intraday < plus bas d'hier (Previous Day Low)
- **`gap_up`** / **`gap_down`** — open d'aujourd'hui s'écarte significativement de la close d'hier
- **`volume_above_prev_day`** — volume cumulé d'aujourd'hui > volume total d'hier × 1.05

Ces events s'ajoutent aux trois existants (transitions de direction, breakout 20-bar, reversal RSI/EMA cross). Même salon d'alerte, même watchlist, même pipeline de dispatch.

## Non-goals

- Pas de séparation des salons d'alerte — tout passe par `!trend channel #salon` existant.
- Pas de mention de rôle pour ces nouveaux events (cohérent avec les autres alertes du module).
- Pas de paywall / SaaS gating — feature gratuite comme le reste du module.
- Pas de gestion des jours fériés US — un lundi férié, on a hier = vendredi (la dernière daily bar avant aujourd'hui), c'est OK.
- Pas de gap pendant la session (intraday gaps) — uniquement le gap d'open vs close d'hier.
- Pas de détection multi-jour (ex. "3 jours consécutifs au-dessus du PDH") — events atomiques.
- Pas de re-classification d'un ticker après ajout : `quote_type` est figé à l'ajout via `!trend watch`.

## Architecture

### Fichiers touchés

Pas de nouveau fichier — extension des modules existants.

- **Modifié** : `trading/trend-engine.js` (~+200 lignes) — 5 nouvelles fonctions pures + extension de `detectAll`.
- **Modifié** : `trading/trend-engine.test.js` — fixtures + tests par event.
- **Modifié** : `trading/trend-scanner.js` (~+150 lignes) — `getDailyContext`, lookup `quote_type`, `detectorOpts` étendu, formatters, dispatch des nouvelles alertes, daily-reset logic.
- **Modifié** : `trading/trend-scanner.test.js` — mocks daily chart + tests d'intégration.
- **Modifié** : `db/sqlite.js` — `ALTER TABLE` pour 8 nouvelles colonnes.
- **Modifié** : `db/trend-store.js` — accesseurs `quote_type` (set/get) + 5 event types + state daily reset.
- **Modifié** : `db/trend-store.test.js` — tests des nouveaux accesseurs.
- **Modifié** : `discord/trend-commands.js` — `!trend watch` capture `quote_type` ; `!trend TICKER` affiche les events daily récents.
- **Modifié** : `.env.example` — 4 nouvelles vars.

### Dépendances

- **`trading/indicators.js`** (existant, inchangé).
- **Yahoo client partagé** (créé dans `index.js`, déjà passé à scanner et commands).
- **`better-sqlite3`** (existant).

Aucune nouvelle dépendance npm.

### Principe de séparation maintenu

`trend-engine` reste 100% pur (in: candles + contexte daily ; out: verdict). Le scanner et les commandes l'utilisent identiquement. Pas de couplage Discord/DB dans le moteur.

## Schéma DB (ALTER TABLE)

```sql
-- Capture du quoteType Yahoo lors de !trend watch (lazy backfill pour
-- les tickers déjà présents avant cette feature).
ALTER TABLE trend_watchlist ADD COLUMN quote_type TEXT;

-- État daily par ticker. daily_state_date sert de sentinelle pour le
-- reset automatique en début de chaque jour ET.
ALTER TABLE trend_state ADD COLUMN daily_state_date            TEXT;
ALTER TABLE trend_state ADD COLUMN pdh_alerts_today            INTEGER DEFAULT 0;
ALTER TABLE trend_state ADD COLUMN pdh_below_since             INTEGER;
ALTER TABLE trend_state ADD COLUMN pdl_alerts_today            INTEGER DEFAULT 0;
ALTER TABLE trend_state ADD COLUMN pdl_above_since             INTEGER;
ALTER TABLE trend_state ADD COLUMN gap_alerted_today           INTEGER DEFAULT 0;
ALTER TABLE trend_state ADD COLUMN volume_above_alerted_today  INTEGER DEFAULT 0;
```

**`daily_state_date`** : format `'YYYY-MM-DD'` en heure ET. Au début de chaque `runScanCycle` par ticker, si la date stockée diffère de la date ET courante, on remet à zéro les 6 colonnes daily (`pdh_alerts_today`, `pdh_below_since`, `pdl_alerts_today`, `pdl_above_since`, `gap_alerted_today`, `volume_above_alerted_today`) et on update `daily_state_date`.

Pourquoi une string ET plutôt qu'un timestamp comparé : plus lisible en debug, évite les pièges DST, et la résolution journalière est suffisante.

**Backfill `quote_type`** : tickers ajoutés avant cette feature ont `NULL`. Au scan, si `NULL` → fetch `yahoo.quote(ticker)`, lit `quoteType`, persiste, continue. Une seule fois par ticker.

## Fetch Yahoo (`getDailyContext`)

Nouveau helper dans `trading/trend-scanner.js` :

```js
async function getDailyContext(yahoo, ticker) {
  // 1M = interval 1d, ~22 daily bars. Ample pour avoir hier (et avant-hier en
  // cas de jour férié US qui décale la "daily précédente").
  const chart = await yahoo.getChart(ticker, '1M');
  const quotes = (chart && chart.quotes) || [];
  if (quotes.length < 2) return null;

  // Yahoo place la bougie "today" en dernier (en cours, vol cumulé, close = lastPrice).
  // "yesterday" = avant-dernière bougie complète.
  const today = quotes[quotes.length - 1];
  const yesterday = quotes[quotes.length - 2];

  return {
    yesterday: { high: yesterday.high, low: yesterday.low, close: yesterday.close, volume: yesterday.volume },
    todayOpen: today.open,
    todayCumVolume: today.volume,
  };
}
```

Le scanner appelle ce helper en plus du `getChart(ticker, '1D')` (intraday 5min) existant. **Coût** : 1 fetch supplémentaire par ticker par scan, cache TTL 30s du `createYahooClient` partagé absorbe les répétitions.

## Détection des quoteType

`quote_type` ∈ {`EQUITY`, `ETF`, `INDEX`, `MUTUALFUND`, `CRYPTOCURRENCY`, `CURRENCY`, `FUTURE`, `null` (avant backfill)}.

Catégories pour le seuil de gap :

```js
function isIndexLikeQuoteType(qt) {
  return qt === 'ETF' || qt === 'INDEX' || qt === 'MUTUALFUND';
}
```

Tout le reste (incl. `null` non-backfillé) tombe dans le bucket "stock" → seuil plus élevé. Backfill prioritaire au prochain scan pour clarifier.

## Règles de détection

### PDH break

```
État lu : pdh_alerts_today (int), pdh_below_since (int|null)
Inputs : intradayCandles, pdh = yesterday.high, reentryMs
Retour : { event, stateUpdate }
  event = { type: 'pdh_break', pdh, price, volume } | null
  stateUpdate = delta des colonnes à persister | null

last = intradayCandles[-1]
if last.c > pdh:
  if pdh_alerts_today == 0:
    → event = ALERT, stateUpdate = { pdh_alerts_today: 1, pdh_below_since: null }
  elif pdh_below_since == null:
    → event = null, stateUpdate = null
  else:
    if (now - pdh_below_since) >= reentryMs:
      → event = ALERT (ré-entrée), stateUpdate = { pdh_alerts_today: alerts+1, pdh_below_since: null }
    else:
      → event = null, stateUpdate = { pdh_below_since: null }  (remontée rapide, clear sans alerter)

elif last.c <= pdh and pdh_alerts_today > 0:
  if pdh_below_since == null:
    → event = null, stateUpdate = { pdh_below_since: now }
  else:
    → event = null, stateUpdate = null  (déjà en phase "en dessous")

else (last.c <= pdh and pdh_alerts_today == 0):
  → event = null, stateUpdate = null
```

### PDL break

Symétrique : remplace `pdh` ↔ `pdl`, `>` ↔ `<`, `pdh_below_since` ↔ `pdl_above_since`.

```
last.c < pdl AND alerts_today == 0 → ALERT (premier break)
last.c < pdl AND above_since != null AND elapsed >= reentryMs → ALERT (ré-entrée)
last.c < pdl AND above_since != null AND elapsed < reentryMs → clear above_since (no alert)
last.c >= pdl AND alerts_today > 0 AND above_since == null → set above_since = now
```

### Gap up / gap down

```
État : gap_alerted_today (0|1)
Inputs : intradayCandles, prevClose, gapThresholdPct
Output : { type: 'gap_up' | 'gap_down', openPrice, prevClose, gapPct } ou null

if gap_alerted_today: → null
todayOpen = première bougie 5min ≥ 09:30 ET (intradayCandles[0].o si non vide)
if !todayOpen or !prevClose: → null

gapPct = (todayOpen - prevClose) / prevClose * 100
if gapPct >= +gapThresholdPct:
  → ALERT 'gap_up', store update: gap_alerted_today = 1
elif gapPct <= -gapThresholdPct:
  → ALERT 'gap_down', store update: gap_alerted_today = 1
else: → null
```

`gapThresholdPct` choisi à l'appel selon `quote_type` :
- `isIndexLikeQuoteType(qt)` → `TREND_GAP_THRESHOLD_INDEX_PCT` (default 0.5)
- sinon → `TREND_GAP_THRESHOLD_STOCK_PCT` (default 1.5)

### Volume above prev day

```
État : volume_above_alerted_today (0|1)
Inputs : intradayCandles, prevDayVolume, multiplier (default 1.05)
Output : { type: 'volume_above_prev_day', todayVolume, prevDayVolume, ratio } ou null

if volume_above_alerted_today: → null
if !prevDayVolume or prevDayVolume <= 0: → null  (sentinelle, ticker peu liquide)
todayCumVolume = sum(b.v for b in intradayCandles)
if todayCumVolume > prevDayVolume * multiplier:
  → ALERT, store update: volume_above_alerted_today = 1
else: → null
```

`multiplier = 1 + TREND_VOLUME_VS_PREV_PCT / 100` (default 1.05 = +5%).

Note : `todayCumVolume` peut aussi venir de `getDailyContext().todayCumVolume` (Yahoo accumule la bougie daily du jour). Pour la fiabilité, on somme depuis l'intraday — source unique, déjà fetch.

### detectAll étendu

Les nouveaux détecteurs **restent purs** : ils prennent `state` en lecture, retournent l'event ET un `stateUpdate` (delta à appliquer). Le scanner applique le delta après l'appel.

Signature des nouveaux détecteurs :

```js
// Retourne { event: {...} | null, stateUpdate: { col1: val1, ... } | null }
function detectPDHBreak(intraday, pdh, state, reentryMs) { ... }
function detectPDLBreak(intraday, pdl, state, reentryMs) { ... }
function detectGap(intraday, prevClose, gapThresholdPct, state) { ... }
function detectVolumeAbovePrevDay(intraday, prevDayVolume, multiplier, state) { ... }
```

Exemple `detectPDHBreak` retours :
- premier break : `{ event: { type: 'pdh_break', ... }, stateUpdate: { pdh_alerts_today: 1, pdh_below_since: null } }`
- toujours au-dessus, déjà alerté : `{ event: null, stateUpdate: null }`
- retour sous PDH : `{ event: null, stateUpdate: { pdh_below_since: now } }`
- ré-entrée propre : `{ event: { ... }, stateUpdate: { pdh_alerts_today: 2, pdh_below_since: null } }`
- retour rapide < reentryMs : `{ event: null, stateUpdate: { pdh_below_since: null } }`

`detectAll` étendu :

```js
function detectAll(intraday, dailyContext, state, opts) {
  const direction = detectDirection(intraday);
  if (direction === null) return null;

  const events = [];
  const stateUpdates = {};  // accumulé puis retourné en bloc

  const breakout = detectBreakout(intraday, opts.breakoutLookback, opts.breakoutVolMult);
  if (breakout) events.push(breakout);
  const reversal = detectReversal(intraday, opts.rsiOverbought, opts.rsiOversold);
  if (reversal) events.push(reversal);

  if (dailyContext) {
    for (const detector of [
      () => detectPDHBreak(intraday, dailyContext.yesterday.high, state, opts.reentryMs),
      () => detectPDLBreak(intraday, dailyContext.yesterday.low, state, opts.reentryMs),
      () => detectGap(intraday, dailyContext.yesterday.close, opts.gapThresholdPct, state),
      () => detectVolumeAbovePrevDay(intraday, dailyContext.yesterday.volume, opts.volumeMultiplier, state),
    ]) {
      const { event, stateUpdate } = detector();
      if (event) events.push(event);
      if (stateUpdate) Object.assign(stateUpdates, stateUpdate);
    }
  }

  return { direction, events, snapshot: { price, ema9, ema20, rsi }, stateUpdates };
}
```

Le scanner applique `stateUpdates` après dispatch via un nouvel accesseur du store (cf. section DB).

## Daily reset

Au début de `runScanCycle` par ticker :

```js
const todayET = formatDateET(now());  // 'YYYY-MM-DD'
const state = store.getState(ticker) || {};
if (state.daily_state_date !== todayET) {
  store.resetDailyState(ticker, todayET);
  state.daily_state_date = todayET;
  state.pdh_alerts_today = 0;
  state.pdh_below_since = null;
  // ... reset des 6 colonnes
}
```

Helper `formatDateET(date)` utilise `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })` → format `YYYY-MM-DD` natif.

## Scanner — boucle étendue

```
Pour chaque ticker (in séries, throttle 200ms inchangé) :
  1. Lookup quote_type via store.getQuoteType(ticker, guildId-agnostic)
     - Si NULL : await yahoo.quote(ticker), capture quoteType, store.setQuoteType
     - Si erreur Yahoo : log + skip (continuera au prochain scan)
  2. Daily reset (cf. ci-dessus) si daily_state_date != todayET
  3. Fetch intraday : await yahoo.getChart(ticker, '1D')   [existant]
  4. Fetch daily   : await getDailyContext(yahoo, ticker)
     - Si erreur : daily-events skipped pour ce cycle, mais direction/breakout/reversal continuent
  5. verdict = detectAll(intraday, daily, state, detectorOpts)
       verdict = { direction, events, snapshot, stateUpdates }
  6. Si verdict.stateUpdates non vide : store.applyStateUpdates(ticker, stateUpdates) (un seul UPSERT avec les colonnes deltas)
  7. Pour chaque event dans verdict.events : format alert + dispatch (même channel pipeline existant)
```

`detectorOpts` étendu avec :
- `reentryMs = TREND_PDH_PDL_REENTRY_MIN * 60_000`
- `gapThresholdPct` (résolu selon `quote_type`)
- `volumeMultiplier`

## Format des alertes

Toutes en anglais, Markdown plain (cohérent avec l'existant) :

```
🟢 **$AAPL** — PDH break
Closed above yesterday's high $174.50
Price: $174.62 · Volume: 1.2M
```

```
🔴 **$AAPL** — PDL break
Closed below yesterday's low $172.10
Price: $171.98 · Volume: 1.5M
```

```
⬆️ **$AAPL** — gap up +1.8%
Opened $176.20 vs prev close $173.10
```

```
⬇️ **$AAPL** — gap down -2.3%
Opened $169.20 vs prev close $173.10
```

```
📊 **$AAPL** — volume above prev day
Today: 18.5M (+7.6%) · Yesterday: 17.2M
Time: 14:23 ET
```

Volume formaté avec suffixes K/M/B (helper `fmtVolume` existant). Time helper utilise déjà `Intl` ET.

## Commandes Discord

### `!trend watch <TICKER>` — extension

Capture `quote_type` du payload Yahoo lors de la validation existante :

```js
const quote = await yahoo.getQuote(ticker);
const quoteType = quote.quoteType || null;
store.addToWatchlist(guildId, ticker, now, quoteType);
```

Signature de `addToWatchlist` étendue avec un 4ème argument optionnel `quoteType`.

### `!trend TICKER` — section "Recent events" étendue

Affiche les nouveaux events du jour (uniquement ceux fired today, lookup via `_alerts_today > 0` ou `_alerted_today == 1`) :

```
📊 $AAPL
Direction: 📈 uptrend (since 11:25 ET)
Price: $174.23 · EMA9 $173.10 · EMA20 $172.50 · RSI 58

Today's daily-reference events:
• 🟢 PDH break  (yesterday's high $174.50)
• ⬆️ Gap up +1.8% at open

Recent intraday events:
• 🚀 Breakout at 11:25 ET — $173.50 high broken on 1.8× volume

Today's volume: 18.5M (+7.6% vs yesterday)
```

Les events daily affichés ne sont reset qu'au prochain jour ET (cohérent avec `daily_state_date`).

## Erreurs & edge cases

| Cas | Comportement |
|-----|-------------|
| `getDailyContext` fail (Yahoo timeout) | Log + skip les 4 nouveaux events pour ce cycle ; direction/breakout/reversal continuent |
| `getDailyContext` retourne < 2 quotes (ticker très jeune) | Retourne null → 4 events skipped |
| `quote_type` lookup fail (Yahoo down sur quote()) | Retombe sur bucket "stock" (seuil haut) ; backfill réessayé au prochain scan |
| Premier scan d'un ticker en plein milieu de session | `daily_state_date` mis à aujourd'hui, `pdh_alerts_today = 0` ; gap NE FIRE PAS si `gap_alerted_today` est 0 mais l'open du jour est passé (logique : on rate les gaps des tickers ajoutés post-9:30) |
| Lundi férié US (4 juillet, etc.) | "Yesterday" = vendredi (dernière daily bar Yahoo), comportement normal |
| Volume d'hier = 0 (rare, ticker très peu liquide) | Volume event skipped (`prevDayVolume <= 0` guard) |
| DST switch | `formatDateET` utilise Intl, pas de souci |
| Bot redémarre en plein milieu d'une session | `trend_state` persisté ; pas de re-fire des alertes déjà fired today (les flags `*_today` survivent au restart) |

## Tests

### `trading/trend-engine.test.js`

Fixtures candles + valeurs daily à la main :

- `detectPDHBreak` :
  - premier break (close > pdh, alerts_today=0) → fire, state.alerts_today=1, below_since=null
  - toujours au-dessus → null
  - retombé sous PDH → null, state.below_since=now
  - re-cassure après ≥ reentryMs → fire, alerts_today=2, below_since=null
  - re-cassure < reentryMs → null, mais state.below_since cleared
  - never broken → null
- `detectPDLBreak` : symétriques (4 cas)
- `detectGap` :
  - gap up valide (≥ threshold) → fire 'gap_up', state.gap_alerted=1
  - gap down valide → fire 'gap_down'
  - sous le seuil → null
  - déjà alerté today → null (idempotent)
  - thresholds index vs stock (passer 0.5 vs 1.5)
- `detectVolumeAbovePrevDay` :
  - cumul > prev × 1.05 → fire
  - cumul < prev × 1.05 → null
  - déjà alerté → null
  - prev volume = 0 → null

### `trading/trend-scanner.test.js`

Mocks Yahoo (intraday + daily + quote) + DB in-memory :

- `getDailyContext` parsing : extrait yesterday's OHLCV + today's open
- Backfill `quote_type` : ticker NULL → premier scan fetch quote() → store.setQuoteType
- Daily reset : changement d'ET date entre 2 scans → flush daily state
- Dispatch des nouvelles alertes selon `quote_type` (gap threshold différent SPY vs AAPL)
- Throttle inchangé, propage les erreurs Yahoo daily sans casser les autres events

### `db/trend-store.test.js`

- `setQuoteType` / `getQuoteType` (round-trip)
- `addToWatchlist` 4-arg signature (ticker + quoteType)
- `resetDailyState(ticker, dateET)` : flush des 6 colonnes daily, set date
- `applyStateUpdates(ticker, updates)` : UPSERT générique sur `trend_state` avec un objet `{ col: val, ... }`. Whitelist des colonnes autorisées (anti-injection, même pattern que `updateEvent` existant)

## Env vars

Ajoutées à `.env.example` (toutes optionnelles avec défauts) :

```ini
# Trend module — daily-reference signals
TREND_PDH_PDL_REENTRY_MIN=15        # min sous (au-dessus) du niveau pour autoriser ré-alerte
TREND_GAP_THRESHOLD_INDEX_PCT=0.5   # seuil gap pour ETF/INDEX/MUTUALFUND
TREND_GAP_THRESHOLD_STOCK_PCT=1.5   # seuil gap pour les actions
TREND_VOLUME_VS_PREV_PCT=5          # % au-dessus du volume de la veille
```

Lues dans `readScannerConfig()`, propagées via `detectorOpts`. Défauts identiques à ce qui est codé dans le moteur — toutes optionnelles.

## Étapes manuelles utilisateur

Une fois mergé et déployé :

1. **Sur Railway** : ajouter les 4 nouvelles env vars (optionnel — défauts s'appliquent sinon). Pattern identique à la première vague de vars trend.
2. **Sur Discord** : aucun changement — la watchlist et le channel d'alerte existants servent. Les nouveaux events apparaissent automatiquement dans le même salon.
3. **Backfill `quote_type`** : automatique au prochain scan post-déploiement pour les tickers existants (SPY, QQQ, etc.).
