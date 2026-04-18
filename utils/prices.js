// ─────────────────────────────────────────────────────────────────────
// utils/prices.js — Parsing des prix et tickers dans un message
// ─────────────────────────────────────────────────────────────────────
// Fonctions pures, aucun état. Reconnaît :
//   - Prix simple : 0.64, $0.63
//   - Range avec ticker : "$TSLA 150.00-155.00", "NCT 2.60-4.06"
//   - Range seul : "9.86-11.50", "3.43-4.32"
//   - Mots-clés : "in at X", "target Y", "tp Y", "stop Z", "sl Z"
//   - Séparateurs : "2.50...3.50", "2.50 to 3.50"
//
// Les virgules sont converties en points avant parsing (format FR).
//
// Exporte :
//   extractPrices(content)  → { entry_price, target_price, stop_price,
//                                exit_price, gain_pct }
//   extractTicker(content)  → string (legacy, pour backward compat)
//   detectTicker(content)   → string | null (version filtrée TICKER_IGNORE)
//   enrichContent(content)  → content + " | Gain: +X.XX%" si calculable
//   TICKER_IGNORE           → Set des mots 2-5 lettres à ignorer
// ─────────────────────────────────────────────────────────────────────

// Mots courts qui ressemblent à un ticker mais n'en sont pas. Étendre
// au besoin si on observe des faux-positifs dans les logs.
const TICKER_IGNORE = new Set([
  'I', 'A', 'THE', 'AND', 'OR', 'TO', 'IN', 'AT', 'ON',
  'BY', 'FOR', 'OF', 'UP', 'OK',
]);

// Retourne tous les prix extraits d'un message. `exit_price === target_price`
// est conservé pour compat ascendante (ancien code qui lit `exit_price`).
function extractPrices(content) {
  if (!content) {
    return { entry_price: null, target_price: null, stop_price: null, exit_price: null, gain_pct: null };
  }

  // Normalise virgules → points (la regex \d+\.\d+ ne matche pas les virgules).
  const c = content.replace(/,/g, '.');
  let entry = null;
  let target = null;
  let stop = null;

  // Priorité 1 — Ticker + range : "$TSLA 150.00-155.00" ou "NCT 2.60-4.06".
  const rangeM = c.match(/(?:\$?[A-Z]{1,6}\s+)\$?(\d+(?:\.\d+)?)\s*[-\u2013]\s*\$?(\d+(?:\.\d+)?)/i);
  if (rangeM) {
    const a = parseFloat(rangeM[1]);
    const b = parseFloat(rangeM[2]);
    entry  = Math.min(a, b);
    target = Math.max(a, b);
  }

  // Priorité 1b — Range seul (souvent en réponse à un message parent) :
  // "3.43-4.32". On ancre au début et à la fin pour éviter de matcher
  // un range à l'intérieur d'une phrase.
  if (!entry) {
    const standaloneRange = c.match(/^\s*\$?(\d+(?:\.\d+)?)\s*[-\u2013]\s*\$?(\d+(?:\.\d+)?)\s*$/);
    if (standaloneRange) {
      const a = parseFloat(standaloneRange[1]);
      const b = parseFloat(standaloneRange[2]);
      entry  = Math.min(a, b);
      target = Math.max(a, b);
    }
  }

  // Priorité 2 — Mots-clés d'entrée.
  if (!entry) {
    const em = c.match(/(?:in\s+at|entry|bought?|long\s+at|achat|entree)\s+\$?(\d+(?:\.\d+)?)/i);
    if (em) entry = parseFloat(em[1]);
  }

  // Priorité 2b — Format RF : "buy only above $X" ou "buy above $X".
  // Le seuil "above" est le prix d'entrée (trigger breakout).
  if (!entry) {
    const em = c.match(/buy\s+(?:only\s+)?above\s+\$?(\d+(?:\.\d+)?)/i);
    if (em) entry = parseFloat(em[1]);
  }

  // Priorité 3 — Mots-clés de sortie/cible.
  // Pour RF : "Targets $6.14/6.78/7.44" — on prend le PREMIER (TP1,
  // le plus conservateur). La regex matche "Targets" (pluriel) aussi.
  if (!target) {
    const xm = c.match(/(?:targets?|tp|out\s+at|exit\s+at|sold?\s+at|sortie|objectif)\s+\$?(\d+(?:\.\d+)?)/i);
    if (xm) target = parseFloat(xm[1]);
  }

  // Priorité 4 — Stop loss.
  const sm = c.match(/(?:stop|sl|stoploss|stop[-\s]?loss)\s+\$?(\d+(?:\.\d+)?)/i);
  if (sm) stop = parseFloat(sm[1]);

  // Priorité 5 — Séparateurs "..." ou " to " : "2.50...3.50", "2.50 to 3.50".
  if (!entry || !target) {
    const lm = c.match(/\$?(\d+(?:\.\d+)?)\s*(?:\.{2,}|\bto\b)\s*\$?(\d+(?:\.\d+)?)/i);
    if (lm) {
      const a = parseFloat(lm[1]);
      const b = parseFloat(lm[2]);
      if (!entry)  entry  = Math.min(a, b);
      if (!target) target = Math.max(a, b);
    }
  }

  // Gain % calculé uniquement si on a les deux bornes et que l'entrée n'est pas nulle.
  let gain_pct = null;
  if (entry !== null && target !== null && entry > 0) {
    gain_pct = parseFloat((((target - entry) / entry) * 100).toFixed(2));
  }

  return { entry_price: entry, target_price: target, stop_price: stop, exit_price: target, gain_pct };
}

// Version legacy : retourne le premier ticker trouvé (pas de filtrage
// TICKER_IGNORE). Conservé pour backward compat avec anciens appels.
function extractTicker(content) {
  if (!content) return '';
  const m = content.match(/\$([A-Z]{1,6})/i) || content.match(/\b([A-Z]{2,6})\b/);
  return m ? m[1].toUpperCase() : '';
}

// Version recommandée : filtre les mots courts usuels via TICKER_IGNORE.
function detectTicker(content) {
  if (!content) return null;

  // $TICKER a priorité absolue (format non-ambigu).
  const m1 = content.match(/\$([A-Z]{1,6})/i);
  if (m1) return m1[1].toUpperCase();

  // Fallback : premier mot 2-5 lettres majuscules qui n'est pas dans
  // TICKER_IGNORE. Les mots 6 lettres sont exclus (trop de faux-positifs).
  const m2 = content.match(/\b([A-Z]{2,5})\b/g);
  if (m2) {
    for (const t of m2) {
      if (!TICKER_IGNORE.has(t)) return t;
    }
  }
  return null;
}

// Ajoute une ligne "Gain: +X.XX%" au contenu si un gain est calculable,
// sinon renvoie le contenu tel quel.
function enrichContent(content) {
  const { gain_pct } = extractPrices(content);
  if (gain_pct === null) return content;
  const sign = gain_pct >= 0 ? '+' : '';
  return content + ' | Gain: ' + sign + gain_pct + '%';
}

module.exports = {
  extractPrices,
  extractTicker,
  detectTicker,
  enrichContent,
  TICKER_IGNORE,
};
