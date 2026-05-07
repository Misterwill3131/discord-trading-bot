// ─────────────────────────────────────────────────────────────────────
// discord/trend-commands.js — Commandes !trend ...
// ─────────────────────────────────────────────────────────────────────
//   !trend TICKER          analyse à la demande (any user)
//   !trend watchlist       liste les tickers de la guild (any user)
//   !trend status          résumé config + scanner (any user)
//   !trend watch TICKER    ajoute (ManageGuild)
//   !trend unwatch TICKER  retire (ManageGuild)
//   !trend channel #salon  set salon d'alerte (ManageGuild)
// ─────────────────────────────────────────────────────────────────────

const { PermissionsBitField } = require('discord.js');
const { detectAll } = require('../trading/trend-engine');

function adaptYahooBars(quotes) {
  if (!Array.isArray(quotes)) return [];
  return quotes
    .filter(q => Number.isFinite(q.close))
    .map(q => ({
      t: q.date instanceof Date ? q.date.getTime() : q.date,
      o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
    }));
}

const DIRECTION_EMOJI = { uptrend: '📈', downtrend: '📉', sideways: '➡️' };

function formatPrice(v)  { return Number.isFinite(v) ? '$' + v.toFixed(2) : '—'; }
function formatRsi(v)    { return Number.isFinite(v) ? v.toFixed(0) : '—'; }
function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' ET';
}

function isUnknownTicker(err) {
  return err && (
    /not.*found/i.test(err.message || '') ||
    /no.*data/i.test(err.message || '') ||
    err.code === 'NOT_FOUND'
  );
}

// !trend TICKER → analyse complète
async function handleAnalyze(message, ticker, { yahoo, store }) {
  let chart, dailyContext;
  try {
    chart = await yahoo.getChart(ticker, '1D');
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    console.error('[trend] yahoo error', err && err.message);
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }
  // Daily context: best-effort, omit sections if not available.
  try {
    const { getDailyContext } = require('../trading/trend-scanner');
    dailyContext = await getDailyContext(yahoo, ticker);
  } catch (e) {
    dailyContext = null;
  }

  const candles = adaptYahooBars(chart && chart.quotes);
  const state = store.getState(ticker) || {};
  const verdict = detectAll(candles, dailyContext, state, {});
  if (!verdict) {
    return message.reply(`❌ Not enough data for $${ticker}`).catch(() => {});
  }

  const sinceLine = state && state.direction_changed_at
    ? ` (since ${formatTime(state.direction_changed_at)})`
    : '';

  const lines = [
    `📊 **$${ticker}**`,
    `Direction: ${DIRECTION_EMOJI[verdict.direction] || ''} ${verdict.direction}${sinceLine}`,
    `Price: ${formatPrice(verdict.snapshot.price)} · EMA9 ${formatPrice(verdict.snapshot.ema9)} · EMA20 ${formatPrice(verdict.snapshot.ema20)} · RSI ${formatRsi(verdict.snapshot.rsi)}`,
  ];

  // Today's daily-reference events (only if we have state from this trading day)
  const dailyLines = [];
  if (state.pdh_alerts_today > 0 && dailyContext) {
    const priorHigh = dailyContext.priorHigh != null ? dailyContext.priorHigh : dailyContext.yesterday.high;
    dailyLines.push(`• 🟢 PDH break (2-day high ${formatPrice(priorHigh)})`);
  }
  if (state.pdl_alerts_today > 0 && dailyContext) {
    const priorLow = dailyContext.priorLow != null ? dailyContext.priorLow : dailyContext.yesterday.low;
    dailyLines.push(`• 🔴 PDL break (2-day low ${formatPrice(priorLow)})`);
  }
  if (state.gap_alerted_today && dailyContext) {
    const gapPct = ((dailyContext.todayOpen - dailyContext.yesterday.close) / dailyContext.yesterday.close) * 100;
    const arrow = gapPct >= 0 ? '⬆️' : '⬇️';
    const sign = gapPct >= 0 ? '+' : '';
    dailyLines.push(`• ${arrow} Gap ${sign}${gapPct.toFixed(1)}% at open`);
  }
  if (state.volume_above_alerted_today && dailyContext) {
    const ratio = dailyContext.todayCumVolume / dailyContext.yesterday.volume;
    const overPct = (ratio - 1) * 100;
    dailyLines.push(`• 📊 Volume above prev day (+${overPct.toFixed(1)}%)`);
  }
  if (dailyLines.length > 0) {
    lines.push('');
    lines.push("Today's daily-reference events:");
    lines.push(...dailyLines);
  }

  // Recent intraday events
  const intradayLines = [];
  if (state.last_breakout_at) {
    intradayLines.push(`• 🚀 Breakout at ${formatTime(state.last_breakout_at)}`);
  }
  if (state.last_bullish_reversal_at) {
    intradayLines.push(`• 🔄 Bullish reversal at ${formatTime(state.last_bullish_reversal_at)}`);
  }
  if (state.last_bearish_reversal_at) {
    intradayLines.push(`• 🔄 Bearish reversal at ${formatTime(state.last_bearish_reversal_at)}`);
  }
  lines.push('');
  lines.push('Recent intraday events:');
  if (intradayLines.length > 0) {
    lines.push(...intradayLines);
  } else {
    lines.push('• (no recent events tracked — add to watchlist for monitoring)');
  }

  // Today's volume vs yesterday (if we have daily context)
  if (dailyContext && dailyContext.yesterday.volume > 0) {
    const ratio = dailyContext.todayCumVolume / dailyContext.yesterday.volume;
    const overPct = (ratio - 1) * 100;
    const sign = overPct >= 0 ? '+' : '';
    const todayVolFmt = dailyContext.todayCumVolume >= 1e6
      ? (dailyContext.todayCumVolume / 1e6).toFixed(1) + 'M'
      : Math.round(dailyContext.todayCumVolume).toString();
    lines.push('');
    lines.push(`Today's volume: ${todayVolFmt} (${sign}${overPct.toFixed(1)}% vs yesterday)`);
  }

  return message.reply(lines.join('\n')).catch(e => console.error('[trend] reply', e.message));
}

