const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

// Modules locaux — utilitaires purs extraits pour clarté.
const { BLOCKED_AUTHORS, AUTHOR_ALIASES, getDisplayName } = require('./utils/authors');
const {
  extractPrices,
  extractTicker,
  detectTicker,
  enrichContent,
  TICKER_IGNORE,
} = require('./utils/prices');
const {
  DATA_DIR,
  MAX_LOG,
  todayKey,
  loadDailyFile,
  saveDailyFile,
  loadInitialMessages,
  saveTodayMessages,
} = require('./utils/persistence');
const { classifySignal } = require('./filters/signal');
const {
  parseRssItems,
  getNewsEmoji,
  isNewsRelevant,
  extractSource,
  NEWS_KEYWORDS,
  NEWS_BLOCKED,
  INDEX_VARIATION_REGEX,
} = require('./filters/news');
// Seuls COMMON_CSS + sidebarHTML (utilisés inline par la page /config)
// et LOGIN_HTML (servi par app.get('/login') qui a sa propre logique
// cookie) sont importés ici. Les autres templates sont câblés via
// routes/pages.js.
const { COMMON_CSS, sidebarHTML } = require('./pages/common');
const { LOGIN_HTML } = require('./pages/login');
const {
  generateImage,
  drawMessageBlock,
  generateProofImage,
  setDiscordClient: setCanvasDiscordClient,
  PROOF_LAYOUT,
} = require('./canvas/proof');
const { generatePromoImage } = require('./canvas/promo');
const { registerPageRoutes } = require('./routes/pages');
const { registerImageRoutes } = require('./routes/images');
const { registerNewsRoutes } = require('./routes/news');
const { registerAnalyticsRoutes } = require('./routes/analytics');
const { registerFilterRoutes } = require('./routes/filters');
const { registerMessageRoutes } = require('./routes/messages');
const { registerProfitRoutes } = require('./routes/profits');
const profitCounter = require('./profit/counter');
// Ré-expose les symboles profit utilisés inline par les commandes Discord
// et le listener #profits. Destructuring de profitCounter pour garder
// les anciens call sites inchangés.
const {
  countProfitEntries,
  profitFiltersMatch,
  profitFilters,
  loadProfitData,
  loadProfitMessages,
  saveProfitMessages,
  addProfitMessage,
  getProfitRecord,
  buildProfitSummaryMsg,
  sendDailyProfitSummary,
  PROFIT_PHRASE_MAX,
} = profitCounter;
const { customFilters, saveCustomFilters } = require('./state/custom-filters');
const { messageLog, logEvent } = require('./state/messages');
const newsPoller = require('./news/poller');
const imageState = require('./state/images');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PROFITS_CHANNEL_ID = process.env.PROFITS_CHANNEL_ID || '';
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID || '';
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://discord-trading-bot-production-f159.up.railway.app';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'boom2024';
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

// DATA_DIR, todayKey, loadDailyFile, saveDailyFile, loadInitialMessages,
// saveTodayMessages, MAX_LOG sont importés depuis ./utils/persistence.


// lastPromoImageBuffer / lastImageBuffer / lastImageId / imageGallery / addToGallery
// sont désormais dans state/images.js (accès via imageState.*).

// saveTodayMessages + loadInitialMessages sont importés depuis ./utils/persistence.

// customFilters + saveCustomFilters viennent de ./state/custom-filters.
// Le handler Discord et /config mutent/lisent directement cet objet.

// CUSTOM_AVATARS et CUSTOM_EMOJIS sont importés depuis ./canvas/config.
// ─────────────────────────────────────────────────────────────────────

// CONFIG et FONT sont importés depuis ./canvas/config.

// COMMON_CSS et sidebarHTML sont importés depuis ./pages/common.

// DASHBOARD_HTML est importé depuis ./pages/dashboard.

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(cookieHeader) {
  var result = {};
  if (!cookieHeader) return result;
  cookieHeader.split(';').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    var key = pair.slice(0, idx).trim();
    var val = pair.slice(idx + 1).trim();
    result[key] = decodeURIComponent(val);
  });
  return result;
}

function requireAuth(req, res, next) {
  var cookies = parseCookies(req.headers.cookie);
  if (cookies['boom_session'] === SESSION_TOKEN) return next();
  res.redirect('/login');
}

// Enregistre toutes les pages HTML statiques (/dashboard, /stats, /profits,
// /news, /leaderboard, /ticker/:symbol, /image-generator, /proof-generator,
// /raw-messages, /gallery) en une seule fois. Voir routes/pages.js.
registerPageRoutes(app, requireAuth);

// Endpoints news (SSE + snapshot) — stateless par rapport à messageLog.
registerNewsRoutes(app, requireAuth);
// routes/images.js (routes de génération + galerie) doivent attendre la
// création de messageLog — enregistrées juste après.

