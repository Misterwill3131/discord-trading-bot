// ─────────────────────────────────────────────────────────────────────
// filters/signal.js — Classification des messages en signal trading
// ─────────────────────────────────────────────────────────────────────
// Transforme un message brut en { type, reason, confidence, ticker } :
//
//   type        'entry' | 'exit' | 'neutral' | null (filtré)
//   reason      libellé court expliquant pourquoi
//   confidence  0-100 (indicatif, pas strictement calibré)
//   ticker      symbole détecté ou null
//
// Ordre de décision (premier match gagne) :
//   1. customFilters.allowed  → bypass tout le reste (corrections humaines)
//   2. customFilters.blocked  → rejeté (règles apprises)
//   3. BLOCKED_KEYWORDS       → rejeté (actualités, IPO, halts…)
//   4. Absence de ticker      → rejeté
//   5. Mot-clé entrée         → 'entry'
//   6. Mot-clé sortie         → 'exit'
//   7. Conversation sans prix → rejeté
//   8. Absence de prix        → rejeté
//   9. Sinon                  → 'neutral'
//
// `customFilters` est injecté en argument pour éviter tout couplage au
// module qui gère la persistence (testabilité + pas d'état caché).
// ─────────────────────────────────────────────────────────────────────

const { detectTicker } = require('../utils/prices');

// Termes qui suggèrent du contenu non-trading (annonces corporate, presse
// financière). Si l'un apparaît, le message est rejeté direct.
const BLOCKED_KEYWORDS = [
  'news', 'sec', 'ipo', 'offering', 'halted', 'form 8-k', 'reverse stock split',
];

// Mots-clés qui classifient un message comme entrée/sortie.
// RF utilise "buy only above $X" ou "buy above $X" pour signaler ses
// entrées (format distinct des autres analystes).
const ENTRY_KEYWORDS = ['entree', 'entry', 'long', 'scalp', 'buy only above', 'buy above'];
// RF clôture ses trades par un reply "TICKER all targets done ✅" ou
// "TICKER SL hit" — on reconnaît ces marqueurs explicites pour tagger
// type='exit' au lieu de neutral. 'tp hit' / 'target hit' couvrent
// aussi des variantes utilisées par d'autres analystes. 'cut' est
// utilisé par le trading engine pour déclencher une sortie manuelle.
const EXIT_KEYWORDS  = [
  'sortie', 'exit', 'stop', 'cut',
  'targets done', 'target hit', 'all targets', 'tp hit', 'sl hit', 'stopped out',
];

// Patterns regex pour captures plus flexibles (numéros variables, ordre libre).
// Complète EXIT_KEYWORDS quand un simple `includes` ne suffit pas :
//   - "TP2 hit" / "target 3 reached"  (numéros dans le token)
//   - "out at 158" / "sold at 12.5" / "closed at 3.4"
// `includesAnyRegex` est appelé après `includesAny(EXIT_KEYWORDS)`.
const EXIT_REGEX = [
  /\btp\s*\d+\s*(?:hit|reached|done|fill(?:ed)?)\b/i,
  /\btarget\s*\d+\s*(?:hit|reached|done|fill(?:ed)?)\b/i,
  /\b(?:out|sold|closed?)\s+at\b/i,
];

