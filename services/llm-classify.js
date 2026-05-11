// ─────────────────────────────────────────────────────────────────────
// services/llm-classify.js — Classification LLM fallback pour le relay
// ─────────────────────────────────────────────────────────────────────
// Quand les heuristiques regex (isExitSuggestion, isIPOAnnouncement,
// shouldRelay, etc.) échouent à classifier un message qui POURRAIT être
// un signal financier, on appelle Claude Haiku 4.5 pour une seconde
// opinion. Best-effort : un échec API ne bloque jamais le relay.
//
// Stratégie :
//   1. Vérif kill switch (LLM_CLASSIFY_ENABLED, ANTHROPIC_API_KEY)
//   2. Hash SHA-256 du texte trimmé → check cache (forever, jamais TTL)
//   3. Si miss : appel API avec system prompt cacheable + few-shot
//   4. Parse JSON strict, valide la forme, store en cache
//   5. Retourne { type, entities, cached, latencyMs } ou null
//
// Cache forever : un message a TOUJOURS la même classification. Pas de
// TTL nécessaire. Permet de re-poster un duplicate sans recoût.
// Invalidation explicite via llmClassifyInvalidateModel() si on change
// de prompt/modèle.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/sqlite');

const DEFAULT_MODEL = process.env.LLM_CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_CLASSIFY_TIMEOUT_MS || '3000', 10);

// Version du prompt (system + few-shot). À BUMPER à chaque modification
// substantielle du SYSTEM_PROMPT ou de FEW_SHOT pour invalider
// automatiquement les classifications cachées avec l'ancienne version.
//
// Stockée dans le champ `model` de la table cache sous forme
// "model#version" → l'ancien cache devient invisible (mismatch lookup)
// sans avoir à supprimer les lignes (audit historique préservé).
const PROMPT_VERSION = 'v2';

// Types autorisés en sortie. Tout type hors liste est rejeté → null.
const VALID_TYPES = new Set(['entry', 'exit', 'ipo', 'passthrough', 'ignore']);

// Lazy init du client : pas d'instance créée au require, seulement au
// premier appel. Évite de charger le SDK quand le feature flag est OFF.
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function isEnabled() {
  return process.env.LLM_CLASSIFY_ENABLED === 'true' && !!process.env.ANTHROPIC_API_KEY;
}

// SHA-256 hex du texte trimmé. Ne dépend ni du modèle ni du prompt :
// si on change le prompt, il faut invalider le cache via
// llmClassifyInvalidateModel().
function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '').trim()).digest('hex');
}

// System prompt — partie cacheable côté Anthropic. Stable, jamais
// modifié au runtime. Tout changement de wording = bump du modèle ou
// invalidation cache obligatoire pour éviter classifications obsolètes.
const SYSTEM_PROMPT = `Tu classifies des messages d'un serveur Discord de trading.

Catégories possibles (UNE seule par message) :

- "entry" : nouveau signal d'entrée formaté (ouvrir une position long/short).
  Format type : "$TICKER entry X target Y sl Z", "in $XYZ at 5.50", "long $ABC at 250 PT 270".
  STRUCTURE explicite avec mots-clés trading. PAS de la prose narrative.

- "exit" : suggestion de sortie d'une position existante.
  Format compact "TICKER X-Y" sans mots-clés signal, OU instruction "trim $XYZ here", "out at 5.50".
  PAS un status update passé ("PT hit", "stopped out") qui sont "ignore".

- "ipo" : annonce d'IPO (introduction en bourse).
  Mentionne "IPO", "raise", "valuation", "price range", "expected to trade".

- "passthrough" : alerte BOT TECHNIQUE STRUCTURÉE provenant d'un service automatisé.
  Format type : "TICKER #1 BREAKOUT $X.XX FT 5M MC 3M RV 10x 1V 50K", "VIX spike >25",
  "$SPY rejected key level". Ces messages ont un FORMAT MÉCANIQUE répétitif, pas de
  prose narrative, pas de phrases conversationnelles.
  RÈGLE : si le message contient des phrases comme "If you...", "doing a beautiful...",
  "you will catch...", "watch this", "great job" → ce N'EST PAS passthrough, c'est
  COMMENTAIRE HUMAIN → "ignore".

- "ignore" : tout le reste — commentaire, conversation, coaching, FYI, status update
  passé, prose narrative qui mentionne un ticker/prix sans donner d'instruction
  actionnable structurée. Exemples : "EZGO doing a beautiful breakout at 2.60",
  "great job everyone who caught XYZ", "watching for setups today", "lol nice catch".

Format de sortie OBLIGATOIRE — JSON strict, AUCUN texte avant ou après :
{
  "type": "entry" | "exit" | "ipo" | "passthrough" | "ignore",
  "ticker": string | null,
  "entry": number | null,
  "target": number | null,
  "stop": number | null,
  "low": number | null,
  "high": number | null,
  "confidence": number entre 0 et 1
}

Règles :
- Pour "entry" : remplis entry/target/stop si présents, low/high = null.
- Pour "exit" : remplis low/high (zone de sortie), entry/target/stop = null.
- Pour "ipo" / "passthrough" / "ignore" : tous les champs prix = null.
- ticker : majuscules, sans le $. null si pas clairement identifiable.
- confidence : 0.95+ si tu es certain, 0.7-0.9 si plausible, < 0.5 si tu hésites.

Test décisif passthrough vs ignore : "Est-ce qu'un BOT automatisé pourrait avoir
généré ce texte exact ?" Si la réponse est NON (parce qu'il y a de la prose
conversationnelle, un ton humain, un encouragement, une phrase d'enseignement)
→ "ignore".`;

