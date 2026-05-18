// ─────────────────────────────────────────────────────────────────────
// discord/milestone-checker.js — Cron tick paliers de gain
// ─────────────────────────────────────────────────────────────────────
// Toutes les 30 min (pendant RTH US), lit analyst_watchlist, fetch les
// prix FMP en bulk, calcule le gain cumulé par ticker et déclenche une
// alerte Discord (reply sous le message d'origine) au prochain palier
// non-tiré, sous réserve d'un cooldown 1h depuis la dernière alerte du
// même ticker.
//
// Mark-then-send atomique : INSERT OR IGNORE dans milestone_alerts avant
// le reply Discord. Si l'insert échoue (UNIQUE constraint), un autre tick
// a déjà tiré ce palier → on skip. Si l'insert réussit mais le reply
// Discord échoue, on perd l'alerte plutôt que de spammer au tick suivant.
// ─────────────────────────────────────────────────────────────────────

// Trouve le prochain palier strictement > lastFired ET ≤ gainPct.
// Retour null = rien à tirer pour ce ticker à ce tick.
// Note : on retourne le PREMIER palier passé, pas le dernier — donc
// si gain=350 et lastFired=20, on tire 50 (pas 300). Évite de skip les
// paliers intermédiaires si le marché bouge vite entre 2 ticks.
function nextMilestone(gainPct, lastFiredPct, milestones) {
  if (!Number.isFinite(gainPct)) return null;
  const list = Array.isArray(milestones) ? milestones : [];
  const lower = (lastFiredPct == null) ? -Infinity : Number(lastFiredPct);
  for (const m of list) {
    if (m > lower && gainPct >= m) return m;
  }
  return null;
}

