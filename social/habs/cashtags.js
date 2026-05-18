// ─────────────────────────────────────────────────────────────────────
// social/habs/cashtags.js — Top winners selector for Stocktwits cashtags
// ─────────────────────────────────────────────────────────────────────
// OCR result `trades` est un array de { ticker, entryPrice, hodPrice }
// ou { ticker, gainPct } selon le parser. On supporte les deux.
// Cf spec : top 3 winners par gain % descendant. Tie-break = ordre d'entrée.
// ─────────────────────────────────────────────────────────────────────

function normalizeTicker(t) {
  return String(t || '').toUpperCase().replace(/^\$+/, '');
}

function computeGain(trade) {
  if (!trade) return null;
  if (trade.gainPct != null && Number.isFinite(Number(trade.gainPct))) {
    return Number(trade.gainPct);
  }
  const entry = Number(trade.entryPrice);
  const hod = Number(trade.hodPrice);
  if (Number.isFinite(entry) && Number.isFinite(hod) && entry > 0) {
    return ((hod - entry) / entry) * 100;
  }
  return null;
}

function topWinners(trades, n = 3) {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const scored = trades
    .map((t, idx) => ({
      ticker: normalizeTicker(t && t.ticker),
      gain: computeGain(t || {}),
      idx,
    }))
    // Include flatline trades (gain === 0) intentionally — "top moves" can
    // include zero-move closes when nothing else is greener.
    .filter(x => x.ticker && x.gain != null);
  // Sort by gain desc; ties broken by original idx (stable).
  scored.sort((a, b) => b.gain - a.gain || a.idx - b.idx);
  return scored.slice(0, n).map(x => x.ticker);
}

module.exports = { topWinners, normalizeTicker, computeGain };