// Few-shot examples — couvre les formats observés dans le serveur source.
// Modifie cette liste si tu veux affiner la classification (puis invalide
// le cache du modèle correspondant).
const FEW_SHOT = [
  // — entry —
  { user: '$AAPL entry 150 target 160 sl 145',
    assistant: '{"type":"entry","ticker":"AAPL","entry":150,"target":160,"stop":145,"low":null,"high":null,"confidence":0.99}' },
  { user: 'in $TSLA at 250, looking for 270, stop 245',
    assistant: '{"type":"entry","ticker":"TSLA","entry":250,"target":270,"stop":245,"low":null,"high":null,"confidence":0.92}' },

  // — exit —
  { user: 'ELPW 6.60-9🔥',
    assistant: '{"type":"exit","ticker":"ELPW","entry":null,"target":null,"stop":null,"low":6.6,"high":9,"confidence":0.95}' },
  { user: 'DGNX 4.80-5.59',
    assistant: '{"type":"exit","ticker":"DGNX","entry":null,"target":null,"stop":null,"low":4.8,"high":5.59,"confidence":0.95}' },

  // — ipo —
  { user: '📅 IPOs expected next week\n\n$HAWK – HawkEye 360\n• Defense tech\n• ~$400M raise\n• Price range: $24-26',
    assistant: '{"type":"ipo","ticker":"HAWK","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.97}' },

  // — passthrough (BOT-formatted alerts ONLY, mechanical structure) —
  { user: 'EZGO #13 BREAKOUT $2.65 FT 21M MC 430K RV 37x 1V 76K | 0 Borrow',
    assistant: '{"type":"passthrough","ticker":"EZGO","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.95}' },
  { user: 'CYPH #1 +26% $1.24 FT 73M MC 61M RV 0.76x 1V 74K',
    assistant: '{"type":"passthrough","ticker":"CYPH","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.95}' },

  // — ignore (status updates, prose, coaching, conversation) —
  { user: 'UONE first PT hit 6.30-7.50',
    assistant: '{"type":"ignore","ticker":"UONE","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.9}' },
  { user: 'lol nice catch',
    assistant: '{"type":"ignore","ticker":null,"entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.99}' },
  { user: 'trimmed half $XYZ at 12',
    assistant: '{"type":"ignore","ticker":"XYZ","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.9}' },
  // Cas EZGO réel rapporté par l'utilisateur — prose éducative avec
  // ticker + prix mais ton humain coaching → ignore (PAS passthrough,
  // PAS entry).
  { user: 'EZGO doing a beautiful breakout over HOD at 2.60. If you line out your charts, you will catch these moves daily.',
    assistant: '{"type":"ignore","ticker":"EZGO","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.92}' },
  { user: 'Great job everyone who caught XYZ today, beautiful move',
    assistant: '{"type":"ignore","ticker":"XYZ","entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.95}' },
  { user: 'Watching for breakouts on these names today, stay sharp',
    assistant: '{"type":"ignore","ticker":null,"entry":null,"target":null,"stop":null,"low":null,"high":null,"confidence":0.95}' },
];

