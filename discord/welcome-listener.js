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

module.exports = {
  formatWelcomeMessage,
  shouldWelcome,
};
