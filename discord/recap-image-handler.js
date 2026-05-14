// ─────────────────────────────────────────────────────────────────────
// discord/recap-image-handler.js — Auto-trigger TobTradeRecap depuis image
// ─────────────────────────────────────────────────────────────────────
// Quand un utilisateur poste une image dans le canal configuré via
// TOB_RECAP_IMAGE_CHANNEL_ID, on :
//   1. Récupère la première attachment image (PNG/JPEG/WebP/GIF)
//   2. La download localement (temp file) puis l'OCR via Claude Vision
//      (utils/parse-recap-image.js)
//   3. Enqueue un render_job composition='TobTradeRecap' avec recap_data
//      = JSON OCR + output_channel_id = même canal pour le retour MP4
//   4. Reply "🎬 Recap en cours…" pour feedback immédiat
//
// Le worker (video/scripts/render-worker.ts) poll la queue, render la
// composition TobTradeRecap, et POST le MP4 vers /api/render-queue/:id/done.
// Le handler render-queue (routes/render-queue.js) lit output_channel_id
// du job DB et poste le MP4 dans ce canal.
//
// Sécurité : pas de whitelist d'auteurs (le canal lui-même filtre — si
// l'admin ouvre la perm send messages à n'importe qui c'est son choix).
// Skip les bots pour éviter loop (le bot post le MP4 final dans le même
// canal après render).
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');

const { parseRecapImage } = require('../utils/parse-recap-image');
const { enqueueRenderJob, getMessagesByTsRange } = require('../db/sqlite');
const { generateImage } = require('../canvas/proof');

// Default 12 alertes : le feed-style scroll-up à ~8 visibles, on en montre
// 4 de plus qui scroll en haut. Plus que ça = phase trop longue.
const DEFAULT_MAX_ALERTS = parseInt(process.env.TOB_RECAP_MAX_ALERTS || '12', 10);

// Mode de génération des cartes pour la parade :
//   'synthetic' (default) : génère des Discord-cards à partir du tableau OCR.
//                            Pas de query DB, garanti que ça matche le récap.
//   'db-lookup'           : ancien comportement — cherche les messages dans
//                            la DB par ticker + prix. Sujet aux mismatches
//                            quand ZZ a posté des updates plutôt que des
//                            calls explicites avec le bon prix.
const ALERT_MODE = (process.env.TOB_RECAP_ALERT_MODE || 'synthetic').toLowerCase();

// Auteur affiché sur les cartes synthétiques. Surchargeable via env si
// quelqu'un d'autre relaie les signaux dans le futur.
const SYNTHETIC_AUTHOR = process.env.TOB_RECAP_SYNTHETIC_AUTHOR || 'ZZ';

// Format prix pour les cartes synthétiques. Pour les prix >= 1, on garde
// 2 décimales (ex: "1.43", "33.00") — c'est le style ZZ standard.
// Pour les sub-1, on strip les zéros traînants (0.440 → 0.44) pour matcher
// l'affichage du tableau OCR du récap.
function fmtPriceForCard(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1) return n.toFixed(2);
  const s = n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
  // Strip trailing zeros : "0.440" → "0.44", "0.0460" → "0.046"
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

const IMAGE_EXT_BY_CT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const IMAGE_EXT_FALLBACK = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// Détecte la 1ère attachment image dans un message Discord.js.
function pickImageAttachment(message) {
  if (!message.attachments || message.attachments.size === 0) return null;
  for (const att of message.attachments.values()) {
    const ct = (att.contentType || '').toLowerCase();
    if (ct.startsWith('image/')) return att;
    // Fallback : Discord ne renvoie pas toujours contentType. On regarde
    // l'extension du nom.
    const ext = path.extname(att.name || '').toLowerCase();
    if (IMAGE_EXT_FALLBACK.has(ext)) return att;
  }
  return null;
}

