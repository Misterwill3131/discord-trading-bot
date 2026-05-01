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

function registerTrendCommands(client, { store, yahoo }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!trend')) return;

    const args = text.slice('!trend'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!trend <TICKER>` · `!trend watch <TICKER>` · `!trend watchlist` · `!trend status` · `!trend channel #channel`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    // First branch: analyze. Will be expanded in later tasks.
    if (!['watch', 'unwatch', 'watchlist', 'channel', 'status'].includes(sub)) {
      const ticker = args[0].replace(/\$/g, '').toUpperCase();
      return handleAnalyze(message, ticker, { yahoo, store });
    }

    // Other subcommands wired in subsequent tasks.
    return message.reply('Subcommand not implemented yet').catch(() => {});
  });
}

module.exports = { registerTrendCommands };
