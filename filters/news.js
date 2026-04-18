// ─────────────────────────────────────────────────────────────────────
// filters/news.js — Parsing RSS et filtrage d'actualité économique US
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures. Aucun état. Utilisées par le poller de news (qui lui
// est stateful et vit encore dans index.js).
//
// Exporte :
//   parseRssItems(xml, feed)     — XML RSS → [{title, link, pubDate, …}]
//   getNewsEmoji(title)          — emoji selon catégorie devinée
//   isNewsRelevant(item)         — whitelist/blacklist sur titre+desc
//   extractSource(title)         — "Reuters: xxx" → "Reuters"
//   NEWS_KEYWORDS                — whitelist (au moins un requis)
//   NEWS_BLOCKED                 — blacklist (rejet immédiat)
//   INDEX_VARIATION_REGEX        — bloque "Nasdaq drops 1.4%"
//
// Philosophie du filtre : on se concentre sur l'actualité qui BOUGE les
// marchés US (Fed, macro US, entreprises US, dollar, Trump & géopolitique
// pertinente pour les marchés). On exclut activement le bruit (sport,
// célébrités, banques centrales non-US, variations d'indices quotidiennes
// car redondantes).
// ─────────────────────────────────────────────────────────────────────

// Décode les entités HTML courantes trouvées dans les flux RSS.
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// Parse un XML RSS en items structurés. `feed.cleanTitle(raw)` permet à
// chaque flux d'appliquer son propre nettoyage de titre (préfixes, etc.).
function parseRssItems(xml, feed) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
      return m ? m[1].trim() : '';
    };
    const rawTitle = decodeEntities(get('title'));
    items.push({
      title: feed.cleanTitle(rawTitle),
      link: get('link'),
      pubDate: get('pubDate'),
      guid: get('guid') || get('link') || rawTitle.substring(0, 60),
      description: decodeEntities(get('description').replace(/<[^>]+>/g, '')).trim(),
      source: feed.name,
    });
  }
  return items;
}

// Retourne un emoji catégoriel. L'ordre compte : vérifications plus
// spécifiques d'abord (oil avant "market", crypto avant "currencies").
function getNewsEmoji(title) {
  const t = title.toLowerCase();
  if (/\b(oil|crude|wti|brent|opec|lng|natural gas|energy|petroleum)\b/.test(t)) return '🛢️';
  if (/\b(fed|fomc|powell|ecb|boj|boe|central bank|interest rate|rate cut|rate hike|treasury|treasuries)\b/.test(t)) return '🏦';
  if (/\b(bitcoin|btc|ethereum|eth|crypto|blockchain|coinbase|binance)\b/.test(t)) return '₿';
  if (/\b(gold|silver|copper|commodit)/i.test(t)) return '🥇';
  if (/\b(forex|dollar|usd|eur\/|gbp|jpy|dxy|currency|currencies)\b/.test(t)) return '💵';
  if (/\b(tariff|sanction|trade deal|embargo|geopolitic|war|military|missile|troops)\b/.test(t)) return '🌍';
  if (/\b(stock|s&p|spx|nasdaq|dow|earning|ipo|rally|market|index|nyse|sell.?off|bull|bear)\b/.test(t)) return '📈';
  return '📰';
}