// !trend watchlist → affiche les tickers sur la watchlist
async function handleWatchlist(message, { store, yahoo }) {
  const guildId = message.guildId;
  if (!guildId) return message.reply('Use this command in a server.').catch(() => {});
  const tickers = store.getWatchlist(guildId);
  if (tickers.length === 0) {
    return message.reply('Watchlist is empty. Add tickers with `!trend watch <TICKER>`.').catch(() => {});
  }

  const lines = [`Watchlist (${tickers.length} ticker${tickers.length === 1 ? '' : 's'}):`];
  for (const ticker of tickers) {
    const state = store.getState(ticker);
    const dir = state && state.direction;
    const emoji = DIRECTION_EMOJI[dir] || '·';
    const dirLabel = dir || 'unknown';
    lines.push(`${emoji} $${ticker} — ${dirLabel}`);
  }
  return message.reply(lines.join('\n')).catch(() => {});
}

// `!trend list` — show all guilds (the bot is in) where the trend module is
// configured AND the user is a member. Multi-guild visibility, no permission
// required (read-only, the user can already see those channels via Discord).
// Works in DM too — uses message.author.id to look up membership.
async function handleList(message, { store }) {
  const userId = message.author && message.author.id;
  if (!userId) return;
  const client = message.client;
  const allConfigs = store.getAllConfiguredGuilds();
  if (allConfigs.length === 0) {
    return message.reply('Trend module not configured anywhere yet.').catch(() => {});
  }

  const lines = [];
  for (const cfg of allConfigs) {
    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild) continue;  // bot no longer in this guild
    let isMember = false;
    try {
      const member = await guild.members.fetch(userId);
      isMember = !!member;
    } catch {
      isMember = false;  // user not in this guild (or fetch failed)
    }
    if (!isMember) continue;

    const watchCount = store.getWatchlist(cfg.guildId).length;
    const main = `<#${cfg.channelId}>`;
    const gap  = cfg.gapChannelId ? `<#${cfg.gapChannelId}>` : '(uses main)';
    lines.push(`• **${guild.name}** — main: ${main} · gap: ${gap} · ${watchCount} ticker${watchCount === 1 ? '' : 's'}`);
  }

  if (lines.length === 0) {
    return message.reply("Trend module isn't active in any server you share with this bot.").catch(() => {});
  }
  const header = `Trend module active in ${lines.length} server${lines.length === 1 ? '' : 's'} you're in:`;
  return message.reply([header, ...lines].join('\n')).catch(() => {});
}