// Télécharge une URL Discord vers un temp file et retourne le path absolu.
async function downloadToTemp(url, contentType, originalName) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Discord CDN ${res.status} ${res.statusText}`);
  }
  const buf = await res.buffer();
  // Préfère l'extension du nom original, sinon utilise content-type.
  const fromName = path.extname(originalName || '').toLowerCase();
  const ext = IMAGE_EXT_FALLBACK.has(fromName)
    ? (fromName === '.jpeg' ? '.jpg' : fromName)
    : (IMAGE_EXT_BY_CT[(contentType || '').toLowerCase()] || '.png');
  const tmpPath = path.join(os.tmpdir(), `recap-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// Date courante en America/New_York au format YYYY-MM-DD.
function todayNyDateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// Décale une dateKey "YYYY-MM-DD" de N jours (positif ou négatif). Géré via
// Date.UTC pour que les bornes mois/année soient propres.
function addDaysToDateKey(key, days) {
  const [y, m, d] = String(key).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Convertit "YYYY-MM-DD" (date NY) en [startUtcIso, endUtcIso] couvrant
// minuit NY à minuit NY le lendemain.
//
// Pourquoi : les messages sont stockés en UTC (`new Date().toISOString()`),
// donc un substr(ts, 1, 10) sur la date NY ramènerait des messages de la
// veille soir (heures NY 20-24h) qui sont en UTC le jour suivant. Cette
// fonction calcule la vraie fenêtre 00h00 NY → 00h00 NY (next-day) en UTC,
// en tenant compte du DST EDT/EST.
function nyDateKeyToUtcRange(nyDateKey) {
  const [y, m, d] = nyDateKey.split('-').map(Number);
  // Probe à midi NY ce jour-là pour déterminer EDT (-4) vs EST (-5).
  // Midi est safely past tout shift DST qui peut se produire à 2 AM.
  const probeUtc = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).formatToParts(probeUtc);
  const tzName = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'EST';
  const offsetHours = tzName === 'EDT' ? 4 : 5;
  // 00h00 NY ce jour → UTC offsetHours
  const startIso = new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0)).toISOString();
  const endIso = new Date(Date.UTC(y, m - 1, d + 1, offsetHours, 0, 0)).toISOString();
  return [startIso, endIso];
}

// Normalise un ticker pour comparaison : majuscules + strip "$".
function normalizeTicker(t) {
  return String(t || '').toUpperCase().replace(/^\$+/, '');
}

// Variantes textuelles d'un prix pour le matching dans le content brut.
// Ex: 0.046 → ["0.046", ".046"]    1.43 → ["1.43"]   33 → ["33", "33.00"]
function priceVariants(price) {
  if (!Number.isFinite(price)) return [];
  const variants = new Set();
  // Canonique
  variants.add(String(price));
  // Sans leading zero pour < 1
  if (price < 1 && price > 0) {
    const s = String(price);
    if (s.startsWith('0.')) variants.add(s.slice(1));
  }
  // Variations fixed(2) et fixed(3) pour gérer "1.43" et "1.430"
  variants.add(price.toFixed(2));
  variants.add(price.toFixed(3));
  variants.add(price.toFixed(4));
  // Strip trailing zeros : "1.430" → "1.43"
  for (const v of [...variants]) {
    if (v.includes('.')) {
      variants.add(v.replace(/0+$/, '').replace(/\.$/, ''));
    }
  }
  return [...variants].filter(v => v && v.length >= 2);
}

// Vérifie qu'une chaîne `content` contient le prix `priceStr` avec des
// bornes propres (pas de chiffre/point juste avant ou de chiffre juste
// après). Évite "1.43" matchant "1.434".
function contentContainsPrice(content, priceStr) {
  const c = String(content || '');
  const idx = c.indexOf(priceStr);
  if (idx === -1) return false;
  const before = idx === 0 ? ' ' : c[idx - 1];
  const after = idx + priceStr.length >= c.length ? ' ' : c[idx + priceStr.length];
  return !/[\d.]/.test(before) && !/\d/.test(after);
}

