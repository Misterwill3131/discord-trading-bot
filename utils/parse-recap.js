// ─────────────────────────────────────────────────────────────────────
// utils/parse-recap.js — Parse un message Discord "RECAP:" en data structurée
// ─────────────────────────────────────────────────────────────────────
// Input  : contenu raw d'un message Discord (string), Date du message
// Output : { date, tickers, runnersHit, runnersTotal, tagline, totalGainPct } | null
//
// Retourne null si le message ne ressemble pas à un recap valide
// (pas de "RECAP:" en début, ou < 3 tickers parsables).
//
// Utilisé par discord/handler.js pour décider de déclencher un render
// auto BoomRecap. Pure : pas d'I/O, pas de DB.
// ─────────────────────────────────────────────────────────────────────

const { formatDateET } = require('./dates');

// Match "$TICKER NN% swing?" — tolère décimales et "swing" optionnel.
// Le 'g' flag est requis pour itérer matchAll.
const TICKER_REGEX = /\$([A-Z]{1,6})\s+(\d+(?:\.\d+)?)%\s*(swing)?/gmi;

// Match "5 out of 6 runners", "5/6 runners", "5 of 6 runner".
const RUNNERS_REGEX = /(\d+)\s*(?:out\s+of|\/|of)\s*(\d+)\s*runners?/i;

// Préfixe RECAP en début de message, accepte espace optionnel avant ':'.
const RECAP_PREFIX_REGEX = /^\s*RECAP\s*:/i;

const TAGLINE_DEFAULT = 'Plenty of chances to bank today.';
const MIN_TICKERS = 3;

function parseRecap(content, messageDate) {
  if (!content || typeof content !== 'string') return null;
  if (!RECAP_PREFIX_REGEX.test(content)) return null;

  // 1. Extract tickers
  const matches = [...content.matchAll(TICKER_REGEX)];
  if (matches.length < MIN_TICKERS) return null;

  const tickers = matches.map(m => {
    const gainPct = parseFloat(m[2]);
    return {
      ticker:  m[1].toUpperCase(),
      gainPct,
      swing:   Boolean(m[3]),
      isHero:  gainPct >= 100,
    };
  });

  // 2. Sort desc par gainPct
  tickers.sort((a, b) => b.gainPct - a.gainPct);

  // 3. Compute total
  const totalGainPct = tickers.reduce((sum, t) => sum + t.gainPct, 0);

  // 4. Extract runners ratio
  const runnersMatch = content.match(RUNNERS_REGEX);
  const runnersHit   = runnersMatch ? parseInt(runnersMatch[1], 10) : null;
  const runnersTotal = runnersMatch ? parseInt(runnersMatch[2], 10) : null;

  // 5. Extract tagline : premier paragraphe qui n'est pas RECAP: ni une
  //    ligne ticker, et qui a au moins 30 chars de prose.
  const paragraphs = content.split(/\n\n+/).map(p => p.trim());
  let tagline = TAGLINE_DEFAULT;
  for (const para of paragraphs) {
    if (RECAP_PREFIX_REGEX.test(para)) continue;
    // Skip si le paragraphe est juste des lignes ticker
    const lines = para.split('\n');
    const tickerLines = lines.filter(l => /\$[A-Z]{1,6}\s+\d+(?:\.\d+)?%/.test(l)).length;
    if (tickerLines === lines.length) continue;
    if (para.length < 30) continue;
    // Strip @everyone / @here
    tagline = para.replace(/@(everyone|here)/gi, '').trim();
    break;
  }

  return {
    date: formatDateET(messageDate),
    tickers,
    runnersHit,
    runnersTotal,
    tagline,
    totalGainPct,
  };
}

module.exports = { parseRecap };
