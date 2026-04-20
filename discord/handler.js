// ─────────────────────────────────────────────────────────────────────
// discord/handler.js — Handler messageCreate pour le canal de trading
// ─────────────────────────────────────────────────────────────────────
// Orchestre TOUT le flow d'un message dans TRADING_CHANNEL :
//
//   1. Filtre canal + auteurs (BLOCKED_AUTHORS hardcodé + customFilters)
//   2. !top / !stats TICKER  (commandes scopées au canal de trading)
//   3. Détection de réponse (fetch parent + fusion contenu pour classify)
//   4. classifySignal → log event (passed ou filtré)
//   5. Génération image (signal ou proof si reply)
//   6. Auto proof image pour les recaps (entry < target) :
//        - cherche l'alerte originale dans messageLog + fichiers disque
//        - génère + poste dans le salon
//   7. Promo image 1080×1080 pour signaux complets (ticker + entry + target)
//   8. POST vers Make.com (webhook externe pour l'automation)
//
// Beaucoup de dépendances — c'est le cœur du bot. On les importe toutes
// en haut pour que le handler lui-même reste lisible.
//
// Les helpers (handleTopCommand, handleStatsCommand, findOriginalAlert,
// sendToMakeWebhook) sont extraits en fonctions pour éviter un énorme
// bloc de 250 lignes imbriquées.
// ─────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const { BLOCKED_AUTHORS, getDisplayName } = require('../utils/authors');
const { extractPrices, extractTicker } = require('../utils/prices');
const { classifySignal } = require('../filters/signal');
const { getMessagesByTicker } = require('../db/sqlite');
const { customFilters } = require('../state/custom-filters');
const { messageLog, logEvent } = require('../state/messages');
const { generateImage, generateProofImage } = require('../canvas/proof');
const { generatePromoImage } = require('../canvas/promo');
const imageState = require('../state/images');

// ── !top : 3 auteurs avec le plus de signaux acceptés aujourd'hui ───
async function handleTopCommand(message) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayMsgs = messageLog.filter(m => m.passed && new Date(m.ts) >= midnight);

  const authorMap = {};
  todayMsgs.forEach(m => {
    if (m.author) authorMap[m.author] = (authorMap[m.author] || 0) + 1;
  });
  const top = Object.keys(authorMap)
    .map(k => [k, authorMap[k]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const dateStr = new Date().toISOString().slice(0, 10);
  const medals = ['1.', '2.', '3.'];
  const lines = ['**🏆 Top Analysts — ' + dateStr + '**'];
  if (!top.length) {
    lines.push('> No accepted signals today');
  } else {
    top.forEach((t, i) => {
      lines.push('> ' + medals[i] + ' **' + t[0] + '** — ' + t[1] + ' signal' + (t[1] > 1 ? 's' : ''));
    });
  }
  try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!top]', e.message); }
}

// ── !stats TICKER : stats du jour sur un symbole précis ─────────────
async function handleStatsCommand(message, ticker) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayMsgs = messageLog.filter(m =>
    new Date(m.ts) >= midnight && m.ticker && m.ticker.toUpperCase() === ticker
  );
  const total = todayMsgs.length;
  const accepted = todayMsgs.filter(m => m.passed).length;
  const filtered = total - accepted;

  // Regroupement par display name canonique + exclusion des auteurs bloqués
  // (pour afficher "Z (5)" au lieu de "traderzz1m (3), ZZ (2)").
  const authorMap = {};
  todayMsgs.filter(m => m.passed).forEach(m => {
    if (!m.author || BLOCKED_AUTHORS.has(String(m.author).toLowerCase())) return;
    const key = getDisplayName(m.author);
    authorMap[key] = (authorMap[key] || 0) + 1;
  });
  const topAuthors = Object.keys(authorMap)
    .map(k => k + ' (' + authorMap[k] + ')')
    .sort((a, b) => authorMap[b.split(' ')[0]] - authorMap[a.split(' ')[0]]);
  const authorStr = topAuthors.length ? topAuthors.join(', ') : 'Aucun';

  const lines = [
    '**📈 Stats $' + ticker + ' — aujourd\'hui**',
    '> Signaux : ' + total,
    '> Acceptés : ' + accepted + ' | Filtrés : ' + filtered,
    '> Auteurs : ' + authorStr,
  ];
  try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!stats]', e.message); }
}

// ── Recherche de l'alerte originale pour un recap ───────────────────
// Priorité 1 : si c'est une réponse Discord, on prend le message parent.
// Priorité 2 : single query DB via l'index (ticker, ts), on retient le
// premier message passed antérieur au recap (getMessagesByTicker trie DESC).
function findOriginalAlert({ signalTicker, messageCreatedAt, isReply, parentContent, parentAuthor }) {
  if (isReply && parentContent && parentAuthor) {
    return { author: parentAuthor, content: parentContent, ts: null };
  }

  const sinceIso = new Date(messageCreatedAt.getTime() - 30 * 86400000).toISOString();
  const rows = getMessagesByTicker(signalTicker.toUpperCase(), sinceIso);
  // rows est triée DESC par ts → le premier `passed` antérieur au recap
  // est bien le dernier signal d'entrée le plus récent.
  const found = rows.find(m =>
    m.passed && m.id !== undefined && new Date(m.ts) < messageCreatedAt
  );
  if (!found) return null;
  return {
    author: found.author,
    content: found.content || found.preview || '',
    ts: found.ts,
  };
}

