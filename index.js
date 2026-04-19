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
const { setDiscordClient: setCanvasDiscordClient } = require('./canvas/proof');
const { registerTradingHandler } = require('./discord/handler');
const { registerDiscordCommands } = require('./discord/commands');
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

// ── Configuration env ──────────────────────────────────────────────
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL   = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL    = process.env.TRADING_CHANNEL || 'trading-floor';
const PROFITS_CHANNEL_ID = process.env.PROFITS_CHANNEL_ID || '';
const NEWS_CHANNEL_ID    = process.env.NEWS_CHANNEL_ID || '';
const PORT               = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://discord-trading-bot-production-f159.up.railway.app';

// ── Serveur HTTP ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
// dans canvas, daily summary dans profit).
setCanvasDiscordClient(client);
profitCounter.setDiscordClient(client);

// Listeners + scheduler. Les helpers internes font eux-mêmes leur
// `client.once('ready')` si nécessaire — pas de ordre requis ici.
registerDiscordCommands(client, { profitsChannelId: PROFITS_CHANNEL_ID });
registerProfitListener(client, { profitsChannelId: PROFITS_CHANNEL_ID });
registerTradingHandler(client, {
  tradingChannel: TRADING_CHANNEL,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
});
startScheduler({ client, tradingChannel: TRADING_CHANNEL });

// Log de connexion + démarrage du poller RSS au ready.
client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);
  newsPoller.startPolling({ client, channelId: NEWS_CHANNEL_ID });
});

client.login(DISCORD_TOKEN);
