// ─────────────────────────────────────────────────────────────────────
// utils/caption-llm.js — Génération de captions vidéo via Claude
// ─────────────────────────────────────────────────────────────────────
// Pour chaque render job, génère une caption ADAPTÉE à la plateforme :
//   - 'discord' : multi-line avec stats détaillées, top picks, all trades
//                 (~500-1500 chars, profite du 2000-char limit Discord)
//   - 'twitter' : punchy, max 270 chars, hashtags pertinents
//   - 'tiktok'  : super court, hook accrocheur, max 150 chars
//
// Modèle : claude-haiku-4-5 (le moins cher, suffisamment bon pour ces
// outputs courts et structurés). Cache en mémoire par hash du payload
// pour éviter les regen sur jobs identiques.
//
// Fallback : si Anthropic API down OU pas d'ELEVENLABS_API_KEY [sic,
// ANTHROPIC_API_KEY], retourne null → le worker utilise sa caption
// template builtin.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = process.env.CAPTION_LLM_MODEL || 'claude-haiku-4-5';
const MAX_CACHE = 100;

// Cache en mémoire (LRU-ish via Map insertion order)
const cache = new Map();

function cacheKey(composition, platform, payload) {
  const h = crypto.createHash('sha256');
  h.update(composition);
  h.update('|');
  h.update(platform);
  h.update('|');
  h.update(JSON.stringify(payload));
  return h.digest('hex');
}

// Forbidden params anti-prompt-injection (cf llm-classify.js pattern)
const FORBIDDEN_API_PARAMS = ['tools', 'tool_choice', 'mcp_servers'];
function assertNoExternalAccess(payload) {
  for (const k of FORBIDDEN_API_PARAMS) {
    if (k in payload) throw new Error(`caption-llm: forbidden field '${k}'`);
  }
}

const PLATFORM_PROMPTS = {
  discord:
    `You write Discord post captions for a trading signals video.

CONTEXT: A short marketing video (15-30s) showcasing today's trade results from "Temple of Boom" (TOB), a Discord trading community. The video is posted in the same Discord server.

REQUIREMENTS:
- 200-800 characters total
- Multi-line OK (Discord supports it)
- Use bold (**word**) and inline code (\`$TICKER\`) sparingly
- Highlight: total trades, success rate, top 3 picks with %
- End with a punchy line that invites lurkers to join the live channel
- Tone: confident, no-bullshit, slightly playful. NOT corporate or salesy.
- NEVER use hashtags (Discord doesn't process them)
- NEVER add quote marks around the entire caption

Output ONLY the caption text, no preface.`,

  twitter:
    `You write Twitter/X post captions for a trading signals video.

CONTEXT: A short vertical video (15-30s) showcasing today's top trades from "Temple of Boom" (TOB), a Discord trading community.

REQUIREMENTS:
- Max 270 characters (Twitter limit minus URL room)
- Single paragraph, no line breaks unless absolutely necessary
- 1-2 relevant cashtags ($TICKER style) but NOT 10
- 1-2 emojis MAX, only if they amplify (🚀 💥 🔥)
- Hook in the first 5 words ("4x in 2 hours.", "$TDIC +1000%.", etc.)
- End with a soft CTA to the bio link
- Tone: confident, punchy, the kind of tweet that gets retweeted by trading accounts

Output ONLY the caption text, no preface.`,

  tiktok:
    `You write TikTok caption text for a trading signals video.

CONTEXT: A short vertical video (15-30s) showcasing today's top trades from "Temple of Boom" (TOB), a Discord trading community.

REQUIREMENTS:
- Max 150 characters
- 1 hook line + 1 CTA line (max 2 lines)
- Use 2-3 hashtags AT THE END (#daytrading #stocks #stockmarket #penny etc.)
- 1-2 emojis MAX
- Tone: bold, attention-grabbing, ALL CAPS hooks are OK
- No links (TikTok hides them; use "link in bio")

Output ONLY the caption text, no preface.`,

  stocktwits:
    `You write Stocktwits post captions for a trader's daily journal.

CONTEXT: A personal trader sharing their closed positions for the day on Stocktwits.

REQUIREMENTS:
- 150-300 characters total
- Trader journal voice, first-person OR neutral observational
- Reference tickers as $CASHTAG (Stocktwits auto-parses these)
- Highlight: total trades, win/loss split, top 3 picks with %
- End with a community-engagement question, NOT a CTA
- NEVER include URLs, links, or domain names
- NEVER mention "Temple of Boom", "Discord", "join", "subscribe", "live calls"
- NEVER use promotional language ("amazing", "huge wins", "follow me for more")
- Tone: humble, observational, factual

Match the style of a retail trader posting their own day's recap, not a marketing account.

Output ONLY the caption text, no preface.`,
};

