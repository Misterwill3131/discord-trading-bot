// ─────────────────────────────────────────────────────────────────────
// utils/parse-recap-image.js — OCR Claude Vision pour tableau récap TOB
// ─────────────────────────────────────────────────────────────────────
// Input  : path d'une image PNG/JPEG du tableau de récap TOB (avec
//          colonnes TICKER | ENTRY | HOD | T1 | T2 | T3 | TARGETS |
//          SUCCESS et un footer LONG TERM INVESTMENTS optionnel,
//          potentiellement avec plusieurs tickers).
// Output : JSON structuré matchant le schema TobTradeRecap :
//   {
//     dateLabel: "TODAY",
//     trades: [{ ticker: "$XOS", entryPrice: 2.49, hodPrice: 2.90 }, ...],
//     longTermInvestments: [
//       { ticker: "$RVI", entryPrice: 0.50, currentPrice: 1.16 },
//       { ticker: "$REA", entryPrice: 1.21, currentPrice: 1.91 }
//     ]
//   }
//
// Utilise Claude Sonnet 4.5 (vision) — le bot utilise déjà la même clé
// ANTHROPIC_API_KEY et le même SDK que services/llm-classify.js.
//
// Couts : ~$0.01-0.03 par image selon résolution. Pas de cache : chaque
// récap est unique. Si tu fais tourner souvent sur la même image, le
// caller peut wrapper avec un cache SHA-256 (cf. llm-classify.js).
//
// Sécurité : isolation stricte (pas de tools, mcp_servers, etc.) — copie
// du pattern de llm-classify.js.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = process.env.RECAP_OCR_MODEL || 'claude-sonnet-4-5-20251001';
const MAX_TOKENS = 8000;

// Params Anthropic interdits — copie depuis llm-classify.js pour
// éviter qu'un futur ajout donne au LLM accès au web/code/fichiers.
const FORBIDDEN_API_PARAMS = [
  'tools', 'tool_choice', 'mcp_servers',
];

function assertNoExternalAccess(payload) {
  for (const k of FORBIDDEN_API_PARAMS) {
    if (k in payload) {
      throw new Error(`parse-recap-image: API payload contains forbidden field '${k}'. Refusing to send.`);
    }
  }
}

const SYSTEM_PROMPT = `You are a precise OCR specialist for "TOB TRADE RECAP" trading recap table images.

These images have a dark background, gold title "✦ TOB TRADE RECAP FOR TODAY ✦", and a main table with these columns from left to right:
  TICKER | ENTRY PRICE | HOD PRICE | T1 (+5%) | T2 (+10%) | T3 (+15%) | TARGETS HIT | SUCCESS RATE

The bottom of the image has a stats panel (Total Calls, Combined Final, etc.) and optionally a "LONG TERM INVESTMENTS" section listing ONE OR MORE long-term holdings (each with ticker, entry price, and current price). Treat both "LONG TERM INVESTMENT" and "LONG TERM INVESTMENTS" sections the same way — always return an array (possibly empty, possibly with multiple entries).

Your task: extract ONLY the TICKER + ENTRY PRICE + HOD PRICE from each row of the main table, plus ALL long-term investments if present. The T1/T2/T3/targets/success columns are auto-computed downstream — DO NOT extract them.

Output STRICTLY this JSON shape (no prose, no markdown fences, no explanation):
{
  "dateLabel": "TODAY",
  "trades": [
    { "ticker": "$XOS", "entryPrice": 2.49, "hodPrice": 2.90 },
    { "ticker": "$HAO", "entryPrice": 0.046, "hodPrice": 0.071 }
  ],
  "longTermInvestments": [
    { "ticker": "$RVI", "entryPrice": 0.50, "currentPrice": 1.16 },
    { "ticker": "$REA", "entryPrice": 1.21, "currentPrice": 1.91 }
  ]
}

Rules:
- ALWAYS keep the $ prefix on tickers
- Parse EVERY row of the main table — duplicates (e.g., $XOS appearing twice) are different trades, include all
- Numbers as floats (no commas, no $, no quotes)
- If the image has 41 rows, return 41 objects in trades[]
- "longTermInvestments" is ALWAYS an array. Use [] if no long-term section is visible. Include EVERY long-term entry the image shows (1, 2, 3, …).
- "dateLabel" defaults to "TODAY" unless image clearly shows a specific date
- If a row is illegible/cut off, OMIT it — never invent numbers
- Output JSON only. NO markdown code fences. NO prose.`;