// Pour un trade donné (ticker + entryPrice), trouve l'alerte la + pertinente
// parmi les candidats (entries du jour ce ticker, ordre ASC).
//
// Stratégie :
//   1. Si une candidate contient le prix d'entrée (texte) → return celle-là.
//      C'est l'appel d'entrée original (ex: ZZ "TDIC 1.43-3.19" pour
//      trade TDIC entry=1.43).
//   2. Sinon → la plus ancienne candidate du jour. Heuristique : le premier
//      message d'un ticker est généralement le call d'entrée plutôt que les
//      updates/target hits qui arrivent après.
function pickAlertForTrade(candidatesAsc, trade) {
  if (!candidatesAsc || candidatesAsc.length === 0) return null;
  const variants = priceVariants(trade.entryPrice);
  for (const v of variants) {
    const match = candidatesAsc.find(m => contentContainsPrice(m.content, v));
    if (match) return match;
  }
  // Fallback : la première (la plus ancienne) entry du jour pour ce ticker.
  return candidatesAsc[0];
}

// Génère les PNG base64 des alertes du jour pour le AlertsParadePhase.
// Renvoie `[]` si DB indispo, aucune alerte entry, ou canvas KO.
// `deps` permet de mocker getMessagesByTsRange/generateImage en test.
//
// `trades` (optionnel) = trades OCR du récap (array de {ticker, entryPrice, hodPrice}).
// Si fourni, on construit la parade en sélectionnant POUR CHAQUE TRADE
// l'alerte du jour qui matche au mieux (prix d'entrée présent dans le
// content, sinon la + ancienne pour ce ticker). Ça évite que la parade
// soit dominée par les target hits / updates qui arrivent après le call
// original.
//
// Si trades est vide/non fourni, toutes les entries du jour sont prises
// (comportement legacy).
// Génère N cartes Discord-style synthétiques (une par trade du récap).
// Pas de query DB. Chaque carte ressemble à un call ZZ standard :
//   author = "ZZ", content = "$TICKER ENTRY_PRICE🔥", ts staggered chrono.
//
// Garanti que chaque ligne du tableau OCR a sa carte dans la parade —
// supprime tous les mismatches dus aux updates/target hits/recaps absents.
async function buildSyntheticAlertImages(trades, deps = {}, maxAlerts = DEFAULT_MAX_ALERTS) {
  const _generateImage = deps.generateImage || generateImage;
  const author = deps.syntheticAuthor || SYNTHETIC_AUTHOR;
  const now = deps.now ? new Date(deps.now) : new Date();

  if (!Array.isArray(trades) || trades.length === 0) return [];

  // Auto-scale : une carte par ligne, même si on dépasse le default.
  const effectiveMax = Math.max(maxAlerts, trades.length);
  const slice = trades.slice(0, effectiveMax);

  const out = [];
  for (let i = 0; i < slice.length; i++) {
    const trade = slice[i];
    if (!trade || !trade.ticker) continue;
    const ticker = String(trade.ticker).replace(/^\$+/, '');
    const entryStr = fmtPriceForCard(trade.entryPrice);
    // Stagger 1 min : la 1ère carte = now - N min, la dernière = now - 1 min.
    // Donne une illusion de flow chronologique pendant la parade.
    const offsetMs = (slice.length - i) * 60_000;
    const ts = new Date(now.getTime() - offsetMs).toISOString();
    const content = entryStr ? `$${ticker} ${entryStr}🔥` : `$${ticker}🔥`;
    try {
      const buf = await _generateImage(author, content, ts, { scale: 2 });
      out.push({
        base64: buf.toString('base64'),
        ticker,
      });
    } catch (err) {
      console.warn(`[recap-image-handler] synthetic alert ${i + 1} render failed: ${err.message}`);
    }
  }
  return out;
}