// !trend status → affiche le statut du bot
async function handleStatus(message, { store, scannerConfig }) {
  const guildId = message.guildId;
  if (!guildId) return message.reply('Use this command in a server.').catch(() => {});
  const channelId = store.getChannel(guildId);
  const gapChannelId = store.getGapChannel(guildId);
  const directionDisabled = store.isDirectionDisabled(guildId);
  const watchCount = store.getWatchlist(guildId).length;
  const channelLine = channelId ? `<#${channelId}> ✅` : '⚠️ not set (use `!trend channel #channel`)';
  const gapLine = gapChannelId
    ? `<#${gapChannelId}> ✅`
    : '(uses main alert channel — set with `!trend gap-channel #channel`)';
  const directionLine = directionDisabled ? '❌ disabled' : '✅ enabled';
  const marketOpen = require('../trading/trend-scanner').isUSMarketOpen(new Date());
  const lines = [
    'Trend bot status (this server):',
    `• Alert channel: ${channelLine}`,
    `• Gap channel: ${gapLine}`,
    `• Direction alerts: ${directionLine}`,
    `• Watchlist: ${watchCount} ticker${watchCount === 1 ? '' : 's'}`,
    `• Scanner: running (every ${scannerConfig?.intervalMin || 5} min)`,
    `• Market: ${marketOpen ? 'open' : 'closed'}`,
  ];
  return message.reply(lines.join('\n')).catch(() => {});
}

// Liste blanche d'utilisateurs auxquels on accorde l'équivalent ManageGuild
// pour les commandes !trend, sur un serveur précis. Format env :
//   TREND_TRUSTED_USERS=guildId:userId,guildId:userId,...
// Lu une fois au load du module. Pour ajouter/retirer : modifier l'env var
// + redéployer (Railway redémarre auto).
function parseTrustedUsers(envValue) {
  if (!envValue || typeof envValue !== 'string') return new Set();
  return new Set(
    envValue
      .split(',')
      .map(s => s.trim())
      .filter(s => /^\d{1,20}:\d{1,20}$/.test(s))  // guildId:userId, snowflakes only
  );
}

const TRUSTED_PAIRS = parseTrustedUsers(process.env.TREND_TRUSTED_USERS);

function isTrustedTrendUser(guildId, userId) {
  if (!guildId || !userId) return false;
  return TRUSTED_PAIRS.has(`${guildId}:${userId}`);
}

function requireManageGuild(message) {
  if (!message.guildId) {
    message.reply('Use this command in a server.').catch(() => {});
    return false;
  }
  // ManageGuild OR trusted user (env-listed) — both authorize trend admin commands.
  const hasManageGuild = !!message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild);
  const isTrusted = isTrustedTrendUser(message.guildId, message.author?.id);
  if (!hasManageGuild && !isTrusted) {
    message.reply('❌ You need Manage Server permission to use this command.').catch(() => {});
    return false;
  }
  return true;
}

// PUBLIC : tout membre du serveur peut ajouter un ticker à la watchlist.
// `!trend unwatch` reste ManageGuild (sinon n'importe qui pourrait retirer
// le travail des autres). Validation ticker + fetch Yahoo conservés.
async function handleWatch(message, args, { store, yahoo }) {
  if (!message.guildId) {
    return message.reply('Use this command in a server.').catch(() => {});
  }
  if (args.length < 2) {
    return message.reply('Usage: `!trend watch <TICKER>`').catch(() => {});
  }
  const ticker = args[1].replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return message.reply('❌ Invalid ticker format').catch(() => {});
  }

  // Validate ticker against Yahoo before adding (a fetch test).
  let quoteType = null;
  try {
    const chart = await yahoo.getChart(ticker, '1D');
    if (!chart || !Array.isArray(chart.quotes) || chart.quotes.length === 0) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    if (typeof yahoo.getQuote === 'function') {
      try {
        const quote = await yahoo.getQuote(ticker);
        if (quote && quote.quoteType) quoteType = quote.quoteType;
      } catch (qErr) {
        // Quote fetch is best-effort; chart already validated the ticker exists.
        console.warn(`[trend] quote fetch failed for ${ticker}: ${qErr && qErr.message}`);
      }
    }
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }

  const added = store.addToWatchlist(message.guildId, ticker, Date.now(), quoteType);
  if (!added) {
    return message.reply(`ℹ️ $${ticker} already in watchlist`).catch(() => {});
  }
  const total = store.getWatchlist(message.guildId).length;
  return message.reply(`✅ Added $${ticker} to watchlist (${total} ticker${total === 1 ? '' : 's'} total)`).catch(() => {});
}

