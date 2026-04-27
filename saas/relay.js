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
const { buildSignalDTO, brandedEmbed } = require('./anonymize');
const brand = require('./brand');

// Filtres heuristiques avant relais. On ne relaye PAS :
//   - Les messages du bot lui-même
//   - Les messages vides (après sanitize)
//   - Les messages qui n'ont ni ticker ni prix extraits (= bavardage,
//     pas un signal exploitable)
function shouldRelay(message, dto) {
  if (!message) return false;
  if (message.author?.bot) return false;
  if (!dto) return false;
  // Au moins un signal exploitable (ticker OU au moins un prix)
  const hasSignal = dto.ticker
    || dto.entry_price != null
    || dto.target_price != null
    || dto.stop_price != null;
  return Boolean(hasSignal);
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

// Wire-up : enregistre le messageCreate listener sur clientSource.
// `opts` = { clientSource, clientSaas, sourceGuildId, sourceChannelIds (Set or csv) }.
function register({ clientSource, clientSaas, sourceGuildId, sourceChannelIds }) {
  if (!clientSource || !clientSaas) {
    console.warn('[saas/relay] clientSource and clientSaas required — skipping wire-up');
    return;
  }
  if (clientSource.__saasRelayRegistered) return;
  clientSource.__saasRelayRegistered = true;

  // Normaliser sourceChannelIds en Set
  const channelSet = new Set();
  if (Array.isArray(sourceChannelIds)) {
    for (const id of sourceChannelIds) if (id) channelSet.add(String(id).trim());
  } else if (typeof sourceChannelIds === 'string') {
    for (const id of sourceChannelIds.split(',')) if (id.trim()) channelSet.add(id.trim());
  } else if (sourceChannelIds instanceof Set) {
    for (const id of sourceChannelIds) channelSet.add(String(id));
  }

  if (!sourceGuildId) {
    console.warn('[saas/relay] SOURCE_GUILD_ID not set — relay will accept any guild (NOT recommended)');
  }
  if (channelSet.size === 0) {
    console.warn('[saas/relay] SOURCE_CHANNEL_IDS empty — relay disabled until configured');
  }

  clientSource.on('messageCreate', async (message) => {
    try {
      // Filtre 1 : guild source
      if (sourceGuildId && message.guildId !== sourceGuildId) return;
      // Filtre 2 : channel source
      if (channelSet.size > 0 && !channelSet.has(message.channelId)) return;
      // Filtre 3 : pas de bot, pas de DM
      if (!message.guildId) return;
      if (message.author?.bot) return;

      const dto = buildSignalDTO(message);
      if (!shouldRelay(message, dto)) return;

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

  console.log(
    `[saas/relay] Registered. sourceGuild=${sourceGuildId || '*'} channels=[${[...channelSet].join(',') || '*'}]`
  );
}

module.exports = {
  register,
  broadcast,    // exposé pour tests
  shouldRelay,  // exposé pour tests
};
