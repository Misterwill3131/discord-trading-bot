// ─────────────────────────────────────────────────────────────────────
// index.js — Point d'entrée du bot Discord trading
// ─────────────────────────────────────────────────────────────────────
// Ce fichier se contente de wirer tous les modules ensemble : env,
// Express, Discord client, routes, handlers, jobs. La logique vit
// dans les modules enfants (utils/, filters/, canvas/, pages/, routes/,
// state/, auth/, discord/, profit/, news/).
//
// Ordre de vie :
//   1. Charger env + modules (imports)
//   2. Créer l'app Express + monter toutes les routes
//   3. Démarrer le serveur HTTP
//   4. Créer le client Discord + injecter dans canvas/profit
//   5. Enregistrer handlers/commandes/scheduler
//   6. Login Discord
// ─────────────────────────────────────────────────────────────────────

const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');

// Modules utilisés à la racine — state partagé, routes, handlers, jobs.
const { requireAuth, registerAuthRoutes } = require('./auth/session');
const {
  requireTradingAuth,
  registerTradingAuthRoutes,
} = require('./auth/trading-session');
const { setDiscordClient: setCanvasDiscordClient } = require('./canvas/proof');
const { registerTradingHandler } = require('./discord/handler');
const { registerRecapImageHandler } = require('./discord/recap-image-handler');
const { registerDiscordCommands } = require('./discord/commands');
const { registerMarketCommands } = require('./discord/market-commands');
const { createYahooClient } = require('./discord/market-commands');
const { createFmpClient } = require('./discord/fmp-client');
const { createMarketData: createDiscordMarketData } = require('./discord/market-data');
const { createSlashCommands } = require('./discord/slash-commands');
const { createChartImgClient } = require('./discord/chart-img-client');
const { db } = require('./db/sqlite');
const { createTrendStore } = require('./db/trend-store');
const { registerTrendCommands } = require('./discord/trend-commands');
const { startTrendScanner } = require('./trading/trend-scanner');
const { registerProfitListener } = require('./discord/profit-listener');
const { startScheduler } = require('./discord/jobs');
const newsPoller = require('./news/poller');
const profitCounter = require('./profit/counter');
const { registerPageRoutes } = require('./routes/pages');
const { registerImageRoutes } = require('./routes/images');
const { registerVideoStudioRoutes, setVideoStudioDiscordClient } = require('./routes/video-studio');
const { registerNewsRoutes } = require('./routes/news');
const { registerAnalyticsRoutes } = require('./routes/analytics');
const { registerFilterRoutes } = require('./routes/filters');
const { registerMessageRoutes } = require('./routes/messages');
const { registerProfitRoutes } = require('./routes/profits');
const { registerConfigRoutes } = require('./routes/config');
const { registerDbViewerRoutes } = require('./routes/db-viewer');
const { registerBackupLogRoutes } = require('./routes/backup-log');
const { registerWelcomeLogRoutes } = require('./routes/welcome-log');
const { registerDbSnapshotRoutes } = require('./routes/db-snapshot');
const { registerChartTestRoutes } = require('./routes/chart-test');
const { registerCostDashboardRoutes } = require('./routes/cost-dashboard');
const imageState = require('./state/images');
const { messageLog } = require('./state/messages');

// Trading engine — broker, market data, engine orchestrator.
const { loadTradingConfig, saveTradingConfig, getSecrets: getTradingSecrets } = require('./trading/config');
const { createMarketData } = require('./trading/marketdata');
const { createBroker } = require('./trading/broker');
const { createEngine: createTradingEngine } = require('./trading/engine');
const { registerTradingRoutes } = require('./routes/trading');
const { createEmailNotifier } = require('./notifications/email');

// SaaS relais — feature-flag par SAAS_BOT_TOKEN. Si la variable n'est pas
// définie, tout ce code reste dormant et le déploiement existant est intact.
const { registerSaasAdminRoutes } = require('./routes/saas-admin');
const { registerGuildGuard } = require('./saas/guards');
const { registerSaasCommands } = require('./saas/commands');
const { register: registerSaasRelay } = require('./saas/relay');
const { register: registerScreenerIngest } = require('./discord/screener-ingest');
const { register: registerAnalystWatchlist } = require('./discord/analyst-watchlist');
const licenseSync = require('./saas/license-sync');