// toFixed2 uses Math.round(n*100)/100 before .toFixed(2) to get
// consistent half-up rounding (IEEE 754 .toFixed rounds half-to-even,
// which yields '18.55' for 18.555 in Node.js).
function toFixed2(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

// Format compact : `🚀 (AAPL 200.00-240.00) +20.00% — by @alice`.
// Le pourcentage affiché est le gain RÉEL calculé depuis les deux prix
// (à 2 décimales), pas le palier-bucket — l'utilisateur veut voir la
// performance réelle (ex: +403.57% si SBFM passe de 0.28 à 1.41), pas
// `+100%` parce que c'est le seuil qu'on a franchi.
// `milestonePct` reste dans la signature : utile au caller pour savoir
// quel palier fire (mark-then-send), mais on ne l'affiche plus.
// Mention `@username` en plain text — le caller met allowedMentions:[]
// pour empêcher Discord de ping l'utilisateur à chaque palier.
function buildAlertMessage({
  ticker, milestonePct, initialPrice, currentPrice, mentionedByUsername,
}) {
  void milestonePct;  // explicitly unused — see comment above
  const name = mentionedByUsername || 'analyst';
  const initial = Number(initialPrice);
  const current = Number(currentPrice);
  const gainPct = initial > 0 ? ((current - initial) / initial) * 100 : 0;
  return '🚀 ('
    + ticker + ' '
    + toFixed2(initial) + '-'
    + toFixed2(current) + ') +'
    + toFixed2(gainPct) + '% — by @' + name;
}

// Parse les paliers depuis l'env var (CSV d'entiers positifs, trié).
function parseMilestones(raw, fallback) {
  const parsed = String(raw || '').split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : fallback;
}

// Lit la config depuis process.env avec des défauts sains. Exposé pour
// les tests qui peuvent override.
function readConfig() {
  // Parse cooldown / TTL with NaN guards. If env var is non-numeric we fall
  // back to the documented default (1h / 30d) rather than NaN, which would
  // silently bypass the cooldown check or the archive cutoff.
  const cooldownHoursRaw = parseFloat(process.env.MILESTONE_COOLDOWN_HOURS || '1');
  const cooldownHours = Number.isFinite(cooldownHoursRaw) ? cooldownHoursRaw : 1;
  const ttlDaysRaw = parseInt(process.env.WATCHLIST_TTL_DAYS || '30', 10);
  const ttlDays = Number.isFinite(ttlDaysRaw) ? ttlDaysRaw : 30;

  return {
    milestones: parseMilestones(
      process.env.MILESTONE_THRESHOLDS,
      [20, 50, 100, 200, 300, 500, 1000],
    ),
    cooldownMs: Math.max(0, cooldownHours) * 3600_000,
    ttlMs:      Math.max(1, ttlDays) * 86400_000,
  };
}

async function tick(client, nowMs, deps = {}) {
  const db = deps.db || require('../db/sqlite');
  const isRTH = deps.isRTH || require('./market-alerts').isRTH;
  const marketClient = deps.marketClient;  // required at runtime
  const cfg = readConfig();
  const milestones = deps.milestones || cfg.milestones;
  const cooldownMs = (deps.cooldownMs != null) ? deps.cooldownMs : cfg.cooldownMs;
  const ttlMs      = (deps.ttlMs      != null) ? deps.ttlMs      : cfg.ttlMs;

  const now = Number(nowMs) || Date.now();

  // RTH guard — pas de poll hors marché US régulier.
  if (!isRTH(new Date(now))) return;

  // Archive les entrées trop anciennes AVANT de poll → pas de quota FMP gaspillé.
  try {
    db.archiveExpiredWatchlist(now - ttlMs, now);
  } catch (err) {
    console.error('[milestone-checker] archive failed: ' + err.message);
  }

  const entries = db.getActiveWatchlist();
  if (!Array.isArray(entries) || entries.length === 0) return;

  // Pas de marketClient = pas de poll possible.
  if (!marketClient || typeof marketClient.getQuotesBulk !== 'function') {
    console.warn('[milestone-checker] no marketClient available, skipping tick');
    return;
  }

  const tickers = [...new Set(entries.map(e => e.ticker))];
  let quotes;
  try {
    quotes = await marketClient.getQuotesBulk(tickers);
  } catch (err) {
    console.error('[milestone-checker] FMP bulk failed: ' + err.message);
    return;
  }

  for (const entry of entries) {
    const quote = quotes[entry.ticker];
    if (!quote || !Number.isFinite(quote.price)) continue;

    const gainPct = ((quote.price - entry.initial_price) / entry.initial_price) * 100;
    const target = nextMilestone(gainPct, entry.last_milestone_pct, milestones);
    if (target == null) continue;

    if (entry.last_alert_at != null && (now - entry.last_alert_at) < cooldownMs) continue;

    // Mark-then-send atomique : si UNIQUE bloque (palier déjà tiré),
    // insertMilestoneAlert renvoie false → on skip.
    const fired = db.insertMilestoneAlert({
      ticker: entry.ticker,
      milestonePct: target,
      initialPrice: entry.initial_price,
      currentPrice: quote.price,
      gainPct,
      firedAt: now,
      discordMessageId: null,
    });
    if (!fired) continue;

    // Reply Discord. Si fail (msg supprimé, perms), on garde l'insert :
    // perdre 1 alerte vaut mieux qu'en spammer au tick suivant.
    try {
      const text = buildAlertMessage({
        ticker: entry.ticker,
        milestonePct: target,
        initialPrice: entry.initial_price,
        currentPrice: quote.price,
        mentionedByUsername: entry.mentioned_by_username,
      });

      const dedicatedChannelId = process.env.MILESTONE_ALERTS_CHANNEL_ID || '';

      let reply;
      if (dedicatedChannelId) {
        // Mode canal dédié : post normal + lien vers le message d'origine
        // si on arrive à récupérer le guildId. Si la source est inaccessible
        // (msg supprimé, perms perdues), on poste sans le lien plutôt que
        // de skip l'alerte entièrement.
        let sourceLink = '';
        try {
          const sourceChannel = await client.channels.fetch(entry.source_channel_id);
          const sourceMsg     = await sourceChannel.messages.fetch(entry.source_message_id);
          const guildId       = sourceMsg.guildId
            || (sourceMsg.guild && sourceMsg.guild.id)
            || '';
          if (guildId) {
            sourceLink = '\n📎 https://discord.com/channels/'
              + guildId + '/' + entry.source_channel_id + '/' + entry.source_message_id;
          }
        } catch (err) {
          console.warn('[milestone-checker] source link unavailable for '
            + entry.ticker + ': ' + err.message);
        }

        const ch = await client.channels.fetch(dedicatedChannelId);
        reply = await ch.send({
          content: text + sourceLink,
          allowedMentions: { parse: [] },
        });
      } else {
        // Mode reply : comportement actuel.
        const channel   = await client.channels.fetch(entry.source_channel_id);
        const sourceMsg = await channel.messages.fetch(entry.source_message_id);
        reply = await sourceMsg.reply({
          content: text,
          allowedMentions: { parse: [] },
        });
      }

      // Backfill the discord_message_id on the milestone_alerts row we
      // just inserted. Non-blocking : if this update fails, the alert
      // was still posted — we just lose the audit link.
      if (reply && reply.id && typeof db.setMilestoneAlertDiscordId === 'function') {
        try {
          db.setMilestoneAlertDiscordId({
            ticker: entry.ticker,
            milestonePct: target,
            discordMessageId: String(reply.id),
          });
        } catch (err) {
          console.error('[milestone-checker] failed to backfill discord_message_id: '
            + err.message);
        }
      }
      db.updateWatchlistAfterAlert({
        ticker: entry.ticker,
        lastMilestonePct: target,
        lastAlertAt: now,
      });
    } catch (err) {
      console.error('[milestone-checker] reply failed for ' + entry.ticker
        + ': ' + err.message);
    }
  }
}

module.exports = {
  nextMilestone,
  buildAlertMessage,
  tick,
  // exposed for tests
  parseMilestones,
  readConfig,
};
