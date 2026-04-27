// ─────────────────────────────────────────────────────────────────────
// saas/commands.js — Slash commands admin + client pour le bot SaaS
// ─────────────────────────────────────────────────────────────────────
// Toutes les commandes sont enregistrées sur clientSaas (jamais sur le
// bot trading existant). Strings utilisateur EN anglais.
//
// Admin (scope: SOURCE_GUILD_ID, garde adminOnly) :
//   /saas add guild_id plan expires_at
//   /saas suspend guild_id [reason]
//   /saas resume guild_id
//   /saas list [status]
//   /saas info guild_id
//   /saas force-leave guild_id
//   /saas pending
//
// Client (scope: global, garde manageGuildOnly) :
//   /setup channel:<channel>
//   /status
//   /connect code:<code>
// ─────────────────────────────────────────────────────────────────────

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const db = require('../db/sqlite');
const licenses = require('./licenses');
const { adminOnly, manageGuildOnly, leaveGuild } = require('./guards');
const { BRAND_NAME, BRAND_COLOR } = require('./brand');
const { STATUSES } = licenses;

// Helper: réponse safe (try/catch — éviter de crash si interaction expirée).
async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ...payload, ephemeral: true });
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (err) {
    console.error('[saas/commands] reply failed:', err.message);
  }
}

// ── Définitions admin (scope guild source) ──────────────────────────

function buildAdminCommands() {
  const saas = new SlashCommandBuilder()
    .setName('saas')
    .setDescription('Manage SaaS relay licenses (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add')
      .setDescription('Add or update a license')
      .addStringOption(o => o.setName('guild_id').setDescription('Discord guild ID').setRequired(true))
      .addStringOption(o => o.setName('plan').setDescription('Plan name').setRequired(false))
      .addStringOption(o => o.setName('expires_at').setDescription('ISO date or YYYY-MM-DD').setRequired(false))
    )
    .addSubcommand(s => s.setName('suspend')
      .setDescription('Suspend a license (bot leaves the guild)')
      .addStringOption(o => o.setName('guild_id').setDescription('Discord guild ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Optional reason').setRequired(false))
    )
    .addSubcommand(s => s.setName('resume')
      .setDescription('Resume a suspended license')
      .addStringOption(o => o.setName('guild_id').setDescription('Discord guild ID').setRequired(true))
    )
    .addSubcommand(s => s.setName('list')
      .setDescription('List licenses')
      .addStringOption(o => o.setName('status').setDescription('Filter by status').setRequired(false)
        .addChoices(...STATUSES.map(s => ({ name: s, value: s }))))
    )
    .addSubcommand(s => s.setName('info')
      .setDescription('Show details for a license')
      .addStringOption(o => o.setName('guild_id').setDescription('Discord guild ID').setRequired(true))
    )
    .addSubcommand(s => s.setName('force-leave')
      .setDescription('Force the bot to leave a guild')
      .addStringOption(o => o.setName('guild_id').setDescription('Discord guild ID').setRequired(true))
    )
    .addSubcommand(s => s.setName('pending')
      .setDescription('List pending claim codes (Launchpass subs not yet claimed)')
    );
  return [saas.toJSON()];
}

// ── Définitions client (scope global) ───────────────────────────────

