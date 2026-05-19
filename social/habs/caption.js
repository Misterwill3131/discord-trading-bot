// ─────────────────────────────────────────────────────────────────────
// social/habs/caption.js — Stocktwits caption pipeline
// ─────────────────────────────────────────────────────────────────────
// Pipeline en 3 étages :
//   1. LLM (utils/caption-llm.js avec platform='stocktwits')
//   2. Validation : reject URL, brand mention, banned phrases
//   3. Fallback template (variant 1 du spec, Stocktwits-rules compliant)
//
// Cf docs/superpowers/specs/2026-05-18-habs-design.md section 6.
// ─────────────────────────────────────────────────────────────────────

const { normalizeTicker, computeGain } = require('./cashtags');

const BANNED_PATTERNS = [
  /https?:\/\//i,
  /temple[\s\-]*of[\s\-]*boom/i,
  /\bdiscord\b/i,
  /\bdiscord\.gg\b/i,
  /\bjoin\s+(us|the|our|my)\b/i,
  /\bsubscribe\b/i,
  /\blive\s+calls?\b/i,
];

function todayNyDateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function validateCaption(text) {
  if (!text || typeof text !== 'string') return false;
  for (const pat of BANNED_PATTERNS) {
    if (pat.test(text)) return false;
  }
  return true;
}

// Construit la caption template (fallback déterministe).
function renderTemplate(ocrResult) {
  const dateLabel = (ocrResult && ocrResult.dateLabel) || todayNyDateKey();
  const trades = Array.isArray(ocrResult && ocrResult.trades) ? ocrResult.trades : [];

  // Enrich trades avec gain calculé
  const enriched = trades
    .map((t, idx) => ({
      ticker: normalizeTicker(t && t.ticker),
      gain: computeGain(t || {}),
      idx,
    }))
    .filter(x => x.ticker && x.gain != null);

  const n = enriched.length;
  const wins = enriched.filter(x => x.gain > 0).length;
  const losses = n - wins;

  // Top moves : top 3 par gain desc (peut être négatif sur all-losing day)
  const sorted = [...enriched].sort((a, b) => b.gain - a.gain || a.idx - b.idx);
  const top = sorted.slice(0, 3);
  const topLines = top.map(x => {
    const sign = x.gain >= 0 ? '+' : '';
    return `$${x.ticker} ${sign}${x.gain.toFixed(0)}%`;
  }).join('\n');

  return `Trade journal — ${dateLabel}

${n} closes today · ${wins}W / ${losses}L

Top moves:
${topLines}

What's everyone watching into tomorrow?`;
}

// Pipeline complet. opts.llmFn permet d'injecter un mock (test) ou la
// vraie generateCaption (prod). Si llmFn absent → fallback direct.
async function buildCaption(ocrResult, opts = {}) {
  const llmFn = opts.llmFn; // async (ocrResult) => string|null
  if (typeof llmFn === 'function') {
    try {
      const llmOut = await llmFn(ocrResult);
      if (typeof llmOut === 'string' && llmOut.trim().length > 0) {
        const trimmed = llmOut.trim();
        if (validateCaption(trimmed)) return trimmed;
      }
    } catch {
      // ignore, fallback
    }
  }
  return renderTemplate(ocrResult);
}

module.exports = { buildCaption, renderTemplate, validateCaption };
