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
const { extractPrices, extractTicker, stripDiscordMeta, extractPnl, computePnlString } = require('../utils/prices');
const { classifySignal } = require('../filters/signal');
const { getMessagesByTicker, enqueueRenderJob, tryClaimRecapDate, setRecapRenderJobId } = require('../db/sqlite');
const { parseRecap } = require('../utils/parse-recap');
const { pickTemplate } = require('../utils/template-dispatcher');
const { pickTease, parsePnlNumeric } = require('../utils/pick-tease');

// Floor en % en-dessous duquel on ne génère PAS de proof video.
// Décision business : trop petit = pas worth the render time + dilue le brand.
// Configurable via env si tu veux tuner sans code change.
const PROOF_PCT_FLOOR = parseFloat(process.env.PROOF_PCT_FLOOR || '20');
const { customFilters } = require('../state/custom-filters');
const { messageLog, logEvent } = require('../state/messages');
const { generateImage, generateProofImage, generateProofImageVertical } = require('../canvas/proof');
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
  const authorStr = topAuthors.length ? topAuthors.join(', ') : 'None';

  const lines = [
    '**📈 Stats $' + ticker + ' — Today**',
    '> Signals: ' + total,
    '> Accepted: ' + accepted + ' | Filtered: ' + filtered,
    '> Authors: ' + authorStr,
  ];
  try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!stats]', e.message); }
}

