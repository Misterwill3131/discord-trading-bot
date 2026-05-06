// ─────────────────────────────────────────────────────────────────────
// discord/screener-ingest.js — Ingestion des 9 channels TrendVision
// ─────────────────────────────────────────────────────────────────────
// Le bot écoute en parallèle de la pipeline signal/passthrough/IPO
// existante. Chaque message d'un de ces 9 channels est :
//   1. mappé à une catégorie screener
//   2. parsé pour extraire un ticker (regex simple)
//   3. extrait du content + embeds Discord
//   4. inséré dans Postgres screener_alerts (table partagée avec le
//      site qui rendra /account/screener)
//
// Note importante : ces channels sont DISTINCTS de SOURCE_CHANNEL_IDS
// (qui drive le broadcast signal/passthrough). Donc le listener relay
// existant les ignore — pas de double-ingestion ni de broadcast vers
// les guilds clients.
// ─────────────────────────────────────────────────────────────────────

const pg = require('../db/postgres');

// ── Channel ID → catégorie ───────────────────────────────────────────
// Source de vérité : config envoyée par l'utilisateur. Ces IDs sont
// stables côté Discord, on peut les hardcoder. Pour ajouter/retirer
// un scanner, éditer cette table.
const CHANNEL_CATEGORY = {
  '1349050950253416511': { category: 'ipo',         name: 'ipo-scanner' },
  '1349051458900852771': { category: 'whale',       name: 'whale-scanner' },
  '1349046112815677480': { category: 'zero_borrow', name: 'zero-borrow' },
  '1349049340848640031': { category: 'volume',      name: 'volume-scanner' },
  '1349050802383097887': { category: 'all_in_one',  name: 'all-in-one' },
  '1349050584032088155': { category: 'squeeze',     name: 'squeeze-alerts' },
  '1349049762581839914': { category: 'halt',        name: 'halts-scanner' },
  '1349049895298007192': { category: 'social',      name: 'social-media' },
  '1349050898432655432': { category: 'tv_news',     name: 'tv-news' },
};

// ── Ticker extraction ────────────────────────────────────────────────
// Heuristique : un ticker US est 1-5 lettres MAJUSCULES, optionnellement
// préfixé d'un $. On préfère le 1er match dans le content texte ; si
// rien, on regarde dans le titre/description des embeds.
//
// Exclut les mots courants "anglais" qui matchent le pattern (TRUE,
// FALSE, NULL, etc.) — la même blacklist que celle utilisée dans
// saas/anonymize.js, gardée minimale ici puisque les channels scanners
// postent typiquement du contenu structuré.
const TICKER_REGEX = /\$?\b([A-Z]{1,5})\b/g;
const TICKER_BLACKLIST = new Set([
  // Articles / pronoms / prépositions courantes
  'A', 'I', 'AT', 'BE', 'BY', 'DO', 'GO', 'IF', 'IN', 'IS', 'IT', 'NO',
  'OF', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE', 'AS', 'AN', 'MY', 'HE',
  'THE', 'AND', 'BUT', 'NOT', 'NOW', 'WHO', 'WHY', 'HOW', 'CAN', 'WAS',
  'HAS', 'HAD', 'GET', 'GOT', 'PUT', 'BIG', 'NEW', 'ALL', 'TOP', 'OUT',
  'OFF', 'ARE', 'WAS', 'WHEN', 'WITH', 'WILL', 'THIS', 'THAT', 'FROM',
  'OVER', 'INTO', 'JUST', 'MUST', 'EACH', 'BEEN', 'BOTH', 'MORE', 'SOME',
  'SUCH', 'THEN', 'THEY', 'WERE', 'WHAT', 'WHEN', 'YOUR', 'HAVE', 'HERE',
  // Time / dates
  'AM', 'PM', 'ET', 'EST', 'EDT', 'PST', 'PDT', 'UTC', 'GMT',
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT',
  'NOV', 'DEC', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN',
  // Acronymes financiers / corporate non-tickers
  'CEO', 'CFO', 'COO', 'CTO', 'IPO', 'ETF', 'FED', 'SEC', 'IRS', 'GDP',
  'CPI', 'PMI', 'PCE', 'PPI', 'YOY', 'QOQ', 'MOM', 'EPS', 'PE', 'PEG',
  'TBD', 'FYI', 'TLDR', 'FAQ', 'PR', 'PA',
  // Devises
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD', 'INR',
  // Booléens / states
  'TRUE', 'FALSE', 'NULL', 'YES', 'NONE',
  // Modifiers numériques courants dans la finance
  'LOW', 'HIGH', 'MID', 'AVG', 'MAX', 'MIN', 'NET', 'EBIT', 'ROE',
]);

