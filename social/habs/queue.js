// ─────────────────────────────────────────────────────────────────────
// social/habs/queue.js — Habs enqueue API
// ─────────────────────────────────────────────────────────────────────
// Une seule fonction publique : enqueueRecap. Appelée par
// discord/recap-image-handler.js après un OCR success.
//
// Dedup atomique via le UNIQUE index DB (platform, source_message_id,
// ocr_hash) : INSERT OR IGNORE renvoie null si déjà présent.
//
// Cf docs/superpowers/specs/2026-05-18-habs-design.md section 3-4.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { topWinners } = require('./cashtags');
const { buildCaption } = require('./caption');

function computeOcrHash(trades) {
  // Stringify avec key sort pour stabilité indépendante de l'ordre des
  // champs (mais l'ordre des trades dans l'array est significatif).
  const stable = (Array.isArray(trades) ? trades : []).map(t => ({
    ticker: String(t && t.ticker || '').toUpperCase().replace(/^\$+/, ''),
    entryPrice: t && t.entryPrice != null ? Number(t.entryPrice) : null,
    hodPrice: t && t.hodPrice != null ? Number(t.hodPrice) : null,
    gainPct: t && t.gainPct != null ? Number(t.gainPct) : null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// Args :
//   db          : { insertSocialPostJob }  (injectable pour test)
//   ocrResult   : { dateLabel, trades: [...] }
//   messageId   : Discord message.id
//   captionFn   : async (ocrResult) => string  (injectable; default = buildCaption avec LLM null)
//   llmFn       : async (ocrResult) => string  (passé à buildCaption si captionFn non fourni)
async function enqueueRecap({ db, ocrResult, messageId, captionFn, llmFn }) {
  if (!ocrResult || !Array.isArray(ocrResult.trades) || ocrResult.trades.length === 0) {
    console.warn('[habs] enqueueRecap skipped: no trades in OCR result');
    return null;
  }
  if (!messageId) {
    console.warn('[habs] enqueueRecap skipped: no messageId');
    return null;
  }

  const cashtags = topWinners(ocrResult.trades, 3);
  const captionBuilder = captionFn || ((o) => buildCaption(o, { llmFn }));
  const caption = await captionBuilder(ocrResult);

  const ocrHash = computeOcrHash(ocrResult.trades);

  return db.insertSocialPostJob({
    platform: 'stocktwits',
    assetType: 'text',
    caption,
    cashtags,
    sourceKind: 'recap',
    sourceMessageId: String(messageId),
    ocrHash,
  });
}

module.exports = { enqueueRecap, computeOcrHash };