async function handleUnwatch(message, args, { store }) {
  if (!requireManageGuild(message)) return;
  if (args.length < 2) {
    return message.reply('Usage: `!trend unwatch <TICKER>`').catch(() => {});
  }
  const ticker = args[1].replace(/\$/g, '').toUpperCase();
  const removed = store.removeFromWatchlist(message.guildId, ticker);
  if (!removed) {
    return message.reply(`ℹ️ $${ticker} not in watchlist`).catch(() => {});
  }
  return message.reply(`✅ Removed $${ticker}`).catch(() => {});
}

async function handleChannel(message, args, { store }) {
  if (!message.guildId) {
    return message.reply('Use this command in a server.').catch(() => {});
  }

  // No argument: show current configuration. Read access OK for any user.
  if (args.length < 2) {
    const channelId = store.getChannel(message.guildId);
    if (!channelId) {
      return message.reply('⚠️ No alert channel set. Use `!trend channel #channel` (Manage Server permission required).').catch(() => {});
    }
    return message.reply(`Trend alert channel: <#${channelId}>`).catch(() => {});
  }

  // Set: requires permissions.
  if (!requireManageGuild(message)) return;

  // Discord auto-expands #channel into <#ID>. Parse either form.
  const arg = args[1];
  let channelId = null;
  const tagMatch = arg.match(/^<#(\d+)>$/);
  if (tagMatch) channelId = tagMatch[1];
  else if (/^\d+$/.test(arg)) channelId = arg;
  if (!channelId) {
    return message.reply('Usage: `!trend channel #channel`').catch(() => {});
  }

  // Sanity-check: the channel must exist in this guild and be a text channel.
  let channel;
  try {
    channel = await message.client.channels.fetch(channelId);
  } catch {
    return message.reply('❌ That channel does not exist or I cannot access it.').catch(() => {});
  }
  if (!channel || channel.guildId !== message.guildId) {
    return message.reply('❌ That channel is not in this server.').catch(() => {});
  }
  if (typeof channel.send !== 'function') {
    return message.reply('❌ That channel cannot receive messages.').catch(() => {});
  }

  store.setChannel(message.guildId, channelId, Date.now());
  return message.reply(`✅ Trend alerts will be posted to <#${channelId}>`).catch(() => {});
}

// `!trend gap-channel` — gère le salon dédié aux gap_up/gap_down.
// Sans argument : affiche la config actuelle.
// Avec argument 'off' / 'remove' / 'clear' : retire le routage dédié.
// Avec un salon : route les gaps vers ce salon.
//
// `!trend direction` — toggle on/off pour les alertes uptrend/downtrend
// per-guild. Le state interne reste tracké, seule l'alerte Discord est
// supprimée. Permet aux serveurs d'opter-out du bruit des transitions
// de direction tout en conservant les events ponctuels (breakout, gap, etc.).
//
// Sans argument : affiche le statut actuel.
// 'on' / 'enable' / 'enabled' / 'yes' : active les alertes.
// 'off' / 'disable' / 'disabled' / 'no' : désactive.
async function handleDirection(message, args, { store }) {
  if (!message.guildId) {
    return message.reply('Use this command in a server.').catch(() => {});
  }

  if (args.length < 2) {
    const disabled = store.isDirectionDisabled(message.guildId);
    return message.reply(`Direction alerts (uptrend/downtrend): ${disabled ? '❌ disabled' : '✅ enabled'}`).catch(() => {});
  }

  if (!requireManageGuild(message)) return;

  const arg = args[1].toLowerCase();
  let disabled;
  if (['off', 'disable', 'disabled', 'no'].includes(arg)) disabled = true;
  else if (['on', 'enable', 'enabled', 'yes'].includes(arg)) disabled = false;
  else {
    return message.reply('Usage: `!trend direction on` · `!trend direction off`').catch(() => {});
  }

  const ok = store.setDirectionDisabled(message.guildId, disabled, Date.now());
  if (!ok) {
    return message.reply('⚠️ Set the main alert channel first with `!trend channel #channel`.').catch(() => {});
  }
  return message.reply(disabled
    ? '✅ Direction alerts (uptrend/downtrend) disabled for this server.'
    : '✅ Direction alerts (uptrend/downtrend) enabled for this server.'
  ).catch(() => {});
}

// NOTE : nécessite qu'un main channel soit déjà configuré (`!trend channel`)
// car la ligne trend_channel doit exister pour que setGapChannel puisse
// l'updater.
async function handleGapChannel(message, args, { store }) {
  if (!message.guildId) {
    return message.reply('Use this command in a server.').catch(() => {});
  }

  if (args.length < 2) {
    const gapChannelId = store.getGapChannel(message.guildId);
    if (!gapChannelId) {
      return message.reply('⚠️ No dedicated gap channel set. Gap alerts go to the main alert channel. Use `!trend gap-channel #channel` to dedicate one.').catch(() => {});
    }
    return message.reply(`Gap alerts channel: <#${gapChannelId}>`).catch(() => {});
  }

  if (!requireManageGuild(message)) return;

  const arg = args[1].toLowerCase();
  if (arg === 'off' || arg === 'remove' || arg === 'clear' || arg === 'none') {
    store.deleteGapChannel(message.guildId);
    return message.reply('✅ Dedicated gap channel removed. Gap alerts will go to the main alert channel.').catch(() => {});
  }

  const original = args[1];
  let channelId = null;
  const tagMatch = original.match(/^<#(\d+)>$/);
  if (tagMatch) channelId = tagMatch[1];
  else if (/^\d+$/.test(original)) channelId = original;
  if (!channelId) {
    return message.reply('Usage: `!trend gap-channel #channel` · `!trend gap-channel off`').catch(() => {});
  }

  let channel;
  try {
    channel = await message.client.channels.fetch(channelId);
  } catch {
    return message.reply('❌ That channel does not exist or I cannot access it.').catch(() => {});
  }
  if (!channel || channel.guildId !== message.guildId) {
    return message.reply('❌ That channel is not in this server.').catch(() => {});
  }
  if (typeof channel.send !== 'function') {
    return message.reply('❌ That channel cannot receive messages.').catch(() => {});
  }

  const ok = store.setGapChannel(message.guildId, channelId, Date.now());
  if (!ok) {
    return message.reply('⚠️ Set the main alert channel first with `!trend channel #channel`.').catch(() => {});
  }
  return message.reply(`✅ Gap alerts will be posted to <#${channelId}>`).catch(() => {});
}

function registerTrendCommands(client, { store, yahoo, scannerConfig }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!trend')) return;

    const args = text.slice('!trend'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!trend <TICKER>` · `!trend watch <TICKER>` · `!trend unwatch <TICKER>` · `!trend watchlist` · `!trend status` · `!trend list` · `!trend channel #channel` · `!trend gap-channel #channel` · `!trend direction on|off`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    if (sub === 'watch')        return handleWatch(message, args, { store, yahoo });
    if (sub === 'unwatch')      return handleUnwatch(message, args, { store });
    if (sub === 'channel')      return handleChannel(message, args, { store });
    if (sub === 'gap-channel')  return handleGapChannel(message, args, { store });
    if (sub === 'direction')    return handleDirection(message, args, { store });
    if (sub === 'watchlist')    return handleWatchlist(message, { store, yahoo });
    if (sub === 'status')       return handleStatus(message, { store, scannerConfig });
    if (sub === 'list')         return handleList(message, { store });

    // Default: treat first arg as a ticker symbol.
    const ticker = args[0].replace(/\$/g, '').toUpperCase();
    return handleAnalyze(message, ticker, { yahoo, store });
  });
}

module.exports = { registerTrendCommands, parseTrustedUsers };
