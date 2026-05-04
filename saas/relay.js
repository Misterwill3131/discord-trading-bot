// ─────────────────────────────────────────────────────────────────────
// saas/relay.js — Orchestrateur de relais multi-tenant
// ─────────────────────────────────────────────────────────────────────
// Écoute messageCreate sur clientSource (serveur source uniquement, salons
// configurés). Pour chaque message valide :
//   1. buildSignalDTO (anonymisation structurée)
//   2. broadcast vers chaque licence active avec target_channel_id défini
//   3. log relay_log + UPDATE last_relay_at
//
// Erreurs isolées par client : si un guild client est inaccessible (kick,
// channel supprimé, perm manquante), on log et on passe au suivant. Pas
// de retry pour l'instant — Discord rate-limit est géré par discord.js.
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const licenses = require('./licenses');
const {
  buildSignalDTO,
  brandedEmbed,
  brandedEmbedIPO,
  sanitizeText,
  sanitizeTextPreserveLines,
  isIPOAnnouncement,
  parseIPOAnnouncement,
} = require('./anonymize');
const brand = require('./brand');

// Filtres heuristiques avant relais. On ne relaye QUE les messages où un
// prix d'entrée a été extrait — c'est le critère minimal d'un signal
// actionnable côté client. Tout le reste (recaps, commentaires, FYI,
// exits sans prix, news, etc.) est ignoré.
//
// Rejette aussi les messages de STATUS/EXIT (PT hit, stopped out, scaled
// out, sold, etc.) même s'ils contiennent un range de prix qui ressemble
// à un setup. Ex: "UONE first PT hit 6.30-7.50" — l'extracteur voit un
// range mais c'est en fait l'annonce d'une sortie.
//
// Les bots sont autorisés par défaut (les alertes des serveurs source
// proviennent souvent d'un webhook ou bot upstream). Le filtrage par auteur
// se fait via la denylist nommée (isAuthorBlocked) plus bas.
function shouldRelay(message, dto) {
  if (!message) return false;
  if (!dto) return false;
  if (dto.is_exit_update) return false;
  return dto.entry_price != null && Number.isFinite(dto.entry_price);
}

// Denylist par défaut — bots upstream connus pour spammer / poster des
// messages non actionnables. Override via env SAAS_BLOCKED_BOT_NAMES (csv).
// Match case-insensitive substring sur author.username.
const DEFAULT_BLOCKED_BOT_NAMES = ['frogoracle'];

function loadBlockedBotNames() {
  const env = process.env.SAAS_BLOCKED_BOT_NAMES;
  if (env == null) return DEFAULT_BLOCKED_BOT_NAMES.slice();
  const arr = String(env).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return arr.length > 0 ? arr : DEFAULT_BLOCKED_BOT_NAMES.slice();
}

// Vrai si l'auteur du message est un bot dont le username matche la
// denylist. Les humains et les bots non listés passent.
function isAuthorBlocked(message, blockedBotNames) {
  if (!message?.author?.bot) return false;
  const username = String(message.author.username || '').toLowerCase();
  if (!username) return false;
  const list = blockedBotNames || DEFAULT_BLOCKED_BOT_NAMES;
  for (const blocked of list) {
    if (blocked && username.includes(blocked)) return true;
  }
  return false;
}

// Bots dont les messages sont relayés "tel quel" — texte sanitisé envoyé
// en plain content (pas d'embed, pas de check shouldRelay). Override via
// env SAAS_PASSTHROUGH_BOT_NAMES (csv). Match case-insensitive substring.
//
// Le sanitize reste critique : sanitizeText supprime les mentions, emojis
// custom et URLs Discord qui pourraient leaker l'identité du serveur source.
const DEFAULT_PASSTHROUGH_BOT_NAMES = ['trendvision'];

function loadPassthroughBotNames() {
  const env = process.env.SAAS_PASSTHROUGH_BOT_NAMES;
  if (env == null) return DEFAULT_PASSTHROUGH_BOT_NAMES.slice();
  const arr = String(env).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return arr.length > 0 ? arr : DEFAULT_PASSTHROUGH_BOT_NAMES.slice();
}