// ── POST vers Make.com (pas bloquant — on catch et on log) ──────────
async function sendToMakeWebhook(makeWebhookUrl, payload) {
  if (!makeWebhookUrl) return;
  try {
    const result = await fetch(makeWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log('Sent to Make, status: ' + result.status);
  } catch (err) {
    console.error('Error sending to Make:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Handler principal — enregistre le listener sur client.on('messageCreate')
// ─────────────────────────────────────────────────────────────────────
function registerTradingHandler(client, { tradingChannel, railwayUrl, makeWebhookUrl, tradingEngine }) {
  client.on('messageCreate', async (message) => {
    // Bots OK uniquement s'ils viennent d'un webhook (Make, bridge, etc).
    if (message.author.bot && !message.webhookId) return;

    const channelName = message.channel.name || '';
    console.log('Message received - channel: "' + channelName + '", author: ' + message.author.username);
    if (!channelName.includes(tradingChannel)) return;

    const content = message.content;
    const authorName = message.author.username;

    // ── Commandes scopées au canal de trading ─────────────────────────
    if (content.trim() === '!top') {
      await handleTopCommand(message);
      return;
    }
    const statsMatch = content.trim().match(/^!stats\s+([A-Z$]{1,7})/i);
    if (statsMatch) {
      const ticker = statsMatch[1].replace('$', '').toUpperCase();
      await handleStatsCommand(message, ticker);
      return;
    }

    // ── Filtre par auteur ─────────────────────────────────────────────
    // BLOCKED_AUTHORS (hardcodé) : drop silencieux, pas de logEvent — ces
    // auteurs ne doivent JAMAIS apparaître dans le dashboard/stats.
    // customFilters.blockedAuthors (UI) : logué avec reason 'Auteur bloqué'
    // pour que l'utilisateur voie que son filtre a bien matché.
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

    // ── Détection de réponse + enrichissement ─────────────────────────
    let parentContent = null;
    let parentAuthor = null;
    let isReply = false;

    if (message.reference && message.reference.messageId) {
      try {
        const parentMsg = await message.channel.messages.fetch(message.reference.messageId);
        parentContent = parentMsg.content || '';
        parentAuthor = (parentMsg.author && parentMsg.author.username) || null;
        isReply = true;
        console.log('[REPLY] Parent: ' + parentContent.substring(0, 60));
      } catch (e) {
        console.warn('[REPLY] Could not fetch parent message:', e.message);
      }
    }

    // Pour la classification, on fusionne parent + reply : si quelqu'un
    // répond "3.43-4.32" à un message "$TSLA entry 3", la réponse seule
    // n'a ni ticker ni contexte — le parent donne les deux.
    const classifyContent = isReply && parentContent
      ? parentContent + ' ' + content
      : content;

    const extra = {
      isReply,
      parentPreview: parentContent
        ? (parentContent.length > 80 ? parentContent.slice(0, 80) + '…' : parentContent)
        : null,
      parentAuthor,
    };

    // ── Classification + logging ─────────────────────────────────────
    // On passe `replyBody` (le contenu du reply seul, pas mergé) pour que
    // le classifier détecte un exit si le reply contient "targets done" /
    // "SL hit" / etc. — sinon le parent (entrée d'origine) matcherait
    // ENTRY_KEYWORDS en premier et on perdrait la nature clôture du reply.
    const result = classifySignal(classifyContent, customFilters, {
      replyBody: isReply ? content : null,
    });
    const filterType = result.type;
    const filterReason = result.reason;
    const signalConfidence = result.confidence;
    const signalTicker = result.ticker;

    const pricesForLog = extractPrices(classifyContent);
    const extraWithSignal = Object.assign({}, extra, {
      confidence: signalConfidence,
      ticker: signalTicker,
      entry_price: pricesForLog.entry_price != null ? pricesForLog.entry_price : null,
    });

    if (!filterType && !authorAllowed) {
      // Filtré ET auteur non autorisé → bloqué (mais logué pour les stats).
      console.log('Filtered (' + filterReason + '): ' + content.substring(0, 80));
      logEvent(authorName, channelName, content, null, filterReason, extraWithSignal);
      return;
    }

    if (!filterType && authorAllowed) {
      // Contenu filtré MAIS auteur whitelisted : on logue passed:false
      // (pour des stats honnêtes) et on continue pour envoyer l'image.
      console.log('[AUTHOR ALLOWED bypass] ' + authorName + ': ' + content.substring(0, 60));
      logEvent(authorName, channelName, content, null, 'Auteur autorise (contenu filtre)', extraWithSignal);
    } else {
      logEvent(authorName, channelName, content, filterType, filterReason, extraWithSignal);
    }

    // ── Trading engine hook (entries: classifier said 'entry' + full signal) ──
    if (tradingEngine && filterType === 'entry' && signalTicker) {
      if (pricesForLog.entry_price != null && pricesForLog.target_price != null) {
        tradingEngine.onEntry({
          ticker: signalTicker.toUpperCase(),
          entry_price: pricesForLog.entry_price,
          target_price: pricesForLog.target_price,
          author: authorName,
          raw_content: content,
          ts: message.createdAt.toISOString(),
        }).catch(err => console.error('[trading] onEntry error:', err.message));
      } else {
        // Entry signal but missing entry or target price → engine requires both.
        console.log('[trading] $' + signalTicker + ' ENTRY signal skipped — missing '
          + (pricesForLog.entry_price == null ? 'entry_price ' : '')
          + (pricesForLog.target_price == null ? 'target_price' : '')
          + ' (content: ' + content.slice(0, 80) + ')');
      }
    }

    // ── Trading engine hook (exits: classifier said 'exit' + ticker) ──
    // Author-match check lives inside engine.onExit.
    if (tradingEngine && filterType === 'exit' && signalTicker) {
      tradingEngine.onExit({
        ticker: signalTicker.toUpperCase(),
        author: authorName,
        content,
      }).catch(err => console.error('[trading] onExit error:', err.message));
    }

    const sendType = filterType || 'neutral';
    console.log('[' + sendType.toUpperCase() + ']' + (isReply ? ' [REPLY]' : '') + ' ' + content);

    // ── Génération image (signal ou proof si c'est une reply) ────────
    let imageUrl = null;
    try {
      const imgBuf = (isReply && parentAuthor)
        ? await generateProofImage(
            parentAuthor, parentContent || '', null,
            message.author.username, content, message.createdAt.toISOString()
          )
        : await generateImage(message.author.username, content, message.createdAt.toISOString());

      imageState.lastImageBuffer = imgBuf;
      imageState.lastImageId = Date.now();
      imageState.addToGallery('signal', signalTicker, authorName, imgBuf);
      imageUrl = railwayUrl + '/image/latest?t=' + imageState.lastImageId;
      console.log('Image generated, URL: ' + imageUrl);
    } catch (err) {
      console.error('Image generation error:', err.message);
    }

    // ── Auto proof image pour les recaps (exit > entry = profit) ────
    const recapPrices = extractPrices(classifyContent);
    const isRecap = signalTicker
      && recapPrices.entry_price !== null
      && recapPrices.target_price !== null
      && recapPrices.target_price > recapPrices.entry_price;

    if (isRecap) {
      try {
        const originalAlert = findOriginalAlert({
          signalTicker,
          messageCreatedAt: message.createdAt,
          isReply, parentContent, parentAuthor,
        });

        if (originalAlert) {
          console.log('[proof] Generating proof image for $' + signalTicker + ' — original by ' + originalAlert.author);
          const proofBuf = await generateProofImage(
            originalAlert.author, originalAlert.content, originalAlert.ts,
            message.author.username, content, message.createdAt.toISOString()
          );
          imageState.addToGallery('proof', signalTicker, authorName, proofBuf);
          // Poste directement l'image dans le canal (pas via webhook).
          await message.channel.send({
            files: [{ attachment: proofBuf, name: 'proof-' + signalTicker.toLowerCase() + '.png' }],
          });
          console.log('[proof] Proof image posted for $' + signalTicker);
        } else {
          console.log('[proof] No original alert found for $' + signalTicker);
        }
      } catch (err) {
        console.error('[proof] Error generating proof image:', err.message);
      }
    }

    // ── Promo image 1080×1080 pour signaux complets ──────────────────
    const pricesData = extractPrices(classifyContent);
    let promoImageBase64 = null;
    if (signalTicker && pricesData.entry_price != null && pricesData.target_price != null) {
      try {
        const promoBuf = await generatePromoImage(
          signalTicker, pricesData.gain_pct, pricesData.entry_price, pricesData.target_price
        );
        imageState.lastPromoImageBuffer = promoBuf;
        promoImageBase64 = promoBuf.toString('base64');
        console.log('[promo] Promo image generated for $' + signalTicker);
      } catch (err) {
        console.error('[promo] Promo image error:', err.message);
      }
    }

    // ── Webhook Make.com (automation externe) ────────────────────────
    await sendToMakeWebhook(makeWebhookUrl, {
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
      ...pricesData,
    });
  });
}

module.exports = {
  registerTradingHandler,
  // Exports pour tests éventuels ou réutilisation par d'autres handlers.
  handleTopCommand,
  handleStatsCommand,
  findOriginalAlert,
};
