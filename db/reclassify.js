// ─────────────────────────────────────────────────────────────────────
// db/reclassify.js — Re-passe tous les messages à travers le classifier
// ─────────────────────────────────────────────────────────────────────
// Use case : après un changement du classifier ou du parser de prix
// (ex: ajout du format RF "buy only above"), les messages historiques
// en DB restent taggés selon l'ancienne logique. Cette fonction les
// ré-évalue et met à jour `type`, `reason`, `ticker`, `entry_price`,
// `passed` en une seule transaction.
//
// Important — reconstitution du contexte reply :
//   Pour les messages `isReply=1`, l'original handler mergeait le
//   parent complet avec le reply. En DB on n'a que `parentPreview`
//   (tronqué à 80 chars). C'est suffisant pour re-détecter le ticker
//   dans la majorité des cas, mais pour des parents exceptionnellement
//   longs sans ticker dans les 80 premiers chars, la reclassif perdra
//   le contexte. Rare en pratique.
//
// Opération atomique : wrappée dans `db.transaction()` — soit tout
// réussit, soit rien n'est modifié.
//
// Exporte :
//   reclassifyAllMessages()
//     → { total, updated, unchanged, by: { 'old→new': n } }
// ─────────────────────────────────────────────────────────────────────

const { db } = require('./sqlite');
const { classifySignal } = require('../filters/signal');
const { extractPrices } = require('../utils/prices');
const { customFilters } = require('../state/custom-filters');

// Prepare statements réutilisés dans la transaction.
const stmtSelectAll = db.prepare('SELECT * FROM messages ORDER BY ts ASC');
const stmtUpdate = db.prepare(`
  UPDATE messages
  SET type = @type,
      reason = @reason,
      ticker = @ticker,
      entry_price = @entry_price,
      passed = @passed,
      confidence = @confidence
  WHERE id = @id
`);

// Détermine le `classifyContent` en se basant sur ce qui est stocké.
// Pour les replies, on merge parentPreview (tronqué) avec content,
// comme le faisait le handler à l'origine.
function buildClassifyContent(row) {
  const content = row.content || '';
  if (row.isReply === 1 && row.parentPreview) {
    return row.parentPreview + ' ' + content;
  }
  return content;
}

function reclassifyAllMessages() {
  const stats = {
    total: 0,
    updated: 0,
    unchanged: 0,
    // Tracker des transitions pour diagnostic : "null→entry": 5, "entry→exit": 1, ...
    transitions: {},
  };

  // Snapshot immuable des rows — éviter de dépendre d'un curseur live
  // pendant qu'on UPDATE.
  const rows = stmtSelectAll.all();

  const tx = db.transaction(() => {
    for (const row of rows) {
      stats.total++;

      const classifyContent = buildClassifyContent(row);
      const replyBody = row.isReply === 1 ? (row.content || '') : null;

      const result = classifySignal(classifyContent, customFilters, { replyBody });
      const prices = extractPrices(classifyContent);

      const newType = result.type;
      const newReason = result.reason;
      const newTicker = result.ticker;
      const newEntryPrice = prices.entry_price;
      const newPassed = newType !== null ? 1 : 0;
      const newConfidence = result.confidence != null ? result.confidence : null;

      // Équivalence : on compare aux valeurs stockées (0/1 vs booleans déjà
      // gérés dans fromRow côté lecture, mais ici row vient de prepare.all()
      // qui retourne les INTEGER bruts).
      const oldType = row.type;
      const changed =
        newType !== oldType
        || newReason !== row.reason
        || newTicker !== row.ticker
        || newEntryPrice !== row.entry_price
        || newPassed !== row.passed
        || newConfidence !== row.confidence;

      if (changed) {
        stmtUpdate.run({
          id: row.id,
          type: newType,
          reason: newReason,
          ticker: newTicker,
          entry_price: newEntryPrice,
          passed: newPassed,
          confidence: newConfidence,
        });
        stats.updated++;
        const key = (oldType || 'null') + '→' + (newType || 'null');
        stats.transitions[key] = (stats.transitions[key] || 0) + 1;
      } else {
        stats.unchanged++;
      }
    }
  });

  tx();
  return stats;
}

module.exports = { reclassifyAllMessages };
