// ─────────────────────────────────────────────────────────────────────
// news/poller.js — Poller RSS + diffusion Discord + SSE dashboard
// ─────────────────────────────────────────────────────────────────────
// Encapsule toute la logique "news feeds" :
//   • État interne (items vus, file des N dernières, clients SSE)
//   • Polling HTTP des flux RSS (FinancialJuice par défaut)
//   • Filtrage via filters/news (whitelist US + blacklist sport/BCE)
//   • Condensation "même minute" — édite le dernier message Discord au
//     lieu d'en créer un nouveau si on est dans la même minute calendaire
//   • Groupement par "source" (ex: "Powell:") pour lisibilité
//   • Broadcast SSE aux clients connectés sur /api/news-events
//
// Le module ne connaît pas Express : on expose `registerSSEClient(res)`
// pour que routes/news.js branche le flux HTTP sans avoir à exposer
// les structures internes.
//
// Exporte :
//   startPolling({ client, channelId })  — lance le poller (appelé au ready)
//   getRecentNews()                      — copie de l'état pour lecture
//   registerSSEClient(res)               — renvoie un unregister()
// ─────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const {
  parseRssItems,
  getNewsEmoji,
  isNewsRelevant,
  extractSource,
} = require('../filters/news');
const {
  insertNewsItem,
  getRecentNewsItems,
  trimNewsItems,
  purgeNewsOlderThan,
} = require('../db/sqlite');

// Rétention des news en DB. Au-delà, on DELETE même si on n'a pas
// atteint la limite de lignes — c'est une contrainte de fraîcheur
// (dashboard affiche du récent, pas une archive).
const NEWS_RETENTION_DAYS = 7;

// ── Configuration ────────────────────────────────────────────────────
const NEWS_FEEDS = [
  {
    name: 'FJ',
    url: 'https://www.financialjuice.com/feed.ashx?xy=rss',
    cleanTitle: t => t.replace(/^FinancialJuice:\s*/i, ''),
  },
];
const NEWS_POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes

// Certains feeds RSS renvoient 403 sans UA réaliste. On spoofe un Chrome
// stable pour éviter d'être traités en scraper.
const RSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
};

// Au-delà de ce seuil, on tronque les Set de déduplication (évite de
// garder en mémoire l'historique complet depuis le démarrage du bot).
const SEEN_CACHE_MAX = 1000;
const SEEN_CACHE_KEEP = 500;

// ── État interne (non exporté) ───────────────────────────────────────
const newsSeenGuids   = new Set();
const newsSeenTitles  = new Set();
// Purge au boot : si le bot a été éteint plusieurs jours, on nettoie
// les items devenus trop vieux avant de les charger en RAM.
try {
  const purged = purgeNewsOlderThan(NEWS_RETENTION_DAYS);
  if (purged > 0) console.log('[news] Purged ' + purged + ' items > ' + NEWS_RETENTION_DAYS + ' days at boot');
} catch (e) {
  console.error('[news] Boot purge failed:', e.message);
}
// Hydrate recentNews depuis la DB au boot — permet à /news et à !news
// d'afficher le fil immédiatement, sans attendre le prochain poll RSS.
// Les items DB viennent déjà triés DESC par ts — on garde le format tel quel.
const recentNews      = getRecentNewsItems(50);
const newsSSEClients  = []; // { res } — broadcast des nouveaux items
const newsInitialized = {}; // par feed : premier poll = seed seulement
// Fenêtre de condensation : si le poll suivant tombe dans la même minute
// calendaire que le précédent, on édite ce message au lieu d'en créer un
// nouveau. Évite le spam visuel quand plusieurs headlines arrivent en rafale.
let lastNewsMsg = null;
let lastNewsSentAt = null;

// Injectés via startPolling() — évite de passer client/channelId partout.
let _client = null;
let _channelId = null;

// ── Helpers exposés ──────────────────────────────────────────────────
function getRecentNews() {
  return recentNews;
}

