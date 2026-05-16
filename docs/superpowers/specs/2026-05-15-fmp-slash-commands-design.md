# FMP Slash Commands — Design

**Date** : 2026-05-15
**Statut** : Draft — en attente de validation utilisateur

## Problème

Le bot Discord expose ~3-5 % des capacités de l'API Financial Modeling Prep (FMP). Les analystes et traders sur le serveur n'ont pas d'accès rapide aux fondamentaux (P/E, EPS, market cap), aux targets analystes Wall Street, aux earnings passés, aux trades insiders, ou aux trades du Congrès US — informations toutes disponibles via le plan FMP Premium déjà payé.

## Objectif

Ajouter **3 slash commands Discord** qui exposent ces données FMP de façon contextualisée et privée (ephemeral) :

- `/analyze TICKER` — prix actuel + fondamentaux (P/E, EPS, market cap) + analyst targets + last earnings (beat/miss)
- `/insider TICKER` — 5 dernières transactions insider (achats/ventes)
- `/politicians TICKER` — 5 derniers trades US Senate + House combinés

Avec **fallback automatique sur Yahoo Finance** quand FMP retourne null (pour les 4 méthodes qui ont un équivalent Yahoo).

## Non-objectifs

- Pas de pagination (toujours les 5 plus récents, fixe)
- Pas d'autres slash commands (/earnings-digest et /macro = features D et E, dans des PR séparées)
- Pas de migration des commandes bang existantes (`!price`, `!chart`, etc.) — coexistence assumée
- Pas de fallback Yahoo pour /politicians (Yahoo n'a pas de données congressional — graceful "no data")
- Pas d'argument optionnel `limit` — les 5 plus récents, point
- Pas de rate limit côté bot (FMP Premium = 750 req/min, largement suffisant)

## Architecture

Structure à 3 couches : orchestrateur de fallback au-dessus des deux clients de données.

```
┌─────────────────────────────────────────────┐
│  discord/slash-commands.js  (NEW)           │
│  • registerSlashCommands(client) au 'ready' │
│  • interactionCreate dispatcher             │
│  • 3 handlers : analyze / insider / pol     │
│  • Embed builders (1 par command)           │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  discord/market-data.js  (NEW)              │
│  createMarketData({ fmpClient, yahooClient }) │
│  • Orchestrateur try-FMP-then-Yahoo         │
│  • Format unifié quelle que soit la source  │
│  • Indique la source ('fmp'|'yahoo') dans   │
│    chaque retour                            │
└──────────────────┬──────────────────────────┘
                   │              │
                   ▼              ▼
   ┌─────────────────────┐  ┌──────────────────────┐
   │  fmp-client.js      │  │  market-commands.js  │
   │  (EXTENDED)         │  │  createYahooClient   │
   │  + 6 méthodes       │  │  (EXTENDED +4 mthds) │
   └─────────────────────┘  └──────────────────────┘
```

**Fichiers concernés** :
- *Nouveaux* : `discord/market-data.js`, `discord/market-data.test.js`, `discord/slash-commands.js`, `discord/slash-commands.test.js`
- *Modifiés* : `discord/fmp-client.js` (+6 méthodes + tests), `discord/market-commands.js` (extension `createYahooClient` + tests), `index.js` (wire), `.env.example` (1 nouvelle var optionnelle)

## Configuration

```env
# === SLASH COMMANDS ==================================================
# Channel ID Discord pour LIMITER l'enregistrement des slash commands
# (/analyze, /insider, /politicians) à un seul guild.
#
# Si défini : enregistrement guild-scoped → propagation INSTANTANÉE
# (utile en dev / test). Récupérer l'ID via clic droit sur le serveur
# Discord avec Developer Mode activé.
#
# Si vide : enregistrement GLOBAL → propagation ~1h, accessible
# dans tous les serveurs où le bot est invité. À utiliser en prod.
SLASH_COMMAND_GUILD_ID=
```

**Reco production** : laisser **vide** → global. Les 3 commandes apparaîtront partout où le bot est invité (TOB + serveurs SaaS futurs) après ~1h de propagation Discord.

**Env vars réutilisées** : `DISCORD_TOKEN` (existant, obligatoire), `FMP_API_KEY` (existant, obligatoire).

## Extensions `discord/fmp-client.js`

6 nouvelles méthodes ajoutées à l'objet retourné par `createFmpClient()`. Pattern identique à `getQuote` existant : `httpJson` → parse → return null sur miss.

| Méthode | Endpoint FMP | Retour (null si pas de data) |
|---------|-------------|-------------------------------|
| `getRatiosTtm(ticker)` | `/api/v3/ratios-ttm/{ticker}` | `{ peRatioTTM, netIncomePerShareTTM (= eps), marketCapTTM, ... }` |
| `getPriceTargetSummary(ticker)` | `/api/v4/price-target-summary?symbol={ticker}` | `{ targetConsensus, targetHigh, targetLow, numberOfAnalysts }` |
| `getEarningsSurprises(ticker)` | `/api/v3/earnings-surprises/{ticker}` | `[{ date, eps, estimatedEps }, ...]` (most recent first) |
| `getInsiderTrades(ticker, limit=5)` | `/api/v4/insider-trading?symbol={ticker}&limit={n}` | `[{ filingDate, transactionType, reportingName, securitiesTransacted, price }, ...]` |
| `getSenateTrades(ticker, limit=5)` | `/api/v4/senate-trading?symbol={ticker}` | `[{ transactionDate, senator, type, amount }, ...]` (slice premières 5) |
| `getHouseTrades(ticker, limit=5)` | `/api/v4/senate-disclosure?symbol={ticker}` | `[{ disclosureDate, representative, type, amount }, ...]` (slice premières 5) |

**Cache** : 5 minutes pour fundamentals (ratios, targets, earnings) ; 15 minutes pour insider/politicians (data append-only).

**Endpoints exacts à valider** au moment de l'implémentation via dashboard FMP — l'implementer doit confirmer les paths v3 vs v4 et ajuster si la doc diffère.

**Behavior** : chaque méthode retourne `null` si l'endpoint répond 404, retourne array vide, ou throw. L'orchestrateur (Layer 2) traite null comme déclencheur de fallback.

## `discord/market-data.js` (nouveau)

**Responsabilité** : orchestrateur try-FMP-then-Yahoo. Format de retour unifié quelle que soit la source. Le caller (slash handler) ne connaît PAS quelle source a fourni la data — il reçoit un format propre + un champ `source: 'fmp' | 'yahoo'` pour transparency.

**Signature** :

```js
const marketData = createMarketData({
  fmpClient,            // required (instance de createFmpClient)
  yahooClient,          // required (instance de createYahooClient)
  logger = console,
});
```

**Méthodes** :

```js
marketData.getQuote(ticker)
  → { source, price, change, changePct, dayHigh, dayLow, volume, name } | null

marketData.getRatiosTtm(ticker)
  → { source, peRatio, eps, marketCap } | null

marketData.getPriceTargetSummary(ticker)
  → { source, targetMean, targetHigh, targetLow, numberOfAnalysts } | null

marketData.getEarningsSurprises(ticker, limit=1)
  → { source, mostRecent: { date, epsActual, epsEstimate, beat: boolean, surprise: pct } } | null

marketData.getInsiderTrades(ticker, limit=5)
  → { source, trades: [{ date, name, type, shares, price, value }, ...] } | null

marketData.getSenateTrades(ticker, limit=5)
  → { source: 'fmp', trades: [{ date, name, type, amountMin, amountMax }, ...] } | null

marketData.getHouseTrades(ticker, limit=5)
  → { source: 'fmp', trades: [{ date, name, type, amountMin, amountMax }, ...] } | null
```

**Pattern try-then-fallback** (exemple pour `getRatiosTtm`) :

```js
async function getRatiosTtm(ticker) {
  try {
    const fmp = await fmpClient.getRatiosTtm(ticker);
    if (fmp && fmp.peRatioTTM != null) {
      return {
        source: 'fmp',
        peRatio: fmp.peRatioTTM,
        eps: fmp.netIncomePerShareTTM,
        marketCap: fmp.marketCapTTM,
      };
    }
  } catch (err) {
    logger.warn('[market-data] FMP getRatiosTtm failed for ' + ticker + ': ' + err.message);
  }
  try {
    const yh = await yahooClient.getQuoteSummary(ticker, ['summaryDetail', 'defaultKeyStatistics']);
    if (yh) {
      return {
        source: 'yahoo',
        peRatio: yh.summaryDetail?.trailingPE ?? null,
        eps: yh.defaultKeyStatistics?.trailingEps ?? null,
        marketCap: yh.summaryDetail?.marketCap ?? null,
      };
    }
  } catch (err) {
    logger.warn('[market-data] Yahoo getRatiosTtm failed for ' + ticker + ': ' + err.message);
  }
  return null;
}
```

**`getSenateTrades` et `getHouseTrades` n'ont pas de fallback Yahoo** (Yahoo n'expose pas ces données). Si FMP retourne null → on retourne null directement.

