// ─────────────────────────────────────────────────────────────────────
// saas/guards.js — Garde-fous d'accès au bot SaaS
// ─────────────────────────────────────────────────────────────────────
// Trois mécanismes complémentaires :
//   1. guildCreate handler : refuse les invitations sur serveurs sans
//      licence active (avec grâce 30s pour la race paiement/invite).
//   2. Tick périodique (5 min) : leave les serveurs dont la licence
//      a expiré, été suspendue ou annulée.
//   3. Middlewares slash commands : adminOnly, manageGuildOnly.
//
// Toutes les strings utilisateur sont en anglais (mémoire user).
// ─────────────────────────────────────────────────────────────────────

const { PermissionFlagsBits } = require('discord.js');
const db = require('../db/sqlite');
const licenses = require('./licenses');

const GRACE_MS = 30_000;          // période de grâce pour onboarding
const TICK_INTERVAL_MS = 5 * 60_000; // re-check toutes les 5 minutes

// Tente de poster un message dans le system channel du guild — ignore
// silencieusement si le bot n'a pas la permission ou si le channel est
// absent. L'objectif est UX, pas critique.
async function notifyGuild(guild, text) {
  try {
    const ch = guild.systemChannel;
    if (!ch) return;
    const me = guild.members.me;
    if (!me) return;
    const perms = ch.permissionsFor(me);
    if (!perms || !perms.has(PermissionFlagsBits.SendMessages)) return;
    await ch.send(text);
  } catch (_) {
    // Ne pas crash le guildCreate sur une erreur de DM.
  }
}

// Quitte un guild et logge la raison. Idempotent : si le bot n'est plus
// dans le guild, le leave throw est avalé.
async function leaveGuild(guild, reason) {
  try {
    db.autoLeaveLogClose(guild.id);
    db.autoLeaveLogInsert({ guild_id: guild.id, guild_name: guild.name, reason });
    await guild.leave();
    console.log(`[saas/guards] Left guild ${guild.id} (${guild.name}) reason=${reason}`);
  } catch (err) {
    console.error(`[saas/guards] Failed to leave guild ${guild.id}:`, err.message);
  }
}

// Enregistre le handler guildCreate + démarre le tick périodique.
// Idempotent : appelable plusieurs fois sans dupliquer les listeners.
//
// `opts.adminGuildId` : si défini, ce guild est TOUJOURS épargné par le
// guard (jamais kické même sans licence). C'est le guild où sont
// enregistrées les commandes admin — sans le bot dedans, l'utilisateur
// perd l'accès au panneau de contrôle.
function registerGuildGuard(clientSaas, opts = {}) {
  if (!clientSaas) {
    console.warn('[saas/guards] registerGuildGuard called without clientSaas — skip');
    return null;
  }
  if (clientSaas.__saasGuardRegistered) return null;
  clientSaas.__saasGuardRegistered = true;

  const adminGuildId = opts.adminGuildId || '';
  const isAdminGuild = (id) => adminGuildId && String(id) === String(adminGuildId);

  clientSaas.on('guildCreate', async (guild) => {
    // Le guild admin est toujours épargné — c'est le panneau de contrôle.
    if (isAdminGuild(guild.id)) {
      db.autoLeaveLogInsert({ guild_id: guild.id, guild_name: guild.name, reason: 'joined-admin' });
      console.log(`[saas/guards] Joined admin guild ${guild.id} (${guild.name}) — never auto-leave`);
      return;
    }

    const lic = licenses.get(guild.id);
    if (lic && licenses.isActive(lic)) {
      // Licence valide : on log l'arrivée et on reste.
      db.autoLeaveLogInsert({ guild_id: guild.id, guild_name: guild.name, reason: 'joined-active' });
      console.log(`[saas/guards] Joined active license guild ${guild.id} (${guild.name})`);
      await notifyGuild(
        guild,
        `Connected. Use /setup channel:#your-alerts to choose where signals are posted.`
      );
      return;
    }

    // Pas de licence active. Ouvre une fenêtre de grâce 30s puis leave.
    db.autoLeaveLogInsert({
      guild_id: guild.id, guild_name: guild.name,
      reason: lic ? `pending-${lic.status}` : 'no-license',
    });
    console.log(`[saas/guards] Joined guild ${guild.id} (${guild.name}) WITHOUT active license — grace period started`);
    await notifyGuild(
      guild,
      `Welcome. If you have a paid subscription, run /connect code:<your_code> within 30 seconds. ` +
      `Otherwise the bot will leave automatically.`
    );

    setTimeout(async () => {
      const recheck = licenses.get(guild.id);
      if (recheck && licenses.isActive(recheck)) {
        // Sauvé in extremis par /connect.
        console.log(`[saas/guards] Guild ${guild.id} claimed during grace — keeping`);
        return;
      }
      await leaveGuild(guild, 'grace-timeout');
    }, GRACE_MS);
  });

  // Tick périodique : enforce les expirations.
  const tick = async () => {
    try {
      for (const [guildId, guild] of clientSaas.guilds.cache) {
        // Skip admin guild — toujours épargné.
        if (isAdminGuild(guildId)) continue;

        const lic = licenses.get(guildId);
        if (!lic) {
          await leaveGuild(guild, 'no-license');
          continue;
        }
        // Bascule expired si nécessaire (tick = source de vérité du temps)
        if (lic.status === 'active' && licenses.isExpired(lic)) {
          licenses.expire(guildId);
        }
        const fresh = licenses.get(guildId);
        if (!licenses.isActive(fresh)) {
          await leaveGuild(guild, fresh ? fresh.status : 'no-license');
        }
      }
    } catch (err) {
      console.error('[saas/guards] tick error:', err.message);
    }
  };

  // Lancement du timer après le ready (sinon clientSaas.guilds.cache est vide)
  clientSaas.once('ready', () => {
    console.log(`[saas/guards] Tick started, interval=${TICK_INTERVAL_MS}ms`);
    tick().catch(() => {}); // first run immediate
    const handle = setInterval(() => { tick().catch(() => {}); }, TICK_INTERVAL_MS);
    // Stocker le handle pour permettre clearInterval lors d'un shutdown propre.
    clientSaas.__saasTickHandle = handle;
  });

  // Log les leaves (qu'ils soient initiés par nous ou par un kick côté client).
  clientSaas.on('guildDelete', (guild) => {
    db.autoLeaveLogClose(guild.id);
    console.log(`[saas/guards] Removed from guild ${guild.id} (${guild.name})`);
  });

  return { tick, GRACE_MS, TICK_INTERVAL_MS };
}

// ── Middlewares pour slash commands ────────────────────────────────

// Bot admin (toi). Vérification optionnelle par user_id : si ADMIN_USER_ID
// est vide, on s'appuie uniquement sur Discord-level perms (Administrator)
// + scope guild (ADMIN_GUILD_ID). Si ADMIN_USER_ID est défini, on impose
// la vérification stricte par user pour double-gate.
function adminOnly(adminUserId) {
  return (interaction) => {
    if (adminUserId && interaction.user.id !== adminUserId) {
      interaction.reply({ content: 'Unauthorized.', ephemeral: true }).catch(() => {});
      return false;
    }
    return true;
  };
}

// Membre avec permission Manage Guild (admin du serveur client).
function manageGuildOnly(interaction) {
  if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    interaction.reply({ content: 'You need the "Manage Server" permission.', ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

module.exports = {
  registerGuildGuard,
  adminOnly,
  manageGuildOnly,
  leaveGuild,
  notifyGuild,
  GRACE_MS,
  TICK_INTERVAL_MS,
};
