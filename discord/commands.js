// ─────────────────────────────────────────────────────────────────────
// discord/commands.js — Commandes Discord simples (!xxx)
// ─────────────────────────────────────────────────────────────────────
// Commandes "globales" (fonctionnent dans n'importe quel salon) :
//   !profits         → compteur du jour + record all-time
//   !bilan           → rapport journalier Markdown (même contenu que
//                      celui posté automatiquement à 20h EDT)
//   !delete-report   → supprime le dernier rapport journalier posté
//                      dans #profits (retrouve par ID sauvegardé ou
//                      par scan des 50 derniers messages)
//   !news            → top 5 dernières headlines RSS (depuis poller)
//
// NE couvre PAS !top et !stats TICKER — celles-ci sont scopées au
// TRADING_CHANNEL et vivent dans le handler principal (discord/handler.js
// ou encore dans index.js si pas encore extrait).
// ─────────────────────────────────────────────────────────────────────

const { todayKey } = require('../utils/persistence');
const profitCounter = require('../profit/counter');
const newsPoller = require('../news/poller');

function registerDiscordCommands(client, { profitsChannelId }) {
  // ── !profits ───────────────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() !== '!profits') return;

    console.log('[!profits] Command received from ' + message.author.username
                + ' in #' + (message.channel.name || message.channel.id));

    const dateKey = todayKey();
    const data = profitCounter.loadProfitData(dateKey);
    const count = data.count || 0;
    const dateStr = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric',
    });

    const record = profitCounter.getProfitRecord();
    // Record annoncé uniquement si le count du jour dépasse ou égale
    // l'ancien — sinon on affiche le record existant comme cible.
    const recordLine = (count > 0 && count >= record.count)
      ? '\n> 🏆 **NEW RECORD!**'
      : '\n> 📊 Record: **' + record.count + '** (' + record.date + ')';

    try {
      await message.reply(
        '📊 **Daily Profits — ' + dateStr + '**\n'
        + '> 🔥 **' + count + '** profit' + (count !== 1 ? 's' : '') + ' posted today'
        + recordLine
      );
    } catch (e) {
      console.error('[!profits]', e.message);
    }
  });

  // ── !bilan ─────────────────────────────────────────────────────────
  // Repost du daily summary à la demande — utile quand le 20h EDT auto
  // a été manqué (bot down ou silent mode activé).
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() !== '!bilan') return;

    console.log('[!bilan] Triggered by ' + message.author.username);
    try {
      await message.reply(profitCounter.buildProfitSummaryMsg());
    } catch (e) {
      console.error('[!bilan]', e.message);
    }
  });

  // ── !delete-report ─────────────────────────────────────────────────
  // Workflow "undo" pour le daily summary : supprime le message posté
  // par le bot dans #profits. On essaie d'abord l'ID mémorisé (certain
  // match), fallback vers scan du contenu dans les 50 derniers messages.
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() !== '!delete-report') return;

    if (!profitsChannelId) {
      try { await message.reply('❌ PROFITS_CHANNEL_ID non configuré.'); } catch (_) {}
      return;
    }

    try {
      const ch = client.channels.cache.get(profitsChannelId);
      if (!ch) { await message.reply('❌ Salon #profits introuvable.'); return; }

      let targetMsg = null;

      // 1. Essai par ID mémorisé — plus rapide + certain match.
      const savedMsgId = profitCounter.getLastSummaryMessageId();
      if (savedMsgId) {
        try { targetMsg = await ch.messages.fetch(savedMsgId); } catch (_) {}
      }

      // 2. Fallback : scan des 50 derniers messages du canal, on retient
      //    le message le plus récent posté par le bot (peu importe le contenu).
      if (!targetMsg) {
        const fetched = await ch.messages.fetch({ limit: 50 });
        targetMsg = fetched.find(m => m.author.id === client.user.id) || null;
      }

      if (!targetMsg) {
        await message.reply('❌ Aucun message du bot trouvé dans #profits.');
        return;
      }

      await targetMsg.delete();
      // Évite que !delete-report enchaîné supprime un message plus ancien
      // en vidant le pointeur si on a bien supprimé celui qu'on visait.
      if (profitCounter.getLastSummaryMessageId() === targetMsg.id) {
        profitCounter.clearLastSummaryMessageId();
      }
      console.log('[!delete-report] Report deleted by ' + message.author.username);
      try { await message.react('✅'); } catch (_) {}
    } catch (e) {
      console.error('[!delete-report]', e.message);
      try { await message.reply('❌ Erreur : ' + e.message); } catch (_) {}
    }
  });

  // ── !news ──────────────────────────────────────────────────────────
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() !== '!news') return;

    const recentNews = newsPoller.getRecentNews();
    if (!recentNews.length) {
      try { await message.reply('📰 No recent news available.'); } catch (_) {}
      return;
    }

    const top5 = recentNews.slice(0, 5);
    const lines = ['📰 **Latest News**'];
    top5.forEach((n, i) => {
      lines.push('> ' + (i + 1) + '. ' + n.emoji + ' ' + n.title);
    });

    try {
      await message.reply(lines.join('\n'));
    } catch (e) {
      console.error('[!news]', e.message);
    }
  });
}

module.exports = { registerDiscordCommands };
