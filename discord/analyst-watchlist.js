// ─────────────────────────────────────────────────────────────────────
// discord/analyst-watchlist.js — Listener event-driven
// ─────────────────────────────────────────────────────────────────────
// Écoute le canal TRADING_CHANNEL et :
//  1. Stocke TOUS les messages (analystes + bots) dans tracked_messages
//     pour audit.
//  2. Si auteur non-blocklisté ET ticker détecté → seed analyst_watchlist
//     avec le prix mentionné dans le message (ou le prix marché FMP en
//     fallback).
//
// Filtre d'auteur : env var ANALYST_AUTHOR_BLOCKLIST (CSV de username,
// tag `Name#1234`, ou ID Discord 17+ chars). Par défaut vide = capture
// tout le monde, humains + bots. Utile pour exclure les bots de feedback
// (modération, recap) ou des humains qu'on ne veut pas dans la watchlist.
//
// La 1ère mention d'un ticker gagne (INSERT OR IGNORE sur PK ticker).
// Le module milestone-checker.js consomme cette table via le cron 30 min.
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const { extractTicker } = require('./screener-ingest');

// Regex prix : $XX, $XX.XX, $X,XXX.XX (avec virgules de milliers).
// Prend le PREMIER match — convention "prix d'entrée" si plage donnée.
// Le lookahead (?!\d) interdit un chiffre trailing : empêche un partial-match
// de "$200000" en "$2000" (cap à 4 chiffres avant la virgule).
const PRICE_REGEX = /\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)(?!\d)/;

function extractPrice(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = text.match(PRICE_REGEX);
  if (!m) return null;
  const price = parseFloat(m[1].replace(/,/g, ''));
  // Sanity range : 0 < prix < 100,000 (bornes exclues).
  // Filtre les faux positifs (codes ZIP, années en $, prix BTC pris pour stock).
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000) return null;
  return price;
}

// Sérialise les embeds Discord en JSON léger pour stockage. Mirror du
// pattern utilisé dans screener-ingest.js (même format, donc analyses
// cross-table possibles plus tard).
function serializeEmbeds(embeds) {
  if (!Array.isArray(embeds) || embeds.length === 0) return null;
  return embeds.map((e) => ({
    title:       e.title       || e.data?.title       || null,
    description: e.description || e.data?.description || null,
    url:         e.url         || e.data?.url         || null,
    color:       e.color       || e.data?.color       || null,
    image:       e.image?.url     || e.data?.image?.url     || null,
    thumbnail:   e.thumbnail?.url || e.data?.thumbnail?.url || null,
    fields: Array.isArray(e.fields || e.data?.fields)
      ? (e.fields || e.data.fields).map((f) => ({
          name:   f.name   || '',
          value:  f.value  || '',
          inline: !!f.inline,
        }))
      : [],
  }));
}

// Combine content + textes d'embeds pour maximiser le hit rate du
// ticker/price extractor (les bots TrendVision postent souvent en embed).
function combinedSearchText(message) {
  const content = message.content || '';
  const embedJson = serializeEmbeds(message.embeds);
  const embedText = embedJson
    ? embedJson.map(e => (e.title || '') + ' ' + (e.description || '')).join(' ')
    : '';
  return { text: content + ' ' + embedText, embedJson };
}

// Le filtre channel utilise le même pattern que le bot trading existant
// (substring match) — donc pas de nouvelle env var de canal à gérer.
function channelMatches(channelName) {
  if (typeof channelName !== 'string' || channelName.length === 0) return false;
  const target = (process.env.TRADING_CHANNEL || 'trading-floor').toLowerCase();
  return channelName.toLowerCase().includes(target);
}