// Site public de vente (landing, pricing, FAQ, legal, funnel post-action).
// Routes sans auth — montées AVANT le dashboard pour que GET / serve la
// landing au lieu de rediriger vers /dashboard.
const { registerPublicRoutes } = require('./routes/public');
const { registerCheckoutRoutes } = require('./routes/checkout');
const { registerCustomerAccountRoutes } = require('./routes/customer-account');
const { registerAdminCmsRoutes } = require('./routes/admin-cms');
const { registerRenderQueueRoutes } = require('./routes/render-queue');

// ── Configuration env ──────────────────────────────────────────────
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL   = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL    = process.env.TRADING_CHANNEL || 'trading-floor';
const PROFITS_CHANNEL_ID = process.env.PROFITS_CHANNEL_ID || '';
const NEWS_CHANNEL_ID    = process.env.NEWS_CHANNEL_ID || '';
// Salon Discord où envoyer les alertes trading (entry/fill/exit).
// Doit être un CHANNEL ID (pas un guild ID). Le bot doit être invité
// dans ce serveur avec la permission "Send Messages".
const TRADING_ALERTS_CHANNEL_ID = process.env.TRADING_ALERTS_CHANNEL_ID || '';
// Salon dédié aux alertes market-data (yesterday/weekly H/L break,
// volume spike). Si vide → fallback sur TRADING_ALERTS_CHANNEL_ID
// (utile si on veut tout sur le même salon). Définir une valeur
// distincte pour isoler ces alertes (ex : serveur de test).
const MARKET_ALERTS_CHANNEL_ID = process.env.MARKET_ALERTS_CHANNEL_ID
  || TRADING_ALERTS_CHANNEL_ID;
// Alertes email via Resend (optionnel). Si l'une des 3 vars manque,
// sendEmailAlert est un no-op silencieux — pas d'erreur, pas de fetch.
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_TO    = process.env.ALERT_EMAIL_TO || '';
const ALERT_EMAIL_FROM  = process.env.ALERT_EMAIL_FROM || '';
// chart-img.com API — alimente !chart. Si absent, !chart répond avec un
// message "command unavailable" (pas de crash). Définir dans Railway env vars.
const CHART_IMG_API_KEY = process.env.CHART_IMG_API_KEY || '';
const PORT               = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://templeofboom.up.railway.app';

