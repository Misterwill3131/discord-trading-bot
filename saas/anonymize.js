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
function buildSignalDTO(message) {
  const rawContent = message?.content || '';
  const cleanContent = sanitizeText(rawContent);
  const prices = extractPrices(cleanContent);
  const ticker = detectTicker(cleanContent);
  const side = detectSide(rawContent);
  const createdAt = message?.createdAt instanceof Date
    ? message.createdAt
    : new Date(message?.createdAt || message?.createdTimestamp || Date.now());

  return {
    ticker:           ticker || null,
    side:             side,
    entry_price:      prices.entry_price,
    target_price:     prices.target_price,
    stop_price:       prices.stop_price,
    gain_pct:         prices.gain_pct,
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

// Construit l'embed Discord branded depuis un DTO. PURE : retourne un
// EmbedBuilder, ne l'envoie pas. Le caller fait le `.send({ embeds: [...] })`
// avec `allowedMentions: { parse: [] }`.
//
// `brand` doit avoir { BRAND_NAME, BRAND_COLOR, BRAND_THUMBNAIL_URL?, BRAND_IMAGE_URL? }.
//
// Title : `$TICKER` seul (pas de LONG/SHORT — décision design : la couleur
// et le contexte des prix suffisent à indiquer la direction).
function brandedEmbed(dto, brand) {
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
  roundToMinute,
  detectSide,
  buildSignalDTO,
  brandedEmbed,
  fmtPrice,
};
