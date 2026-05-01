// ─────────────────────────────────────────────────────────────────────
// trading/trend-scanner.js — Boucle de scan trend + dispatch alertes
// ─────────────────────────────────────────────────────────────────────
// Tick 60s ; déclenche un scan toutes les TREND_SCAN_INTERVAL_MIN min
// pendant les heures de marché US régulières (lun-ven, 9:30-16:00 ET).
// Pour chaque ticker watché par au moins une guild :
//   1. Fetch candles via Yahoo (cached).
//   2. detectAll → verdict.
//   3. Compare à trend_state, génère alertes (transitions + events).
//   4. Dispatch chaque alerte aux guilds qui watch le ticker.
// ─────────────────────────────────────────────────────────────────────

// Détermine si NYSE est ouverte à la date donnée (heures régulières).
// Gère DST automatiquement via Intl.DateTimeFormat timezone NY.
// Pas de gestion des jours fériés US — on accepte de scanner pour rien
// le 4 juillet (~10 jours/an, coût négligeable).
function isUSMarketOpen(date = new Date()) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  let weekday = '', hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour')    hour = parseInt(p.value, 10);
    else if (p.type === 'minute')  minute = parseInt(p.value, 10);
  }

  // Intl peut produire 'hour' = '24' à minuit (selon le runtime). Normalise.
  if (hour === 24) hour = 0;

  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

module.exports = { isUSMarketOpen };
