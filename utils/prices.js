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
  // Mots de base
  'I', 'A', 'THE', 'AND', 'OR', 'TO', 'IN', 'AT', 'ON',
  'BY', 'FOR', 'OF', 'UP', 'OK', 'IS', 'IT', 'AM', 'BE',
  'AN', 'AS', 'IF', 'SO', 'NO', 'DO', 'GO', 'HE', 'SHE',
  'WE', 'ME', 'MY', 'US', 'WHO', 'WHY', 'HOW', 'OUR',
  // Mots courants du chat trading
  'BUY', 'SELL', 'NEW', 'HIGH', 'LOW', 'LOSS', 'GAIN', 'RED',
  'OUT', 'DAY', 'WEEK', 'YEAR', 'ALL', 'ANY', 'MORE', 'ONLY',
  'EVEN', 'TOO', 'THIS', 'THAT', 'WITH', 'FROM', 'JUST',
  'NOT', 'NOW', 'BUT', 'YET', 'SEE', 'RUN', 'HIT', 'WAS',
  'WERE', 'BEEN', 'HAVE', 'HAS', 'HAD', 'WILL', 'CAN',
  'SHOULD', 'WOULD', 'COULD', 'MAY', 'JUST', 'BIG',
  'ALERT', 'BREAK', 'NEWS', 'PLAY', 'SETUP', 'TIME',
  'CALL', 'PUT', 'FAST', 'SLOW', 'OPEN', 'CLOSE', 'LIVE',
  'PRICE', 'PROFIT', 'CASH', 'LOOK', 'NICE', 'GOOD',
  // Acronymes financiers fréquents (pas des tickers actions)
  'CEO', 'CFO', 'SEC', 'IPO', 'CPI', 'FED', 'FOMC', 'ETF',
  'PE', 'EPS', 'ROI', 'YTD', 'QOQ', 'YOY', 'ATH', 'PM', 'AM',
]);

// Pattern de nombre qui accepte : "0.46", ".46", "46", "46.5".
// Utilisé comme fragment dans toutes les regex de prix.
const NUM = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';

// Variante de NUM qui rejette les nombres suivis d'un `%` — un nombre suivi
// de '%' est un pourcentage de gain ou un autre indicateur, jamais un prix.
// Sans ce filtre, "QQQ: 1100% TS alert" extrayait 1100 comme entry_price,
// "RECAP: $SNAL 318%" extrayait 318, et "ARAI +29%" extrayait 29 — tous
// faux et catastrophiques pour le calcul P&L.
//
// Le `(?![\d.])` empêche le backtracking de matcher un préfixe : sur "1100%",
// sans cette assertion, NUM_NOT_PCT matcherait "110" en abandonnant le "0"
// final puisque "0%" déclenche le rejet de fin. On exige donc que le nombre
// soit "complet" (aucun chiffre ni point ne suit) AVANT de tester le %.
const NUM_NOT_PCT = NUM + '(?![\\d.])(?!\\s*%)';

