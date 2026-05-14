// ─────────────────────────────────────────────────────────────────────
// discord/milestone-checker.js — Cron tick paliers de gain
// ─────────────────────────────────────────────────────────────────────
// Toutes les 30 min (pendant RTH US), lit analyst_watchlist, fetch les
// prix FMP en bulk, calcule le gain cumulé par ticker et déclenche une
// alerte Discord (reply sous le message d'origine) au prochain palier
// non-tiré, sous réserve d'un cooldown 1h depuis la dernière alerte du
// même ticker.
//
// Mark-then-send atomique : INSERT OR IGNORE dans milestone_alerts avant
// le reply Discord. Si l'insert échoue (UNIQUE constraint), un autre tick
// a déjà tiré ce palier → on skip. Si l'insert réussit mais le reply
// Discord échoue, on perd l'alerte plutôt que de spammer au tick suivant.
// ─────────────────────────────────────────────────────────────────────

// Trouve le prochain palier strictement > lastFired ET ≤ gainPct.
// Retour null = rien à tirer pour ce ticker à ce tick.
// Note : on retourne le PREMIER palier passé, pas le dernier — donc
// si gain=350 et lastFired=20, on tire 50 (pas 300). Évite de skip les
// paliers intermédiaires si le marché bouge vite entre 2 ticks.
function nextMilestone(gainPct, lastFiredPct, milestones) {
  if (!Number.isFinite(gainPct)) return null;
  const list = Array.isArray(milestones) ? milestones : [];
  const lower = (lastFiredPct == null) ? -Infinity : Number(lastFiredPct);
  for (const m of list) {
    if (m > lower && gainPct >= m) return m;
  }
  return null;
}

module.exports = {
  nextMilestone,
};
