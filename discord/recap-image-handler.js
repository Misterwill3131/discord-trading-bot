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
    const match = candidatesAsc.find(m => {
      const c = String(m.content || '');
      // \b évite "1.43" matchant "1.434". On utilise un check char-bornes
      // simple — les content sont du texte libre, regex coûte.
      const idx = c.indexOf(v);
      if (idx === -1) return false;
      const before = idx === 0 ? ' ' : c[idx - 1];
      const after = idx + v.length >= c.length ? ' ' : c[idx + v.length];
      return !/[\d.]/.test(before) && !/\d/.test(after);
    });
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
async function buildAlertImagesBase64({
  maxAlerts = DEFAULT_MAX_ALERTS,
  trades = null,
  deps = {},
} = {}) {
  const _getMessagesByTsRange = deps.getMessagesByTsRange || getMessagesByTsRange;
  const _generateImage = deps.generateImage || generateImage;
  const dateKey = deps.dateKey || todayNyDateKey();
  const [startIso, endIso] = nyDateKeyToUtcRange(dateKey);

  let messages = [];
  try {
    messages = _getMessagesByTsRange(startIso, endIso) || [];
  } catch (err) {
    console.warn(`[recap-image-handler] DB query failed for ${dateKey}: ${err.message}`);
    return [];
  }

  // getMessagesByTsRange retourne DESC — on inverse pour ordre ASC (chronologique).
  const allEntriesAsc = messages.filter(m => m.type === 'entry').reverse();

  // Mode "récap" : per-trade matching → one alert per trade row, in
  // chronological order.
  let entryAlerts;
  if (Array.isArray(trades) && trades.length > 0) {
    const seenIds = new Set();
    const picked = [];
    for (const trade of trades) {
      const tNorm = normalizeTicker(trade && trade.ticker);
      if (!tNorm) continue;
      const candidates = allEntriesAsc.filter(m => normalizeTicker(m.ticker) === tNorm);
      const chosen = pickAlertForTrade(candidates, trade);
      if (!chosen) continue;
      // Dedupe : si le même message a été choisi pour 2 trades (ex: le call
      // mentionne plusieurs prix), on ne le rend qu'une fois.
      const key = chosen.id != null ? `id:${chosen.id}` : `ts:${chosen.ts}:${chosen.author}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      picked.push(chosen);
    }
    // Tri chronologique (la première à apparaître à l'écran = la + ancienne)
    picked.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    entryAlerts = picked.slice(0, maxAlerts);
  } else {
    // Legacy : toutes les entries du jour, capées à maxAlerts (plus anciennes en 1er).
    entryAlerts = allEntriesAsc.slice(0, maxAlerts);
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
  todayNyDateKey,
  nyDateKeyToUtcRange,
};