## Extensions `createYahooClient` dans `discord/market-commands.js`

4 nouvelles méthodes ajoutées à `createYahooClient` (qui existe déjà avec `getQuote`). Wrappers minces sur `yahoo-finance2`'s `quoteSummary` avec timeout 10s et cache 5min :

| Méthode Yahoo nouvelle | Wrappe |
|-----------------------|--------|
| `getQuoteSummary(ticker, modules)` | Passthrough — `yahoo.quoteSummary(ticker, { modules })`. Utilisé directement par market-data.js. |
| `getEarningsHistory(ticker)` | Convenience : `quoteSummary(['earningsHistory'])` → array of past earnings. |
| `getInsiderTransactions(ticker)` | Convenience : `quoteSummary(['insiderTransactions'])`. |
| `getFinancialData(ticker)` | Convenience : `quoteSummary(['financialData'])` — pour analyst targets. |

Yahoo client reste un wrapper minimal. La translation Yahoo → format unifié vit dans `market-data.js`.

## `discord/slash-commands.js` (nouveau)

### Structure

```js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function createSlashCommands({ marketData, logger = console } = {}) {
  // ── Command definitions ────────────────────────────────────────
  const commandDefs = [
    new SlashCommandBuilder()
      .setName('analyze')
      .setDescription('Show fundamentals + analyst targets + last earnings for a ticker')
      .addStringOption(opt => opt
        .setName('ticker')
        .setDescription('Stock ticker (e.g., AAPL)')
        .setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('insider')
      .setDescription('Show the last 5 insider transactions for a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Stock ticker').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('politicians')
      .setDescription('Show the last 5 US Senate + House trades for a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Stock ticker').setRequired(true))
      .toJSON(),
  ];

  async function register(client) {
    const guildId = process.env.SLASH_COMMAND_GUILD_ID || '';
    try {
      if (guildId) {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(commandDefs);
        logger.log('[slash-commands] registered ' + commandDefs.length
          + ' commands on guild ' + guildId + ' (instant propagation)');
      } else {
        await client.application.commands.set(commandDefs);
        logger.log('[slash-commands] registered ' + commandDefs.length
          + ' commands GLOBALLY (propagation up to 1h)');
      }
    } catch (err) {
      logger.error('[slash-commands] registration failed: ' + err.message);
    }
  }

  async function handleInteractionCreate(interaction) {
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case 'analyze':     return handleAnalyze(interaction);
      case 'insider':     return handleInsider(interaction);
      case 'politicians': return handlePoliticians(interaction);
    }
  }

  async function handleAnalyze(interaction) { /* see Handler logic below */ }
  async function handleInsider(interaction) { /* see Handler logic below */ }
  async function handlePoliticians(interaction) { /* see Handler logic below */ }

  function wire(client) {
    client.once('ready', () => register(client));
    client.on('interactionCreate', (interaction) => {
      handleInteractionCreate(interaction).catch(err =>
        logger.error('[slash-commands] handler error: ' + err.message));
    });
  }

  return { wire, register, handleInteractionCreate,
           handleAnalyze, handleInsider, handlePoliticians };
}

module.exports = { createSlashCommands };
```