function registerSSEClient(res) {
  const client = { res };
  newsSSEClients.push(client);
  return function unregister() {
    const idx = newsSSEClients.indexOf(client);
    if (idx >= 0) newsSSEClients.splice(idx, 1);
  };
}

// ── Logique de polling ───────────────────────────────────────────────
function addToRecentNews(item) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    ts: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    title: item.title,
    emoji: getNewsEmoji(item.title),
    source: item.source || 'FJ',
    link: item.link,
  };
  recentNews.unshift(entry);
  if (recentNews.length > 50) recentNews.pop();

  // Persiste en DB + purge items > NEWS_RETENTION_DAYS. Les erreurs ne
  // doivent pas bloquer le polling — on catch et log.
  try {
    insertNewsItem(entry);
    purgeNewsOlderThan(NEWS_RETENTION_DAYS);
  } catch (e) {
    console.error('[news] DB persist failed:', e.message);
  }

  // Broadcast aux clients SSE connectés (dashboard /news en temps réel).
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  newsSSEClients.forEach((c, i) => {
    try { c.res.write(payload); } catch (_) { newsSSEClients.splice(i, 1); }
  });
}

async function pollOneFeed(feed) {
  try {
    const res = await fetch(feed.url, { timeout: 15000, headers: RSS_HEADERS });
    if (!res.ok) {
      if (res.status === 429) console.error('[news][' + feed.name + '] Rate limited (429)');
      else console.error('[news][' + feed.name + '] Fetch failed:', res.status);
      return [];
    }
    const xml = await res.text();
    const items = parseRssItems(xml, feed);

    // Premier poll d'un feed : on marque tout comme déjà vu sans poster
    // (sinon on poste l'historique entier au démarrage du bot).
    if (!newsInitialized[feed.name]) {
      items.forEach(i => newsSeenGuids.add(feed.name + ':' + i.guid));
      newsInitialized[feed.name] = true;
      console.log('[news][' + feed.name + '] Initialized — ' + items.length + ' headlines marked as seen');
      return [];
    }

    // Déduplication par GUID + par titre (les titres se répètent parfois
    // avec un GUID différent, signe d'une republication).
    const newItems = items.filter(i => {
      const key = feed.name + ':' + i.guid;
      if (newsSeenGuids.has(key)) return false;
      if (newsSeenTitles.has(i.title)) return false;
      newsSeenGuids.add(key);
      newsSeenTitles.add(i.title);
      return true;
    }).reverse(); // reverse : les RSS listent du plus récent au plus ancien,
                  // on veut poster dans l'ordre chronologique.

    return newItems.filter(i => isNewsRelevant(i));
  } catch (e) {
    console.error('[news][' + feed.name + '] Error:', e.message);
    return [];
  }
}

// Groupe les headlines consécutives d'une même source (ex: "Powell:") pour
// un rendu compact "> • ligne 1 / > • ligne 2" dans Discord.
function groupBySource(items) {
  const groups = [];
  for (const item of items) {
    const src = extractSource(item.title);
    const last = groups.length ? groups[groups.length - 1] : null;
    if (src && last && last.source === src) {
      last.items.push(item);
    } else {
      groups.push({ source: src, items: [item] });
    }
  }
  return groups;
}

// Formate les groupes en lignes Markdown prêtes à poster.
function formatGroups(groups) {
  const lines = [];
  for (const g of groups) {
    if (g.source && g.items.length > 1) {
      const emoji = getNewsEmoji(g.items[0].title);
      lines.push(emoji + ' ' + g.source + ':');
      for (const item of g.items) {
        const text = item.title.replace(g.source + ': ', '').replace(g.source + ':', '').trim();
        lines.push('> • ' + text);
      }
    } else {
      for (const item of g.items) {
        lines.push(getNewsEmoji(item.title) + ' ' + item.title);
      }
    }
  }
  return lines;
}