function extractTicker(text) {
  if (!text) return null;
  const matches = text.matchAll(TICKER_REGEX);
  for (const m of matches) {
    const ticker = m[1];
    if (TICKER_BLACKLIST.has(ticker)) continue;
    // Doit avoir au moins 1 lettre, max 5. Le regex assure déjà.
    return ticker;
  }
  return null;
}

// ── Embed serialization ──────────────────────────────────────────────
// Les scanners postent souvent leur info dans des embeds (title, desc,
// fields, image). On serialize en objet léger pour le stockage JSONB.
function serializeEmbeds(embeds) {
  if (!Array.isArray(embeds) || embeds.length === 0) return null;
  return embeds.map((e) => ({
    title: e.title || e.data?.title || null,
    description: e.description || e.data?.description || null,
    url: e.url || e.data?.url || null,
    color: e.color || e.data?.color || null,
    image: e.image?.url || e.data?.image?.url || null,
    thumbnail: e.thumbnail?.url || e.data?.thumbnail?.url || null,
    fields: Array.isArray(e.fields || e.data?.fields)
      ? (e.fields || e.data.fields).map((f) => ({
          name: f.name || '',
          value: f.value || '',
          inline: !!f.inline,
        }))
      : [],
  }));
}

// ── Handler principal ────────────────────────────────────────────────
// Appelé par le messageCreate listener installé dans index.js. Filter
// agressif : tout message hors des 9 channels mappés est ignoré
// instantanément.
async function ingestScreenerMessage(message) {
  if (!message || !message.channel) return;
  const channelId = String(message.channel.id);
  const meta = CHANNEL_CATEGORY[channelId];
  if (!meta) return;
  if (!pg.isEnabled) return;

  const content = (message.content || '').slice(0, 4000);
  const embedJson = serializeEmbeds(message.embeds);

  // Texte combiné pour l'extraction ticker : content + titres/desc des
  // embeds. Améliore le hit rate sur les channels qui postent en embed
  // (volume-scanner, whale-scanner, etc.).
  const embedText = embedJson
    ? embedJson
        .map((e) => `${e.title || ''} ${e.description || ''}`)
        .join(' ')
    : '';
  const ticker = extractTicker(`${content} ${embedText}`);

  await pg.insertScreenerAlert({
    sourceChannelId: channelId,
    sourceChannelName: meta.name,
    sourceMessageId: String(message.id),
    category: meta.category,
    ticker,
    content: content || null,
    embedJson,
  });
}

// ── Wire-up : enregistre le listener sur le client Discord ───────────
// `client` peut être clientSource (déjà dans le serveur source) ou
// le client principal — peu importe tant qu'il a accès aux 9 channels
// TrendVision. Le filter par channel ID dans ingestScreenerMessage
// rend l'enregistrement multi-client safe (no double-write grâce à
// ON CONFLICT DO NOTHING côté DB).
function register(client) {
  if (!client || typeof client.on !== 'function') {
    console.warn('[screener-ingest] no client passed, listener not registered');
    return;
  }
  client.on('messageCreate', (message) => {
    ingestScreenerMessage(message).catch((err) => {
      console.error('[screener-ingest] handler error:', err.message);
    });
  });
  console.log(
    `[screener-ingest] active — listening to ${Object.keys(CHANNEL_CATEGORY).length} channels`,
  );
}

module.exports = {
  register,
  ingestScreenerMessage, // exposé pour tests
  CHANNEL_CATEGORY,      // exposé pour tests + admin tooling
  extractTicker,         // exposé pour tests
  serializeEmbeds,       // exposé pour tests
};
