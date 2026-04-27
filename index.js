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
const { registerDiscordCommands } = require('./discord/commands');
const { registerMarketCommands } = require('./discord/market-commands');
const { registerProfitListener } = require('./discord/profit-listener');
const { startScheduler } = require('./discord/jobs');
const newsPoller = require('./news/poller');
const profitCounter = require('./profit/counter');
const { registerPageRoutes } = require('./routes/pages');
const { registerImageRoutes } = require('./routes/images');
const { registerNewsRoutes } = require('./routes/news');
const { registerAnalyticsRoutes } = require('./routes/analytics');
const { registerFilterRoutes } = require('./routes/filters');
const { registerMessageRoutes } = require('./routes/messages');
const { registerProfitRoutes } = require('./routes/profits');
const { registerConfigRoutes } = require('./routes/config');
const { registerDbViewerRoutes } = require('./routes/db-viewer');
const { registerBackupLogRoutes } = require('./routes/backup-log');
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
// Alertes email via Resend (optionnel). Si l'une des 3 vars manque,
// sendEmailAlert est un no-op silencieux — pas d'erreur, pas de fetch.
const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL_TO    = process.env.ALERT_EMAIL_TO || '';
const ALERT_EMAIL_FROM  = process.env.ALERT_EMAIL_FROM || '';
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

// Static assets (logo SaaS, etc.) — servis publiquement sans auth.
// Cache long (1 jour) car les assets changent rarement et sont versionnés
// implicitement par leur nom de fichier.
app.use('/static', express.static('static', { maxAge: '1d', immutable: false }));

// Auth + pages statiques en premier (ne nécessitent aucun state runtime).
registerAuthRoutes(app);
app.get('/', (_req, res) => res.redirect('/dashboard'));
registerPageRoutes(app, requireAuth);

// APIs lectures/écritures sur l'état partagé.
registerNewsRoutes(app, requireAuth);
registerImageRoutes(app, requireAuth, imageState, {
  messageLog,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
});
registerAnalyticsRoutes(app, requireAuth, messageLog);
registerFilterRoutes(app, requireAuth);
registerMessageRoutes(app, requireAuth);
registerConfigRoutes(app, requireAuth);

// DB viewer (read-only SQL playground, auth-protected).
registerDbViewerRoutes(app, requireAuth);

// Backup log (historique des 30 derniers runs en mémoire).
registerBackupLogRoutes(app, requireAuth);

// Profits : injection du channelId avant d'enregistrer les routes.
profitCounter.setProfitsChannelId(PROFITS_CHANNEL_ID);
registerProfitRoutes(app, requireAuth);

// SaaS routes — webhooks publics + API admin auth-protégée.
// Inconditionnel : utile même sans clientSaas (pour gérer les licences via API).
registerSaasAdminRoutes(app, requireAuth);

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
  ],
});

// Injection du client dans les modules qui en ont besoin (mentions
// dans canvas, daily summary dans profit, alertes trading).
setCanvasDiscordClient(client);
profitCounter.setDiscordClient(client);
discordClientRef = client;  // active sendTradingAlert()

// Listeners + scheduler. Les helpers internes font eux-mêmes leur
// `client.once('ready')` si nécessaire — pas de ordre requis ici.
registerDiscordCommands(client, { profitsChannelId: PROFITS_CHANNEL_ID });
registerMarketCommands(client);
registerProfitListener(client, { profitsChannelId: PROFITS_CHANNEL_ID });
registerTradingHandler(client, {
  tradingChannel: TRADING_CHANNEL,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
  tradingEngine,
  sendEmailAlert,
});
startScheduler({ client, tradingChannel: TRADING_CHANNEL });

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

  registerGuildGuard(clientSaas, { adminGuildId: SAAS_ADMIN_GUILD_ID });
  registerSaasCommands(clientSaas, {
    adminGuildId: SAAS_ADMIN_GUILD_ID,
    adminUserId:  SAAS_ADMIN_USER_ID,
  });
  // Le relais consomme messageCreate du client SOURCE (bot trading existant)
  // et publie via clientSaas vers les serveurs clients.
  registerSaasRelay({
    clientSource: client,
    clientSaas,
    sourceGuildId: SAAS_SOURCE_GUILD_ID,
    sourceChannelIds: SAAS_SOURCE_CHANNELS,
  });

  clientSaas.once('ready', () => {
    console.log('[saas] Bot connected as ' + clientSaas.user.tag);
    console.log(`[saas] Guilds: ${clientSaas.guilds.cache.size}`);
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