function matchesAnyRegex(text, patterns) {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

// Regex pour filtrer les messages "conversationnels" (questions, réactions).
const CONVO_START_RE = /^(and\s+)?(how|who|what|when|why|did|do|are|is|can|any|anyone|has|have|congrats|gg|nice|good|great|lol|haha|check|look|wow|reminder|just|btw|fyi|ok|okay)\b/i;

// Regex "a-t-on un prix quelque part dans le message ?"
const HAS_PRICE_RE       = /\d+(?:\.\d+)?/;
const HAS_PRICE_WITH_RANGE_RE = /\$?\d+(?:\.\d+)?(?:\s*[-\u2013]\s*\$?\d+(?:\.\d+)?)?/;

// Regex ticker (plus permissive que detectTicker — sert juste à décider
// si un ticker est présent, peu importe lequel).
const HAS_TICKER_RE = /\$[A-Z]{1,6}|\b[A-Z]{2,5}\b/;

function includesAny(lower, phrases) {
  for (const p of phrases) {
    if (lower.includes(p.toLowerCase())) return true;
  }
  return false;
}

function classifySignal(content, customFilters, options) {
  if (!content) return { type: null, reason: 'No content', confidence: 90, ticker: null };

  const lower = content.toLowerCase();
  const ticker = detectTicker(content);
  const cf = customFilters || { allowed: [], blocked: [] };
  const opts = options || {};

  // Pré-check : si on a un `replyBody` (contenu non-mergé d'une réponse
  // Discord) et qu'il contient des mots-clés d'exit, on force type='exit'.
  // Raison : pour un reply, le parent est l'entrée d'origine et le reply
  // est la clôture. Le merged contient les deux — sans ce pré-check,
  // ENTRY_KEYWORDS matcherait en premier (parent) et on perdrait le fait
  // que c'est une clôture. Le ticker vient toujours du merged (le reply
  // seul n'a souvent que "TICKER all targets done" sans $).
  if (opts.replyBody) {
    const replyLower = String(opts.replyBody).toLowerCase();
    if (includesAny(replyLower, EXIT_KEYWORDS) || matchesAnyRegex(replyLower, EXIT_REGEX)) {
      const hasPrice = HAS_PRICE_RE.test(content);
      return {
        type: 'exit',
        reason: 'Reply exit',
        confidence: hasPrice ? 90 : 70,
        ticker,
      };
    }
  }

  // 1. Whitelist custom — priorité absolue (correction de faux-négatifs
  //    par un humain via le dashboard /config).
  if (includesAny(lower, cf.allowed || [])) {
    return { type: 'neutral', reason: 'Accepted', confidence: 90, ticker };
  }

  // 2. Blacklist custom — règles apprises (faux-positifs corrigés).
  if (includesAny(lower, cf.blocked || [])) {
    return { type: null, reason: 'Learned filter', confidence: 90, ticker };
  }

  // 3. Mots-clés bloqués hardcodés.
  for (const b of BLOCKED_KEYWORDS) {
    if (lower.includes(b)) {
      return { type: null, reason: 'Blocked keyword', confidence: 95, ticker };
    }
  }

  // 4. Un ticker est requis pour tout le reste.
  if (!HAS_TICKER_RE.test(content)) {
    console.log('[FILTER] No ticker, ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'No ticker', confidence: 90, ticker: null };
  }

  // 5. Signal d'entrée détecté.
  if (includesAny(lower, ENTRY_KEYWORDS)) {
    const hasPrice = HAS_PRICE_RE.test(content);
    return { type: 'entry', reason: 'Accepted', confidence: hasPrice ? 90 : 70, ticker };
  }

  // 5b. Entrée implicite — présence d'un stop-loss avec un prix.
  // Ex: "$GMEX .46$ s.l 43" n'a pas de mot d'entrée mais le SL prouve
  // que le trader a ouvert une position. On capture aussi "sl X",
  // "stop X", "stoploss X", "stop-loss X" avec un prix après.
  const STOP_WITH_PRICE_RE = /(?:^|\s)(?:stop[-\s]?loss|stoploss|s\.?l|stop)\s+\$?(?:\d+(?:\.\d+)?|\.\d+)/i;
  if (STOP_WITH_PRICE_RE.test(content)) {
    const hasPrice = HAS_PRICE_RE.test(content);
    return { type: 'entry', reason: 'Implicit entry (stop-loss)', confidence: hasPrice ? 75 : 60, ticker };
  }

  // 5c. Entrée implicite — ticker + un prix dans la suite du message.
  // Ex: "GLND 5.2!", "$NVDA 140 oversold", "$Fchl high risk .23".
  // `ticker` vient de detectTicker (TICKER_IGNORE filtré + Discord meta
  // strippée), garantissant qu'un mot courant ou un username en "Replying
  // to X" ne déclenche pas. 30 chars max entre ticker et prix pour
  // capturer du texte court entre les deux mais pas un prix isolé à 50+
  // chars de distance.
  if (ticker) {
    const TICKER_ADJACENT_PRICE_RE = /(?:\$[A-Za-z]{1,6}|\b[A-Z]{2,5})\b[^\d.]{0,30}\$?(?:\d+(?:\.\d+)?|\.\d+)/;
    if (TICKER_ADJACENT_PRICE_RE.test(content)) {
      return { type: 'entry', reason: 'Implicit entry (ticker+price)', confidence: 55, ticker };
    }
  }

  // 6. Signal de sortie détecté (substring ou regex).
  if (includesAny(lower, EXIT_KEYWORDS) || matchesAnyRegex(lower, EXIT_REGEX)) {
    const hasPrice = HAS_PRICE_RE.test(content);
    return { type: 'exit', reason: 'Accepted', confidence: hasPrice ? 90 : 70, ticker };
  }

  // 7. Filtre conversationnel : question ou mot d'ouverture sans aucun prix.
  const hasPrice    = HAS_PRICE_WITH_RANGE_RE.test(content);
  const isQuestion  = content.trim().endsWith('?');
  const startsConvo = CONVO_START_RE.test(content.trim());
  if ((isQuestion || startsConvo) && !hasPrice) {
    console.log('[FILTER] Conversational ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'Conversational', confidence: 75, ticker };
  }

  // 8. Neutre requiert à la fois un ticker (déjà vérifié) ET un prix.
  if (!hasPrice) {
    console.log('[FILTER] No price for neutral, ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'No price', confidence: 70, ticker };
  }

  return { type: 'neutral', reason: 'Accepted', confidence: 60, ticker };
}

module.exports = {
  classifySignal,
  BLOCKED_KEYWORDS,
  ENTRY_KEYWORDS,
  EXIT_KEYWORDS,
};