// LOGIN_HTML est importé depuis ./pages/login.

app.get('/login', (req, res) => {
  var cookies = parseCookies(req.headers.cookie);
  if (cookies['boom_session'] === SESSION_TOKEN) return res.redirect('/dashboard');
  res.set('Content-Type', 'text/html');
  res.send(LOGIN_HTML);
});

app.post('/login', (req, res) => {
  var pw = (req.body && req.body.password) || '';
  if (pw === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', 'boom_session=' + SESSION_TOKEN + '; Path=/; HttpOnly');
    return res.redirect('/dashboard');
  }
  res.set('Content-Type', 'text/html');
  var html = LOGIN_HTML.replace('id="err" class="err"', 'id="err" class="err show"');
  res.send(html);
});

// lastImageBuffer, lastImageId, imageGallery, addToGallery : voir state/images.js
// Accessibles via la constante `imageState` déjà importée en haut.

// messageLog, sseClients, logEvent proviennent de state/messages.js.
// Les routes suivantes mutent/lisent ces structures via ce module.

// Images : lecture de messageLog (find-alert) + écriture dans imageState.
registerImageRoutes(app, requireAuth, imageState, {
  messageLog,
  railwayUrl: RAILWAY_URL,
  makeWebhookUrl: MAKE_WEBHOOK_URL,
});

// Analytics (read-only). messageLog passé par référence.
registerAnalyticsRoutes(app, requireAuth, messageLog);

// Filtres custom (mutate state/custom-filters + persist).
registerFilterRoutes(app, requireAuth);

// Messages (read + SSE). Lit state/messages directement.
registerMessageRoutes(app, requireAuth);

// Profits (compteur + review + webhook). State/logic dans profit/counter.
profitCounter.setProfitsChannelId(PROFITS_CHANNEL_ID);
registerProfitRoutes(app, requireAuth);















// ─────────────────────────────────────────────────────────────────────
//  Interface Generateur d'Images
// ─────────────────────────────────────────────────────────────────────
// IMAGE_GEN_HTML est importé depuis ./pages/image-generator.

// ─────────────────────────────────────────────────────────────────────
//  Page Messages Bruts — tous les messages Discord sans filtre
// ─────────────────────────────────────────────────────────────────────
// RAW_MESSAGES_HTML est importé depuis ./pages/raw-messages.



// Mise a jour de /preview pour supporter le parametre ?ts=

// ─────────────────────────────────────────────────────────────────────
//  Proof Generator: /proof-generator + /api/find-alert + /api/proof-image
// ─────────────────────────────────────────────────────────────────────

// Find original entry alert for a ticker in message history (last 90 days)

// Generate proof image

// PROOF_GEN_HTML est importé depuis ./pages/proof-generator.


// STATS_HTML est importé depuis ./pages/stats.



// ─────────────────────────────────────────────────────────────────────
//  Feature 4a: GET /api/profits-history?days=7
// ─────────────────────────────────────────────────────────────────────

// Expose profit count increment via API (called externally or via Make.com)

// Modifier manuellement le count de profits du jour

// Lire / modifier le paramètre "bot silencieux dans #profits"



// ─────────────────────────────────────────────────────────────────────
//  Profits review API — messages list, feedback, filters
// ─────────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────────
//  Webhook endpoint pour Discord → profits (pas d'auth requise)
//  Configure le webhook Discord du salon #profits vers cette URL
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  Feature 4b: GET /profits — bar chart page
// ─────────────────────────────────────────────────────────────────────
// PROFITS_PAGE_HTML est importé depuis ./pages/profits.


// ─────────────────────────────────────────────────────────────────────
//  News Dashboard: /news + /api/recent-news + /api/news-events (SSE)
// ─────────────────────────────────────────────────────────────────────

// NEWS_PAGE_HTML est importé depuis ./pages/news.


// ─────────────────────────────────────────────────────────────────────
//  Analyst Performance API: /api/analyst-performance?days=30
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  Ticker page /ticker/:symbol + /api/ticker/:symbol
// ─────────────────────────────────────────────────────────────────────

// TICKER_PAGE_HTML est importé depuis ./pages/ticker.


// ─────────────────────────────────────────────────────────────────────
//  Feature 3: GET /leaderboard — 30-day leaderboard
// ─────────────────────────────────────────────────────────────────────
// LEADERBOARD_HTML est importé depuis ./pages/leaderboard.



// GET /api/leaderboard/analyst?author=AR&days=30
// Returns the full list of valid signals for a specific author