async function buildAlertImagesBase64({
  maxAlerts = DEFAULT_MAX_ALERTS,
  trades = null,
  deps = {},
} = {}) {
  // Mode synthétique : génère les cartes directement depuis le récap OCR.
  // Default activé via env TOB_RECAP_ALERT_MODE. Ce mode est déterministe
  // et évite tous les bugs de matching DB (mauvais jour, mauvais message,
  // ticker manquant, etc.).
  const mode = deps.mode || ALERT_MODE;
  if (mode === 'synthetic') {
    return buildSyntheticAlertImages(trades, deps, maxAlerts);
  }

  // Mode legacy : DB lookup. Conservé pour rétrocompat ou si quelqu'un
  // veut vraiment les vrais messages Discord (au risque des mismatches).
  const _getMessagesByTsRange = deps.getMessagesByTsRange || getMessagesByTsRange;
  const _generateImage = deps.generateImage || generateImage;
  const today = deps.dateKey || todayNyDateKey();

  // Détection auto du jour pertinent : on query today ET yesterday (NY)
  // puis on prend le jour qui a le plus d'entries matchant les tickers du
  // récap. Couvre le cas typique où ZZ post le récap le lendemain matin
  // (la journée courante a 0 alerte pour les tickers d'hier, mais hier en
  // a plein).
  //
  // Si trades non fourni → mode legacy, juste today.
  const dateKeys = Array.isArray(trades) && trades.length > 0
    ? [today, addDaysToDateKey(today, -1)]
    : [today];

  // Fetch messages for each candidate date.
  const dayCandidates = [];
  for (const dk of dateKeys) {
    try {
      const [s, e] = nyDateKeyToUtcRange(dk);
      const msgs = _getMessagesByTsRange(s, e) || [];
      dayCandidates.push({ dk, entries: msgs.filter(m => m.type === 'entry') });
    } catch (err) {
      console.warn(`[recap-image-handler] DB query failed for ${dk}: ${err.message}`);
      dayCandidates.push({ dk, entries: [] });
    }
  }

  // Mode "récap" : per-trade matching → one alert per trade row, in
  // chronological order.
  let entryAlerts;
  if (Array.isArray(trades) && trades.length > 0) {
    // Score chaque jour : combien d'entries matchent les tickers du récap ?
    const recapSet = new Set(
      trades.map(t => normalizeTicker(t && t.ticker)).filter(Boolean)
    );
    const scored = dayCandidates.map(d => ({
      ...d,
      matchCount: d.entries.filter(e => recapSet.has(normalizeTicker(e.ticker))).length,
    }));
    // Pick le jour avec le plus de matches. En cas d'égalité, le premier
    // dans dateKeys gagne (= today préféré sur yesterday).
    const best = scored.reduce((a, b) => b.matchCount > a.matchCount ? b : a);
    if (best.matchCount === 0) {
      console.log('[recap-image-handler] no alert matches recap tickers in last 2 days → empty parade');
      return [];
    }
    if (best.dk !== today) {
      console.log(`[recap-image-handler] using ${best.dk} alerts (${best.matchCount} matches) instead of ${today} — recap appears to cover ${best.dk}`);
    }
    const allEntriesAsc = best.entries.slice().reverse();

    // Helper : clé d'identification d'un message pour le tracking "déjà
    // utilisé" (préfère m.id quand dispo, fallback sur ts+author).
    const msgKey = (m) => m.id != null ? `id:${m.id}` : `ts:${m.ts}:${m.author}`;

    // Pour chaque trade du récap, sélectionne UN message. Pour les tickers
    // dupliqués (ex: $LNKS 1.39 puis $LNKS 1.66) on préfère un message
    // différent pour chaque trade (= 2 cartes distinctes dans la parade)
    // mais si ZZ a tout posté en un seul call ("LNKS 1.39 to 1.66"), on
    // accepte de réutiliser le même message — mieux que de skip la ligne.
    const usedMessages = new Set();
    const picked = [];
    for (const trade of trades) {
      const tNorm = normalizeTicker(trade && trade.ticker);
      if (!tNorm) continue;
      const candidates = allEntriesAsc.filter(m => normalizeTicker(m.ticker) === tNorm);
      if (candidates.length === 0) continue;

      // Priorité 1 : un message NON-utilisé contenant le prix exact du trade.
      const variants = priceVariants(trade.entryPrice);
      let chosen = null;
      for (const v of variants) {
        chosen = candidates.find(m => !usedMessages.has(msgKey(m)) && contentContainsPrice(m.content, v));
        if (chosen) break;
      }
      // Priorité 2 : n'importe quel message non-utilisé pour ce ticker
      // (sans match prix → on prend le plus ancien).
      if (!chosen) {
        chosen = candidates.find(m => !usedMessages.has(msgKey(m))) || null;
      }
      // Priorité 3 : fallback complet — réutilise un message déjà pris
      // (mieux qu'un trou dans la parade pour des tickers dupliqués où
      // ZZ n'a fait qu'un seul call multi-prix).
      if (!chosen) {
        chosen = pickAlertForTrade(candidates, trade);
      }
      if (!chosen) continue;

      usedMessages.add(msgKey(chosen));
      picked.push(chosen);
    }
    // Tri chronologique (la première à apparaître à l'écran = la + ancienne)
    picked.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    // Cap : permet de monter au-delà du default si le récap a beaucoup
    // de trades — l'utilisateur veut une carte par ligne, on respecte.
    const effectiveMax = Math.max(maxAlerts, trades.length);
    entryAlerts = picked.slice(0, effectiveMax);
  } else {
    // Legacy : toutes les entries du jour (today seulement), capées à
    // maxAlerts (plus anciennes en 1er).
    const todayAsc = (dayCandidates[0] && dayCandidates[0].entries.slice().reverse()) || [];
    entryAlerts = todayAsc.slice(0, maxAlerts);
  }

  if (entryAlerts.length === 0) return [];

  const out = [];
  for (let i = 0; i < entryAlerts.length; i++) {
    const a = entryAlerts[i];
    try {
      const buf = await _generateImage(
        a.author || 'Unknown',
        a.content || '',
        a.ts,
        { scale: 2 },
      );
      out.push({
        base64: buf.toString('base64'),
        ticker: a.ticker || null,
      });
    } catch (err) {
      console.warn(`[recap-image-handler] alert ${i + 1} render failed: ${err.message}`);
    }
  }
  return out;
}

