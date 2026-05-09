// ─────────────────────────────────────────────────────────────────────
// discord/gap-commands.js — Commandes !gap ...
// ─────────────────────────────────────────────────────────────────────
//   !gap chart TICKER     — render PNG annoté du dernier gap overnight
//                           (premarket open vs prev session close)
//
// Préfixe distinct du !trend pour que les utilisateurs n'aient pas à
// retenir un sub-command long. Marche sur n'importe quel ticker (pas
// besoin qu'il soit dans la watchlist du serveur).
// ─────────────────────────────────────────────────────────────────────

const { renderGapChartPng } = require('../canvas/gap-chart');
const { formatDateET } = require('../trading/trend-scanner');

function fmtPrice(v) { return Number.isFinite(v) ? '$' + v.toFixed(2) : '—'; }

function isUnknownTicker(err) {
  return err && (
    /not.*found/i.test(err.message || '') ||
    /no.*data/i.test(err.message || '') ||
    err.code === 'NOT_FOUND'
  );
}

// !gap chart TICKER — fetch 5D, calcule prevSessionClose / todayOpen / gapPct
// des 2 dernières dates ET distinctes, render PNG annoté, reply avec attach.
// Marche n'importe quand (anchor sur les bars, pas sur Date.now()).
async function handleGapChart(message, args, { yahoo }) {
  if (!message.guildId) {
    return message.reply('Use this command in a server.').catch(() => {});
  }
  if (args.length < 2) {
    return message.reply('Usage: `!gap chart <TICKER>`').catch(() => {});
  }
  const ticker = args[1].replace(/\$/g, '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return message.reply('❌ Invalid ticker format').catch(() => {});
  }

  let chart;
  try {
    chart = await yahoo.getChart(ticker, '5D');
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }

  const quotes = (chart && chart.quotes) || [];
  const bars = quotes
    .filter(q => Number.isFinite(q.close))
    .map(q => ({
      t: q.date instanceof Date ? q.date.getTime() : q.date,
      o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
    }));
  if (bars.length < 2) {
    return message.reply(`❌ Not enough data for $${ticker}`).catch(() => {});
  }

  // 2 dernières dates ET distinctes (gère weekends/holidays naturellement).
  const datesInOrder = [];
  const seen = new Set();
  for (const b of bars) {
    const d = formatDateET(new Date(b.t));
    if (!seen.has(d)) { seen.add(d); datesInOrder.push(d); }
  }
  if (datesInOrder.length < 2) {
    return message.reply(`❌ Need at least 2 trading days of data for $${ticker}`).catch(() => {});
  }
  const latestDate = datesInOrder[datesInOrder.length - 1];
  const prevDate   = datesInOrder[datesInOrder.length - 2];

  let prevSessionClose = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (formatDateET(new Date(bars[i].t)) === prevDate) {
      prevSessionClose = bars[i].c;
      break;
    }
  }
  let todayOpen = null;
  for (let i = 0; i < bars.length; i++) {
    if (formatDateET(new Date(bars[i].t)) === latestDate) {
      todayOpen = bars[i].o;
      break;
    }
  }
  if (!Number.isFinite(prevSessionClose) || !Number.isFinite(todayOpen) || prevSessionClose <= 0) {
    return message.reply(`❌ Could not compute gap for $${ticker}`).catch(() => {});
  }

  const gapPct = ((todayOpen - prevSessionClose) / prevSessionClose) * 100;
  const png = renderGapChartPng({ bars, prevSessionClose, todayOpen, gapPct, ticker });
  if (!png) {
    return message.reply(`❌ Could not render chart for $${ticker}`).catch(() => {});
  }

  const sign = gapPct >= 0 ? '+' : '';
  const arrow = gapPct >= 0 ? '⬆️' : '⬇️';
  const direction = gapPct >= 0 ? 'up' : 'down';
  const captionLines = [
    `${arrow} **$${ticker}** — overnight gap ${direction} ${sign}${gapPct.toFixed(2)}%`,
    `Open ${fmtPrice(todayOpen)} vs prev session close ${fmtPrice(prevSessionClose)}`,
  ];
  return message.reply({
    content: captionLines.join('\n'),
    files: [{ attachment: png, name: `gap-${ticker}-${Date.now()}.png` }],
  }).catch(e => console.error('[gap] chart reply', e.message));
}

function registerGapCommands(client, { yahoo }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!gap')) return;

    const args = text.slice('!gap'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!gap chart <TICKER>`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    if (sub === 'chart') return handleGapChart(message, args, { yahoo });

    return message.reply('Usage: `!gap chart <TICKER>`').catch(() => {});
  });
}

module.exports = { registerGapCommands };