/**
 * Parse une image de récap TOB en data structurée.
 * @param {string} imagePath - chemin absolu vers PNG ou JPEG
 * @param {object} [opts]
 * @param {string} [opts.model] - override le modèle Claude
 * @returns {Promise<{dateLabel: string, trades: Array, longTermInvestments: Array, _meta: object}>}
 */
async function parseRecapImage(imagePath, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY env var required (cf services/llm-classify.js setup).');
  }

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image introuvable : ${imagePath}`);
  }

  const ext = path.extname(imagePath).toLowerCase();
  let mediaType;
  if (ext === '.png') mediaType = 'image/png';
  else if (ext === '.jpg' || ext === '.jpeg') mediaType = 'image/jpeg';
  else if (ext === '.webp') mediaType = 'image/webp';
  else if (ext === '.gif') mediaType = 'image/gif';
  else throw new Error(`Format non supporté : ${ext} (utilise PNG/JPEG/WebP/GIF)`);

  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const sizeKB = (imageBuffer.length / 1024).toFixed(0);

  const model = opts.model || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  const payload = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: imageBase64,
          },
        },
        {
          type: 'text',
          text: 'Extract ALL trade rows from this recap image. Output JSON only — no markdown fences, no prose.',
        },
      ],
    }],
  };

  assertNoExternalAccess(payload);

  const startedAt = Date.now();
  const response = await client.messages.create(payload);
  const latencyMs = Date.now() - startedAt;

  if (!response.content || !response.content.length || response.content[0].type !== 'text') {
    throw new Error('Réponse Claude vide ou format inattendu');
  }

  let text = response.content[0].text.trim();
  // Strip markdown fences si présents (au cas où Claude ignore l'instruction)
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Claude a renvoyé du non-JSON : ${err.message}\nRaw: ${text.slice(0, 500)}`);
  }

  // Validation minimale
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON parsed mais pas un object');
  }
  if (!Array.isArray(parsed.trades)) {
    throw new Error('Le JSON ne contient pas trades[]');
  }
  for (const t of parsed.trades) {
    if (!t.ticker || typeof t.entryPrice !== 'number' || typeof t.hodPrice !== 'number') {
      throw new Error(`Trade invalide : ${JSON.stringify(t)}`);
    }
  }

  // Defaults sécurisés
  parsed.dateLabel = parsed.dateLabel || 'TODAY';
  // Compat : ancien shape singleton `longTermInvestment` est remappé en
  // array. Si rien n'est fourni, on retourne [].
  if (Array.isArray(parsed.longTermInvestments)) {
    parsed.longTermInvestments = parsed.longTermInvestments.filter(
      lt => lt && typeof lt === 'object'
        && typeof lt.ticker === 'string'
        && typeof lt.entryPrice === 'number'
        && typeof lt.currentPrice === 'number'
    );
  } else if (parsed.longTermInvestment && typeof parsed.longTermInvestment === 'object') {
    parsed.longTermInvestments = [parsed.longTermInvestment];
  } else {
    parsed.longTermInvestments = [];
  }
  // On supprime l'ancien champ pour éviter de polluer le template.
  delete parsed.longTermInvestment;

  parsed._meta = {
    model,
    latencyMs,
    imageSizeKB: parseInt(sizeKB, 10),
    tradesCount: parsed.trades.length,
    usage: response.usage || null,
  };

  return parsed;
}

module.exports = { parseRecapImage };