function isPassthroughBot(message, passthroughNames) {
  if (!message?.author?.bot) return false;
  const username = String(message.author.username || '').toLowerCase();
  if (!username) return false;
  const list = passthroughNames || DEFAULT_PASSTHROUGH_BOT_NAMES;
  for (const name of list) {
    if (name && username.includes(name)) return true;
  }
  return false;
}

// Envoie un embed à UN guild client. Retourne l'objet { status, error, msgId }
// pour logging. Ne throw jamais — tous les erreurs sont capturées.
async function sendToClient(clientSaas, license, embed) {
  try {
    const guild = clientSaas.guilds.cache.get(license.guild_id);
    if (!guild) {
      return { status: 'skip', error: 'bot-not-in-guild' };
    }
    const channel = await clientSaas.channels.fetch(license.target_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return { status: 'error', error: 'channel-unavailable' };
    }
    const sent = await channel.send({
      embeds: [embed],
      // Ceinture+bretelles : strip toute mention résiduelle au moment du send.
      allowedMentions: { parse: [] },
    });
    return { status: 'ok', msgId: sent.id };
  } catch (err) {
    return { status: 'error', error: err.message ? err.message.slice(0, 200) : 'unknown' };
  }
}

// Broadcast vers toutes les licences prêtes. Renvoie le résumé numérique
// pour logging caller-side.
async function broadcast(clientSaas, dto) {
  const embed = brandedEmbed(dto, brand);
  const targets = licenses.listReadyForRelay();
  let ok = 0, skip = 0, error = 0;
  for (const lic of targets) {
    const res = await sendToClient(clientSaas, lic, embed);
    db.relayLogInsert({
      guild_id: lic.guild_id,
      source_message_id: dto.source_message_id,
      relayed_message_id: res.msgId || null,
      status: res.status,
      error: res.error || null,
    });
    if (res.status === 'ok') {
      ok++;
      db.licenseTouchRelay(lic.guild_id);
    } else if (res.status === 'skip') {
      skip++;
    } else {
      error++;
    }
  }
  return { ok, skip, error, total: targets.length };
}

// Envoie le contenu texte (déjà sanitisé) à UN guild client dans son
// passthrough_channel_id. Pas d'embed.
async function sendRawToClient(clientSaas, license, content) {
  try {
    const guild = clientSaas.guilds.cache.get(license.guild_id);
    if (!guild) {
      return { status: 'skip', error: 'bot-not-in-guild' };
    }
    if (!license.passthrough_channel_id) {
      return { status: 'skip', error: 'no-passthrough-channel' };
    }
    const channel = await clientSaas.channels.fetch(license.passthrough_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return { status: 'error', error: 'channel-unavailable' };
    }
    const sent = await channel.send({
      content,
      allowedMentions: { parse: [] },
    });
    return { status: 'ok', msgId: sent.id };
  } catch (err) {
    return { status: 'error', error: err.message ? err.message.slice(0, 200) : 'unknown' };
  }
}

// Broadcast en mode "passthrough" : relaie le texte sanitisé tel quel
// dans le passthrough_channel_id de chaque licence qui en a configuré un.
// Les clients sans passthrough_channel_id ne reçoivent PAS ces alertes
// (opt-in explicite via /setup-passthrough).
async function broadcastRaw(clientSaas, sourceMessageId, content) {
  const targets = licenses.listReadyForPassthrough();
  let ok = 0, skip = 0, error = 0;
  for (const lic of targets) {
    const res = await sendRawToClient(clientSaas, lic, content);
    db.relayLogInsert({
      guild_id: lic.guild_id,
      source_message_id: sourceMessageId,
      relayed_message_id: res.msgId || null,
      status: res.status,
      error: res.error || null,
    });
    if (res.status === 'ok') {
      ok++;
      db.licenseTouchRelay(lic.guild_id);
    } else if (res.status === 'skip') {
      skip++;
    } else {
      error++;
    }
  }
  return { ok, skip, error, total: targets.length };
}