// Construit le payload `enqueueRenderJob` pour un TobTradeRecap.
// Les champs NOT NULL hérités (entry_*/exit_*/pnl) sont remplis avec des
// placeholders descriptifs — le worker les ignore pour cette composition,
// il lit recap_data uniquement.
function buildRecapJobPayload({ ocrResult, alertImagesBase64, authorName, messageCreatedAt, outputChannelId }) {
  const tsIso = (messageCreatedAt instanceof Date ? messageCreatedAt : new Date(messageCreatedAt)).toISOString();
  const dateLabel = ocrResult.dateLabel || 'TODAY';
  const tradesCount = (ocrResult.trades || []).length;
  return {
    ticker: 'TOB-RECAP',
    entry_author: authorName || 'unknown',
    entry_message: `OCR recap image (${tradesCount} trades, ${dateLabel})`,
    entry_ts: tsIso,
    exit_author: authorName || 'unknown',
    exit_message: `Recap auto-triggered from image`,
    exit_ts: tsIso,
    pnl: dateLabel,
    composition: 'TobTradeRecap',
    template_name: 'trade-recap-default',
    recap_data: JSON.stringify({
      dateLabel: ocrResult.dateLabel,
      trades: ocrResult.trades,
      longTermInvestments: ocrResult.longTermInvestments || [],
      alertImagesBase64: alertImagesBase64 || [],
    }),
    output_channel_id: outputChannelId,
  };
}

