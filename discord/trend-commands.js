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
  let chart;
  try {
    chart = await yahoo.getChart(ticker, '1D');
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    console.error('[trend] yahoo error', err && err.message);
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }
  const candles = adaptYahooBars(chart && chart.quotes);
  const verdict = detectAll(candles);
  if (!verdict) {
    return message.reply(`❌ Not enough data for $${ticker}`).catch(() => {});
  }

  const state = store.getState(ticker);
  const sinceLine = state && state.direction_changed_at
    ? ` (since ${formatTime(state.direction_changed_at)})`
    : '';

  const lines = [
    `📊 **$${ticker}**`,
    `Direction: ${DIRECTION_EMOJI[verdict.direction] || ''} ${verdict.direction}${sinceLine}`,
    `Price: ${formatPrice(verdict.snapshot.price)} · EMA9 ${formatPrice(verdict.snapshot.ema9)} · EMA20 ${formatPrice(verdict.snapshot.ema20)} · RSI ${formatRsi(verdict.snapshot.rsi)}`,
    '',
    'Recent events (last seen):',
  ];

  if (state) {
    if (state.last_breakout_at) {
      lines.push(`• 🚀 Breakout at ${formatTime(state.last_breakout_at)}`);
    }
    if (state.last_bullish_reversal_at) {
      lines.push(`• 🔄 Bullish reversal at ${formatTime(state.last_bullish_reversal_at)}`);
    }
    if (state.last_bearish_reversal_at) {
      lines.push(`• 🔄 Bearish reversal at ${formatTime(state.last_bearish_reversal_at)}`);
    }
    if (!state.last_breakout_at && !state.last_bullish_reversal_at && !state.last_bearish_reversal_at) {
      lines.push('• (no recent events tracked)');
    }
  } else {
    lines.push('• (no recent events tracked — add to watchlist for monitoring)');
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

// !trend status → affiche le statut du bot
async function handleStatus(message, { store, scannerConfig }) {
  const guildId = message.guildId;
  if (!guildId) return message.reply('Use this command in a server.').catch(() => {});
  const channelId = store.getChannel(guildId);
  const watchCount = store.getWatchlist(guildId).length;
  const channelLine = channelId ? `<#${channelId}> ✅` : '⚠️ not set (use `!trend channel #channel`)';
  const marketOpen = require('../trading/trend-scanner').isUSMarketOpen(new Date());
  const lines = [
    'Trend bot status (this server):',
    `• Alert channel: ${channelLine}`,
    `• Watchlist: ${watchCount} ticker${watchCount === 1 ? '' : 's'}`,
    `• Scanner: running (every ${scannerConfig?.intervalMin || 5} min)`,
    `• Market: ${marketOpen ? 'open' : 'closed'}`,
  ];
  return message.reply(lines.join('\n')).catch(() => {});
}

function requireManageGuild(message) {
  if (!message.guildId) {
    message.reply('Use this command in a server.').catch(() => {});
    return false;
  }
  if (!message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    message.reply('❌ You need Manage Server permission to use this command.').catch(() => {});
    return false;
  }
  return true;
}

async function handleWatch(message, args, { store, yahoo }) {
  if (!requireManageGuild(message)) return;
  if (args.length < 2) {
    return message.reply('Usage: `!trend watch <TICKER>`').catch(() => {});
  }
  const ticker = args[1].replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return message.reply('❌ Invalid ticker format').catch(() => {});
  }

  // Validate ticker against Yahoo before adding (a fetch test).
  try {
    const chart = await yahoo.getChart(ticker, '1D');
    if (!chart || !Array.isArray(chart.quotes) || chart.quotes.length === 0) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }

  const added = store.addToWatchlist(message.guildId, ticker, Date.now());
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

function registerTrendCommands(client, { store, yahoo, scannerConfig }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!trend')) return;

    const args = text.slice('!trend'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!trend <TICKER>` · `!trend watch <TICKER>` · `!trend unwatch <TICKER>` · `!trend watchlist` · `!trend status` · `!trend channel #channel`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    if (sub === 'watch')     return handleWatch(message, args, { store, yahoo });
    if (sub === 'unwatch')   return handleUnwatch(message, args, { store });
    if (sub === 'watchlist') return handleWatchlist(message, { store, yahoo });
    if (sub === 'status')    return handleStatus(message, { store, scannerConfig });

    if (!['channel'].includes(sub)) {
      const ticker = args[0].replace(/\$/g, '').toUpperCase();
      return handleAnalyze(message, ticker, { yahoo, store });
    }

    return message.reply('Subcommand not implemented yet').catch(() => {});
  });
}

module.exports = { registerTrendCommands };