// Whitelist : il faut au moins un de ces mots-clés (titre + description,
// lowercase) pour qu'un item soit considéré pertinent.
const NEWS_KEYWORDS = [
  // ─── Réserve fédérale & politique monétaire US ───
  'fed', 'federal reserve', 'fomc', 'powell', 'inflation', 'cpi', 'pce', 'ppi',
  'interest rate', 'rate cut', 'rate hike', 'rate decision',
  'quantitative', 'balance sheet', 'monetary policy',
  // ─── Macro-économie US ───
  'gdp', 'jobs report', 'nonfarm', 'payroll', 'unemployment', 'jobless claims',
  'pmi', 'ism', 'retail sales', 'consumer confidence', 'consumer sentiment',
  'housing starts', 'durable goods', 'trade balance', 'recession', 'soft landing',
  'stagflation', 'deficit', 'debt ceiling', 'credit rating', 'downgrade',
  // ─── Marchés US (indices & structure) ───
  'wall street', 'stock market', 'nyse', 'nasdaq', 's&p', 'spx', 'dow jones',
  'russell', 'circuit breaker', 'market halt', 'vix', 'volatility',
  'short squeeze', 'flash crash', 'margin call',
  // ─── Résultats d'entreprises ───
  'earnings', 'eps', 'revenue', 'guidance', 'outlook',
  'beats estimates', 'misses estimates', 'profit warning', 'ipo', 'buyback',
  'dividend', 'merger', 'acquisition', 'layoffs', 'restructuring',
  // ─── Grandes capitalisations US ───
  'tesla', 'apple', 'nvidia', 'amazon', 'google', 'alphabet', 'meta', 'microsoft',
  'berkshire', 'jpmorgan', 'goldman sachs', 'morgan stanley', 'blackrock',
  'exxon', 'chevron', 'palantir', 'openai', 'anthropic',
  // ─── Trésorerie US & obligations ───
  'treasury', 'yield', 't-bill', 'bond', '10-year', '2-year', 'yield curve',
  'spread', 'auction',
  // ─── Matières premières (impact direct économie US) ───
  'oil', 'crude', 'wti', 'brent', 'opec', 'gold', 'silver', 'copper',
  'natural gas', 'commodity',
  // ─── Crypto (marchés US) ───
  'bitcoin', 'btc', 'ethereum', 'crypto',
  // ─── Dollar US ───
  'dollar', 'dxy', 'usd',
  // ─── Politique US (impact économique) ───
  'trump', 'biden', 'white house', 'congress', 'senate',
  'executive order', 'government shutdown', 'legislation',
  // ─── Entourage & administration Trump ───
  'vance', 'musk', 'administration', 'maga', 'oval office',
  // ─── Politique commerciale US ───
  'tariff', 'trade war', 'trade deal', 'sanction', 'embargo', 'export ban',
  'chip ban', 'trade deficit',
  // ─── Sujets géopolitiques récurrents dans l'actu Trump ───
  // (Trump commente souvent ces dossiers ; on les garde pour ne pas
  // manquer ses déclarations qui déplacent les marchés US.)
  'iran', 'israel', 'ukraine', 'russia', 'china', 'putin', 'xi jinping',
  'netanyahu', 'middle east',
  // ─── Mentions US explicites ───
  'united states', 'u.s.', 'u.s ', 'american economy', 'american jobs',
];

// Blacklist : rejet même si un keyword whitelist est aussi présent.
const NEWS_BLOCKED = [
  // Sports & divertissement — bruit pur.
  'sport', 'football', 'soccer', 'basketball', 'nba', 'nfl', 'mlb', 'tennis',
  'olympic', 'fifa', 'world cup', 'celebrity', 'kardashian', 'hollywood',
  'movie', 'film', 'actor', 'actress', 'grammy', 'oscar', 'emmy',
  'entertainment', 'reality tv', 'concert', 'album', 'music', 'gaming',
  'video game', 'esport',
  // Banques centrales non-US — pertinent pour leurs marchés locaux mais
  // bruit pour un bot qui trade US. On laisse passer "Fed" via whitelist.
  'ecb', 'european central bank', 'lagarde',
  'boj', 'bank of japan', 'ueda',
  'boe', 'bank of england', 'bailey',
  'pboc', 'people\'s bank of china',
  'snb', 'swiss national bank',
  'rbnz', 'reserve bank of new zealand',
  'rba', 'reserve bank of australia',
];

// Bloque les titres de variation d'index quotidienne (ex: "Nasdaq drops
// 1.4%") — redondants avec les métriques live et ne donnent pas d'alpha.
const INDEX_VARIATION_REGEX = /\b(s&p\s*500?|spx|spy|qqq|nasdaq|dow\s*jones|dow|russell\s*2000?|nikkei|ftse|dax|cac\s*40?)\b.{0,40}(\bup\b|\bdown\b|\brises?\b|\bfalls?\b|\bgains?\b|\blosses?\b|\bslips?\b|\bclimbs?\b|\bdrops?\b|\bsurges?\b|\bplunges?\b|\badvances?\b|\bdeclines?\b|\btrims?\b|\bpares?\b|\bsheds?\b|\badds?\b|\bsinks?\b|\brallies\b|\bslumps?\b|\breadjust|\brebounds?\b)/i;

function isNewsRelevant(item) {
  const title = item.title || '';
  const text = (title + ' ' + (item.description || '')).toLowerCase();

  // 1. Variations d'index quotidiennes → bloqué.
  if (INDEX_VARIATION_REGEX.test(title)) return false;

  // 2. Blacklist → bloqué.
  for (const b of NEWS_BLOCKED) {
    if (text.includes(b.toLowerCase())) return false;
  }

  // 3. Whitelist — au moins un mot requis.
  for (const kw of NEWS_KEYWORDS) {
    if (text.includes(kw)) return true;
  }

  return false;
}

// Extrait un préfixe de source ("Reuters: xxx" → "Reuters"). Retourne
// null si aucun préfixe propre.
function extractSource(title) {
  const m = title.match(/^([^:]{3,50}):\s/);
  return m ? m[1].trim() : null;
}

module.exports = {
  parseRssItems,
  getNewsEmoji,
  isNewsRelevant,
  extractSource,
  NEWS_KEYWORDS,
  NEWS_BLOCKED,
  INDEX_VARIATION_REGEX,
};
