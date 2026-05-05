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
const pg = require('../db/postgres');
const licenses = require('./licenses');
const llmClassify = require('../services/llm-classify');
const {
  buildSignalDTO,
  brandedEmbed,
  brandedEmbedIPO,
  brandedEmbedExit,
  sanitizeText,
  sanitizeTextPreserveLines,
  isIPOAnnouncement,
  parseIPOAnnouncement,
  isExitSuggestion,
  looksLikeShortSignal,
} = require('./anonymize');

// Seuil de confiance LLM minimum pour acter sur une classification. En
// dessous, on log mais on ne broadcast pas (évite faux positifs LLM).
const LLM_CONFIDENCE_THRESHOLD = parseFloat(process.env.LLM_CLASSIFY_MIN_CONFIDENCE || '0.7');

// Heuristique légère : "ce message MÉRITE qu'on dépense un appel LLM ?"
// On évite d'appeler le LLM sur du chatter pur ("lol", "thanks") pour
// limiter les coûts. On exige a minima un ticker pattern (1-6 majuscules
// précédé éventuellement de $) OU au moins 2 nombres.
function looksWorthLLM(text) {
  if (!text) return false;
  const t = String(text);
  if (t.length < 4 || t.length > 500) return false;
  const hasTicker = /\$?[A-Z]{2,6}\b/.test(t);
  const numCount = (t.match(/\d+(?:\.\d+)?/g) || []).length;
  return hasTicker || numCount >= 2;
}
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
//
// Pour chaque relay vers un guild client, on log dans 2 endroits :
// - SQLite relay_log (audit primaire du bot, déjà existant)
// - Postgres signal_relays (lu par le site pour stats + recent feed
//   sur /account dashboard) — best-effort, no-op si DATABASE_URL absent
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
    // Mirror Postgres pour le dashboard customer (best-effort).
    pg.insertSignalRelay({
      guildId: lic.guild_id,
      ticker: dto.ticker,
      side: dto.side, // 'long' | 'short' | undefined
      entryPrice: dto.entry_price,
      targetPrice: dto.target_price,
      stopPrice: dto.stop_price,
      sourceMessageId: dto.source_message_id,
      relayedMessageId: res.msgId || null,
      status: res.status,
    }).catch(() => {});
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