// Parse une CSV de noms/tags/IDs d'auteurs à filtrer du seeding watchlist.
// Format de chaque entry :
//   - "Username"           → match case-insensitive sur message.author.username
//   - "Username#1234"      → match sur le tag complet (legacy + bots Discord)
//   - "1234567890..."      → 17+ digits → traité comme user ID Discord
// Espaces autour des entries ignorés. Vide si env var absente/vide.
function parseAuthorBlocklist(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Retourne true si l'auteur du message est dans la blocklist. La comparaison
// est case-insensitive sur username et tag. Les entries purement numériques
// (≥17 chars) sont matchées contre l'ID Discord.
function isBlockedAuthor(author, blocklist) {
  if (!author || !Array.isArray(blocklist) || blocklist.length === 0) return false;
  const username = (author.username || '').toLowerCase();
  const tag      = (author.tag || '').toLowerCase();
  const id       = String(author.id || '');
  for (const entry of blocklist) {
    const e = entry.toLowerCase();
    if (/^\d{17,}$/.test(entry) && entry === id) return true;
    if (e === username) return true;
    if (e === tag)      return true;
  }
  return false;
}

// Hook FMP injecté pour les tests (par défaut : aucun, le caller injectera
// via register()). Pas de require global du client réel ici — il a besoin
// d'une apiKey runtime.
async function handleMessage(message, { marketClient = null, authorBlocklist = null } = {}) {
  if (!message || !message.channel || !message.author) return;
  if (!channelMatches(message.channel.name)) return;
  // Resolve blocklist : option (tests) > env var (prod). On le parse une fois
  // par message ici car register() ne passe pas explicitement la liste —
  // l'env var lookup est ~free.
  const blocklist = Array.isArray(authorBlocklist)
    ? authorBlocklist
    : parseAuthorBlocklist(process.env.ANALYST_AUTHOR_BLOCKLIST);

  const { text, embedJson } = combinedSearchText(message);
  const content = (message.content || '').slice(0, 4000);
  const ticker = extractTicker(text);
  const messagePrice = extractPrice(text);

  // Audit : stocke TOUT, analystes + bots.
  db.insertTrackedMessage({
    messageId:       String(message.id),
    channelId:       String(message.channel.id),
    authorId:        String(message.author.id),
    authorUsername:  message.author.username || null,
    isBot:           message.author.bot ? 1 : 0,
    content,
    embedJson:       embedJson ? JSON.stringify(embedJson) : null,
    extractedTicker: ticker,
    extractedPrice:  messagePrice,
    createdAt:       Number(message.createdTimestamp) || Date.now(),
  });

  // ── Seeding watchlist : auteur non-blocklisté ET ticker détecté ──
  // Avant : on filtrait TOUS les bots (`if (message.author.bot) return;`),
  // ce qui rejetait ~70% du signal en jetant les relais TrendVision et
  // autres bots analystes. Maintenant on capture tout sauf ce qui est
  // explicitement listé dans ANALYST_AUTHOR_BLOCKLIST.
  if (isBlockedAuthor(message.author, blocklist)) return;
  if (!ticker) return;

  let initialPrice = messagePrice;
  let priceSource = 'message';
  if (initialPrice == null) {
    if (!marketClient || typeof marketClient.getQuote !== 'function') return;
    try {
      const quote = await marketClient.getQuote(ticker);
      const p = quote && Number.isFinite(quote.price) ? quote.price : null;
      // Apply the same sanity range as extractPrice: prevents seeding with
      // 0 (halted/delisted tickers) which would cause div-by-zero downstream
      // in milestone-checker. Same upper bound to be consistent.
      if (p != null && p > 0 && p < 100_000) {
        initialPrice = p;
        priceSource = 'market';
      }
    } catch (err) {
      console.warn('[analyst-watchlist] market fetch failed for ' + ticker
        + ': ' + (err.message || err));
      return;
    }
  }
  if (initialPrice == null) return;

  db.insertWatchlistEntry({
    ticker,
    initialPrice,
    initialPriceSource:  priceSource,
    sourceMessageId:     String(message.id),
    sourceChannelId:     String(message.channel.id),
    mentionedByUserId:   String(message.author.id),
    mentionedByUsername: message.author.username || null,
    firstSeenAt:         Number(message.createdTimestamp) || Date.now(),
  });
}

// Wire-up : enregistre le listener messageCreate. Le client FMP est créé
// ici (1 fois par process) à partir de FMP_API_KEY. Si la key est absente,
// on log et on continue sans fallback marché — l'extraction de prix
// depuis le message reste fonctionnelle.
function register(client) {
  if (!client || typeof client.on !== 'function') {
    console.warn('[analyst-watchlist] no client passed, listener not registered');
    return;
  }

  let marketClient = null;
  const apiKey = process.env.FMP_API_KEY || '';
  if (apiKey) {
    try {
      const { createFmpClient } = require('./fmp-client');
      marketClient = createFmpClient({ apiKey });
    } catch (err) {
      console.error('[analyst-watchlist] FMP init failed: ' + err.message);
    }
  } else {
    console.warn('[analyst-watchlist] FMP_API_KEY empty — message-price-only mode');
  }

  client.on('messageCreate', (msg) => {
    handleMessage(msg, { marketClient }).catch((err) =>
      console.error('[analyst-watchlist] handler error: ' + err.message)
    );
  });
  console.log('[analyst-watchlist] listener registered (channel substring: '
    + (process.env.TRADING_CHANNEL || 'trading-floor') + ')');
}

module.exports = {
  extractPrice,
  serializeEmbeds,
  handleMessage,
  register,
  // exposed for tests
  parseAuthorBlocklist,
  isBlockedAuthor,
};
