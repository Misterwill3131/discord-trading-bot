// ─────────────────────────────────────────────────────────────────────
// saas/anonymize.js — Sanitisation et reconstruction d'un signal trading
// ─────────────────────────────────────────────────────────────────────
// MODULE SÉCURITÉ CRITIQUE. Toutes les fuites potentielles vers le client
// passent par ici. Toute fonction est PURE — pas de DB, pas de réseau,
// pas de référence aux clients Discord. Testable unitairement.
//
// Garantie d'étanchéité (couverte par saas/anonymize.test.js) :
//   - Aucune mention Discord (<@id>, <@&id>, <#id>) ne survit au sanitize
//   - Aucun emoji custom (<:n:id>, <a:n:id>) — révèle l'ID du serveur source
//   - Aucune URL discord.com/channels/X/Y/Z ni discord.gg/X
//   - Aucun nom d'auteur, ni nom de serveur source, ni ID
//   - Aucune attachment URL Discord (cdn.discordapp.com, media.discordapp.net)
//   - Le texte original n'est JAMAIS dump tel quel : on reconstruit l'embed
//     depuis un DTO structuré (ticker, prix, note nettoyée). C'est la
//     ligne de défense principale.
//   - Le timestamp de l'embed est arrondi à la minute (anti-fingerprint
//     sub-seconde permettant de corréler avec les logs source).
// ─────────────────────────────────────────────────────────────────────

const { EmbedBuilder } = require('discord.js');
const { extractPrices, detectTicker } = require('../utils/prices');

// Patterns à supprimer du texte avant insertion dans l'embed.
// Ordre important : les plus spécifiques en premier.
const PATTERNS = [
  // Mentions user, optionnel ! pour nick
  /<@!?\d+>/g,
  // Mentions de rôle
  /<@&\d+>/g,
  // Mentions de channel
  /<#\d+>/g,
  // Emoji custom statique <:nom:id> et animé <a:nom:id>
  /<a?:[A-Za-z0-9_]+:\d+>/g,
  // Liens Discord vers un message/channel/serveur (tous les TLDs)
  /https?:\/\/(?:www\.)?(?:discord(?:app)?\.com|discord\.gg|ptb\.discord\.com|canary\.discord\.com)\/\S+/gi,
  // CDN Discord (attachments, avatars) — révèlent souvent guild_id ou user_id
  /https?:\/\/(?:cdn|media)\.discord(?:app)?\.(?:com|net)\/\S+/gi,
];

// Strip exhaustif de toute trace Discord. Retourne un texte "safe" pour
// affichage côté client. NE GARDE PAS d'espaces multiples — collapse à 1.
// Trim final.
function sanitizeText(s) {
  if (!s) return '';
  let out = String(s);
  for (const re of PATTERNS) out = out.replace(re, '');
  // Strip @everyone / @here même non-mention (au cas où dans le texte brut)
  out = out.replace(/@everyone\b/gi, '').replace(/@here\b/gi, '');
  // Collapse whitespace + trim
  return out.replace(/\s+/g, ' ').trim();
}

