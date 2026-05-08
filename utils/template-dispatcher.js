// ─────────────────────────────────────────────────────────────────────
// utils/template-dispatcher.js — Sélection automatique d'un template
// ─────────────────────────────────────────────────────────────────────
// Centralise les règles : "quel template Remotion utiliser pour ce job
// de render ?". Côté bot, on appelle pickTemplate() avant d'enqueue —
// le nom du template est stocké dans render_jobs.template_name et le
// worker s'en sert pour merger les props par défaut + props dynamiques.
// ─────────────────────────────────────────────────────────────────────

// Parse une string PnL ("+85%", "-3%", "20%", "+20.5%") → number
// (signed). Retourne NaN si pas parsable.
function parsePnlToNumber(pnl) {
  if (!pnl || typeof pnl !== 'string') return NaN;
  const m = pnl.match(/^([+-]?)(\d+(?:\.\d+)?)%$/);
  if (!m) return NaN;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * parseFloat(m[2]);
}

// Règles de dispatch. Premier match gagne. Toujours fallback sur
// 'classic-green' si rien ne match (template safe par défaut).
//
// Ajouter un nouveau template : crée le .json dans video/templates/,
// puis ajoute une règle ici. Les règles peuvent inspecter pnl, ticker,
// entryAuthor, exitAuthor, etc.
function pickTemplate({ pnl, ticker: _ticker, entryAuthor: _entryAuthor }) {
  const pnlNum = parsePnlToNumber(pnl);

  // Big win (>=50%) → template gold avec glow accentué.
  if (!Number.isNaN(pnlNum) && pnlNum >= 50) return 'gold-celebration';

  // Default : template green standard.
  return 'classic-green';
}

module.exports = {
  pickTemplate,
  parsePnlToNumber,
};
