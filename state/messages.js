// ─────────────────────────────────────────────────────────────────────
// state/messages.js — Journal des messages Discord + broadcast SSE
// ─────────────────────────────────────────────────────────────────────
// Depuis la migration SQLite, la source de vérité est `db/sqlite.js`
// (fichier boom.db dans DATA_DIR). Ce module garde en mémoire un CACHE
// des `MAX_LOG` messages les plus récents pour :
//
//   • broadcast SSE instant (pas de query à chaque nouveau msg)
//   • lecture rapide par /api/messages, !top, !stats, sendDailySummary,
//     findOriginalAlert (évite un round-trip DB pour les messages chauds)
//
// Le cache `messageLog` est une référence stable (même array tout le
// long). `logEvent` l'invalide pas — il push en tête et pop le plus
// ancien si on dépasse MAX_LOG.
//
// Pour des queries historiques (au-delà de MAX_LOG ou avec filtres
// complexes), utiliser db/sqlite.js directement.
//
// IMPORTANT : ne PAS faire `const { messageLog } = require(...)`
// puis `messageLog = [...]` — ça réassigne la const locale sans toucher
// au module. Toutes les mutations passent par logEvent() OU par
// mutation en place de l'array (push/filter/etc.).
// ─────────────────────────────────────────────────────────────────────

const { MAX_LOG } = require('../utils/persistence');
const { insertMessage, getRecentMessages } = require('../db/sqlite');

// Boot : hydrate le cache depuis la DB (les MAX_LOG plus récents).
// Plus besoin de `loadInitialMessages()` qui lisait le fichier du jour.
const messageLog = getRecentMessages(MAX_LOG);
const sseClients = [];

// Construit une Entry canonique à partir des params + options.
// Exposée pour les tests mais normalement appelée uniquement depuis logEvent.
function buildEntry(author, channel, content, signalType, reason, extra) {
  const ex = extra || {};
  return {
    id:      Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ts:      new Date().toISOString(),
    author,
    channel,
    content: content || '',
    preview: content && content.length > 120 ? content.slice(0, 120) + '…' : (content || ''),
    passed:  signalType !== null,
    type:    signalType,
    reason,
    confidence:  ex.confidence  != null ? ex.confidence  : null,
    ticker:      ex.ticker      != null ? ex.ticker      : null,
    entry_price: ex.entry_price != null ? ex.entry_price : null,
    isReply:       ex.isReply || false,
    parentPreview: ex.parentPreview || null,
    parentAuthor:  ex.parentAuthor || null,
  };
}

// Log un événement : persiste en DB + met à jour le cache + broadcast SSE.
// L'ordre est DB first → cache → SSE : si la DB crash on n'a pas un
// cache incohérent avec ce qui est servi aux clients.
//
// signalType est null pour les messages filtrés (passed:false).
function logEvent(author, channel, content, signalType, reason, extra) {
  const entry = buildEntry(author, channel, content, signalType, reason, extra);

  // Persist d'abord — source de vérité.
  try {
    insertMessage(entry);
  } catch (e) {
    console.error('[logEvent] DB insert failed:', e.message);
    // On continue même si l'INSERT échoue : le cache + SSE fonctionnent
    // encore, seule la persistence est perdue pour cet event.
  }

  // Puis met à jour le cache (tête DESC, cap MAX_LOG).
  messageLog.unshift(entry);
  if (messageLog.length > MAX_LOG) messageLog.pop();

  // Enfin broadcast SSE aux clients connectés.
  // On itère en reverse pour retirer proprement les clients morts sans
  // décaler les indices des vivants.
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].res.write(payload);
    } catch (_) {
      sseClients.splice(i, 1);
    }
  }
}

// Ajoute un client SSE à la liste de broadcast. Retourne une fonction
// d'unregister à appeler sur `req.on('close', ...)` pour éviter les fuites.
function registerSSEClient(res) {
  const client = { res };
  sseClients.push(client);
  return function unregister() {
    const idx = sseClients.indexOf(client);
    if (idx !== -1) sseClients.splice(idx, 1);
  };
}

module.exports = {
  messageLog,
  sseClients,
  logEvent,
  registerSSEClient,
};