### Handler logic (pattern commun)

1. Extract `ticker = interaction.options.getString('ticker').toUpperCase()`
2. `await interaction.deferReply({ ephemeral: true })`
3. Fetch data via `marketData.X(ticker)` (Promise.all si plusieurs appels)
4. Si tout null → `editReply({ content: '❌ No data for $XYZ' })`
5. Sinon → build embed + `editReply({ embeds: [embed] })`
6. Catch → log + `editReply({ content: '❌ Service unavailable, try again later' })`

### Embed formats

**`/analyze AAPL`** :

```
🔍 AAPL — Apple Inc.

▸ Price                $198.42 (+1.23%) — day H/L: $199.85 / $195.10
▸ Fundamentals         P/E 32.4 · EPS $6.13 · Market Cap $3.00T
▸ Analyst Targets      Avg $215.00 · High $250 · Low $180 (12 analysts)
▸ Last Earnings        2026-04-30 — EPS $1.53 vs est $1.50 (✅ beat +2%)

Source: FMP · Footer shows mixed sources si Yahoo a fallback-é
```

**`/insider AAPL`** :

```
👤 AAPL — Insider transactions (5 most recent)

▸ 2026-05-12  COOK Timothy        SOLD     10,000 sh @ $198.00  ($1.98M)
▸ 2026-05-08  ADAMS Katherine     BOUGHT    2,500 sh @ $195.50  ($488K)
▸ 2026-05-01  MAESTRI Luca        SOLD      8,000 sh @ $192.30  ($1.54M)
▸ 2026-04-28  COOK Timothy        SOLD     15,000 sh @ $189.50  ($2.84M)
▸ 2026-04-20  GORE Albert         BOUGHT    1,000 sh @ $185.00  ($185K)

Source: FMP
```

**`/politicians AAPL`** :