// Variante de sanitizeText qui préserve les sauts de ligne — nécessaire
// pour les messages multi-section (IPO, recaps structurés) où la
// structure visuelle (paragraphes, bullets) porte du sens. On strip les
// patterns Discord identiques, mais on collapse uniquement les espaces
// horizontaux (pas les \n).
//
// Comportement : trim chaque ligne, max 2 \n consécutifs, trim global.
function sanitizeTextPreserveLines(s) {
  if (!s) return '';
  let out = String(s);
  for (const re of PATTERNS) out = out.replace(re, '');
  out = out.replace(/@everyone\b/gi, '').replace(/@here\b/gi, '');
  return out
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Arrondit un Date (ou ms) à la minute (secondes/ms à 0). Renvoie un Date.
// Anti-fingerprint : empêche la corrélation par timestamp sub-seconde
// entre le message source et le message relayé.
function roundToMinute(d) {
  const ms = d instanceof Date ? d.getTime() : Number(d);
  return new Date(Math.floor(ms / 60000) * 60000);
}

// Détecte la direction du trade. Conservatif : long par défaut, short
// uniquement si un mot-clé explicite est présent. On ne se fie PAS à
// l'ordre entry/target (parfois target<entry pour un trail/exit annoncé).
const SHORT_RE = /\b(?:short|puts?|bearish|downside|fade|sell\s+to\s+open)\b/i;
function detectSide(text) {
  return SHORT_RE.test(text || '') ? 'short' : 'long';
}

// Construit un DTO structuré depuis un message Discord brut.
// `message` peut être un Discord.js Message OU un objet plain
// { id, content, createdAt }. Aucune dépendance à un Client.
//
// Le DTO ne contient AUCUN champ identifiant la source : pas d'auteur,
// pas de guild_id, pas de channel_id. Seul `source_message_id` est
// présent — il sert au logging interne (relay_log) et NE doit JAMAIS
// apparaître dans l'embed envoyé au client.
// Détecte les scénarios conditionnels d'un signal multi-trigger.
// Pattern : "<prix> <break|bounce|reclaim|hold|reject>"
// Ex: "2.49 break or 1.88 bounce" → 2 scénarios.
const SCENARIO_RE = /\$?(\d+(?:\.\d+)?)\s+(breakout|breaks?|bouncing?|bounces?|reclaim(?:s|ing)?|reject(?:s|ing)?|hold(?:s|ing)?)\b/gi;

const SCENARIO_META = {
  break:    { type: 'break',   emoji: '🔼', label: 'Break entry' },
  breakout: { type: 'break',   emoji: '🔼', label: 'Break entry' },
  bounce:   { type: 'bounce',  emoji: '🔽', label: 'Bounce entry' },
  reclaim:  { type: 'reclaim', emoji: '🔼', label: 'Reclaim entry' },
  hold:     { type: 'hold',    emoji: '🔽', label: 'Hold entry' },
  reject:   { type: 'reject',  emoji: '🔻', label: 'Reject entry' },
};

function parseScenarios(text) {
  if (!text) return [];
  const out = [];
  SCENARIO_RE.lastIndex = 0;
  let m;
  while ((m = SCENARIO_RE.exec(text)) !== null) {
    const price = parseFloat(m[1]);
    if (!Number.isFinite(price)) continue;
    // Normalise le mot-clé (strip 's', 'ing')
    const word = m[2].toLowerCase()
      .replace(/^breakouts?$/, 'breakout')
      .replace(/^breaks?$/, 'break')
      .replace(/^bouncing|bounces?$/, 'bounce')
      .replace(/^reclaim(s|ing)?$/, 'reclaim')
      .replace(/^reject(s|ing)?$/, 'reject')
      .replace(/^hold(s|ing)?$/, 'hold');
    const meta = SCENARIO_META[word];
    if (!meta) continue;
    out.push({ ...meta, price });
  }
  return out;
}

// Détecte un target via "for X" — pattern stricte : "for $X" en fin de
// phrase ou suivi d'espaces, avec X price-like (< 10 000).
// Ex: "for 2.97" → 2.97.
function parseTargetForPattern(text) {
  if (!text) return null;
  const m = text.match(/\bfor\s+\$?(\d+(?:\.\d+)?)\b(?!\s*%)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0 || v >= 10000) return null;
  return v;
}

// "buy only above $X" / "buy above $X" / "buy only below $X" — trigger
// conditionnel sur le prix d'entrée.
function parseBuyCondition(text) {
  if (!text) return null;
  const above = text.match(/\bbuy\s+(?:only\s+)?above\s+\$?(\d+(?:\.\d+)?)/i);
  if (above) {
    const price = parseFloat(above[1]);
    if (Number.isFinite(price) && price > 0 && price < 100000) {
      return { condition: 'above', price };
    }
  }
  const below = text.match(/\bbuy\s+(?:only\s+)?below\s+\$?(\d+(?:\.\d+)?)/i);
  if (below) {
    const price = parseFloat(below[1]);
    if (Number.isFinite(price) && price > 0 && price < 100000) {
      return { condition: 'below', price };
    }
  }
  return null;
}

// "add @$X" / "add at $X" / "DCA $X" / "averaged in @$X" — entrée DCA
// secondaire (renforcer la position si le prix baisse après l'entrée
// primaire).
function parseAddEntry(text) {
  if (!text) return null;
  const m = text.match(/\b(?:add|dca|averaged?(?:\s+in)?|scale\s+in)\b\s*(?:@|at)?\s*\$?(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 && v < 100000 ? v : null;
}

// "Targets $X/$Y/$Z" / "TP $X, $Y, $Z" — ladder de targets multiples.
// Retourne [] si keyword non trouvé. Préserve l'ordre du message.
function parseTargetLadder(text) {
  if (!text) return [];
  // Match "targets" / "target" / "tp" / "tps" suivi du segment de prix.
  // (?!\sloss) pour éviter de matcher "stop loss" ou "target loss".
  const m = text.match(/\b(?:targets?|tps?)\b[:.\-=]?\s+([^\n]+)/i);
  if (!m) return [];
  // Tronque au premier mot-clé d'une autre section (sl, stop, note, etc.)
  const segment = m[1].split(/\b(?:sl|stop|note|sl\b|target\s+loss)\b/i)[0];
  const nums = (segment.match(/\d+(?:\.\d+)?/g) || [])
    .map(n => parseFloat(n))
    .filter(n => Number.isFinite(n) && n > 0 && n < 100000);
  return nums;
}

// "Note: ..." → texte de la note du trader (typiquement gestion du risque
// ou conseil de safety). Limité à 200 chars pour éviter de dump tout le
// message si le pattern matche trop large.
function parseSignalNote(text) {
  if (!text) return null;
  const m = text.match(/\bnote\s*[:.\-–]?\s*(.+)$/i);
  if (!m) return null;
  const note = m[1].trim();
  if (!note) return null;
  return note.slice(0, 200);
}

// Détecte un message de STATUS / EXIT (target hit, stop hit, take profit,
// scaled out, etc.) plutôt qu'un nouveau signal d'entrée. Ces messages
// contiennent typiquement un range de prix qui ressemble à un setup mais
// rapportent en fait un trade déjà en cours.
//
// Ex: "UONE first PT hit 6.30-7.50" → l'extracteur de prix voit
// entry=6.30, target=7.50 alors que c'est juste l'annonce d'un PT atteint.
//
// Liste conservatrice (past tense / phrases sans ambiguïté). Ne matche
// PAS les verbes nus ("trim", "scale") qui pourraient apparaître dans un
// signal d'entrée comme directive future.
const EXIT_STATUS_PATTERNS = [
  // "PT hit" / "first PT hit" / "TP hit" / "target reached" / "target tagged"
  /\b(?:pt|tp|target)s?\s+(?:hit|reached|tagged?|done|complete[d]?|achieved)\b/i,
  // "stopped out" / "stop hit" / "stop tagged" / "stop triggered" / "stop loss hit"
  /\bstopped\s+out\b/i,
  /\bstop(?:\s+loss)?\s+(?:hit|tagged?|triggered)\b/i,
  // Past-tense exits partiels — clairement un statut, pas une intention
  /\btrimmed\b/i,
  /\bscaled\s+(?:out|some|half|partial|down)\b/i,
  /\bscaling\s+(?:out|some|down|half)\b/i,
  // "sold" / "sold off" / "exited" / "closed (position|out|@|at)"
  /\bsold\b/i,
  /\bexited\b/i,
  /\bclosed\s+(?:position|out|@|at|\$)/i,
  // "took profits" / "taking profits" / "locked in"
  /\b(?:took|taking)\s+profits?\b/i,
  /\blocked\s+in\b/i,
];

function parseExitStatus(text) {
  if (!text) return false;
  for (const re of EXIT_STATUS_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Exit suggestions — instructions positives de sortie
// ─────────────────────────────────────────────────────────────────────
// Format compact : "TICKER X-Y[emoji]" (ex: "ELPW 6.60-9🔥"). Ces messages
// indiquent au client de SORTIR de sa position dans la zone de prix
// indiquée. Ne PAS confondre avec un signal d'entrée long :
//
//   $AAPL entry 150 target 160 sl 145   ← signal classique (entrée)
//   ELPW 6.60-9🔥                       ← suggestion de sortie
//
// Heuristique stricte (anti-faux-positif) :
//   - Message court (≤ 80 chars trimmés)
//   - Pas de mots-clés de signal (entry/target/stop/sl/tp/in at/long/short/...)
//   - Match exact : ^TICKER PRICE-PRICE [emoji]?$  (rien d'autre)
//   - Supporte `-`, `–` (en dash), `—` (em dash)
//   - Supporte $TICKER ou TICKER (dollar optionnel)
//
// Retourne { ticker, low, high } ou null.
const EXIT_SUGGESTION_BLOCKERS = /\b(?:entry|target|stop|sl|tp|in\s+at|adding|add|long|short|swing|alert|setup|watch)\b/i;
const EXIT_SUGGESTION_RE = /^\s*\$?([A-Z]{1,6})\s+(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(\p{Extended_Pictographic}*)\s*$/u;

function isExitSuggestion(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (t.length === 0 || t.length > 80) return null;
  if (EXIT_SUGGESTION_BLOCKERS.test(t)) return null;
  const m = t.match(EXIT_SUGGESTION_RE);
  if (!m) return null;
  const low = parseFloat(m[2]);
  const high = parseFloat(m[3]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { ticker: m[1], low, high };
}

// Embed dédié aux suggestions de sortie. Couleur ambre (distincte des
// signaux cyan et des IPOs teal) pour signaler visuellement "exit" et non
// "nouveau trade". Footer rappelle que c'est une sortie, pas une entrée.
const EXIT_EMBED_COLOR = 0xf59e0b; // amber-500

function brandedEmbedExit(parsed, brand, createdAt) {
  const eb = new EmbedBuilder()
    .setColor(EXIT_EMBED_COLOR)
    .setTitle(`🚪 EXIT — $${parsed.ticker}`)
    .addFields({
      name: 'Suggested exit zone',
      value: `**${fmtPrice(parsed.low)}–${fmtPrice(parsed.high)}**`,
      inline: false,
    })
    .setFooter({ text: `via ${brand.BRAND_NAME} · suggested exit, not a new entry` })
    .setTimestamp(createdAt ? roundToMinute(createdAt) : new Date());
  if (brand.BRAND_THUMBNAIL_URL) eb.setThumbnail(brand.BRAND_THUMBNAIL_URL);
  return eb;
}

// ─────────────────────────────────────────────────────────────────────
// IPO announcements — détection + parsing
// ─────────────────────────────────────────────────────────────────────
// Les messages IPO ont une structure multi-section qui ne rentre pas dans
// le modèle entry/target/stop. Format typique :
//
//   📅 IPOs expected next week
//
//   $TICKER1 – Name
//   • bullet
//   • bullet
//
//   $TICKER2 – Name
//   • bullet
//
//   🗓 Both expected to trade: ...
//
// Heuristique stricte : "IPO" + au moins 1 $TICKER + un mot-clé financier
// (raise, valuation, price range, expected to trade, shares, market cap).
const IPO_FINANCIAL_KEYWORDS = /\b(?:raise|valuation|price\s+range|expected\s+to\s+trade|shares?|float|market\s+cap)\b/i;

function isIPOAnnouncement(text) {
  if (!text) return false;
  if (!/\bipos?\b/i.test(text)) return false;
  if (!/\$[A-Z]{1,6}\b/.test(text)) return false;
  if (!IPO_FINANCIAL_KEYWORDS.test(text)) return false;
  return true;
}

// Parse un message IPO en blocs structurés. Retourne :
//   { header: string|null, ipos: [{ ticker, name, bullets }], footer: string|null }
// ou null si le message n'est pas reconnu comme IPO.
//
// Stratégie : split par double newline (\n\s*\n). Chaque bloc commençant
// par "$TICKER" est traité comme un IPO ; les blocs avant le premier
// $TICKER deviennent le header ; les blocs après deviennent le footer.
function parseIPOAnnouncement(text) {
  if (!text) return null;
  if (!isIPOAnnouncement(text)) return null;

  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  let header = null;
  let footer = null;
  const ipos = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const firstLine = lines[0];

    // Bloc IPO : première ligne commence par "$TICKER" suivi optionnellement
    // d'un séparateur (–, -, —, :) et du nom de la société.
    const tickerMatch = firstLine.match(/^\$([A-Z]{1,6})\b\s*[–\-—:]?\s*(.*)$/);
    if (tickerMatch) {
      const ticker = tickerMatch[1];
      const name = (tickerMatch[2] || '').trim();
      const bullets = lines.slice(1)
        .map(l => l.replace(/^[•\-\*▪◆►]\s*/, '').trim())
        .filter(Boolean);
      ipos.push({
        ticker,
        name: name || null,
        bullets,
      });
    } else if (ipos.length === 0) {
      header = header ? `${header}\n${block}` : block;
    } else {
      footer = footer ? `${footer}\n${block}` : block;
    }
  }

  if (ipos.length === 0) return null;
  return { header, ipos, footer };
}

function buildSignalDTO(message) {
  const rawContent = message?.content || '';
  const cleanContent = sanitizeText(rawContent);
  const prices = extractPrices(cleanContent);
  const ticker = detectTicker(cleanContent);
  const side = detectSide(rawContent);
  const scenarios = parseScenarios(cleanContent);
  const targetFromFor = parseTargetForPattern(cleanContent);
  const buy_condition = parseBuyCondition(cleanContent);
  const add_entry_price = parseAddEntry(cleanContent);
  const targets_ladder = parseTargetLadder(cleanContent);
  const signal_note = parseSignalNote(cleanContent);
  const is_exit_update = parseExitStatus(cleanContent);
  const createdAt = message?.createdAt instanceof Date
    ? message.createdAt
    : new Date(message?.createdAt || message?.createdTimestamp || Date.now());

  // Liste finale de targets : priorité au ladder explicite, fallback sur
  // target_price (single) ou targetFromFor.
  let targets = targets_ladder.slice();
  if (targets.length === 0) {
    if (prices.target_price != null) targets.push(prices.target_price);
    else if (targetFromFor != null) targets.push(targetFromFor);
  }

  // target_price (champ legacy) = premier target du ladder pour rétrocompat
  const target_price = targets[0] != null ? targets[0] : null;

  // entry_price : extraction classique en priorité, sinon buy_condition,
  // sinon premier scénario. shouldRelay exige cette valeur.
  const entry_price = prices.entry_price != null
    ? prices.entry_price
    : (buy_condition ? buy_condition.price : (scenarios[0]?.price || null));

  // Recalcule gain_pct si nécessaire
  let gain_pct = prices.gain_pct;
  if (gain_pct == null && entry_price != null && target_price != null && entry_price > 0) {
    gain_pct = parseFloat((((target_price - entry_price) / entry_price) * 100).toFixed(2));
  }

  // is_structured : le signal a une structure multi-section (multi-target,
  // entrée DCA, condition explicite, note du trader). Déclenche le layout
  // dédié structuré.
  const is_structured = (
    targets_ladder.length >= 2 ||
    add_entry_price != null ||
    signal_note != null ||
    buy_condition != null
  );

  return {
    ticker:           ticker || null,
    side:             side,
    entry_price,
    target_price,
    stop_price:       prices.stop_price,
    gain_pct,
    scenarios,                                    // [{ type, emoji, label, price }, ...]
    is_conditional:   scenarios.length >= 2,      // signal conditionnel break/bounce
    targets,                                       // ladder complet (1+ éléments)
    buy_condition,                                 // { condition: 'above'|'below', price }
    add_entry_price,                               // entrée DCA si présente
    signal_note,                                   // texte note du trader
    is_structured,                                 // signal multi-section
    is_exit_update,                                // status/exit (PT hit, stopped out, etc.)
    note:             cleanContent ? cleanContent.slice(0, 300) : null,
    ts_minute:        roundToMinute(createdAt),
    source_message_id: String(message?.id || ''),
  };
}

// Format un prix pour l'affichage. null/undefined → '—' (tiret cadratin).
function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  // Force au moins 2 décimales si le nombre n'est pas entier ; sinon arrondi à 4.
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 10) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(2);
  return n.toFixed(4); // sub-dollar : plus de précision
}

// Construit un embed pour un signal STRUCTURÉ : entrée principale (avec
// condition above/below), entrée DCA optionnelle, ladder de 1-N targets,
// stop loss, et note optionnelle du trader.
function brandedEmbedStructured(dto, brand) {
  const eb = new EmbedBuilder()
    .setColor(brand.BRAND_COLOR)
    .setTitle(dto.ticker ? `$${dto.ticker}` : 'Signal')
    .setFooter({ text: `via ${brand.BRAND_NAME}` })
    .setTimestamp(dto.ts_minute);

  const lines = [];

  // ── Section entrées ──
  if (dto.buy_condition) {
    const cond = dto.buy_condition.condition === 'above' ? 'above' : 'below';
    lines.push(`🟢 **Buy ${cond}:** $${fmtPrice(dto.buy_condition.price)}`);
  } else if (dto.entry_price != null) {
    lines.push(`🟢 **Entry:** $${fmtPrice(dto.entry_price)}`);
  }
  if (dto.add_entry_price != null) {
    lines.push(`➕ **Add (if down):** $${fmtPrice(dto.add_entry_price)}`);
  }

  // ── Section targets ──
  if (dto.targets && dto.targets.length > 0) {
    lines.push('');
    if (dto.targets.length === 1) {
      lines.push(`🎯 **Target:** $${fmtPrice(dto.targets[0])}`);
    } else {
      lines.push(`🎯 **Targets:**`);
      for (const t of dto.targets) {
        lines.push(`  • $${fmtPrice(t)}`);
      }
    }
  }

  // ── Section risque ──
  if (dto.stop_price != null) {
    lines.push(`🛑 **Stop:** $${fmtPrice(dto.stop_price)}`);
  }

  // ── Note du trader ──
  if (dto.signal_note) {
    lines.push('');
    lines.push(`📝 ${dto.signal_note}`);
  }

  eb.setDescription(lines.join('\n'));

  if (brand.BRAND_THUMBNAIL_URL) eb.setThumbnail(brand.BRAND_THUMBNAIL_URL);
  if (brand.BRAND_IMAGE_URL) eb.setImage(brand.BRAND_IMAGE_URL);

  return eb;
}

// Construit un embed pour un signal CONDITIONNEL multi-scénarios.
// Layout dédié : titre "$TICKER — Only if", description avec scénarios
// listés et séparés par "OR IF", target+stop en fin.
function brandedEmbedConditional(dto, brand) {
  const eb = new EmbedBuilder()
    .setColor(brand.BRAND_COLOR)
    .setTitle(`${dto.ticker ? '$' + dto.ticker : 'Signal'} — Only if`)
    .setFooter({ text: `via ${brand.BRAND_NAME}` })
    .setTimestamp(dto.ts_minute);

  const lines = [];
  for (let i = 0; i < dto.scenarios.length; i++) {
    const s = dto.scenarios[i];
    lines.push(`${s.emoji} **${s.label}:** ${fmtPrice(s.price)}`);
    if (i < dto.scenarios.length - 1) {
      lines.push('**OR IF**');
    }
  }
  // Sépare la section trigger de la section objectif.
  if (dto.target_price != null || dto.stop_price != null) {
    lines.push('');
  }
  if (dto.target_price != null) {
    lines.push(`🎯 **Target:** ${fmtPrice(dto.target_price)}`);
  }
  if (dto.stop_price != null) {
    lines.push(`🛑 **Stop:** ${fmtPrice(dto.stop_price)}`);
  }
  if (dto.gain_pct != null && Number.isFinite(dto.gain_pct)) {
    const sign = dto.gain_pct >= 0 ? '+' : '';
    lines.push(`📈 **Potential:** ${sign}${dto.gain_pct.toFixed(2)}%`);
  }

  eb.setDescription(lines.join('\n'));

  if (brand.BRAND_THUMBNAIL_URL) eb.setThumbnail(brand.BRAND_THUMBNAIL_URL);
  if (brand.BRAND_IMAGE_URL) eb.setImage(brand.BRAND_IMAGE_URL);

  return eb;
}

// Construit un embed pour une annonce IPO multi-ticker. `ipoData` =
// { header, ipos: [{ ticker, name, bullets }], footer } produit par
// parseIPOAnnouncement (déjà sanitisé pour l'anonymisation).
//
// Layout : title = header (ou défaut), 1 field par IPO, footer optionnel
// dans un dernier field. Discord limites : 25 fields, name 256 chars,
// value 1024 chars, total 6000 chars — on tronque safe.
function brandedEmbedIPO(ipoData, brand, createdAt) {
  const eb = new EmbedBuilder()
    .setColor(brand.BRAND_COLOR)
    .setFooter({ text: `via ${brand.BRAND_NAME}` })
    .setTimestamp(createdAt ? roundToMinute(createdAt) : new Date());

  const title = (ipoData.header || '📅 IPO Announcement').slice(0, 256);
  eb.setTitle(title);

  // Hard cap 23 ipos pour laisser 1 field au footer + marge.
  const ipos = ipoData.ipos.slice(0, 23);
  for (const ipo of ipos) {
    const fieldName = (ipo.name ? `$${ipo.ticker} — ${ipo.name}` : `$${ipo.ticker}`).slice(0, 256);
    const value = ipo.bullets.length > 0
      ? ipo.bullets.map(b => `• ${b}`).join('\n')
      : '_(no details provided)_';
    eb.addFields({ name: fieldName, value: value.slice(0, 1024), inline: false });
  }

  if (ipoData.footer) {
    eb.addFields({
      name: '​',
      value: ipoData.footer.slice(0, 1024),
      inline: false,
    });
  }

  if (brand.BRAND_THUMBNAIL_URL) eb.setThumbnail(brand.BRAND_THUMBNAIL_URL);
  if (brand.BRAND_IMAGE_URL) eb.setImage(brand.BRAND_IMAGE_URL);

  return eb;
}

// Construit l'embed Discord branded depuis un DTO. PURE : retourne un
// EmbedBuilder, ne l'envoie pas. Le caller fait le `.send({ embeds: [...] })`
// avec `allowedMentions: { parse: [] }`.
//
// `brand` doit avoir { BRAND_NAME, BRAND_COLOR, BRAND_THUMBNAIL_URL?, BRAND_IMAGE_URL? }.
//
// Title : `$TICKER` seul (pas de LONG/SHORT — décision design : la couleur
// et le contexte des prix suffisent à indiquer la direction).
//
// Dispatcher : structured > conditional > simple. Le premier qui matche
// gagne. is_structured prime sur is_conditional (un signal peut être les
// deux : ex. "buy above X / 1.5 break or 1.0 bounce / Targets A/B/C").
function brandedEmbed(dto, brand) {
  if (dto.is_structured) {
    return brandedEmbedStructured(dto, brand);
  }
  if (dto.is_conditional) {
    return brandedEmbedConditional(dto, brand);
  }
  const title = dto.ticker ? `$${dto.ticker}` : 'Signal';

  const eb = new EmbedBuilder()
    .setColor(brand.BRAND_COLOR)
    .setTitle(title)
    .setFooter({ text: `via ${brand.BRAND_NAME}` })
    .setTimestamp(dto.ts_minute);

  // Champs prix : Entry / Target / Stop, inline pour rester compact.
  // Affichés même si null (avec '—') pour que le layout reste stable
  // entre les signaux complets et incomplets.
  eb.addFields(
    { name: 'Entry',  value: fmtPrice(dto.entry_price),  inline: true },
    { name: 'Target', value: fmtPrice(dto.target_price), inline: true },
    { name: 'Stop',   value: fmtPrice(dto.stop_price),   inline: true },
  );

  if (dto.gain_pct != null && Number.isFinite(dto.gain_pct)) {
    const sign = dto.gain_pct >= 0 ? '+' : '';
    eb.addFields({ name: 'Potential', value: `${sign}${dto.gain_pct.toFixed(2)}%`, inline: true });
  }

  if (dto.note) {
    eb.setDescription(dto.note);
  }

  // Thumbnail (haut-droite, ~80×80) : icône de marque discrète.
  if (brand.BRAND_THUMBNAIL_URL) {
    eb.setThumbnail(brand.BRAND_THUMBNAIL_URL);
  }

  // Image (bas, large bannière jusqu'à pleine largeur) : pour mettre en
  // valeur un logo détaillé. Si les deux sont définis, les deux sont rendus.
  if (brand.BRAND_IMAGE_URL) {
    eb.setImage(brand.BRAND_IMAGE_URL);
  }

  return eb;
}

module.exports = {
  sanitizeText,
  sanitizeTextPreserveLines,
  roundToMinute,
  detectSide,
  buildSignalDTO,
  brandedEmbed,
  brandedEmbedConditional,
  brandedEmbedStructured,
  fmtPrice,
  parseScenarios,
  parseTargetForPattern,
  parseBuyCondition,
  parseAddEntry,
  parseTargetLadder,
  parseSignalNote,
  parseExitStatus,
  EXIT_STATUS_PATTERNS,
  isExitSuggestion,
  brandedEmbedExit,
  isIPOAnnouncement,
  parseIPOAnnouncement,
  brandedEmbedIPO,
};
