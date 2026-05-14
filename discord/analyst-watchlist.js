// ─────────────────────────────────────────────────────────────────────
// discord/analyst-watchlist.js — Listener event-driven
// ─────────────────────────────────────────────────────────────────────
// Écoute le canal TRADING_CHANNEL et :
//  1. Stocke TOUS les messages (analystes + bots) dans tracked_messages
//     pour audit.
//  2. Si non-bot ET ticker détecté → seed analyst_watchlist avec le prix
//     mentionné dans le message (ou le prix marché FMP en fallback).
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

// Hook FMP injecté pour les tests (par défaut : aucun, le caller injectera
// via register()). Pas de require global du client réel ici — il a besoin
// d'une apiKey runtime.
async function handleMessage(message, { marketClient = null } = {}) {
  if (!message || !message.channel || !message.author) return;
  if (!channelMatches(message.channel.name)) return;

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

  // ── Seeding watchlist : non-bot ET ticker détecté ────────────────
  if (message.author.bot) return;
  if (!ticker) return;

  let initialPrice = messagePrice;
  let priceSource = 'message';
  if (initialPrice == null) {
    if (!marketClient || typeof marketClient.getQuote !== 'function') return;
    try {
      const quote = await marketClient.getQuote(ticker);
      initialPrice = (quote && Number.isFinite(quote.price)) ? quote.price : null;
      priceSource = 'market';
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

module.exports = {
  extractPrice,
  serializeEmbeds,
  handleMessage,
};
