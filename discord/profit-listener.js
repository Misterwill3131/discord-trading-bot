// ─────────────────────────────────────────────────────────────────────
// discord/profit-listener.js — Compteur automatique sur le canal #profits
// ─────────────────────────────────────────────────────────────────────
// Écoute UNIQUEMENT PROFITS_CHANNEL_ID et classifie chaque message :
//
//   Priorité (stop au premier match) :
//     1. Filtre learned "blocked"   → ignoré (counted:false, reason:learned-blocked)
//     2. Filtre learned "allowed"   → compté (counted:true,  reason:learned-allowed)
//     3. Message avec image         → compté (reason:image)
//     4. Au moins un range de prix  → compté (reason:price range(s))
//     5. Au moins un ticker ($XXX)  → compté (reason:ticker)
//     6. Sinon                      → ignoré (reason:ignored)
//
// Tous les messages sont stockés dans profit-messages-YYYY-MM-DD.json
// (même ceux ignorés) pour que la page /profits review permette un
// feedback correctif (learned filters).
//
// Si `counted`, on incrémente aussi le compteur daily via addProfitMessage.
// ─────────────────────────────────────────────────────────────────────

const { detectTicker } = require('../utils/prices');
const profitCounter = require('../profit/counter');

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp)$/i;

// Calcule counted/reason à partir du contenu + présence d'image.
// Extrait en fonction pure pour la lisibilité (et testabilité future).
function classifyProfitMessage(content, hasImage) {
  if (profitCounter.profitFiltersMatch(profitCounter.profitFilters.blocked, content)) {
    return { counted: false, reason: 'learned-blocked' };
  }
  if (profitCounter.profitFiltersMatch(profitCounter.profitFilters.allowed, content)) {
    return { counted: true, reason: 'learned-allowed' };
  }
  if (hasImage) {
    return { counted: true, reason: 'image' };
  }
  if (profitCounter.countProfitEntries(content) > 0) {
    return { counted: true, reason: 'price range(s)' };
  }
  if (detectTicker(content)) {
    return { counted: true, reason: 'ticker' };
  }
  return { counted: false, reason: 'ignored' };
}

function registerProfitListener(client, { profitsChannelId }) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!profitsChannelId) return;
    if (message.channel.id !== profitsChannelId) return;

    // Discord a 2 façons d'exposer les pièces jointes images : content_type
    // (MIME) ou l'URL avec extension. On accepte les deux, + fallback sur
    // le nom du fichier pour les uploads sans content_type renseigné.
    const hasImage = message.attachments.some(a =>
      (a.contentType && a.contentType.startsWith('image/')) ||
      (a.url && IMAGE_EXT_RE.test(a.url)) ||
      (a.name && IMAGE_EXT_RE.test(a.name))
    );

    const content = message.content || '';
    const textCount = profitCounter.countProfitEntries(content);
    const hasTicker = !!detectTicker(content);
    const { counted, reason } = classifyProfitMessage(content, hasImage);

    // On stocke TOUS les messages (même ignorés) pour permettre le review
    // + feedback learned dans le dashboard /profits. Insert direct en DB
    // pour rester O(1) — pas de re-chargement de la liste journalière.
    profitCounter.appendProfitMessage({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      author: message.author.username,
      content,
      preview: content.length > profitCounter.PROFIT_PHRASE_MAX
        ? content.slice(0, profitCounter.PROFIT_PHRASE_MAX) + '…'
        : content,
      hasImage,
      hasTicker,
      textCount,
      counted,
      reason,
      feedback: null,
    });

    console.log('[profits] ' + reason + ' in #profits from ' + message.author.username + ' → counted=' + counted);

    if (counted) {
      // Calculer le nombre exact de profits selon la raison détectée
      // price ranges → count chaque range, sinon → 1 (image ou ticker seul)
      const profitCount = reason === 'price range(s)' ? textCount : 1;
      await profitCounter.addProfitMessage(content, profitCount);
    }
  });
}

module.exports = { registerProfitListener, classifyProfitMessage };