// ── SaaS relais — env (feature flag : actif uniquement si SAAS_BOT_TOKEN défini) ──
const SAAS_BOT_TOKEN       = process.env.SAAS_BOT_TOKEN || '';
const SAAS_ADMIN_GUILD_ID  = process.env.ADMIN_GUILD_ID || '';
const SAAS_ADMIN_USER_ID   = process.env.ADMIN_USER_ID || '';
const SAAS_SOURCE_GUILD_ID = process.env.SOURCE_GUILD_ID || '';
const SAAS_SOURCE_CHANNELS = (process.env.SOURCE_CHANNEL_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Serveur HTTP ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Headers de sécurité minimaux — appliqués à toutes les réponses.
// nosniff : empêche le navigateur de deviner un Content-Type différent.
// X-Frame-Options : interdit l'embed dans une iframe (anti-clickjacking).
// Referrer-Policy : ne fuite pas l'URL complète vers les domaines tiers.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Static assets (logo SaaS, etc.) — servis publiquement sans auth.
// Cache long (1 jour) car les assets changent rarement et sont versionnés
// implicitement par leur nom de fichier.
app.use('/static', express.static('static', { maxAge: '1d', immutable: false }));

// Routes publiques marketing (landing, pricing, FAQ, legal, funnel). Sans auth.
// Doivent être enregistrées AVANT registerPageRoutes pour que GET / serve la
// landing au lieu de la redirection vers /dashboard.
registerPublicRoutes(app);
registerCheckoutRoutes(app);

// Panel client self-service. Magic-link auth (cookie distinct du dashboard
// admin). `clientSaasRef.current` est défini plus bas, après la création de
// clientSaas — utilisé par /account/preferences/disconnect pour kicker le bot.
const clientSaasRef = { current: null };
registerCustomerAccountRoutes(app, clientSaasRef);

// Auth + pages statiques. Le dashboard reste accessible via /dashboard direct.
registerAuthRoutes(app);
registerPageRoutes(app, requireAuth);

// APIs lectures/écritures sur l'état partagé.
registerNewsRoutes(app, requireAuth);
registerImageRoutes(app, requireAuth, imageState, {
  messageLog,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
});
registerVideoStudioRoutes(app, requireAuth, imageState);
registerAnalyticsRoutes(app, requireAuth, messageLog);
registerFilterRoutes(app, requireAuth);
registerMessageRoutes(app, requireAuth);
registerConfigRoutes(app, requireAuth);

// DB viewer (read-only SQL playground, auth-protected).
registerDbViewerRoutes(app, requireAuth);

// Backup log (historique des 30 derniers runs en mémoire).
registerBackupLogRoutes(app, requireAuth);

// Welcome log (log des joins).
registerWelcomeLogRoutes(app, requireAuth);

// DB snapshot download (VACUUM INTO + stream, auth-protected).
registerDbSnapshotRoutes(app, requireAuth);

// Chart-img smoke test (admin only, fetch un chart sample avec callouts).
registerChartTestRoutes(app, requireAuth);

// Cost dashboard (auth-protected) — track des coûts API + render.
registerCostDashboardRoutes(app, requireAuth);

// Profits : injection du channelId avant d'enregistrer les routes.
profitCounter.setProfitsChannelId(PROFITS_CHANNEL_ID);
registerProfitRoutes(app, requireAuth);

// SaaS routes — webhooks publics + API admin auth-protégée.
// Inconditionnel : utile même sans clientSaas (pour gérer les licences via API).
registerSaasAdminRoutes(app, requireAuth);

// Admin CMS (plans + marketing copy). Auth-protected via requireAuth.
// /admin/plans + /admin/marketing + API JSON /api/admin/*.
registerAdminCmsRoutes(app, requireAuth);

// ── Trading engine bootstrap ───────────────────────────────────────
const tradingSecrets = getTradingSecrets();
const tradingInitialCfg = loadTradingConfig();
// Broker (IBKRBroker en live, PaperBroker en paper). Créé AVANT marketdata
// pour qu'en mode live le marketdata puisse utiliser le même broker IBKR
// comme source de bougies (plus de dépendance Alpaca).
const tradingBroker = createBroker({
  mode: tradingInitialCfg.mode,
  initialEquity: 100000, // paper default; ignored par IBKR
  ibkr: {
    host: tradingSecrets.ibkrHost,
    port: tradingSecrets.ibkrPort,
    clientId: tradingSecrets.ibkrClientId,
  },
  // marketData est injecté plus bas pour éviter la dépendance circulaire.
});
const tradingMarketData = createMarketData({ broker: tradingBroker });
// PaperBroker utilise marketData pour ses simulations de fill — en live,
// IBKRBroker ignore ce champ.
if (tradingBroker && 'marketData' in tradingBroker) {
  tradingBroker.marketData = tradingMarketData;
}

// Discord notifier : closure late-bound sur `client` (créé plus bas).
// Silencieux si client pas prêt ou TRADING_ALERTS_CHANNEL_ID absent.
let discordClientRef = null;
async function sendTradingAlert(message) {
  if (!discordClientRef || !discordClientRef.isReady() || !TRADING_ALERTS_CHANNEL_ID) return;
  try {
    const ch = await discordClientRef.channels.fetch(TRADING_ALERTS_CHANNEL_ID);
    if (ch && ch.isTextBased && ch.isTextBased()) {
      await ch.send(message);
    } else {
      console.error('[trading] alert channel not text-based or not found:', TRADING_ALERTS_CHANNEL_ID);
    }
  } catch (err) {
    console.error('[trading] alert send failed:', err.message);
  }
}

// Notifier dédié aux alertes market-data. Même mécanique que
// sendTradingAlert mais pointe sur MARKET_ALERTS_CHANNEL_ID, qui peut
// être distinct (ex : serveur de test). Si MARKET_ALERTS_CHANNEL_ID
// n'est pas défini, retombe sur TRADING_ALERTS_CHANNEL_ID via la
// constante calculée plus haut.
async function sendMarketAlert(message) {
  if (!discordClientRef || !discordClientRef.isReady() || !MARKET_ALERTS_CHANNEL_ID) return;
  try {
    const ch = await discordClientRef.channels.fetch(MARKET_ALERTS_CHANNEL_ID);
    if (ch && ch.isTextBased && ch.isTextBased()) {
      await ch.send(message);
    } else {
      console.error('[market-alerts] channel not text-based or not found:', MARKET_ALERTS_CHANNEL_ID);
    }
  } catch (err) {
    console.error('[market-alerts] send failed:', err.message);
  }
}

// Email notifier : utilisé par discord/handler pour les alertes d'analystes
// (et non par le trading engine — les trades réels restent Discord-only).
const sendEmailAlert = createEmailNotifier({
  apiKey: RESEND_API_KEY,
  to:     ALERT_EMAIL_TO,
  from:   ALERT_EMAIL_FROM,
});

const tradingEngine = createTradingEngine({
  config: loadTradingConfig,     // function — re-read each call
  marketData: tradingMarketData,
  broker: tradingBroker,
  notifier: sendTradingAlert,
});

// Wire broker events → engine.
tradingBroker.on('orderStatus', (event) => {
  try { tradingEngine.handleOrderEvent(event); }
  catch (err) { console.error('[trading] handleOrderEvent error:', err.message); }
});

// Register trading dashboard routes — protected by a dedicated
// TRADING_PASSWORD (see auth/trading-session.js), independent of the
// main dashboard auth. If TRADING_PASSWORD is unset, /trading returns 503.
registerTradingAuthRoutes(app);
registerTradingRoutes(app, requireTradingAuth, { tradingEngine, tradingBroker });

// Reconcile at boot (live only). Un échec est loggé mais NE désactive PAS
// le trading — l'utilisateur a demandé de garder tradingEnabled sticky pour
// éviter de devoir re-toggler manuellement après chaque panne transitoire
// du gateway. Si un mismatch DB/IBKR est détecté, les positions affectées
// sont déjà marquées 'error' dans reconcile(). Les nouvelles entries peuvent
// toujours se placer. Utiliser le kill-switch ou panic button pour arrêter.
(async () => {
  if (tradingInitialCfg.mode === 'live') {
    console.log('[trading] boot: mode=live, connecting to IBKR gateway at '
      + tradingSecrets.ibkrHost + ':' + tradingSecrets.ibkrPort + '...');
    try {
      if (typeof tradingBroker.connect === 'function') await tradingBroker.connect();
      console.log('[trading] boot: connected, running reconcile...');
      const r = await tradingEngine.reconcile();
      if (!r.ok) {
        console.error('[trading] reconcile failed — trading stays ENABLED (user preference)', r.mismatches || r.reason);
      } else {
        console.log('[trading] reconcile ok');
      }
    } catch (err) {
      console.error('[trading] boot reconcile error (gateway unreachable?) — trading stays ENABLED:', err.message);
    }
  } else {
    console.log('[trading] paper mode — skipping reconcile');
  }
})();

app.listen(PORT, () => console.log('Server running on port ' + PORT));

// ── Client Discord ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});
// On a 11+ modules qui ajoutent leur propre listener messageCreate (handler,
// commands, market-commands, profit-listener, screener-ingest, saas-relay,
// trend-commands, etc.). La limite Node par défaut est 10 → warning. Bump
// à 30 pour avoir de la marge sans masquer une vraie fuite EventEmitter.
client.setMaxListeners(30);

// Injection du client dans les modules qui en ont besoin (mentions
// dans canvas, daily summary dans profit, alertes trading).
setCanvasDiscordClient(client);
profitCounter.setDiscordClient(client);
discordClientRef = client;  // active sendTradingAlert()

// Phase 3 render queue : routes HTTP pour le worker local (poll + ACK MP4).
// Doit être enregistré APRÈS la création de `client` car le helper d'upload
// Discord a besoin du client pour poster dans RENDER_OUTPUT_CHANNEL_ID.
registerRenderQueueRoutes(app, client);

// Inject le client Discord dans video-studio (utilisé par /ab-leaderboard
// pour fetch les reactions sur les messages render postés).
setVideoStudioDiscordClient(client);

// Listeners + scheduler. Les helpers internes font eux-mêmes leur
// `client.once('ready')` si nécessaire — pas de ordre requis ici.
registerDiscordCommands(client, { profitsChannelId: PROFITS_CHANNEL_ID });
// Shared yahooClient — same in-memory cache for !price/!indicator
// (market-commands), !trend (trend-commands), and the auto-scanner.
// !chart is now served by chart-img (Advanced Chart API) instead of the
// local renderer. If CHART_IMG_API_KEY is unset, !chart replies with a
// "command unavailable" message — the rest of the bot still runs.
const sharedYahoo = createYahooClient();

// FMP REST client shared across slash commands. Requires FMP_API_KEY.
// If FMP_API_KEY is absent, the slash commands are not registered at
// all (the bot keeps working without /analyze /insider /politicians).
const fmpKey = process.env.FMP_API_KEY || '';
const sharedFmp = fmpKey
  ? createFmpClient({ apiKey: fmpKey })
  : null;

// Market-data orchestrator with FMP-then-Yahoo fallback. Only wires the
// slash commands when both clients are available — if FMP_API_KEY is
// missing we skip registration entirely (the bot keeps working without
// the slash commands).
if (sharedFmp) {
  const sharedMarketData = createDiscordMarketData({
    fmpClient: sharedFmp,
    yahooClient: sharedYahoo,
  });
  const slashCommands = createSlashCommands({ marketData: sharedMarketData });
  slashCommands.wire(client);
} else {
  console.warn('[slash-commands] FMP_API_KEY missing — /analyze, /insider, /politicians not registered');
}

const chartImgClient = CHART_IMG_API_KEY
  ? createChartImgClient({ apiKey: CHART_IMG_API_KEY })
  : null;
if (!CHART_IMG_API_KEY) {
  console.warn('[!chart] CHART_IMG_API_KEY absent — !chart command will reply with "unavailable"');
}
registerMarketCommands(client, {
  yahooClient: sharedYahoo,
  chartImgClient,
});
const trendStore = createTrendStore(db);
registerTrendCommands(client, {
  store: trendStore,
  yahoo: sharedYahoo,
  scannerConfig: { intervalMin: parseInt(process.env.TREND_SCAN_INTERVAL_MIN, 10) || 5 },
});
const { registerGapCommands } = require('./discord/gap-commands');
registerGapCommands(client, { yahoo: sharedYahoo, chartImg: chartImgClient });
startTrendScanner({ client, store: trendStore, yahoo: sharedYahoo });
registerProfitListener(client, { profitsChannelId: PROFITS_CHANNEL_ID });
const { registerWelcomeListener } = require('./discord/welcome-listener');
registerWelcomeListener(client, {
  guildId:               process.env.TOB_WELCOME_GUILD_ID,
  subscriberRoleId:      process.env.TOB_SUBSCRIBER_ROLE_ID,
  welcomeChannelId:      process.env.TOB_WELCOME_CHANNEL_ID,
  startHereChannelId:    process.env.TOB_START_HERE_CHANNEL_ID,
});
registerTradingHandler(client, {
  tradingChannel: TRADING_CHANNEL,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
  tradingEngine,
  sendEmailAlert,
});
// Auto-trigger d'un TobTradeRecap quand une image recap est postée dans
// le canal configuré (env TOB_RECAP_IMAGE_CHANNEL_ID). OCR Claude Vision
// → enqueueRenderJob composition='TobTradeRecap' → worker render → MP4
// re-posté dans le même canal.
registerRecapImageHandler(client, {
  channelId: process.env.TOB_RECAP_IMAGE_CHANNEL_ID,
});
// Watchlist auto-alimentée par les mentions analystes dans TRADING_CHANNEL.
// Audit complet (analystes + bots) dans tracked_messages ; seed
// analyst_watchlist seulement pour les non-bots avec ticker détecté.
// Pas gaté sur SAAS_BOT_TOKEN — le milestone-checker tick (dans
// discord/jobs.js → startScheduler) est lui aussi always-on, donc le
// listener doit l'être pour que la feature fonctionne sans SaaS.
registerAnalystWatchlist(client);

startScheduler({ client, tradingChannel: TRADING_CHANNEL, sendAlert: sendMarketAlert });

// Log de connexion + démarrage du poller RSS au ready.
client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);
  newsPoller.startPolling({ client, channelId: NEWS_CHANNEL_ID });
});