// Envoie un embed IPO à UN guild client dans son ipo_channel_id.
async function sendIPOToClient(clientSaas, license, embed) {
  try {
    const guild = clientSaas.guilds.cache.get(license.guild_id);
    if (!guild) {
      return { status: 'skip', error: 'bot-not-in-guild' };
    }
    if (!license.ipo_channel_id) {
      return { status: 'skip', error: 'no-ipo-channel' };
    }
    const channel = await clientSaas.channels.fetch(license.ipo_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return { status: 'error', error: 'channel-unavailable' };
    }
    const sent = await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return { status: 'ok', msgId: sent.id };
  } catch (err) {
    return { status: 'error', error: err.message ? err.message.slice(0, 200) : 'unknown' };
  }
}

// Broadcast d'une annonce IPO : embed structuré multi-IPO envoyé dans
// l'ipo_channel_id de chaque licence qui en a configuré un (opt-in via
// /setup-ipo).
async function broadcastIPO(clientSaas, sourceMessageId, embed) {
  const targets = licenses.listReadyForIPO();
  let ok = 0, skip = 0, error = 0;
  for (const lic of targets) {
    const res = await sendIPOToClient(clientSaas, lic, embed);
    db.relayLogInsert({
      guild_id: lic.guild_id,
      source_message_id: sourceMessageId,
      relayed_message_id: res.msgId || null,
      status: res.status,
      error: res.error || null,
    });
    if (res.status === 'ok') {
      ok++;
      db.licenseTouchRelay(lic.guild_id);
    } else if (res.status === 'skip') {
      skip++;
    } else {
      error++;
    }
  }
  return { ok, skip, error, total: targets.length };
}

// Clé KV settings où sont persistées les overrides runtime.
// Si présente, l'array de channel IDs override l'env var SOURCE_CHANNEL_IDS.
// Modifiable à chaud via /saas source — pas de redeploy nécessaire.
const SETTINGS_KEY_SOURCE_CHANNELS = 'saas_source_channels';

// Lit les channels source effectifs à appliquer maintenant. Priorité :
//   1. Override DB (settings KV) si défini et non vide
//   2. Env var (csv) sinon
// Retourne un Set de strings.
function loadSourceChannels(envFallbackArray) {
  const override = db.getSetting(SETTINGS_KEY_SOURCE_CHANNELS, null);
  if (Array.isArray(override) && override.length > 0) {
    return new Set(override.map(String));
  }
  // Fallback env var
  const set = new Set();
  if (Array.isArray(envFallbackArray)) {
    for (const id of envFallbackArray) if (id) set.add(String(id).trim());
  } else if (typeof envFallbackArray === 'string') {
    for (const id of envFallbackArray.split(',')) if (id.trim()) set.add(id.trim());
  }
  return set;
}

// Persiste l'override en DB. Passer null/[] efface l'override (retombe sur env).
function setSourceChannels(channelIds) {
  if (!channelIds || (Array.isArray(channelIds) && channelIds.length === 0)) {
    db.setSetting(SETTINGS_KEY_SOURCE_CHANNELS, null);
    return [];
  }
  const arr = Array.isArray(channelIds)
    ? channelIds.map(String).map(s => s.trim()).filter(Boolean)
    : String(channelIds).split(',').map(s => s.trim()).filter(Boolean);
  db.setSetting(SETTINGS_KEY_SOURCE_CHANNELS, arr);
  return arr;
}

