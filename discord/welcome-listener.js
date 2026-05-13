// ─────────────────────────────────────────────────────────────────────
// discord/welcome-listener.js — Welcome new TOB subscribers
// ─────────────────────────────────────────────────────────────────────
// Whop et Launchpass attribuent le MÊME rôle Discord aux nouveaux
// abonnés. On écoute `guildMemberUpdate` : quand ce rôle transitionne
// d'absent → présent sur un membre non-bot du serveur TOB, on poste
// un message de bienvenue dans le salon configuré.
//
// Stateless : pas de DB, pas de dédupe. Une re-attribution = un nouveau
// welcome (cas rare et bénin).
//
// Spec : docs/superpowers/specs/2026-05-13-tob-welcome-message-design.md
// ─────────────────────────────────────────────────────────────────────

function formatWelcomeMessage(userId, startHereChannelId) {
  return `<@${userId}> welcome to TOB! Please start with <#${startHereChannelId}> and watch us for a week or so to get familiar with the discord.`;
}

// True only when the subscriber role just transitioned from absent → present
// on a non-bot member of the configured TOB guild.
function shouldWelcome(oldMember, newMember, { roleId, guildId }) {
  if (newMember.guild.id !== guildId) return false;
  if (newMember.user.bot) return false;
  const hadRole = oldMember.roles.cache.has(roleId);
  const hasRole = newMember.roles.cache.has(roleId);
  return !hadRole && hasRole;
}

// Registers a guildMemberUpdate listener on `client`. No-op (with a single
// boot warning) if any config field is empty. The handler is async because
// it fetches the welcome channel from the Discord API.
function registerWelcomeListener(client, {
  guildId,
  subscriberRoleId,
  welcomeChannelId,
  startHereChannelId,
}) {
  if (!guildId || !subscriberRoleId || !welcomeChannelId || !startHereChannelId) {
    console.warn('[welcome] missing config — disabled (need TOB_WELCOME_GUILD_ID, TOB_SUBSCRIBER_ROLE_ID, TOB_WELCOME_CHANNEL_ID, TOB_START_HERE_CHANNEL_ID)');
    return;
  }

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (!shouldWelcome(oldMember, newMember, { roleId: subscriberRoleId, guildId })) return;
    try {
      const ch = await client.channels.fetch(welcomeChannelId);
      if (!ch || !ch.isTextBased || !ch.isTextBased()) {
        console.error('[welcome] welcome channel not text-based or not found:', welcomeChannelId);
        return;
      }
      const msg = formatWelcomeMessage(newMember.user.id, startHereChannelId);
      await ch.send(msg);
    } catch (err) {
      console.error('[welcome] send failed:', err.message);
    }
  });

  console.log('[welcome] listener registered (guild=' + guildId + ', role=' + subscriberRoleId + ')');
}

module.exports = {
  formatWelcomeMessage,
  shouldWelcome,
  registerWelcomeListener,
};
