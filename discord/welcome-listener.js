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

const { insertWelcomeLog } = require('../db/sqlite');
const {
  DEFAULT_WELCOME_TEMPLATE,
  applyTemplate,
  getEffectiveTemplate,
} = require('./welcome-template');

function formatWelcomeMessage(userId, startHereChannelId) {
  return applyTemplate(DEFAULT_WELCOME_TEMPLATE, { userId, startHereId: startHereChannelId });
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
    const missing = [
      !guildId            && 'TOB_WELCOME_GUILD_ID',
      !subscriberRoleId   && 'TOB_SUBSCRIBER_ROLE_ID',
      !welcomeChannelId   && 'TOB_WELCOME_CHANNEL_ID',
      !startHereChannelId && 'TOB_START_HERE_CHANNEL_ID',
    ].filter(Boolean).join(', ');
    console.warn('[welcome] missing config — disabled (need ' + missing + ')');
    insertWelcomeLog({ type: 'config-missing', userId: null, username: null, detail: missing });
    return;
  }

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (!shouldWelcome(oldMember, newMember, { roleId: subscriberRoleId, guildId })) return;
    const userId = newMember.user.id;
    const username = newMember.user.tag || newMember.user.username || null;
    try {
      const ch = await client.channels.fetch(welcomeChannelId);
      if (!ch || !ch.isTextBased || !ch.isTextBased()) {
        const detail = 'channel ' + welcomeChannelId + ' not text-based or not found';
        console.error('[welcome] ' + detail);
        insertWelcomeLog({ type: 'error-channel', userId, username, detail });
        return;
      }
      const { template } = getEffectiveTemplate();
      const msg = applyTemplate(template, { userId, startHereId: startHereChannelId });
      await ch.send(msg);
      console.log('[welcome] sent to ' + userId);
      insertWelcomeLog({ type: 'sent', userId, username, detail: null });
    } catch (err) {
      console.error('[welcome] send failed:', err.message);
      insertWelcomeLog({ type: 'error-send', userId, username, detail: err.message });
    }
  });

  console.log('[welcome] listener registered (guild=' + guildId + ', role=' + subscriberRoleId + ')');
}

module.exports = {
  formatWelcomeMessage,
  shouldWelcome,
  registerWelcomeListener,
};