// Wire-up : enregistre le messageCreate listener sur clientSource.
// `opts` = { clientSource, clientSaas, sourceGuildId, sourceChannelIds (Set or csv) }.
//
// sourceChannelIds est utilisé comme FALLBACK uniquement — la liste effective
// est lue à chaque message via loadSourceChannels (qui priorise l'override DB).
function register({ clientSource, clientSaas, sourceGuildId, sourceChannelIds }) {
  if (!clientSource || !clientSaas) {
    console.warn('[saas/relay] clientSource and clientSaas required — skipping wire-up');
    return;
  }
  if (clientSource.__saasRelayRegistered) return;
  clientSource.__saasRelayRegistered = true;

  if (!sourceGuildId) {
    console.warn('[saas/relay] SOURCE_GUILD_ID not set — relay will accept any guild (NOT recommended)');
  }

  clientSource.on('messageCreate', async (message) => {
    try {
      // Filtre 1 : guild source
      if (sourceGuildId && message.guildId !== sourceGuildId) return;
      // Filtre 2 : channel source — lecture dynamique (override DB possible)
      const channelSet = loadSourceChannels(sourceChannelIds);
      const blockedBotNames = loadBlockedBotNames();
      if (channelSet.size > 0 && !channelSet.has(message.channelId)) {
        // Diagnostic : si le message AURAIT été un signal valide (entry_price
        // extrait OU bot passthrough), on log l'ID du channel manquant.
        // Permet à l'admin de découvrir quels channels ajouter à
        // SOURCE_CHANNEL_IDS sans copier les IDs un par un depuis Discord.
        try {
          if (!isAuthorBlocked(message, blockedBotNames) && message.guildId) {
            if (isIPOAnnouncement(message.content || '')) {
              console.log(
                `[saas/relay] MISSED IPO — channel="${message.channel?.name || '?'}" ` +
                `id=${message.channelId} (add to SOURCE_CHANNEL_IDS to relay)`
              );
            } else if (isPassthroughBot(message, loadPassthroughBotNames())) {
              console.log(
                `[saas/relay] MISSED passthrough — channel="${message.channel?.name || '?'}" ` +
                `id=${message.channelId} author="${message.author?.username || '?'}" ` +
                `(add to SOURCE_CHANNEL_IDS to relay)`
              );
            } else {
              const dto = buildSignalDTO(message);
              if (shouldRelay(message, dto)) {
                console.log(
                  `[saas/relay] MISSED signal — channel="${message.channel?.name || '?'}" ` +
                  `id=${message.channelId} ticker=${dto.ticker || '-'} entry=${dto.entry_price} ` +
                  `(add to SOURCE_CHANNEL_IDS to relay)`
                );
              }
            }
          }
        } catch (_) {
          // best-effort log only
        }
        return;
      }
      // À ce stade : message dans source guild + channel listé. Diagnostic
      // détaillé pour comprendre pourquoi un signal pourrait ne pas passer.
      // On log sur chaque rejet POST-channel-filter pour voir ce qui se passe.

      // Filtre 3 : pas de DM
      if (!message.guildId) {
        console.log(`[saas/relay] reject: no guildId (DM?) msg=${message.id}`);
        return;
      }
      // Filtre 4 : auteur dans la denylist (bots upstream blacklistés).
      // Les humains et les bots non listés passent — un signal valide d'un
      // bot autorisé (ex: webhook upstream) est relayé normalement.
      if (isAuthorBlocked(message, blockedBotNames)) {
        console.log(
          `[saas/relay] reject: author blocked — author="${message.author?.username || '?'}" ` +
          `id=${message.author?.id} msg=${message.id}`
        );
        return;
      }

      // Filtre 5a : annonce IPO (multi-ticker, format structuré). Bypass
      // shouldRelay (ne rentre pas dans le modèle entry/target/stop). Détecté
      // via heuristique stricte : "IPO" + $TICKER + mot-clé financier.
      if (isIPOAnnouncement(message.content || '')) {
        const sanitized = sanitizeTextPreserveLines(message.content || '');
        const parsed = parseIPOAnnouncement(sanitized);
        if (!parsed || parsed.ipos.length === 0) {
          console.log(
            `[saas/relay] IPO detected but parse failed — author="${message.author?.username || '?'}" ` +
            `msg=${message.id}`
          );
          return;
        }
        if (!clientSaas.isReady?.()) {
          console.warn('[saas/relay] clientSaas not ready — skipping IPO broadcast');
          return;
        }
        const embed = brandedEmbedIPO(parsed, brand, message.createdAt);
        const result = await broadcastIPO(clientSaas, String(message.id), embed);
        console.log(
          `[saas/relay] IPO msg=${message.id} tickers=[${parsed.ipos.map(i => i.ticker).join(',')}] ` +
          `→ ok=${result.ok} skip=${result.skip} err=${result.error} (of ${result.total})`
        );
        return;
      }

      // Filtre 5 : bot passthrough (relayer texte brut sans embed). Bypass
      // shouldRelay et buildSignalDTO — ces bots sont des sources d'alertes
      // qu'on relaie tel quel.
      if (isPassthroughBot(message, loadPassthroughBotNames())) {
        const sanitized = sanitizeText(message.content || '');
        if (!sanitized) {
          console.log(
            `[saas/relay] passthrough skip: empty after sanitize — ` +
            `author="${message.author?.username || '?'}" msg=${message.id}`
          );
          return;
        }
        if (!clientSaas.isReady?.()) {
          console.warn('[saas/relay] clientSaas not ready — skipping passthrough broadcast');
          return;
        }
        const result = await broadcastRaw(clientSaas, String(message.id), sanitized);
        console.log(
          `[saas/relay] passthrough msg=${message.id} author="${message.author?.username || '?'}" ` +
          `→ ok=${result.ok} skip=${result.skip} err=${result.error} (of ${result.total})`
        );
        return;
      }

      const dto = buildSignalDTO(message);
      if (!shouldRelay(message, dto)) {
        // Logge uniquement si le message contient AU MOINS un ticker détecté ou
        // un nombre — sinon c'est un bavardage banal qu'on n'a pas à diagnostiquer.
        const rawHasNumber = /\d/.test(message.content || '');
        if (dto.ticker || rawHasNumber) {
          const preview = (message.content || '').replace(/\s+/g, ' ').slice(0, 80);
          console.log(
            `[saas/relay] reject: shouldRelay=false — ticker=${dto.ticker || '-'} ` +
            `entry=${dto.entry_price} target=${dto.target_price} exit_update=${dto.is_exit_update} ` +
            `author="${message.author?.username || '?'}" content="${preview}"`
          );
        }
        return;
      }

      // Vérifie clientSaas est ready avant de broadcast
      if (!clientSaas.isReady?.()) {
        console.warn('[saas/relay] clientSaas not ready — skipping broadcast');
        return;
      }

      const result = await broadcast(clientSaas, dto);
      console.log(
        `[saas/relay] msg=${dto.source_message_id} ticker=${dto.ticker || '-'} ` +
        `→ ok=${result.ok} skip=${result.skip} err=${result.error} (of ${result.total})`
      );
    } catch (err) {
      console.error('[saas/relay] messageCreate handler error:', err.message);
    }
  });

  // Log initial du channelSet effectif (DB override OR env fallback)
  const effective = loadSourceChannels(sourceChannelIds);
  console.log(
    `[saas/relay] Registered. sourceGuild=${sourceGuildId || '*'} ` +
    `channels=[${[...effective].join(',') || '*'}] ` +
    `(source: ${db.getSetting(SETTINGS_KEY_SOURCE_CHANNELS, null) ? 'DB override' : 'env fallback'})`
  );
}

module.exports = {
  register,
  broadcast,                  // exposé pour tests
  broadcastRaw,               // exposé pour tests
  broadcastIPO,               // exposé pour tests
  shouldRelay,                // exposé pour tests
  isAuthorBlocked,            // exposé pour tests
  isPassthroughBot,           // exposé pour tests
  loadBlockedBotNames,        // exposé pour tests
  loadPassthroughBotNames,    // exposé pour tests
  loadSourceChannels,         // exposé pour /saas source list
  setSourceChannels,          // exposé pour /saas source set
  DEFAULT_BLOCKED_BOT_NAMES,
  DEFAULT_PASSTHROUGH_BOT_NAMES,
  SETTINGS_KEY_SOURCE_CHANNELS,
};