// Construit les messages pour l'API. Few-shot en premier (pairs
// user/assistant) puis le message à classifier en dernier.
function buildMessages(text) {
  const out = [];
  for (const ex of FEW_SHOT) {
    out.push({ role: 'user', content: ex.user });
    out.push({ role: 'assistant', content: ex.assistant });
  }
  out.push({ role: 'user', content: String(text) });
  return out;
}

// Valide la forme du JSON renvoyé par le LLM. Renvoie l'objet sanitisé
// ou null si invalide (type inconnu, champs manquants, etc.).
function parseClassification(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip code fences éventuels (le modèle peut wrap en ```json malgré
  // l'instruction). Tolérant.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!VALID_TYPES.has(obj.type)) return null;

  const numOrNull = v => (v === null || v === undefined) ? null
                       : (Number.isFinite(Number(v)) ? Number(v) : null);
  const strOrNull = v => (v === null || v === undefined || v === '') ? null
                       : String(v).toUpperCase().slice(0, 8);

  return {
    type:       obj.type,
    ticker:     strOrNull(obj.ticker),
    entry:      numOrNull(obj.entry),
    target:     numOrNull(obj.target),
    stop:       numOrNull(obj.stop),
    low:        numOrNull(obj.low),
    high:       numOrNull(obj.high),
    confidence: Math.max(0, Math.min(1, numOrNull(obj.confidence) ?? 0.5)),
  };
}

// Classify un message. Renvoie :
//   { type, entities, cached, latencyMs, model }
//   ou null si désactivé / API indispo / réponse invalide.
//
// SAFE : tout chemin d'erreur log et renvoie null. Ne throw jamais.
async function classify(text, { model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isEnabled()) return null;
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  // Identifiant composite stocké dans cache.model. Bump PROMPT_VERSION
  // → mismatch automatique sur les anciennes lignes → re-classification.
  const versionedModel = `${model}#${PROMPT_VERSION}`;
  const hash = hashText(trimmed);

  // Cache hit valide UNIQUEMENT si la version du prompt matche. Sinon
  // on traite comme miss et on re-classifie (l'ancien row sera écrasé
  // via INSERT OR REPLACE dans llmClassifyPut).
  const cached = db.llmClassifyGet(hash);
  if (cached && cached.model === versionedModel) {
    return {
      type:      cached.type,
      entities:  cached.entities,
      cached:    true,
      latencyMs: 0,
      model:     cached.model,
    };
  }

  const client = getClient();
  if (!client) return null;

  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      temperature: 0,
      system: [
        // cache_control: rend cette section éligible au prompt caching
        // côté Anthropic → réduit le coût des appels suivants ~10x sur
        // les tokens d'input. Le few-shot fait partie des messages, pas
        // du system, donc il est aussi cacheable via les messages
        // history (cf. doc Anthropic prompt caching).
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: buildMessages(trimmed),
    }, { timeout: timeoutMs });

    const rawText = response?.content?.[0]?.type === 'text'
      ? response.content[0].text
      : null;
    const parsed = parseClassification(rawText);
    if (!parsed) {
      console.warn(
        `[llm-classify] invalid JSON response — raw="${(rawText || '').slice(0, 100)}" ` +
        `text="${trimmed.slice(0, 60)}"`
      );
      return null;
    }

    db.llmClassifyPut(hash, trimmed, parsed.type, parsed, versionedModel);
    const latencyMs = Date.now() - t0;
    return { type: parsed.type, entities: parsed, cached: false, latencyMs, model: versionedModel };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    console.warn(
      `[llm-classify] API error after ${latencyMs}ms — ${err.message?.slice(0, 200)} ` +
      `text="${trimmed.slice(0, 60)}"`
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// MODE EXTRACTION : pour les watchlists multi-tickers
// ─────────────────────────────────────────────────────────────────────
// La regex single-signal échoue sur les posts du type "WL for 11.05"
// avec 10 tickers détaillés — elle aggrège les prix de plusieurs tickers
// dans un embed Frankenstein. Solution : LLM en mode extraction qui
// retourne un ARRAY de signaux, un par ticker actionnable.
//
// Cache séparé du mode classify : on hash avec préfixe "extract:" pour
// éviter collision PK sur le même texte.

const EXTRACT_SYSTEM_PROMPT = `Tu extrais des signaux de trading depuis un message multi-tickers (typiquement une watchlist analyste matinale type "WL for [date]").

Pour CHAQUE ticker mentionné, détermine s'il a un setup actionnable clair :
- "X break" / "X to break" / "needs to break X" / "X break needed for Y" → entry trigger = X, target = Y
- "X has to hold for Y" / "X must hold above Y" → support level (PAS un entry actionnable seul)
- "above X we have Y" → confirmation level + target
- "Alerted at X" → historique passé (À IGNORER comme entry, pas un signal nouveau)
- Listes "X...Y...Z" après un trigger = targets multiples (prendre le PREMIER comme target principal)

Retourne UNIQUEMENT les tickers ayant :
- Un entry trigger CLAIR (break/breakout level)
- ET au moins 1 target derrière

Skip ceux qui sont juste "watch", "hold above support" sans entrée nette, ou en mode coaching.

Format de sortie OBLIGATOIRE — JSON ARRAY strict, AUCUN texte avant ou après :
[
  { "ticker": "HPAI", "side": "long", "entry": 1.50, "target": 1.57, "stop": null, "confidence": 0.9 },
  { "ticker": "GCTS", "side": "long", "entry": 1.86, "target": 1.95, "stop": null, "confidence": 0.85 }
]

Si AUCUN signal actionnable extractible : retourne [] (array vide).

Règles strictes :
- ticker : majuscules, sans le $
- side : "long" par défaut, "short" si le contexte l'indique clairement (puts, bearish, breakdown)
- entry : le PRIX de déclenchement (break level)
- target : le PREMIER prix mentionné après l'entry comme objectif
- stop : null sauf si "sl X" / "stop X" explicite
- confidence : 0.85+ si setup très clair, 0.7-0.84 si plausible, < 0.7 si tu hésites (sera filtré)`;

const EXTRACT_FEW_SHOT = [
  // — Watchlist du cas réel rapporté par l'utilisateur (HPAI message) —
  {
    user: `WL for 11.05:

\$HPAI AI/small-float momentum and sympathy buying around artificial intelligence names.
\$1.50 break needed for 1.57 highs test and then 1.93.

\$MRAM Strong earnings, AI memory/semiconductor hype.
Consolidating nicely above VWAP. \$33s have to hold if VWAP doesn't. Above we have 38...44.58...55.27.

\$GCTS Biotech momentum/speculative rebound.
Nice close on Friday in AH. 1.86 has to break for 1.95 retest and then 2.13...2.30.

\$AEHL china pump low-float trading activity.
1.45 break takes it to 2.03 retest.

\$FLNC Energy storage/battery sector strength.
25 break needed for 27.00 retest and then 28.51 and 31.23. Alerted at 17.30.

\$INOD Continued AI/data-labeling momentum.
82.70 has to hold and 91.88 retested for 103.58+ Alerted at 59.00.`,
    assistant: '[{"ticker":"HPAI","side":"long","entry":1.50,"target":1.57,"stop":null,"confidence":0.9},{"ticker":"GCTS","side":"long","entry":1.86,"target":1.95,"stop":null,"confidence":0.85},{"ticker":"AEHL","side":"long","entry":1.45,"target":2.03,"stop":null,"confidence":0.85},{"ticker":"FLNC","side":"long","entry":25,"target":27.00,"stop":null,"confidence":0.9}]',
  },
  // — Watchlist sans setup actionnable (que du watch/hold) —
  {
    user: `Watching today:
\$AAPL above 200 looks good for upside
\$MSFT consolidating, watch the range
\$NVDA needs to reclaim 130 to be interesting`,
    assistant: '[]',
  },
  // — Mix de setups clairs et hold-only —
  {
    user: `\$XYZ 5.50 break for 6.20 then 6.80
\$ABC just watching, no clear setup
\$DEF 12 break needed, target 14.50 sl 11`,
    assistant: '[{"ticker":"XYZ","side":"long","entry":5.50,"target":6.20,"stop":null,"confidence":0.9},{"ticker":"DEF","side":"long","entry":12,"target":14.50,"stop":11,"confidence":0.95}]',
  },
];

function buildExtractMessages(text) {
  const out = [];
  for (const ex of EXTRACT_FEW_SHOT) {
    out.push({ role: 'user', content: ex.user });
    out.push({ role: 'assistant', content: ex.assistant });
  }
  out.push({ role: 'user', content: String(text) });
  return out;
}

// Valide un array de signaux extraits. Filtre ceux sans entry+target+ticker.
function parseExtraction(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let arr;
  try { arr = JSON.parse(cleaned); } catch { return null; }
  if (!Array.isArray(arr)) return null;

  const numOrNull = v => (v === null || v === undefined) ? null
                       : (Number.isFinite(Number(v)) ? Number(v) : null);
  const strOrNull = v => (v === null || v === undefined || v === '') ? null
                       : String(v).toUpperCase().slice(0, 8);

  const out = [];
  for (const sig of arr) {
    if (!sig || typeof sig !== 'object') continue;
    const ticker = strOrNull(sig.ticker);
    const entry = numOrNull(sig.entry);
    const target = numOrNull(sig.target);
    if (!ticker || !Number.isFinite(entry) || !Number.isFinite(target)) continue;
    out.push({
      ticker,
      side: (sig.side === 'short') ? 'short' : 'long',
      entry,
      target,
      stop: numOrNull(sig.stop),
      confidence: Math.max(0, Math.min(1, numOrNull(sig.confidence) ?? 0.5)),
    });
  }
  return out;
}

// Hash dédié au mode extract (préfixe pour éviter collision PK avec le
// cache classify).
function hashExtractText(text) {
  return crypto.createHash('sha256')
    .update('extract:' + String(text || '').trim())
    .digest('hex');
}

// Extrait les signaux multi-tickers d'un message. Renvoie :
//   { signals: [...], cached, latencyMs, model } ou null si désactivé /
//   API indispo / réponse invalide.
async function extractMultiSignals(text, { model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isEnabled()) return null;
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const versionedModel = `${model}#${PROMPT_VERSION}#extract`;
  const hash = hashExtractText(trimmed);

  const cached = db.llmClassifyGet(hash);
  if (cached && cached.model === versionedModel) {
    // Stocké dans entities (réutilise le champ JSON) pour économiser
    // une migration de schéma. La clé "signals" différencie du format
    // classify.
    return {
      signals:   cached.entities?.signals || [],
      cached:    true,
      latencyMs: 0,
      model:     cached.model,
    };
  }

  const client = getClient();
  if (!client) return null;

  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1500,           // multi-signal → output plus large
      temperature: 0,
      system: [
        { type: 'text', text: EXTRACT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: buildExtractMessages(trimmed),
    }, { timeout: timeoutMs });

    const rawText = response?.content?.[0]?.type === 'text'
      ? response.content[0].text
      : null;
    const signals = parseExtraction(rawText);
    if (signals === null) {
      console.warn(
        `[llm-classify] extract: invalid JSON — raw="${(rawText || '').slice(0, 100)}"`
      );
      return null;
    }

    db.llmClassifyPut(hash, trimmed, 'extract', { signals }, versionedModel);
    const latencyMs = Date.now() - t0;
    return { signals, cached: false, latencyMs, model: versionedModel };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    console.warn(
      `[llm-classify] extract API error after ${latencyMs}ms — ${err.message?.slice(0, 200)}`
    );
    return null;
  }
}

module.exports = {
  classify,
  extractMultiSignals,
  isEnabled,
  hashText,
  hashExtractText,
  parseClassification,    // exposé pour tests
  parseExtraction,        // exposé pour tests
  DEFAULT_MODEL,
  PROMPT_VERSION,
  VALID_TYPES,
};