function buildPayloadSummary(composition, payload) {
  // Distille recap_data / job fields en un blob compact que le LLM voit.
  if (composition === 'TobTradeRecap' || composition === 'BoomRecap') {
    const trades = Array.isArray(payload.trades) ? payload.trades : (Array.isArray(payload.tickers) ? payload.tickers : []);
    const enriched = trades.map(t => {
      const ticker = String(t.ticker || '').replace(/^\$+/, '');
      const gain = t.gainPct != null ? Number(t.gainPct)
        : (Number.isFinite(t.entryPrice) && Number.isFinite(t.hodPrice) && t.entryPrice > 0
            ? ((t.hodPrice - t.entryPrice) / t.entryPrice) * 100 : null);
      return { ticker, gain };
    }).filter(t => t.ticker && t.gain != null);
    const green = enriched.filter(t => t.gain > 0).length;
    const combined = enriched.reduce((s, t) => s + t.gain, 0);
    const top5 = [...enriched].sort((a, b) => b.gain - a.gain).slice(0, 5);
    return {
      type: 'recap',
      dateLabel: payload.dateLabel || 'today',
      tradesCount: enriched.length,
      green,
      combinedGainPct: Math.round(combined),
      avgGainPct: enriched.length > 0 ? Math.round(combined / enriched.length) : 0,
      successRate: enriched.length > 0 ? Math.round(green / enriched.length * 100) : 0,
      topPicks: top5.map(t => `$${t.ticker} ${t.gain >= 0 ? '+' : ''}${t.gain.toFixed(0)}%`),
      longTermCount: Array.isArray(payload.longTermInvestments) ? payload.longTermInvestments.length : 0,
    };
  }
  // ChartTemplate / BoomEntry
  return {
    type: 'single-trade',
    ticker: String(payload.ticker || '').replace(/^\$+/, ''),
    pnl: payload.pnl || null,
    entryPrice: payload.entryPrice || null,
    exitPrice: payload.exitPrice || null,
    entryAuthor: payload.entryAuthor || null,
    exitAuthor: payload.exitAuthor || null,
  };
}

/**
 * Génère une caption pour un job render.
 * @param {string} composition - 'TobTradeRecap' | 'ChartTemplate' | etc.
 * @param {object} payload - job data (recap_data parsed ou job fields)
 * @param {'discord'|'twitter'|'tiktok'} platform
 * @param {object} [opts]
 * @returns {Promise<string|null>} caption text, ou null si LLM unavailable.
 */
async function generateCaption(composition, payload, platform = 'discord', opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!PLATFORM_PROMPTS[platform]) {
    throw new Error(`Unknown platform: ${platform}. Supported: discord, twitter, tiktok, stocktwits.`);
  }

  const summary = buildPayloadSummary(composition, payload);
  const key = cacheKey(composition, platform, summary);
  if (cache.has(key)) return cache.get(key);

  const model = opts.model || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const apiPayload = {
    model,
    max_tokens: 600,
    system: PLATFORM_PROMPTS[platform],
    messages: [{
      role: 'user',
      content: `Write a caption for this video. Data:\n${JSON.stringify(summary, null, 2)}`,
    }],
  };
  assertNoExternalAccess(apiPayload);

  let text = null;
  try {
    const res = await client.messages.create(apiPayload);
    if (res.content && res.content[0] && res.content[0].type === 'text') {
      text = res.content[0].text.trim();
      // Strip wrapping quotes si le LLM en a quand même ajouté.
      text = text.replace(/^["']+|["']+$/g, '').trim();
    }
    // Tracking coût Anthropic. Best-effort : on lit res.usage si dispo
    // (SDK le renvoie systématiquement) sinon on saute le tracking.
    try {
      const { recordAnthropicCall } = require('./cost-tracker');
      const u = res.usage || {};
      recordAnthropicCall({
        model,
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        notes: { kind: 'caption', platform, composition },
      });
    } catch (_) { /* swallow — tracking failure must never break captions */ }
  } catch (err) {
    console.warn(`[caption-llm] Anthropic call failed (${err.message}) — fallback to template caption`);
    return null;
  }

  if (!text) return null;
  cache.set(key, text);
  // Trim cache to MAX_CACHE entries (LRU via insertion order)
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return text;
}

module.exports = {
  generateCaption,
  buildPayloadSummary,  // exposed for tests
  PLATFORM_PROMPTS,     // exposed for smoke tests
};