function buildClientCommands() {
  const setup = new SlashCommandBuilder()
    .setName('setup')
    .setDescription(`Choose the channel where ${BRAND_NAME} signals are posted`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));

  const status = new SlashCommandBuilder()
    .setName('status')
    .setDescription(`Show your ${BRAND_NAME} subscription status`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

  const connect = new SlashCommandBuilder()
    .setName('connect')
    .setDescription(`Activate your ${BRAND_NAME} subscription with a claim code`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption(o => o.setName('code').setDescription('Your claim code').setRequired(true));

  return [setup.toJSON(), status.toJSON(), connect.toJSON()];
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleSaasAdd(interaction) {
  const guildId = interaction.options.getString('guild_id', true);
  const plan = interaction.options.getString('plan') || 'standard';
  const expiresIn = interaction.options.getString('expires_at');
  let expires_at = null;
  if (expiresIn) {
    // Accept "YYYY-MM-DD" or full ISO. Validation minimale.
    const d = new Date(expiresIn.length === 10 ? expiresIn + 'T23:59:59Z' : expiresIn);
    if (isNaN(d.getTime())) {
      return safeReply(interaction, { content: `Invalid expires_at: ${expiresIn}` });
    }
    expires_at = d.toISOString();
  }
  licenses.addLicense({
    guild_id: guildId, plan, expires_at, status: 'active',
    admin: interaction.user.id,
  });
  return safeReply(interaction, {
    content: `License added/updated: \`${guildId}\` plan=\`${plan}\` expires=\`${expires_at || 'never'}\``,
  });
}

async function handleSaasSuspend(interaction, clientSaas) {
  const guildId = interaction.options.getString('guild_id', true);
  const reason = interaction.options.getString('reason') || null;
  licenses.suspend(guildId, { admin: interaction.user.id, reason });
  // Si le bot est dans ce guild, le faire partir tout de suite (le tick le ferait aussi mais l'attente est désagréable).
  const g = clientSaas.guilds.cache.get(guildId);
  if (g) {
    leaveGuild(g, 'suspended').catch(() => {});
  }
  return safeReply(interaction, {
    content: `Suspended \`${guildId}\`${reason ? ` (reason: ${reason})` : ''}.`,
  });
}

async function handleSaasResume(interaction) {
  const guildId = interaction.options.getString('guild_id', true);
  licenses.resume(guildId, { admin: interaction.user.id });
  return safeReply(interaction, {
    content: `Resumed \`${guildId}\`. Re-invite the bot if needed.`,
  });
}

async function handleSaasList(interaction) {
  const status = interaction.options.getString('status');
  const all = licenses.list(status);
  if (all.length === 0) {
    return safeReply(interaction, { content: status ? `No licenses with status=${status}.` : 'No licenses yet.' });
  }
  const lines = all.slice(0, 25).map(l => {
    const expires = l.expires_at ? l.expires_at.slice(0, 10) : 'lifetime';
    const target = l.target_channel_id ? `<#${l.target_channel_id}>` : '(no channel)';
    return `• \`${l.guild_id}\` — ${l.status} / ${l.plan} / exp ${expires} / ${target}`;
  });
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`Licenses (${all.length}${status ? ` · ${status}` : ''})`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: all.length > 25 ? `Showing 25 of ${all.length}` : `${all.length} total` });
  return safeReply(interaction, { embeds: [embed] });
}

async function handleSaasInfo(interaction) {
  const guildId = interaction.options.getString('guild_id', true);
  const lic = licenses.get(guildId);
  if (!lic) return safeReply(interaction, { content: `No license for \`${guildId}\`.` });
  const recent = db.relayLogRecent(guildId, 5);
  const stats = db.relayLogStatsSince(guildId, new Date(Date.now() - 7 * 86400 * 1000).toISOString());
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`License ${guildId}`)
    .addFields(
      { name: 'Status', value: lic.status, inline: true },
      { name: 'Plan', value: lic.plan, inline: true },
      { name: 'Expires', value: lic.expires_at ? lic.expires_at.slice(0, 10) : 'lifetime', inline: true },
      { name: 'Target channel', value: lic.target_channel_id ? `<#${lic.target_channel_id}>` : '(not set)', inline: true },
      { name: 'Last relay', value: lic.last_relay_at || 'never', inline: true },
      { name: 'Relays 7d', value: `ok=${stats.ok} skip=${stats.skip} err=${stats.error}`, inline: true },
    );
  if (recent.length > 0) {
    embed.addFields({
      name: 'Recent relays',
      value: recent.map(r => `${r.ts.slice(11, 19)} ${r.status}${r.error ? ` (${r.error.slice(0, 40)})` : ''}`).join('\n'),
    });
  }
  return safeReply(interaction, { embeds: [embed] });
}

async function handleSaasForceLeave(interaction, clientSaas) {
  const guildId = interaction.options.getString('guild_id', true);
  const g = clientSaas.guilds.cache.get(guildId);
  if (!g) return safeReply(interaction, { content: `Bot is not in guild \`${guildId}\`.` });
  await leaveGuild(g, 'force-leave');
  db.adminActionInsert({ admin: interaction.user.id, action: 'force-leave', guild_id: guildId });
  return safeReply(interaction, { content: `Left guild \`${guildId}\`.` });
}

async function handleSaasPending(interaction) {
  const map = licenses.listPendingSubs();
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return safeReply(interaction, { content: 'No pending claim codes.' });
  }
  const lines = entries.slice(0, 25).map(([code, e]) =>
    `• \`${code}\` → ${e.email || '(no email)'} / ${e.plan} / sub=${e.subId}`
  );
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`Pending claims (${entries.length})`)
    .setDescription(lines.join('\n'));
  return safeReply(interaction, { embeds: [embed] });
}

async function handleSetup(interaction, clientSaas) {
  if (!manageGuildOnly(interaction)) return;
  const lic = licenses.get(interaction.guildId);
  if (!licenses.isActive(lic)) {
    return safeReply(interaction, {
      content: 'No active subscription found for this server. Use /connect with your claim code first.',
    });
  }
  const channel = interaction.options.getChannel('channel', true);
  // Vérifier que le bot peut écrire dans ce channel.
  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
    return safeReply(interaction, {
      content: `I need "Send Messages" and "Embed Links" permissions in ${channel}. Please adjust and retry.`,
    });
  }
  licenses.setTargetChannel(interaction.guildId, channel.id, { admin: interaction.user.id });
  return safeReply(interaction, {
    content: `Signals will now be posted in ${channel}. Note: screenshots from the source are intentionally excluded for security.`,
  });
}