```
🏛️ AAPL — US Congressional trades (5 most recent)

▸ 2026-05-10  Sen. Pelosi      Purchase  $15K–$50K
▸ 2026-05-05  Rep. McCaul      Sale      $1K–$15K
▸ 2026-04-28  Sen. Tuberville  Purchase  $50K–$100K
▸ 2026-04-22  Rep. Greene      Purchase  $1K–$15K
▸ 2026-04-15  Sen. Hagerty     Sale      $15K–$50K

Source: FMP
```

Le footer indique `Source: FMP` ou `Source: Yahoo (fallback)` ou `Source: FMP + Yahoo (mixed)` selon ce que `marketData` a réellement utilisé. Transparency pour l'utilisateur.

## Wiring dans `index.js`

```js
const { createSlashCommands } = require('./discord/slash-commands');
const { createMarketData } = require('./discord/market-data');
const { createFmpClient } = require('./discord/fmp-client');
const { createYahooClient } = require('./discord/market-commands');

// ... après création du client Discord
const fmpClient   = createFmpClient({ apiKey: process.env.FMP_API_KEY });
const yahooClient = createYahooClient();
const marketData  = createMarketData({ fmpClient, yahooClient });
const slashCommands = createSlashCommands({ marketData });
slashCommands.wire(client);
```

**Note** : si `fmpClient` ou `yahooClient` est déjà créé ailleurs dans `index.js` (probable — utilisé par les commandes bang existantes), on réutilise les instances existantes au lieu d'en créer de nouvelles.

## Error handling

Cas couverts au niveau du handler :

| Situation | Réponse Discord (ephemeral) |
|-----------|------------------------------|
| Ticker introuvable (FMP + Yahoo retournent null) | `❌ Ticker $XYZ not found` |
| FMP timeout / network error → Yahoo OK | Embed normal, source: Yahoo |
| Les deux fails | `❌ Service unavailable, try again later` |
| FMP rate-limit (429) → Yahoo OK | Embed normal, source: Yahoo |
| Yahoo rate-limit aussi | `⏳ Rate limited, try again in 30s` |
| Endpoint FMP retourne 403 (Premium-only) | `🔒 This data requires FMP Premium subscription` |

Logs au niveau du handler pour debug + niveau warn dans market-data pour fallback transparency.

## Tests

| Fichier | Tests à ajouter | Total |
|---------|-----------------|-------|
| `discord/fmp-client.test.js` | 6 (1 par méthode FMP : mock fetch, vérifier URL + parsing + null sur miss) | 6 |
| `discord/market-commands.test.js` | 4 (1 par nouveau wrapper Yahoo) | 4 |
| `discord/market-data.test.js` (nouveau) | 12 (par méthode : FMP OK / FMP null → Yahoo OK / les deux null → null. Pour senate/house : juste FMP OK ou null) | 12 |
| `discord/slash-commands.test.js` (nouveau) | 6 (registration global, registration guild-scoped, 3 handlers happy path, 1 handler error case) | 6 |
| **Total** | | **28** |

Pattern de mock standard : fake fetch (pour fmp-client), fake yahoo-finance2 (pour yahoo wrappers), fake fmpClient + yahooClient (pour market-data), fake Discord client + interaction (pour slash-commands).

## Étapes manuelles (opérateur)

**Au merge** : aucune étape manuelle requise. Le bot redémarre, registre les commandes globalement, ~1h de propagation Discord.

**Si testing immédiat souhaité** : set `SLASH_COMMAND_GUILD_ID=<TOB_GUILD_ID>` sur Railway temporairement → propagation instantanée sur TOB seulement. Une fois validé, retirer la var → propagation globale.

## Risques

| Risque | Mitigation |
|--------|------------|
| Endpoint FMP exact diffère de la doc → 404 | Catch + log + tente Yahoo. /politicians ne fonctionne pas (acceptable). |
| Quota FMP épuisé (750 req/min) | Très improbable (3 commands × peu de users). Si arrive : 429 → fallback Yahoo. |
| Yahoo rate-limit (Yahoo public API non-officielle) | Catch + message clair. Cache 5min minimise le risque. |
| Slash commands ne s'enregistrent pas (perms Discord manquantes) | Log error au boot, bot continue à fonctionner. Operator voit l'erreur, ajoute scope `applications.commands` au bot. |
| Format embed dépasse 6000 chars / 25 fields | 5 transactions max par command — impossible d'atteindre la limite. |
| Race condition au boot : `register()` appelé avant `client.application` prêt | Wrap dans `client.once('ready', ...)` — garanti par discord.js. |

## Out of scope (deferred)

- Pagination ou argument `limit` configurable
- Filtrage par type (only buys / only sells)
- Sort options (par montant, par date, etc.)
- Cache du résultat de la commande pour réponse instantanée si même ticker demandé 2× en 5min
- Métriques d'utilisation des commands
- Localization (commandes seulement en anglais)
- `/earnings-digest` (feature D, future PR)
- `/macro-context` (feature E, future PR)