// Broadcast d'une suggestion de sortie : embed dédié envoyé dans le
// target_channel_id (même salon que les signaux d'entrée — cohérence du
// lifecycle de la position : entry → exit lus dans le même fil).
async function broadcastExit(clientSaas, sourceMessageId, embed) {
  const targets = licenses.listReadyForRelay();
  let ok = 0, skip = 0, error = 0;
  for (const lic of targets) {
    const res = await sendToClient(clientSaas, lic, embed);
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
// Appelle le LLM pour classifier un message rejeté par les heuristiques,
// puis broadcast selon la classification. Best-effort : tout échec
// (API down, JSON malformé, low confidence) → log silencieux + return.
//
// Important : NE broadcast QUE si confiance >= LLM_CONFIDENCE_THRESHOLD
// pour éviter d'inonder les clients de faux positifs LLM.
async function tryLLMFallback(clientSaas, message) {
  const result = await llmClassify.classify(message.content || '');
  if (!result) return; // API indispo / JSON invalide / disabled
  const { type, entities, cached, latencyMs, model } = result;
  const conf = entities?.confidence ?? 0;

  console.log(
    `[saas/relay] LLM msg=${message.id} type=${type} ticker=${entities?.ticker || '-'} ` +
    `conf=${conf.toFixed(2)} cached=${cached} latency=${latencyMs}ms model=${model}`
  );

  if (conf < LLM_CONFIDENCE_THRESHOLD) return;
  if (type === 'ignore') return;

  if (!clientSaas.isReady?.()) {
    console.warn('[saas/relay] clientSaas not ready — skipping LLM-routed broadcast');
    return;
  }

  // Routing selon classification LLM
  if (type === 'exit' && entities.ticker
      && Number.isFinite(entities.low) && Number.isFinite(entities.high)) {
    const embed = brandedEmbedExit(
      { ticker: entities.ticker, low: entities.low, high: entities.high },
      brand,
      message.createdAt,
    );
    const r = await broadcastExit(clientSaas, String(message.id), embed);
    db.dailyAlertLogInsert({
      ticker: entities.ticker, alert_type: 'exit', source_message_id: String(message.id),
    });
    console.log(
      `[saas/relay] EXIT (LLM) msg=${message.id} ticker=${entities.ticker} ` +
      `zone=${entities.low}-${entities.high} → ok=${r.ok} skip=${r.skip} err=${r.error}`
    );
    return;
  }

  if (type === 'entry' && entities.ticker && Number.isFinite(entities.entry)) {
    // Construit un DTO synthétique à partir des entités LLM, en partant
    // du DTO regex (préserve note, ts_minute, source_message_id).
    const baseDto = buildSignalDTO(message);
    const syntheticDto = {
      ...baseDto,
      ticker:       entities.ticker,
      entry_price:  entities.entry,
      target_price: Number.isFinite(entities.target) ? entities.target : null,
      stop_price:   Number.isFinite(entities.stop) ? entities.stop : null,
    };
    const r = await broadcast(clientSaas, syntheticDto);
    db.dailyAlertLogInsert({
      ticker: entities.ticker, alert_type: 'entry', source_message_id: String(message.id),
    });
    console.log(
      `[saas/relay] ENTRY (LLM) msg=${message.id} ticker=${entities.ticker} ` +
      `entry=${entities.entry} target=${entities.target} stop=${entities.stop} ` +
      `→ ok=${r.ok} skip=${r.skip} err=${r.error}`
    );
    return;
  }

  if (type === 'passthrough') {
    const sanitized = sanitizeText(message.content || '');
    if (!sanitized) return;
    const r = await broadcastRaw(clientSaas, String(message.id), sanitized);
    console.log(
      `[saas/relay] passthrough (LLM) msg=${message.id} → ok=${r.ok} skip=${r.skip} err=${r.error}`
    );
    return;
  }

  // type=='ipo' : pas géré par LLM (l'embed IPO nécessite parseIPOAnnouncement
  // pour la structure multi-section ; on log et on laisse tomber). Si la
  // regex IPO fast-path n'a pas attrapé, c'est probablement un format
  // dégradé qu'on préfère ignorer plutôt que d'envoyer un embed bancal.
  console.log(`[saas/relay] LLM type=${type} not routed (no handler) msg=${message.id}`);
}

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
            } else if (isExitSuggestion(message.content || '')) {
              console.log(
                `[saas/relay] MISSED exit — channel="${message.channel?.name || '?'}" ` +
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

      // Filtre 5b : suggestion de sortie compacte (ex: "ELPW 6.60-9🔥").
      // Format strict TICKER X-Y[emoji], pas de mots-clés signal. Bypass
      // shouldRelay/buildSignalDTO — sinon parsé comme un faux long avec
      // entry=6.60 target=9. Embed dédié dans target_channel_id (même
      // salon que les signaux : lifecycle entry → exit dans un seul fil).
      {
        const exitParsed = isExitSuggestion(message.content || '');
        if (exitParsed) {
          if (!clientSaas.isReady?.()) {
            console.warn('[saas/relay] clientSaas not ready — skipping exit broadcast');
            return;
          }
          const embed = brandedEmbedExit(exitParsed, brand, message.createdAt);
          const result = await broadcastExit(clientSaas, String(message.id), embed);
          db.dailyAlertLogInsert({
            ticker: exitParsed.ticker,
            alert_type: 'exit',
            source_message_id: String(message.id),
          });
          console.log(
            `[saas/relay] EXIT msg=${message.id} ticker=${exitParsed.ticker} ` +
            `zone=${exitParsed.low}-${exitParsed.high} → ok=${result.ok} skip=${result.skip} err=${result.error} (of ${result.total})`
          );
          return;
        }
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
        // LLM fallback : tenter une 2e opinion sur les messages que les
        // heuristiques ont rejetés mais qui pourraient être des signaux
        // déguisés (format inhabituel raté par les regex). Best-effort,
        // pas de blocage si LLM indispo.
        if (llmClassify.isEnabled() && looksWorthLLM(message.content || '')) {
          await tryLLMFallback(clientSaas, message);
        }
        return;
      }

      // Vérifie clientSaas est ready avant de broadcast
      if (!clientSaas.isReady?.()) {
        console.warn('[saas/relay] clientSaas not ready — skipping broadcast');
        return;
      }

      // Filet de sécurité : si le message ressemble à un format court
      // ambigu (peu d'infos, pas de mots-clés explicites comme entry/
      // target/sl/long/short/etc.), on le re-route en EXIT au lieu de
      // broadcaster une 2e entrée. Couvre les cas où isExitSuggestion
      // a raté la détection (regex stricte trop pointue : caractère
      // exotique, espace bizarre, contenu multi-ligne, etc.).
      //
      // Domaine métier : dans le serveur source, "TICKER X-Y" sans
      // mots-clés signifie TOUJOURS une notification de sortie de
      // position (entry-exit récap d'un trade clôturé). Les vrais
      // nouveaux signaux ont toujours des mots-clés explicites
      // (entry/target/sl/long/setup/etc.) qui sont dans la denylist
      // SHORT_SIGNAL_BLOCKERS, donc ils ne déclenchent pas ce filet.
      if (looksLikeShortSignal(message.content || '', dto)) {
        const exitEmbed = brandedEmbedExit(
          { ticker: dto.ticker, low: dto.entry_price, high: dto.target_price },
          brand,
          message.createdAt,
        );
        const result = await broadcastExit(clientSaas, String(message.id), exitEmbed);
        db.dailyAlertLogInsert({
          ticker: dto.ticker,
          alert_type: 'exit',
          source_message_id: dto.source_message_id,
        });
        console.log(
          `[saas/relay] EXIT (compact) msg=${dto.source_message_id} ticker=${dto.ticker} ` +
          `zone=${dto.entry_price}-${dto.target_price} → ok=${result.ok} skip=${result.skip} err=${result.error} (of ${result.total})`
        );
        return;
      }

      const result = await broadcast(clientSaas, dto);
      // Enregistre l'entrée pour permettre au filet de sécurité de
      // détecter un éventuel doublon plus tard dans la journée.
      db.dailyAlertLogInsert({
        ticker: dto.ticker,
        alert_type: 'entry',
        source_message_id: dto.source_message_id,
      });
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
  broadcastExit,              // exposé pour tests
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