// Nettoie les métadonnées Discord qui perturbent le parsing :
//   - mentions de rôles/users/channels/emojis : <@123>, <@&123>, <#123>, <:name:123>, <a:name:123>
//   - préfixe reply : "> *Replying to X [message](url)*\n"
//   - liens discord : https://discord.com/channels/.../.../...
// À appeler AVANT extractPrices / detectTicker pour éviter les faux positifs
// sur des Discord IDs (18-19 chiffres) ou noms d'utilisateurs.
function stripDiscordMeta(text) {
  if (!text) return text;
  return text
    // Préfixe reply "> *Replying to ... [message](url)*"
    .replace(/^>\s*\*?Replying to[^\n]*(?:\n|$)/im, '')
    // Tags Discord (mentions, emojis, salons) : <@123>, <@!123>, <@&123>, <#123>, <:name:id>, <a:name:id>
    .replace(/<[@#&!a]?:?[^>]+>/g, '')
    // Liens discord.com
    .replace(/https?:\/\/(?:www\.)?discord(?:app)?\.com\/\S+/gi, '')
    // Espaces multiples collapse
    .replace(/\s+/g, ' ')
    .trim();
}

// Retourne tous les prix extraits d'un message. `exit_price === target_price`
// est conservé pour compat ascendante (ancien code qui lit `exit_price`).
function extractPrices(content) {
  if (!content) {
    return { entry_price: null, target_price: null, stop_price: null, exit_price: null, gain_pct: null };
  }

  // Nettoie les métadonnées Discord. Remplace virgule → point UNIQUEMENT
  // dans les nombres (format EU "0,46") pour ne pas transformer
  // "BULL, broke 7" en "BULL. broke 7" (le `.` casserait le parsing).
  // Tolère aussi le typo "1..5" (deux points entre chiffres) → "1.5".
  // Limite à EXACTEMENT 2 dots pour ne pas casser le séparateur de range
  // "..." utilisé en chat trading ("2.50...3.50" reste intact).
  const c = stripDiscordMeta(content)
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\.\.(\d)/g, '$1.$2');
  let entry = null;
  let target = null;
  let stop = null;

  // Priorité 1 — Ticker + range : "$TSLA 150.00-155.00" ou "NCT 2.60-4.06".
  // NUM_NOT_PCT pour éviter "QQQ: 1100%-900%" → range bidon.
  const rangeM = c.match(new RegExp(`(?:\\$?[A-Z]{1,6}\\s+)\\$?(${NUM_NOT_PCT})\\s*[-\\u2013]\\s*\\$?(${NUM_NOT_PCT})`, 'i'));
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
    const standaloneRange = c.match(new RegExp(`^\\s*\\$?(${NUM_NOT_PCT})\\s*[-\\u2013]\\s*\\$?(${NUM_NOT_PCT})\\s*$`));
    if (standaloneRange) {
      const a = parseFloat(standaloneRange[1]);
      const b = parseFloat(standaloneRange[2]);
      entry  = Math.min(a, b);
      target = Math.max(a, b);
    }
  }

  // Priorité 2 — Mots-clés d'entrée.
  if (!entry) {
    const em = c.match(new RegExp(`(?:in\\s+at|entry|bought?|long\\s+at|achat|entree)\\s+\\$?(${NUM_NOT_PCT})`, 'i'));
    if (em) entry = parseFloat(em[1]);
  }

  // Priorité 2b — Format RF : "buy only above $X" ou "buy above $X".
  if (!entry) {
    const em = c.match(new RegExp(`buy\\s+(?:only\\s+)?above\\s+\\$?(${NUM_NOT_PCT})`, 'i'));
    if (em) entry = parseFloat(em[1]);
  }

  // Priorité 3 — Mots-clés de sortie/cible.
  // Inclut maintenant les verbes de clôture partielle (trim, scale) ainsi
  // que le séparateur `@` utilisé en chat trading ("scaled some @1.78").
  // Sur un exit partiel à plusieurs prix ("@1.78/79"), on capture le premier.
  if (!target) {
    const xm = c.match(new RegExp(
      '(?:'
      + 'targets?|tp|out\\s+at|exit\\s+at|sold?\\s+at|sortie|objectif'
      + '|scaled?\\s+(?:out|some|half|partial|down)'
      + '|scaling\\s+(?:out|some|down|half)'
      + '|trim(?:m(?:ing|ed))?(?:\\s+(?:half|partial))?'
      + ')\\s*@?\\s*\\$?(' + NUM_NOT_PCT + ')',
      'i'
    ));
    if (xm) target = parseFloat(xm[1]);
  }

  // Priorité 4 — Stop loss. Reconnaît : "stop 43", "sl 43", "s.l 43",
  // "stoploss 43", "stop loss 43", "stop-loss 43".
  const sm = c.match(new RegExp(`(?:stop[-\\s]?loss|stoploss|s\\.?l|stop)\\s+\\$?(${NUM_NOT_PCT})`, 'i'));
  if (sm) stop = parseFloat(sm[1]);

  // Priorité 5 — Séparateurs "..." ou " to " : "2.50...3.50", "2.50 to 3.50".
  if (!entry || !target) {
    const lm = c.match(new RegExp(`\\$?(${NUM_NOT_PCT})\\s*(?:\\.{2,}|\\bto\\b)\\s*\\$?(${NUM_NOT_PCT})`, 'i'));
    if (lm) {
      const a = parseFloat(lm[1]);
      const b = parseFloat(lm[2]);
      if (!entry)  entry  = Math.min(a, b);
      if (!target) target = Math.max(a, b);
    }
  }

  // Priorité 5b — Pattern "breaks X for Y" (breakout conditionnel).
  // Ex: "scalping once it breaks 0.83 for 0.99" → entry=0.83, target=0.99.
  if (!entry && !target) {
    const bm = c.match(new RegExp(`breaks?\\s+\\$?(${NUM_NOT_PCT})\\s+(?:for|to)\\s+\\$?(${NUM_NOT_PCT})`, 'i'));
    if (bm) {
      entry  = parseFloat(bm[1]);
      target = parseFloat(bm[2]);
    }
  }

  // Priorité 6 — Ticker + prix "proche" (format casual) : "$GMEX .46$",
  // "GLND 5.2", "$Fchl high risk .23". `\$?` avant/après pour "$0.46" et
  // "0.46$". `$TICKER` est insensible à la casse (Discord tolère "$Fchl").
  // Gap de 30 chars max pour capturer "$Fchl high risk .23" (11 chars) sans
  // attraper des prix éloignés de 50+ chars dans une longue phrase.
  // NUM_NOT_PCT pour éviter "QQQ: 1100% TS" → entry_price=1100.
  if (!entry) {
    const im = c.match(new RegExp(`(?:\\$[A-Za-z]{1,6}|\\b[A-Z]{2,5})\\b[^\\d.]{0,30}\\$?(${NUM_NOT_PCT})\\$?`));
    if (im) entry = parseFloat(im[1]);
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
// Strip les métadonnées Discord avant la détection pour éviter les faux
// positifs sur les usernames mentionnés dans "> *Replying to X*".
function detectTicker(content) {
  if (!content) return null;
  const clean = stripDiscordMeta(content);

  // $TICKER a priorité absolue (format non-ambigu).
  const m1 = clean.match(/\$([A-Z]{1,6})/i);
  if (m1) return m1[1].toUpperCase();

  // Fallback : premier mot 2-5 lettres majuscules qui n'est pas dans
  // TICKER_IGNORE. Les mots 6 lettres sont exclus (trop de faux-positifs).
  const m2 = clean.match(/\b([A-Z]{2,5})\b/g);
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

// Extrait le P&L réalisé annoncé dans un message d'exit.
// Couvre :
//   "TICKER +29%"       → 29
//   "TICKER -5%"        → -5
//   "NVDA up 8%"        → 8
//   "AMD down 3.5%"     → -3.5
//   "locked in 20%"     → 20
// Retourne un number signé (+ = gain, - = perte) ou null si rien.
// Utilisé quand ni exit_price ni entry_price ne sont parsables : si on
// a juste "+29%" dans le message, c'est suffisant pour afficher le P&L
// sans avoir à apparier l'exit à une entry avec prix.
function extractExitGainPct(content) {
  if (!content) return null;
  const clean = stripDiscordMeta(content);

  // "+N%" / "-N%" — ancré sur début ou espace pour éviter "150-29%" (range).
  const m1 = clean.match(/(?:^|\s)([+\-])\s*(\d+(?:\.\d+)?)%/);
  if (m1) {
    const sign = m1[1] === '-' ? -1 : 1;
    return sign * parseFloat(m1[2]);
  }

  // "up N%" / "down N%".
  const m2 = clean.match(/\b(up|down)\s+(\d+(?:\.\d+)?)%/i);
  if (m2) {
    const sign = /down/i.test(m2[1]) ? -1 : 1;
    return sign * parseFloat(m2[2]);
  }

  // "locked in N%" — toujours gain positif (on ne « locked in » pas une perte).
  const m3 = clean.match(/\blocked\s+in\s+(\d+(?:\.\d+)?)%/i);
  if (m3) return parseFloat(m3[1]);

  return null;
}

module.exports = {
  extractPrices,
  extractTicker,
  detectTicker,
  enrichContent,
  extractExitGainPct,
  stripDiscordMeta,
  TICKER_IGNORE,
};
