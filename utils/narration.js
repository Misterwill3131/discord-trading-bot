// ─────────────────────────────────────────────────────────────────────
// utils/narration.js — Génère le texte de narration TTS par composition
// ─────────────────────────────────────────────────────────────────────
// Chaque composition Remotion a sa formule de narration (script court
// que la voix off lit pendant la vidéo). Le texte est formaté pour
// être naturel à l'oreille — pas de symboles techniques, des pauses
// implicites via la ponctuation.
//
// Durée cible : 10-20s par narration (≈ 30-50 mots). Plus court = trop
// rapide vs la vidéo. Plus long = la narration dépasse la vidéo.
//
// La fonction publique buildNarrationText(composition, payload) dispatch
// sur la bonne formule selon la composition. Si la composition n'a pas
// de formule narrée, retourne null (le worker skip TTS dans ce cas).
// ─────────────────────────────────────────────────────────────────────

function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(0)}%`;
}

function pickTopN(trades, n) {
  return trades
    .filter(t => Number.isFinite(t.entryPrice) && Number.isFinite(t.hodPrice) && t.entryPrice > 0)
    .map(t => ({
      ticker: String(t.ticker || '').replace(/^\$+/, ''),
      gainPct: ((t.hodPrice - t.entryPrice) / t.entryPrice) * 100,
    }))
    .sort((a, b) => b.gainPct - a.gainPct)
    .slice(0, n);
}

// ── TobTradeRecap ─────────────────────────────────────────────────
// Format : "Today's recap. N trades, X out of N green, combined +Y%.
//          Top picks: $A at +N%, $B at +M%, $C at +K%."
function buildTobTradeRecapNarration(props) {
  const trades = Array.isArray(props.trades) ? props.trades : [];
  if (trades.length === 0) return null;

  const enriched = trades
    .map(t => ({
      ticker: String(t.ticker || '').replace(/^\$+/, ''),
      gainPct: Number.isFinite(t.entryPrice) && Number.isFinite(t.hodPrice) && t.entryPrice > 0
        ? ((t.hodPrice - t.entryPrice) / t.entryPrice) * 100
        : 0,
    }))
    .filter(t => t.ticker);

  const green = enriched.filter(t => t.gainPct > 0).length;
  const combined = enriched.reduce((s, t) => s + t.gainPct, 0);
  const top3 = pickTopN(trades, 3);

  const dateStr = String(props.dateLabel || 'Today').toLowerCase() === 'today'
    ? "Today's"
    : props.dateLabel;

  const parts = [];
  parts.push(`${dateStr} recap.`);
  parts.push(`${enriched.length} trades, ${green} out of ${enriched.length} green, combined ${fmtPct(combined)}.`);
  if (top3.length > 0) {
    const top3Str = top3
      .map(t => `$${t.ticker} at ${fmtPct(t.gainPct)}`)
      .join(', ');
    parts.push(`Top picks: ${top3Str}.`);
  }
  return parts.join(' ');
}

// ── ChartTemplate (proof video) ──────────────────────────────────
// Format : "$TICKER. Entered at $X, took it to $Y for $Z%. That's what
//           we do at Temple of Boom."
function buildChartTemplateNarration(props) {
  const ticker = String(props.ticker || '').replace(/^\$+/, '');
  if (!ticker) return null;
  const pnl = String(props.pnl || '+0%');
  const entryPrice = Number(props.entryPrice);
  const exitPrice = Number(props.exitPrice);
  const parts = [];
  parts.push(`$${ticker}.`);
  if (Number.isFinite(entryPrice) && Number.isFinite(exitPrice)) {
    parts.push(`Entered at ${entryPrice}, took it to ${exitPrice} for ${pnl}.`);
  } else {
    parts.push(`Closed at ${pnl}.`);
  }
  parts.push(`That's how we do it at Temple of Boom.`);
  return parts.join(' ');
}

// ── BoomEntry (signal video) ──────────────────────────────────────
// Format : "Live signal: $TICKER. Entry $X. Watch this run."
function buildBoomEntryNarration(props) {
  const ticker = String(props.ticker || '').replace(/^\$+/, '');
  if (!ticker) return null;
  const parts = [];
  parts.push(`Live signal: $${ticker}.`);
  if (props.message) {
    // Strip ticker + emojis du message brut pour avoir un texte propre.
    const clean = String(props.message)
      .replace(/<a?:[^>]+:[0-9]+>/g, '')  // emojis Discord
      .replace(/[\uD800-\uDFFF].|[☀-➿️]/g, '')  // unicode emojis basics
      .replace(/\$[A-Z]{1,6}/gi, '')  // tickers du début (redondant avec announcement)
      .trim();
    if (clean) parts.push(clean + '.');
  }
  parts.push(`Watch this one.`);
  return parts.join(' ');
}

// ── BoomRecap (multi-tickers daily) ───────────────────────────────
function buildBoomRecapNarration(props) {
  const tickers = Array.isArray(props.tickers) ? props.tickers : [];
  if (tickers.length === 0) return null;
  const runnersHit = props.runnersHit;
  const runnersTotal = props.runnersTotal;
  const totalGain = Number(props.totalGainPct);
  const parts = [];
  parts.push(`Daily recap.`);
  if (Number.isFinite(runnersHit) && Number.isFinite(runnersTotal)) {
    parts.push(`${runnersHit} out of ${runnersTotal} runners.`);
  }
  if (Number.isFinite(totalGain)) {
    parts.push(`Combined ${fmtPct(totalGain)}.`);
  }
  const top3 = tickers
    .slice()
    .sort((a, b) => (Number(b.gainPct) || 0) - (Number(a.gainPct) || 0))
    .slice(0, 3)
    .map(t => `$${String(t.ticker || '').replace(/^\$+/, '')} at ${fmtPct(Number(t.gainPct) || 0)}`);
  if (top3.length > 0) {
    parts.push(`Top picks: ${top3.join(', ')}.`);
  }
  return parts.join(' ');
}

// ── Dispatch principal ────────────────────────────────────────────
function buildNarrationText(composition, payload) {
  if (!payload || typeof payload !== 'object') return null;
  switch (composition) {
    case 'TobTradeRecap': return buildTobTradeRecapNarration(payload);
    case 'ChartTemplate': return buildChartTemplateNarration(payload);
    case 'BoomEntry':     return buildBoomEntryNarration(payload);
    case 'BoomRecap':     return buildBoomRecapNarration(payload);
    default:              return null;  // composition non narrée (SignalAlert, BrandPromo, etc.)
  }
}

module.exports = {
  buildNarrationText,
  // Exposed pour les tests
  buildTobTradeRecapNarration,
  buildChartTemplateNarration,
  buildBoomEntryNarration,
  buildBoomRecapNarration,
};