// Defensive login : un token invalide/absent ne doit pas tuer le process
// (le HTTP dashboard reste utile pour reconfigurer, consulter les logs, etc).
if (!DISCORD_TOKEN) {
  console.warn('[discord] DISCORD_TOKEN absent — skipping Discord login. HTTP dashboard only.');
} else {
  try {
    Promise.resolve(client.login(DISCORD_TOKEN)).catch(err => {
      console.error('[discord] login failed:', err.message);
    });
  } catch (err) {
    console.error('[discord] login threw synchronously:', err.message);
  }
}

// ── Client Discord SaaS (2e bot, feature-flagged) ──────────────────
// Activé UNIQUEMENT si SAAS_BOT_TOKEN est défini. Tant que la variable n'est
// pas en env, ce bloc est dormant — déploiement actuel non perturbé.
//
// NE PAS activer MessageContent intent : ce bot publie des embeds,
// il n'a pas besoin de lire le contenu des messages dans les serveurs
// clients. Réduit la surface d'attaque + évite la review Discord
// (privileged intent au-delà de 100 guilds).
if (SAAS_BOT_TOKEN) {
  const clientSaas = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // Expose à customer-account.js (pour /account/preferences/disconnect).
  clientSaasRef.current = clientSaas;

  registerGuildGuard(clientSaas, { adminGuildId: SAAS_ADMIN_GUILD_ID });
  registerSaasCommands(clientSaas, {
    adminGuildId: SAAS_ADMIN_GUILD_ID,
    adminUserId:  SAAS_ADMIN_USER_ID,
    // Fallback env pour `/saas source` quand l'override DB est absent
    sourceChannelIdsEnv: SAAS_SOURCE_CHANNELS,
  });
  // Le relais consomme messageCreate du client SOURCE (bot trading existant)
  // et publie via clientSaas vers les serveurs clients.
  registerSaasRelay({
    clientSource: client,
    clientSaas,
    sourceGuildId: SAAS_SOURCE_GUILD_ID,
    sourceChannelIds: SAAS_SOURCE_CHANNELS,
  });

  // Screener ingest : listener parallèle sur le même client source
  // pour les 9 channels TrendVision (ipo, whale, zero-borrow, volume,
  // all-in-one, squeeze, halts, social-media, tv-news). Insère dans
  // Postgres screener_alerts. Les channels sont distincts de
  // SOURCE_CHANNEL_IDS donc pas de double-handling.
  registerScreenerIngest(client);

  clientSaas.once('ready', () => {
    console.log('[saas] Bot connected as ' + clientSaas.user.tag);
    console.log(`[saas] Guilds: ${clientSaas.guilds.cache.size}`);
    // Démarre le sync périodique Postgres → SQLite. No-op si DATABASE_URL
    // absent. Propage les changements de status (cancellation Stripe → license)
    // depuis le site vers le miroir SQLite local.
    licenseSync.start();
  });

  try {
    Promise.resolve(clientSaas.login(SAAS_BOT_TOKEN)).catch(err => {
      console.error('[saas] login failed:', err.message);
    });
  } catch (err) {
    console.error('[saas] login threw synchronously:', err.message);
  }
} else {
  console.log('[saas] SAAS_BOT_TOKEN absent — SaaS relay disabled (HTTP API still available)');
}
