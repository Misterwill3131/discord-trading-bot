// ─────────────────────────────────────────────────────────────────────
// state/messages.js — Journal des messages Discord + broadcast SSE
// ─────────────────────────────────────────────────────────────────────
// Cœur de l'état runtime :
//   • messageLog  — Array<Entry> (max MAX_LOG) des messages récents. Tri
//                   DESC (plus récent en tête). Persisté dans les
//                   fichiers journaliers messages-YYYY-MM-DD.json à
//                   chaque logEvent.
//   • sseClients  — clients connectés à /api/events pour recevoir les
//                   events en temps réel (dashboard).
//
// Le handler Discord appelle logEvent() à chaque message qu'il traite
// (accepté ou filtré). Les routes API (messages, export-csv) lisent
// messageLog. Les routes SSE utilisent registerSSEClient().
//
// Champs d'une Entry :
//   id, ts, author, channel, content, preview, passed, type, reason,
//   confidence, ticker, entry_price, isReply, parentPreview, parentAuthor
//
// IMPORTANT : ne PAS faire `const { messageLog } = require(...)`
// puis `messageLog = [...]` — ça réassigne la const locale sans toucher
// au module. Toutes les mutations passent par les méthodes exportées
// OU par mutation en place de l'array (push/filter/etc.).
// ─────────────────────────────────────────────────────────────────────

const { MAX_LOG, loadInitialMessages, saveTodayMessages } = require('../utils/persistence');

const messageLog = loadInitialMessages();
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

// Log un événement : ajoute en tête de messageLog, cap à MAX_LOG,
// persiste sur disque, broadcast aux clients SSE.
//
// signalType est null pour les messages filtrés (passed:false).
function logEvent(author, channel, content, signalType, reason, extra) {
  const entry = buildEntry(author, channel, content, signalType, reason, extra);
  messageLog.unshift(entry);
  if (messageLog.length > MAX_LOG) messageLog.pop();
  saveTodayMessages(messageLog);

  // Broadcast aux SSE : on itère en reverse pour retirer proprement les
  // clients morts sans décaler les indices des vivants.
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