// ─────────────────────────────────────────────────────────────────────
//  Feature 7: GET /config — read-only config display page
// ─────────────────────────────────────────────────────────────────────
app.get('/config', requireAuth, (req, res) => {
  // Reload overrides fresh
  const overrides = loadConfigOverrides();
  const aliases = Object.assign({}, AUTHOR_ALIASES_DEFAULT, overrides.authorAliases || {});
  const channelOverrides = overrides.allowedChannels || [];
  const safeFilters = {
    blocked: customFilters.blocked || [],
    allowed: customFilters.allowed || [],
    blockedAuthors: customFilters.blockedAuthors || [],
    allowedAuthors: customFilters.allowedAuthors || [],
    allowedChannels: customFilters.allowedChannels || [],
  };

  const configPageHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Config</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
  td { padding: 7px 8px; font-size: 13px; vertical-align: middle; }
  .alias-key { font-weight: 700; color: #D649CC; }
  .alias-val { color: #fafafa; }
  .tag { display: inline-block; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 10px; font-size: 12px; margin: 3px; }
  .tag-blocked { border-color: rgba(239,68,68,0.3); color: #f87171; background: rgba(239,68,68,0.1); }
  .tag-allowed { border-color: rgba(16,185,129,0.3); color: #10b981; background: rgba(16,185,129,0.1); }
  .tag-author  { border-color: rgba(214,73,204,0.3); color: #D649CC; background: rgba(214,73,204,0.1); }
  .tag-channel { border-color: rgba(59,130,246,0.3); color: #60a5fa; background: rgba(59,130,246,0.1); }
  .env-row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .env-key { font-size: 12px; color: #a0a0b0; width: 220px; flex-shrink: 0; }
  .env-val { font-size: 12px; color: #fafafa; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 12px; flex: 1; font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { font-size: 12px; color: #a0a0b0; margin-top: 8px; font-style: italic; }
</style>
</head>
<body>
${sidebarHTML('/config')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Config</h1></div>
<div id="wrap">
  <div class="card">
    <div class="card-title">Variables d'environnement</div>
    <div class="env-row"><span class="env-key">TRADING_CHANNEL</span><span class="env-val">${String(process.env.TRADING_CHANNEL || 'trading-floor (defaut)')}</span></div>
    <div class="env-row"><span class="env-key">PROFITS_CHANNEL_ID</span><span class="env-val">${process.env.PROFITS_CHANNEL_ID ? '*** (defini)' : '— (non defini)'}</span></div>
    <div class="env-row"><span class="env-key">DASHBOARD_PASSWORD</span><span class="env-val">*** (masque)</span></div>
    <div class="env-row"><span class="env-key">MAKE_WEBHOOK_URL</span><span class="env-val">${process.env.MAKE_WEBHOOK_URL ? '*** (defini)' : '— (non defini)'}</span></div>
    <div class="env-row"><span class="env-key">RAILWAY_PUBLIC_DOMAIN</span><span class="env-val">${String(process.env.RAILWAY_PUBLIC_DOMAIN || '— (local)')}</span></div>
    <div class="note">Les variables d'environnement sont definies dans Railway ou le fichier .env local.</div>
  </div>

  <div class="card">
    <div class="card-title">Aliases auteurs (AUTHOR_ALIASES)</div>
    ${Object.keys(aliases).length === 0
      ? '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun alias configure — editer config-overrides.json pour en ajouter.</span>'
      : '<table><thead><tr><th>Username Discord</th><th>Nom affiche</th></tr></thead><tbody>'
        + Object.keys(aliases).map(function(k) {
            return '<tr><td class="alias-key">' + k.replace(/</g,'&lt;') + '</td><td class="alias-val">' + String(aliases[k]).replace(/</g,'&lt;') + '</td></tr>';
          }).join('')
        + '</tbody></table>'
    }
    <div class="note">Editer <code>config-overrides.json</code> dans DATA_DIR pour modifier les aliases.</div>
  </div>

  <div class="card">
    <div class="card-title">Filtres actifs (customFilters)</div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Phrases bloqu&#233;es (${safeFilters.blocked.length})</div>
      ${safeFilters.blocked.length ? safeFilters.blocked.map(function(p){ return '<span class="tag tag-blocked">' + p.replace(/</g,'&lt;').substring(0,60) + '</span>'; }).join('') : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune</span>'}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Phrases autoris&#233;es (${safeFilters.allowed.length})</div>
      ${safeFilters.allowed.length ? safeFilters.allowed.map(function(p){ return '<span class="tag tag-allowed">' + p.replace(/</g,'&lt;').substring(0,60) + '</span>'; }).join('') : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune</span>'}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Auteurs bloqu&#233;s (${safeFilters.blockedAuthors.length})</div>
      ${safeFilters.blockedAuthors.length ? safeFilters.blockedAuthors.map(function(a){ return '<span class="tag tag-blocked">' + a.replace(/</g,'&lt;') + '</span>'; }).join('') : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun</span>'}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Auteurs autoris&#233;s (${safeFilters.allowedAuthors.length})</div>
      ${safeFilters.allowedAuthors.length ? safeFilters.allowedAuthors.map(function(a){ return '<span class="tag tag-allowed">' + a.replace(/</g,'&lt;') + '</span>'; }).join('') : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun</span>'}
    </div>
    <div class="note">Modifier les filtres depuis le Dashboard (boutons ✕ ❌ ✅ sur chaque message).</div>
  </div>

  <div class="card">
    <div class="card-title">Canaux de trading autoris&#233;s</div>
    <span class="tag tag-channel">${String(process.env.TRADING_CHANNEL || 'trading-floor')}</span>
    ${channelOverrides.map(function(c){ return '<span class="tag tag-channel">' + c.replace(/</g,'&lt;') + '</span>'; }).join('')}
    <div class="note">Canal principal defini par TRADING_CHANNEL. Canaux additionnels via config-overrides.json.</div>
  </div>
</div>
</div>
</body>
</html>`;
  res.set('Content-Type', 'text/html');
  res.send(configPageHtml);
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 8: GET /promo-image/latest — serve last promo image
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  Gallery — /gallery + /api/gallery + /gallery/image/:id
// ─────────────────────────────────────────────────────────────────────


// /gallery HTML est servi via routes/pages.js (depuis ./pages/gallery).

app.listen(PORT, () => console.log('Server running on port ' + PORT));

// generateImage, drawMessageBlock, generateProofImage, generatePromoImage,
// PROOF_LAYOUT et les helpers (wrapText, resolveUserMentions, parseRichSegments,
// measureRichWidth, wrapRichText, drawRichLine) sont importés depuis ./canvas/*.

// extractPrices, extractTicker, enrichContent, detectTicker, TICKER_IGNORE
// sont désormais importés depuis ./utils/prices en haut du fichier.

// classifySignal est importé depuis ./filters/signal.
// Au call site on lui passe customFilters pour éviter le couplage global.

// ─────────────────────────────────────────────────────────────────────
//  Resume journalier Discord — envoye a 18h00 heure locale
// ─────────────────────────────────────────────────────────────────────
let lastSummaryDate = null;

function sendDailySummary() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayMsgs = messageLog.filter(function(m) { return new Date(m.ts) >= midnight; });
  const total = todayMsgs.length;
  const accepted = todayMsgs.filter(function(m) { return m.passed; }).length;
  const filtered = total - accepted;
  const rate = total ? Math.round(accepted / total * 100) : 0;

  const tickerMap = {};
  todayMsgs.forEach(function(m) { if (m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker] || 0) + 1; });
  const topTickers = Object.keys(tickerMap).map(function(k) { return [k, tickerMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);

  const authorMap = {};
  todayMsgs.forEach(function(m) {
    if (!m.author || BLOCKED_AUTHORS.has(String(m.author).toLowerCase())) return;
    const key = getDisplayName(m.author);
    authorMap[key] = (authorMap[key] || 0) + 1;
  });
  const topAuthors = Object.keys(authorMap).map(function(k) { return [k, authorMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);

  const tickersStr = topTickers.length ? topTickers.map(function(t) { return t[0] + ' (' + t[1] + ')'; }).join(', ') : 'None';
  const authorsStr = topAuthors.length ? topAuthors.map(function(a) { return a[0] + ' (' + a[1] + ')'; }).join(', ') : 'None';

  const summaryText = [
    '**BOOM Daily Summary** — ' + todayStr,
    '> Total messages: **' + total + '**',
    '> Accepted: **' + accepted + '** | Filtered: **' + filtered + '**',
    '> Acceptance rate: **' + rate + '%**',
    '> Top tickers: ' + tickersStr,
    '> Top analysts: ' + authorsStr,
  ].join('\n');

  try {
    const channel = client.channels.cache.find(function(ch) {
      return ch.name && ch.name.includes(TRADING_CHANNEL);
    });
    if (channel && channel.send) {
      channel.send(summaryText).then(function() {
        console.log('[summary] Resume journalier envoye dans #' + channel.name);
      }).catch(function(err) {
        console.error('[summary] Erreur envoi resume:', err.message);
      });
    } else {
      console.warn('[summary] Channel introuvable pour le resume journalier');
    }
  } catch (e) {
    console.error('[summary] Erreur:', e.message);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
// Injecte le client dans canvas/proof pour résoudre les mentions <@id> → @username.
setCanvasDiscordClient(client);
// Injecte le client dans profit/counter pour envoyer le daily summary.
profitCounter.setDiscordClient(client);

// ─────────────────────────────────────────────────────────────────────
//  Feature 6: Auto backup to GitHub at midnight EDT
// ─────────────────────────────────────────────────────────────────────
let lastBackupDate = null;
const backupLog = [];

function runGitBackup() {
  const dateKey = todayKey();
  const dataGlob = path.join(DATA_DIR, '*.json').replace(/\\/g, '/');
  const cmd = 'git -C "' + __dirname.replace(/\\/g, '/') + '" add "' + dataGlob + '" && git -C "' + __dirname.replace(/\\/g, '/') + '" commit -m "Auto backup data ' + dateKey + '" --allow-empty && git -C "' + __dirname.replace(/\\/g, '/') + '" push';
  console.log('[backup] Running git backup for ' + dateKey);
  exec(cmd, function(err, stdout, stderr) {
    const entry = {
      date: new Date().toISOString(),
      success: !err,
      stdout: (stdout || '').trim().substring(0, 300),
      stderr: (stderr || '').trim().substring(0, 300),
      error: err ? err.message : null,
    };
    backupLog.unshift(entry);
    if (backupLog.length > 30) backupLog.pop();
    if (err) {
      console.error('[backup] Git backup failed:', err.message);
    } else {
      console.log('[backup] Git backup success:', stdout.trim().substring(0, 100));
    }
  });
}

// Poller news (flux RSS + diffusion Discord + SSE) : voir news/poller.js.

client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);

  // Lance le poller RSS (no-op si NEWS_CHANNEL_ID absent — logs internes).
  newsPoller.startPolling({ client, channelId: NEWS_CHANNEL_ID });

  // Verification toutes les minutes pour le resume a 18h00 et backup midnight EDT
  setInterval(function() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Resume journalier a 21h00 heure locale
    if (now.getHours() === 21 && now.getMinutes() === 0) {
      if (lastSummaryDate !== todayStr) {
        lastSummaryDate = todayStr;
        sendDailySummary();
      }
    }

    // Daily profit summary at 20:00 EDT
    // 20:00 EDT = 00:00 UTC (summer) or 01:00 UTC (winter)
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const is20hEDT = (utcH === 0 || utcH === 1) && utcM === 0;
    if (is20hEDT && profitCounter.getLastSummaryDate() !== todayStr) {
      profitCounter.setLastSummaryDate(todayStr);
      sendDailyProfitSummary();
    }

    // Backup a minuit EDT (UTC-4 en ete, UTC-5 en hiver)
    // Minuit EDT = 04:00 UTC en ete, 05:00 UTC en hiver
    // On essaie les deux: 04:00 et 05:00 UTC
    const isMidnightEDT = (utcH === 4 || utcH === 5) && utcM === 0;
    if (isMidnightEDT && lastBackupDate !== todayStr) {
      lastBackupDate = todayStr;
      runGitBackup();
    }
  }, 60000);
});


// ─────────────────────────────────────────────────────────────────────
//  !profits command — fonctionne dans tous les salons
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const cmd = message.content.trim().toLowerCase();
  if (cmd !== '!profits') return;
  console.log('[!profits] Command received from ' + message.author.username + ' in #' + (message.channel.name || message.channel.id));

  const dateKey = todayKey();
  const data = loadProfitData(dateKey);
  const count = data.count || 0;
  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });

  const record = getProfitRecord();
  const recordLine = (count > 0 && count >= record.count)
    ? '\n> 🏆 **NEW RECORD!**'
    : '\n> 📊 Record: **' + record.count + '** (' + record.date + ')';

  try {
    await message.reply(
      '📊 **Daily Profits — ' + dateStr + '**\n'
      + '> 🔥 **' + count + '** profit' + (count !== 1 ? 's' : '') + ' posted today'
      + recordLine
    );
  } catch (e) {
    console.error('[!profits]', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  !report command — poste le rapport journalier manuellement
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!bilan') return;
  console.log('[!bilan] Triggered by ' + message.author.username);
  try { await message.reply(buildProfitSummaryMsg()); } catch (e) { console.error('[!bilan]', e.message); }
});

// ─────────────────────────────────────────────────────────────────────
//  !delete-report command — supprime le dernier rapport journalier
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!delete-report') return;

  if (!PROFITS_CHANNEL_ID) {
    try { await message.reply('❌ PROFITS_CHANNEL_ID non configuré.'); } catch (_) {}
    return;
  }

  try {
    const ch = client.channels.cache.get(PROFITS_CHANNEL_ID);
    if (!ch) { await message.reply('❌ Salon #profits introuvable.'); return; }

    let targetMsg = null;

    // Try known message ID first
    const savedMsgId = profitCounter.getLastSummaryMessageId();
    if (savedMsgId) {
      try { targetMsg = await ch.messages.fetch(savedMsgId); } catch (_) {}
    }

    // Fallback: search last 50 messages for the bot's profit report
    if (!targetMsg) {
      const fetched = await ch.messages.fetch({ limit: 50 });
      targetMsg = fetched.find(m =>
        m.author.id === client.user.id && m.content.includes('Daily Profit Report')
      ) || null;
    }

    if (!targetMsg) {
      await message.reply('❌ Aucun rapport journalier trouvé dans #profits.');
      return;
    }

    await targetMsg.delete();
    if (profitCounter.getLastSummaryMessageId() === targetMsg.id) profitCounter.clearLastSummaryMessageId();
    console.log('[!delete-report] Report deleted by ' + message.author.username);
    try { await message.react('✅'); } catch (_) {}
  } catch (e) {
    console.error('[!delete-report]', e.message);
    try { await message.reply('❌ Erreur : ' + e.message); } catch (_) {}
  }
});

// ─────────────────────────────────────────────────────────────────────
//  !news command — last 5 headlines in any channel
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!news') return;

  const recentNews = newsPoller.getRecentNews();
  if (!recentNews.length) {
    try { await message.reply('📰 No recent news available.'); } catch (_) {}
    return;
  }
  const top5 = recentNews.slice(0, 5);
  const lines = ['📰 **Latest News**'];
  top5.forEach((n, i) => {
    lines.push('> ' + (i + 1) + '. ' + n.emoji + ' ' + n.title);
  });
  try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!news]', e.message); }
});

// ─────────────────────────────────────────────────────────────────────
//  Profit counter — écoute #profits pour les messages avec images
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!PROFITS_CHANNEL_ID) return;
  if (message.channel.id !== PROFITS_CHANNEL_ID) return;

  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
  const hasImage = message.attachments.some(a =>
    (a.contentType && a.contentType.startsWith('image/')) ||
    (a.url && IMAGE_EXT.test(a.url)) ||
    (a.name && IMAGE_EXT.test(a.name))
  );
  const content = message.content || '';
  const textCount = countProfitEntries(content);
  const hasTicker = !!detectTicker(content);

  // Decide whether to count, consulting learned filters first
  let counted;
  let reason;
  if (profitFiltersMatch(profitFilters.blocked, content)) {
    counted = false;
    reason = 'learned-blocked';
  } else if (profitFiltersMatch(profitFilters.allowed, content)) {
    counted = true;
    reason = 'learned-allowed';
  } else if (hasImage) {
    counted = true;
    reason = 'image';
  } else if (textCount > 0) {
    counted = true;
    reason = 'price range(s)';
  } else if (hasTicker) {
    counted = true;
    reason = 'ticker';
  } else {
    counted = false;
    reason = 'ignored';
  }

  // Always store the message, even ignored ones
  const dateKey = todayKey();
  const msgs = loadProfitMessages(dateKey);
  msgs.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    author: message.author.username,
    content,
    preview: content.length > PROFIT_PHRASE_MAX ? content.slice(0, PROFIT_PHRASE_MAX) + '…' : content,
    hasImage,
    hasTicker,
    textCount,
    counted,
    reason,
    feedback: null,
  });
  saveProfitMessages(dateKey, msgs);

  console.log('[profits] ' + reason + ' in #profits from ' + message.author.username + ' → counted=' + counted);

  if (counted) {
    await addProfitMessage(content);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot && !message.webhookId) return;
  const channelName = message.channel.name || '';
  console.log('Message received - channel: "' + channelName + '", author: ' + message.author.username);
  if (!channelName.includes(TRADING_CHANNEL)) return;

  const content = message.content;
  const authorName = message.author.username;

  // ── Feature 1: Discord commands !top and !stats TICKER ─────────────────────
  if (content.trim() === '!top') {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayMsgs = messageLog.filter(function(m) { return m.passed && new Date(m.ts) >= midnight; });
    const authorMap = {};
    todayMsgs.forEach(function(m) {
      if (m.author) authorMap[m.author] = (authorMap[m.author] || 0) + 1;
    });
    const top = Object.keys(authorMap).map(function(k) { return [k, authorMap[k]]; })
      .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);
    const dateStr = new Date().toISOString().slice(0, 10);
    const medals = ['1.', '2.', '3.'];
    const lines = ['**🏆 Top Analysts — ' + dateStr + '**'];
    if (!top.length) {
      lines.push('> No accepted signals today');
    } else {
      top.forEach(function(t, i) {
        lines.push('> ' + medals[i] + ' **' + t[0] + '** — ' + t[1] + ' signal' + (t[1] > 1 ? 's' : ''));
      });
    }
    try { await message.reply(lines.join('\n')); } catch(e) { console.error('[!top]', e.message); }
    return;
  }

  const statsMatch = content.trim().match(/^!stats\s+([A-Z$]{1,7})/i);
  if (statsMatch) {
    const ticker = statsMatch[1].replace('$', '').toUpperCase();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayMsgs = messageLog.filter(function(m) { return new Date(m.ts) >= midnight && m.ticker && m.ticker.toUpperCase() === ticker; });
    const total = todayMsgs.length;
    const accepted = todayMsgs.filter(function(m) { return m.passed; }).length;
    const filtered = total - accepted;
    const authorMap = {};
    todayMsgs.filter(function(m) { return m.passed; }).forEach(function(m) {
      if (!m.author || BLOCKED_AUTHORS.has(String(m.author).toLowerCase())) return;
      const key = getDisplayName(m.author);
      authorMap[key] = (authorMap[key] || 0) + 1;
    });
    const topAuthors = Object.keys(authorMap).map(function(k) { return k + ' (' + authorMap[k] + ')'; })
      .sort(function(a, b) { return authorMap[b.split(' ')[0]] - authorMap[a.split(' ')[0]]; });
    const authorStr = topAuthors.length ? topAuthors.join(', ') : 'Aucun';
    const lines = [
      '**📈 Stats $' + ticker + ' — aujourd\'hui**',
      '> Signaux : ' + total,
      '> Acceptés : ' + accepted + ' | Filtrés : ' + filtered,
      '> Auteurs : ' + authorStr,
    ];
    try { await message.reply(lines.join('\n')); } catch(e) { console.error('[!stats]', e.message); }
    return;
  }
  // ───────────────────────────────────────────────────────────────────────────

  // ── Filtre par auteur ──────────────────────────────────────────────────────
  // Les auteurs dans BLOCKED_AUTHORS (hardcodé) sont ignorés silencieusement —
  // aucun logEvent pour qu'ils ne polluent jamais le dashboard. Les auteurs
  // bloqués via customFilters (UI) restent logués avec reason 'Auteur bloqué'
  // pour que l'utilisateur voie que son filtre a fonctionné.
  if (BLOCKED_AUTHORS.has(authorName.toLowerCase())) {
    console.log('[AUTHOR BLOCKED] ' + authorName);
    return;
  }
  if ((customFilters.blockedAuthors || []).includes(authorName)) {
    console.log('[AUTHOR BLOCKED] ' + authorName);
    logEvent(authorName, channelName, content, null, 'Auteur bloqué');
    return;
  }
  const authorAllowed = (customFilters.allowedAuthors || []).includes(authorName);
  // ──────────────────────────────────────────────────────────────────────────

  // ── Détection de réponse + enrichissement de contexte ─────────────────────
  let parentContent = null;
  let parentAuthor  = null;
  let isReply       = false;

  if (message.reference?.messageId) {
    try {
      const parentMsg = await message.channel.messages.fetch(message.reference.messageId);
      parentContent = parentMsg.content || '';
      parentAuthor  = parentMsg.author?.username || null;
      isReply       = true;
      console.log('[REPLY] Parent: ' + parentContent.substring(0, 60));
    } catch (e) {
      console.warn('[REPLY] Could not fetch parent message:', e.message);
    }
  }

  // Contenu enrichi : si c'est une réponse, on fusionne parent + reply
  // pour que le ticker/prix du parent bénéficient à la classification de la réponse
  const classifyContent = isReply && parentContent
    ? parentContent + ' ' + content
    : content;

  const extra = {
    isReply,
    parentPreview: parentContent ? (parentContent.length > 80 ? parentContent.slice(0, 80) + '…' : parentContent) : null,
    parentAuthor,
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Toujours analyser le contenu pour des stats précises.
  // customFilters est passé explicitement pour rester testable et sans
  // couplage caché au module filters/signal.
  const result         = classifySignal(classifyContent, customFilters);
  const filterType     = result.type;       // ce que le filtre de contenu a décidé
  const filterReason   = result.reason;
  const signalConfidence = result.confidence;
  const signalTicker   = result.ticker;

  const pricesForLog = extractPrices(classifyContent);
  const extraWithSignal = Object.assign({}, extra, {
    confidence: signalConfidence,
    ticker: signalTicker,
    entry_price: pricesForLog.entry_price != null ? pricesForLog.entry_price : null,
  });

  if (!filterType && !authorAllowed) {
    // Filtré ET auteur non autorisé → bloqué
    console.log('Filtered (' + filterReason + '): ' + content.substring(0, 80));
    logEvent(authorName, channelName, content, null, filterReason, extraWithSignal);
    return;
  }

  if (!filterType && authorAllowed) {
    // Filtré par le contenu MAIS auteur autorisé → on logue passed:false (stats honnêtes)
    // mais on continue quand même pour envoyer le signal
    console.log('[AUTHOR ALLOWED bypass] ' + authorName + ': ' + content.substring(0, 60));
    logEvent(authorName, channelName, content, null, 'Auteur autorise (contenu filtre)', extraWithSignal);
    // on ne return pas : on envoie quand même l'image/webhook
  } else {
    // Filtre passé normalement
    logEvent(authorName, channelName, content, filterType, filterReason, extraWithSignal);
  }
  const sendType = filterType || 'neutral';
  console.log('[' + sendType.toUpperCase() + ']' + (isReply ? ' [REPLY]' : '') + ' ' + content);

  let imageUrl = null;
  try {
    let imgBuf;
    if (isReply && parentAuthor) {
      imgBuf = await generateProofImage(
        parentAuthor,
        parentContent || '',
        null,
        message.author.username,
        content,
        message.createdAt.toISOString()
      );
    } else {
      imgBuf = await generateImage(message.author.username, content, message.createdAt.toISOString());
    }
    imageState.lastImageBuffer = imgBuf;
    imageState.lastImageId = Date.now();
    imageState.addToGallery('signal', signalTicker, authorName, imgBuf);
    imageUrl = RAILWAY_URL + '/image/latest?t=' + imageState.lastImageId;
    console.log('Image generated, URL: ' + imageUrl);
  } catch (err) {
    console.error('Image generation error:', err.message);
  }

  // ── Auto Proof Image — détecte recap + alerte originale ──────────────────
  const recapPrices = extractPrices(classifyContent);
  const isRecap = signalTicker
    && recapPrices.entry_price !== null
    && recapPrices.target_price !== null
    && recapPrices.target_price > recapPrices.entry_price; // exit > entry = profit confirmé

  if (isRecap) {
    try {
      // Chercher l'alerte originale dans l'historique (30 derniers jours)
      let originalAlert = null;

      // 1. Si c'est une réponse Discord, utiliser le message parent directement
      if (isReply && parentContent && parentAuthor) {
        originalAlert = { author: parentAuthor, content: parentContent, ts: null };
      }

      // 2. Sinon chercher dans l'historique le dernier signal d'entrée pour ce ticker
      if (!originalAlert) {
        for (let i = 0; i < 30 && !originalAlert; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dk = d.toISOString().slice(0, 10);
          const msgs = i === 0
            ? messageLog.filter(m => m.ts && m.ts.slice(0, 10) === dk)
            : loadDailyFile(dk);
          const found = msgs.find(m =>
            m.passed &&
            m.ticker && m.ticker.toUpperCase() === signalTicker.toUpperCase() &&
            m.id !== undefined && // not the current message
            new Date(m.ts) < message.createdAt // must be BEFORE the recap
          );
          if (found) {
            originalAlert = { author: found.author, content: found.content || found.preview || '', ts: found.ts };
          }
        }
      }

      if (originalAlert) {
        console.log('[proof] Generating proof image for $' + signalTicker + ' — original by ' + originalAlert.author);
        const proofBuf = await generateProofImage(
          originalAlert.author,
          originalAlert.content,
          originalAlert.ts,
          message.author.username,
          content,
          message.createdAt.toISOString()
        );
        imageState.addToGallery('proof', signalTicker, authorName, proofBuf);
        // Post the proof image directly in the channel
        await message.channel.send({
          files: [{ attachment: proofBuf, name: 'proof-' + signalTicker.toLowerCase() + '.png' }]
        });
        console.log('[proof] Proof image posted for $' + signalTicker);
      } else {
        console.log('[proof] No original alert found for $' + signalTicker);
      }
    } catch (err) {
      console.error('[proof] Error generating proof image:', err.message);
    }
  }

  // Feature 8: Generate promo image for complete signals (has ticker + prices)
  const pricesData = extractPrices(classifyContent);
  let promoImageBase64 = null;
  if (signalTicker && pricesData.entry_price != null && pricesData.target_price != null) {
    try {
      const promoBuf = await generatePromoImage(signalTicker, pricesData.gain_pct, pricesData.entry_price, pricesData.target_price);
      imageState.lastPromoImageBuffer = promoBuf;
      promoImageBase64 = promoBuf.toString('base64');
      console.log('[promo] Promo image generated for $' + signalTicker);
    } catch (err) {
      console.error('[promo] Promo image error:', err.message);
    }
  }

  try {
    const result = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        author: message.author.username,
        channel: channelName,
        signal_type: sendType,
        timestamp: message.createdAt.toISOString(),
        image_url: imageUrl,
        ticker: extractTicker(classifyContent),
        is_reply: isReply,
        parent_content: parentContent,
        parent_author: parentAuthor,
        promo_image_base64: promoImageBase64,
        ...pricesData
      }),
    });
    console.log('Sent to Make, status: ' + result.status);
  } catch (err) {
    console.error('Error sending to Make:', err.message);
  }
});

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

client.login(DISCORD_TOKEN);