async function handleStatus(interaction) {
  if (!manageGuildOnly(interaction)) return;
  const lic = licenses.get(interaction.guildId);
  if (!lic) {
    return safeReply(interaction, { content: 'No subscription found for this server.' });
  }
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`${BRAND_NAME} subscription`)
    .addFields(
      { name: 'Status', value: lic.status, inline: true },
      { name: 'Plan', value: lic.plan, inline: true },
      { name: 'Expires', value: lic.expires_at ? lic.expires_at.slice(0, 10) : 'lifetime', inline: true },
      { name: 'Target channel', value: lic.target_channel_id ? `<#${lic.target_channel_id}>` : '(not set — run /setup)', inline: false },
      { name: 'Last signal received', value: lic.last_relay_at || 'never', inline: false },
    )
    .setFooter({ text: `via ${BRAND_NAME}` });
  return safeReply(interaction, { embeds: [embed] });
}

async function handleConnect(interaction) {
  if (!manageGuildOnly(interaction)) return;
  const code = interaction.options.getString('code', true).trim().toUpperCase();
  const created = licenses.claimWithCode(code, {
    guild_id: interaction.guildId,
    guild_name: interaction.guild?.name || null,
  });
  if (!created) {
    return safeReply(interaction, {
      content: 'Invalid or already used claim code. Check your email or contact support.',
    });
  }
  return safeReply(interaction, {
    content: `Subscription activated. Run /setup channel:#your-alerts to choose where signals are posted.`,
  });
}

// ── Wire-up ─────────────────────────────────────────────────────────

// Enregistre les commandes Discord et le listener interactionCreate.
// `opts` = { adminGuildId, adminUserId }.
//   - adminGuildId : guild où enregistrer les commandes /saas (typiquement
//     un serveur que le user possède, pas le serveur source).
//   - adminUserId  : optionnel — gate supplémentaire par user_id. Si vide,
//     on s'appuie uniquement sur la perm Discord Administrator + scope guild.
function registerSaasCommands(clientSaas, opts) {
  if (!clientSaas) return;
  if (clientSaas.__saasCommandsRegistered) return;
  clientSaas.__saasCommandsRegistered = true;

  const adminCheck = adminOnly(opts.adminUserId);

  clientSaas.once('ready', async () => {
    try {
      const adminCmds = buildAdminCommands();
      const clientCmds = buildClientCommands();

      // Admin → scope au serveur admin (guild que TOI possèdes, distinct
      // du serveur source qui peut appartenir à un tiers).
      if (opts.adminGuildId) {
        await clientSaas.application.commands.set(adminCmds, opts.adminGuildId);
        console.log(`[saas/commands] Registered ${adminCmds.length} admin command(s) on admin guild ${opts.adminGuildId}`);
      } else {
        console.warn('[saas/commands] ADMIN_GUILD_ID not set — admin commands skipped');
      }

      // Client → global
      await clientSaas.application.commands.set(clientCmds);
      console.log(`[saas/commands] Registered ${clientCmds.length} global command(s)`);
    } catch (err) {
      console.error('[saas/commands] Failed to register commands:', err.message);
    }
  });

  clientSaas.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      switch (interaction.commandName) {
        case 'saas': {
          if (!adminCheck(interaction)) return;
          const sub = interaction.options.getSubcommand();
          if (sub === 'add')         return handleSaasAdd(interaction);
          if (sub === 'suspend')     return handleSaasSuspend(interaction, clientSaas);
          if (sub === 'resume')      return handleSaasResume(interaction);
          if (sub === 'list')        return handleSaasList(interaction);
          if (sub === 'info')        return handleSaasInfo(interaction);
          if (sub === 'force-leave') return handleSaasForceLeave(interaction, clientSaas);
          if (sub === 'pending')     return handleSaasPending(interaction);
          return safeReply(interaction, { content: `Unknown subcommand: ${sub}` });
        }
        case 'setup':   return handleSetup(interaction, clientSaas);
        case 'status':  return handleStatus(interaction);
        case 'connect': return handleConnect(interaction);
        default:
          // Other commands handled elsewhere (or by clientSource).
          return;
      }
    } catch (err) {
      console.error('[saas/commands] handler error:', err);
      return safeReply(interaction, { content: `Error: ${err.message}` });
    }
  });
}

module.exports = {
  registerSaasCommands,
  // Exposés pour tests / dashboard
  buildAdminCommands,
  buildClientCommands,
};