// Handler stateless qu'on peut tester sans Discord (deps injectées).
// Retourne { skipped, reason } ou { enqueued, jobId, tradesCount }.
async function handleRecapImageMessage({ message, channelId, deps = {} }) {
  const _parseRecapImage = deps.parseRecapImage || parseRecapImage;
  const _enqueueRenderJob = deps.enqueueRenderJob || enqueueRenderJob;
  const _downloadToTemp = deps.downloadToTemp || downloadToTemp;
  const _buildAlertImagesBase64 = deps.buildAlertImagesBase64 || buildAlertImagesBase64;
  const _unlink = deps.unlink || ((p) => { try { fs.unlinkSync(p); } catch {} });

  if (!channelId) return { skipped: true, reason: 'channel_not_configured' };
  if (message.author && message.author.bot) return { skipped: true, reason: 'author_is_bot' };
  if (message.channel && message.channel.id !== channelId) return { skipped: true, reason: 'wrong_channel' };

  const attachment = pickImageAttachment(message);
  if (!attachment) return { skipped: true, reason: 'no_image_attachment' };

  let tmpPath = null;
  try {
    tmpPath = await _downloadToTemp(attachment.url, attachment.contentType, attachment.name);

    const ocrResult = await _parseRecapImage(tmpPath);

    if (!ocrResult.trades || ocrResult.trades.length === 0) {
      return { skipped: true, reason: 'ocr_no_trades' };
    }

    // Génère les PNG des alertes du jour (DB query + canvas render).
    // On passe les trades du récap OCR — buildAlertImagesBase64 fait du
    // per-trade matching : pour chaque trade, sélectionne l'alerte du
    // jour dont le content contient le prix d'entrée (= appel original),
    // fallback à la + ancienne pour le ticker sinon. Évite que la parade
    // soit submergée par des target hits / updates postés après les calls.
    // Erreurs absorbed — on enqueue quand même, alertImages=[] est OK
    // (la composition affiche un fallback).
    const alertImagesBase64 = await _buildAlertImagesBase64({
      trades: ocrResult.trades || [],
      deps,
    }).catch(err => {
      console.warn(`[recap-image-handler] alert images failed: ${err.message}`);
      return [];
    });

    const jobId = _enqueueRenderJob(buildRecapJobPayload({
      ocrResult,
      alertImagesBase64,
      authorName: message.author ? message.author.username : null,
      messageCreatedAt: message.createdAt || new Date(),
      outputChannelId: channelId,
    }));

    return {
      enqueued: true,
      jobId,
      tradesCount: ocrResult.trades.length,
      longTermCount: (ocrResult.longTermInvestments || []).length,
      alertImagesCount: alertImagesBase64.length,
    };
  } finally {
    if (tmpPath) _unlink(tmpPath);
  }
}

// Enregistre le listener Discord. `channelId` est lu depuis env var ou
// passé directement (option pour les tests).
function registerRecapImageHandler(client, { channelId } = {}) {
  const target = channelId || process.env.TOB_RECAP_IMAGE_CHANNEL_ID || null;
  if (!target) {
    console.log('[recap-image-handler] TOB_RECAP_IMAGE_CHANNEL_ID non configuré — handler désactivé');
    return;
  }
  console.log(`[recap-image-handler] Listening on channel ${target}`);

  client.on('messageCreate', async (message) => {
    try {
      if (!message.channel || message.channel.id !== target) return;
      if (message.author && message.author.bot) return;
      const attachment = pickImageAttachment(message);
      if (!attachment) return;

      const ack = await message.reply('🎬 Recap image detected — running OCR + rendering, sit tight…').catch(() => null);

      const result = await handleRecapImageMessage({ message, channelId: target });

      if (result.skipped) {
        console.log(`[recap-image-handler] Skipped: ${result.reason}`);
        if (ack && result.reason === 'ocr_no_trades') {
          await ack.edit('⚠ OCR didn\'t find any trade rows in that image — make sure it\'s the full recap table.').catch(() => {});
        }
        return;
      }

      console.log(`[recap-image-handler] Enqueued job #${result.jobId} (${result.tradesCount} trades, ${result.longTermCount} long-term, ${result.alertImagesCount} alerts)`);
      if (ack) {
        const ltSuffix = result.longTermCount > 0 ? ` + ${result.longTermCount} long-term` : '';
        const alertSuffix = result.alertImagesCount > 0 ? `, ${result.alertImagesCount} alerts` : '';
        await ack.edit(`✅ Recap queued — ${result.tradesCount} trades${ltSuffix}${alertSuffix}. Render job #${result.jobId} on the way.`).catch(() => {});
      }
    } catch (err) {
      console.error('[recap-image-handler] error:', err);
      try {
        await message.reply(`❌ Recap render failed: ${err.message}`);
      } catch {}
    }
  });
}

module.exports = {
  registerRecapImageHandler,
  handleRecapImageMessage,
  pickImageAttachment,
  buildRecapJobPayload,
  buildAlertImagesBase64,
  buildSyntheticAlertImages,
  todayNyDateKey,
  nyDateKeyToUtcRange,
  addDaysToDateKey,
};