// ── Recherche de l'alerte originale pour un recap ───────────────────
// Priorité 1 : si c'est une réponse Discord, on prend le message parent.
// Priorité 2 : single query DB via l'index (ticker, ts), on retient le
// premier message qui ressemble à un VRAI entry signal antérieur au recap.
//
// Critères stricts (évite les mentions casuelles type "look at $RXT" qui
// matchaient avant et nous donnaient un mauvais entry author) :
//   - m.passed === true (filtre signal a accepté)
//   - m.type === 'entry' (classifié comme entry, pas exit/neutral/recap)
//   - m.entry_price !== null (un prix d'entrée a été extrait du message,
//     preuve qu'il y a un setup chiffré, pas juste une mention de ticker)
//
// getMessagesByTicker trie DESC par ts → le premier match est le plus récent.
function findOriginalAlert({ signalTicker, messageCreatedAt, isReply, parentContent, parentAuthor }) {
  if (isReply && parentContent && parentAuthor) {
    return { author: parentAuthor, content: parentContent, ts: null };
  }

  const sinceIso = new Date(messageCreatedAt.getTime() - 30 * 86400000).toISOString();
  const rows = getMessagesByTicker(signalTicker.toUpperCase(), sinceIso);
  const found = rows.find(m =>
    m.passed && m.id !== undefined &&
    m.type === 'entry' &&
    m.entry_price !== null && m.entry_price !== undefined &&
    new Date(m.ts) < messageCreatedAt
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

// Phase 3 — quand un exit gagnant arrive avec une entrée matchable,
// enqueue un job pour que le worker local rende la proof video.
async function maybeEnqueueProofRender({
  filterType, signalTicker, pnl, originalAlert,
  authorName, content, messageCreatedAt,
}) {
  if (filterType !== 'exit') return;
  if (!originalAlert) return;
  if (!originalAlert.ts) return;        // skip replies sans parent ts
  if (!pnl || pnl.startsWith('-')) return;  // pnl manquant ou négatif

  // Floor PnL : skip les petits gains (< PROOF_PCT_FLOOR %). Décision business :
  // les vidéos sous 20% diluent l'impact / coûtent du render time pour peu
  // de valeur marketing. Configurable via env PROOF_PCT_FLOOR.
  const pnlNum = parsePnlNumeric(pnl);
  if (pnlNum !== null && pnlNum < PROOF_PCT_FLOOR) {
    console.log(`[render-queue] $${signalTicker} ${pnl} skipped — below ${PROOF_PCT_FLOOR}% floor`);
    return;
  }

  // Génère l'image proof canvas (entry+exit Discord-styled, role pills,
  // emojis custom, etc.). Stockée en base64 pour que le worker l'embed
  // dans la vidéo Remotion. Si la génération échoue, on enqueue quand
  // même (le worker fallback sur les Discord cards Remotion natives).
  let proofImageBase64 = null;
  try {
    // Layout horizontal compact (reference bar + reply arrow + main message),
    // sharp 2x pour la vidéo (1480×~260 natif). Affiché comme une "receipt"
    // band centrée dans la vidéo. generateProofImageVertical existe aussi
    // pour un layout portrait empilé mais on préfère cette version compacte.
    const proofBuf = await generateProofImage(
      originalAlert.author, originalAlert.content, originalAlert.ts,
      authorName, content, messageCreatedAt.toISOString(),
      { scale: 2 }
    );
    proofImageBase64 = proofBuf.toString('base64');
  } catch (err) {
    console.warn('[render-queue] proof image generation failed (fallback cards):', err.message);
  }

  // Choisit le template Remotion selon le PnL (gold-celebration pour
  // gros wins, classic-green sinon). Le worker chargera templates/<name>
  // et mergera ses props + props dynamiques du job.
  const templateName = pickTemplate({
    pnl,
    ticker: signalTicker,
    entryAuthor: originalAlert.author,
  });

  // Picker contextuel pour le tease text (action verb + subtext). Pool dans
  // video/messages/contexts.json. Seedé sur ticker+exitTs pour reproductibilité
  // (re-render du même item → même phrase).
  const tease = pickTease({
    type: 'proof',
    pnl,
    seed: `${signalTicker}-${messageCreatedAt.toISOString()}`,
  });

  try {
    enqueueRenderJob({
      ticker: signalTicker,
      // Resolve les usernames Discord raw vers les display names canoniques
      // (ex: 'traderzz1m' → 'ZZ') AVANT le storage. Ainsi le worker, le
      // canvas, les captions et le proof video utilisent tous le même nom propre.
      entry_author: getDisplayName(originalAlert.author),
      entry_message: originalAlert.content,
      entry_ts: originalAlert.ts,
      exit_author: getDisplayName(authorName),
      exit_message: content,
      exit_ts: messageCreatedAt.toISOString(),
      pnl,
      proof_image_base64: proofImageBase64,
      template_name: templateName,
      tease_action: tease ? tease.teaseAction : null,
      tease_subtext: tease ? tease.teaseSubtext : null,
    });
    console.log(`[render-queue] enqueued ${signalTicker} ${pnl} → template '${templateName}', tease ctx '${tease ? tease.context : 'none'}'`);
  } catch (err) {
    console.error('[render-queue] enqueue failed:', err.message);
  }
}

// Phase Recap — quand un message "RECAP:" arrive d'un auteur whitelisté,
// parse les tickers + enqueue un BoomRecap render job. Idempotent :
// max 1 recap par jour (TZ NY) via daily_recaps.date PRIMARY KEY.
//
// Retourne { enqueued: bool, reason?: string, jobId?: number }
async function maybeEnqueueRecap({
  authorName, content, messageCreatedAt, messageId,
  authorWhitelist,
}) {
  // 1. Auteur whitelist
  const whitelistLower = (authorWhitelist || []).map(s => s.toLowerCase());
  if (!whitelistLower.includes((authorName || '').toLowerCase())) {
    return { enqueued: false, reason: 'author_not_whitelisted' };
  }

  // 2. Parse le contenu
  const parsed = parseRecap(content, messageCreatedAt);
  if (!parsed) {
    return { enqueued: false, reason: 'parse_failed' };
  }

  // 3. Idempotence par date — INSERT OR IGNORE retourne false si déjà claim
  const claimed = tryClaimRecapDate(parsed.date, messageId, parsed.tickers.length);
  if (!claimed) {
    return { enqueued: false, reason: 'already_claimed' };
  }

  // 4. Enqueue render job. ticker='RECAP' (placeholder pas significatif),
  //    entry_*/exit_* dupliqués vers le top ticker (le worker ignore tout
  //    ça pour BoomRecap, il lit recap_data à la place).
  const topTicker = parsed.tickers[0].ticker;
  const tsIso = messageCreatedAt.toISOString();
  try {
    const jobId = enqueueRenderJob({
      ticker: 'RECAP',
      entry_author: authorName,
      entry_message: `RECAP for ${parsed.date}`,
      entry_ts: tsIso,
      exit_author: authorName,
      exit_message: `${parsed.tickers.length} wins, ${parsed.runnersHit ?? '?'}/${parsed.runnersTotal ?? '?'} runners`,
      exit_ts: tsIso,
      pnl: `+${Math.round(parsed.totalGainPct)}%`,
      composition: 'BoomRecap',
      template_name: 'recap-default',
      recap_data: JSON.stringify(parsed),
    });
    setRecapRenderJobId(parsed.date, jobId);
    console.log(`[recap] detected for ${parsed.date}, enqueued render_job #${jobId} (${parsed.tickers.length} tickers, top=$${topTicker} +${parsed.tickers[0].gainPct}%)`);
    return { enqueued: true, jobId };
  } catch (err) {
    console.error('[recap] enqueue failed:', err.message);
    return { enqueued: false, reason: 'enqueue_error' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Email formatting pour les alertes d'analystes
// ─────────────────────────────────────────────────────────────────────
// Le corps de l'email est l'image générée par generateImage() (la même
// que celle postée dans le canal Discord). Le message texte ci-dessous
// sert UNIQUEMENT pour le subject + le fallback texte. Le préfixe 📥
// est requis par le filtre de createEmailNotifier.
function formatAnalystEntryEmail({ authorName, signalTicker, entryPx }) {
  const ticker = '$' + signalTicker.toUpperCase();
  const priceStr = entryPx != null ? String(entryPx) : '—';
  return '📥 ' + ticker + ' entry ' + priceStr + ' (' + authorName + ')';
}

// ─────────────────────────────────────────────────────────────────────
// Handler principal — enregistre le listener sur client.on('messageCreate')
// ─────────────────────────────────────────────────────────────────────
function registerTradingHandler(client, { tradingChannel, railwayUrl, makeWebhookUrl, tradingEngine, sendEmailAlert }) {
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

    // ── Recap auto : si "RECAP:" + auteur whitelisted, render auto ────
    // Idempotent par date NY (max 1×/jour). Ne consume pas le message,
    // on continue le flow normal après si pas matché.
    const recapWhitelist = (process.env.RECAP_AUTHOR_WHITELIST || 'ZZ')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const recapResult = await maybeEnqueueRecap({
      authorName,
      content,
      messageCreatedAt: message.createdAt,
      messageId: message.id,
      authorWhitelist: recapWhitelist,
    });
    if (recapResult.enqueued) {
      // Recap matché et enqueued — log déjà fait dans maybeEnqueueRecap.
      // On ne return PAS car le recap n'est pas un signal trading mais le
      // message n'a pas non plus de signification trading (pas un signal
      // ni un exit). Le flow classifySignal va run et probablement skip.
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
    // Strip les métadonnées Discord (mentions, emojis, "Replying to X")
    // avant la classification — évite que "Replying to ZZ" fasse détecter
    // "ZZ" comme ticker au lieu du vrai ticker plus loin dans le message.
    const cleanContent = stripDiscordMeta(content);
    const cleanParent = isReply && parentContent ? stripDiscordMeta(parentContent) : null;
    const classifyContent = cleanParent
      ? cleanParent + ' ' + cleanContent
      : cleanContent;

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
      let entryPx = pricesForLog.entry_price;
      let targetPx = pricesForLog.target_price;
      let stopPx = pricesForLog.stop_price;

      // Heuristique : si l'entry est sub-dollar mais le stop est un entier
      // à 2+ chiffres, l'utilisateur a probablement écrit "43" pour "0.43"
      // (raccourci courant dans les chats trading). On normalise /100.
      if (stopPx != null && entryPx != null && entryPx < 1 && Number.isInteger(stopPx) && stopPx > 10) {
        const normalized = stopPx / 100;
        console.log('[trading] $' + signalTicker + ' stop normalized ' + stopPx + ' → ' + normalized + ' (sub-dollar entry heuristic)');
        stopPx = normalized;
      }

      // Target absent mais stop connu → on le dérive d'un ratio 2:1.
      // Ex: entry=0.46, stop=0.43 → risque=0.03, target=0.46+2*0.03=0.52.
      if (entryPx != null && targetPx == null && stopPx != null && stopPx < entryPx) {
        const risk = entryPx - stopPx;
        targetPx = entryPx + 2 * risk;
        console.log('[trading] $' + signalTicker + ' target derived (2:1 R:R) from stop: '
          + targetPx.toFixed(4) + ' (entry=' + entryPx + ', stop=' + stopPx + ')');
      }

      // Target reste optionnel — en mode 'trail-only' il n'est pas envoyé
      // à IBKR (seul le trailing stop sert de sortie). L'engine vérifie
      // la validité selon le mode config.
      if (entryPx != null) {
        tradingEngine.onEntry({
          ticker: signalTicker.toUpperCase(),
          entry_price: entryPx,
          target_price: targetPx,   // peut être null → engine décide
          author: authorName,
          raw_content: content,
          ts: message.createdAt.toISOString(),
        }).catch(err => console.error('[trading] onEntry error:', err.message));
      } else {
        console.log('[trading] $' + signalTicker + ' ENTRY signal skipped — no entry_price found'
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
    // imgBuf est capturé dans un scope externe pour pouvoir être réutilisé
    // par l'email alert plus bas (corps inline = même image que Discord).
    let imageUrl = null;
    let imgBuf = null;
    try {
      imgBuf = (isReply && parentAuthor)
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

    // ── Email alert sur entries originales (non-reply) des analystes ─
    // Le corps de l'email est l'image générée ci-dessus (inline). Si la
    // génération a échoué (imgBuf null), on envoie quand même l'email
    // avec le subject seul — fallback texte. sendEmailAlert filtre sur
    // le préfixe 📥 et no-op si les env vars Resend manquent. Async +
    // throw-safe — fire & forget.
    if (sendEmailAlert && filterType === 'entry' && signalTicker && !isReply) {
      const emailMsg = formatAnalystEntryEmail({
        authorName,
        signalTicker,
        entryPx: pricesForLog.entry_price,
      });
      sendEmailAlert(emailMsg, imgBuf ? { imageBuffer: imgBuf } : undefined);
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

    // ── Phase 3 : enqueue render job pour exit gagnant matchable ─────
    // Indépendant du recap heuristic : on filtre sur filterType==='exit'
    // + pnl explicite positif. Le worker local poll render_jobs.
    if (filterType === 'exit' && signalTicker) {
      const exitOriginalAlert = findOriginalAlert({
        signalTicker,
        messageCreatedAt: message.createdAt,
        isReply, parentContent, parentAuthor,
      });
      // computePnlString : multi-fallback (explicite +X%, "up X%",
      // "locked in X%", range "X-Y" calculé). Permet d'auto-render des
      // exits comme "MNTS 4.7-5.59 so far" qui n'ont pas de "+X%" explicite.
      await maybeEnqueueProofRender({
        filterType,
        signalTicker,
        pnl: computePnlString(content),
        originalAlert: exitOriginalAlert,
        authorName: message.author.username,
        content,
        messageCreatedAt: message.createdAt,
      });
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
  formatAnalystEntryEmail,
  maybeEnqueueProofRender,
  maybeEnqueueRecap,
};