// Découpe les lignes en chunks ≤ 2000 chars (limite Discord par message).
function chunkMessages(lines) {
  const combined = lines.join('\n');
  if (combined.length <= 2000) return [combined];

  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > 2000) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Tronque les Set de déduplication pour éviter la fuite mémoire en longue
// durée de vie (on garde les 500 derniers, on jette les plus anciens).
function trimSeenSets() {
  if (newsSeenGuids.size > SEEN_CACHE_MAX) {
    const arr = Array.from(newsSeenGuids);
    arr.splice(0, arr.length - SEEN_CACHE_KEEP);
    newsSeenGuids.clear();
    arr.forEach(g => newsSeenGuids.add(g));
  }
  if (newsSeenTitles.size > SEEN_CACHE_MAX) {
    const arr = Array.from(newsSeenTitles);
    arr.splice(0, arr.length - SEEN_CACHE_KEEP);
    newsSeenTitles.clear();
    arr.forEach(t => newsSeenTitles.add(t));
  }
}

async function pollAllNewsFeeds() {
  if (!_channelId) return;

  let allRelevant = [];
  for (const feed of NEWS_FEEDS) {
    const items = await pollOneFeed(feed);
    allRelevant = allRelevant.concat(items);
  }
  if (!allRelevant.length) return;

  // Propage au dashboard + SSE avant d'envoyer sur Discord.
  allRelevant.forEach(i => addToRecentNews(i));

  const channel = _client && _client.channels.cache.get(_channelId);
  if (!channel || !channel.send) {
    console.error('[news] Channel not found:', _channelId);
    return;
  }

  const groups = groupBySource(allRelevant);
  const lines = formatGroups(groups);
  const chunks = chunkMessages(lines);

  // Condensation : si on est dans la même minute que le dernier envoi et
  // qu'on tient en un seul chunk, on édite le message existant. Sinon on
  // envoie un nouveau message (fallback si l'édition échoue).
  const now = new Date();
  const sameMinute = lastNewsSentAt
    && now.getFullYear() === lastNewsSentAt.getFullYear()
    && now.getMonth()    === lastNewsSentAt.getMonth()
    && now.getDate()     === lastNewsSentAt.getDate()
    && now.getHours()    === lastNewsSentAt.getHours()
    && now.getMinutes()  === lastNewsSentAt.getMinutes();

  let merged = false;
  if (sameMinute && lastNewsMsg && chunks.length === 1) {
    const combinedContent = lastNewsMsg.content + '\n' + chunks[0];
    if (combinedContent.length <= 2000) {
      try {
        const edited = await lastNewsMsg.edit(combinedContent);
        lastNewsMsg = edited;
        lastNewsSentAt = now;
        merged = true;
        console.log('[news] Merged ' + allRelevant.length + ' headline(s) into existing message ' + lastNewsMsg.id);
      } catch (e) {
        console.error('[news] Edit failed, falling back to send:', e.message);
      }
    }
  }

  if (!merged) {
    for (const chunk of chunks) {
      try {
        const sent = await channel.send(chunk);
        lastNewsMsg = sent;
        lastNewsSentAt = new Date();
      } catch (e) {
        console.error('[news] Send error:', e.message);
      }
    }
    console.log('[news] Posted ' + allRelevant.length + ' headline(s) in ' + chunks.length + ' message(s)');
  }

  trimSeenSets();
}

// ── Point d'entrée ───────────────────────────────────────────────────
function startPolling({ client, channelId }) {
  if (!channelId) {
    console.log('[news] NEWS_CHANNEL_ID not set — news polling disabled');
    return;
  }
  _client = client;
  _channelId = channelId;
  console.log('[news] News feeds active — posting to channel ' + channelId);
  console.log('[news] Sources: ' + NEWS_FEEDS.map(f => f.name).join(', '));
  pollAllNewsFeeds();
  setInterval(pollAllNewsFeeds, NEWS_POLL_INTERVAL);
}

module.exports = {
  startPolling,
  getRecentNews,
  registerSSEClient,
};
