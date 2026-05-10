// ─────────────────────────────────────────────────────────────────────
// discord/gap-commands.js — Commandes !gap ...
// ─────────────────────────────────────────────────────────────────────
//   !gap chart TICKER     — render PNG du dernier gap overnight via
//                           chart-img (TradingView Advanced Chart).
//                           Caption affiche les chiffres précis
//                           (open vs prev close, % gap).
//
// Préfixe distinct du !trend pour que les utilisateurs n'aient pas à
// retenir un sub-command long. Marche sur n'importe quel ticker (pas
// besoin qu'il soit dans la watchlist du serveur).
//
// Le rendu canvas local (canvas/gap-chart.js) a été remplacé par
// chart-img : la font système n'avait pas les glyphs emoji/spéciaux et
// produisait des "□" partout. chart-img rend côté serveur avec un vrai
// font set + indicateurs TradingView (VWAP, EMAs, MAs).
// ─────────────────────────────────────────────────────────────────────

const { resolveSymbol } = require('./chart-img-client');
const { formatDateET } = require('../trading/trend-scanner');

function fmtPrice(v) { return Number.isFinite(v) ? '$' + v.toFixed(2) : '—'; }

function isUnknownTicker(err) {
  return err && (
    /not.*found/i.test(err.message || '') ||
    /no.*data/i.test(err.message || '') ||
    err.code === 'NOT_FOUND'
  );
}

// Compute le gap (prevSessionClose, todayOpen, gapPct) depuis les bars 5D
// Yahoo. Anchor sur les 2 dernières dates ET distinctes (gère weekends/
// holidays naturellement). Renvoie null si data insuffisante.
function computeGapFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;

  const datesInOrder = [];
  const seen = new Set();
  for (const b of bars) {
    const d = formatDateET(new Date(b.t));
    if (!seen.has(d)) { seen.add(d); datesInOrder.push(d); }
  }
  if (datesInOrder.length < 2) return null;

  const latestDate = datesInOrder[datesInOrder.length - 1];
  const prevDate   = datesInOrder[datesInOrder.length - 2];

  let prevSessionClose = null;
  let prevCloseTimestamp = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (formatDateET(new Date(bars[i].t)) === prevDate) {
      prevSessionClose   = bars[i].c;
      prevCloseTimestamp = bars[i].t;
      break;
    }
  }
  let todayOpen = null;
  let todayOpenTimestamp = null;
  for (let i = 0; i < bars.length; i++) {
    if (formatDateET(new Date(bars[i].t)) === latestDate) {
      todayOpen          = bars[i].o;
      todayOpenTimestamp = bars[i].t;
      break;
    }
  }
  if (!Number.isFinite(prevSessionClose) || !Number.isFinite(todayOpen) || prevSessionClose <= 0) {
    return null;
  }

  const gapPct = ((todayOpen - prevSessionClose) / prevSessionClose) * 100;
  // Timestamps inclus pour permettre au caller de placer un drawing
  // (rectangle, ligne, etc.) sur la zone du gap dans le chart.
  // latestBarTimestamp = dernier bar des données → utile pour étendre
  // un rectangle horizontalement jusqu'au bord droit du chart.
  return {
    prevSessionClose,
    todayOpen,
    gapPct,
    prevCloseTimestamp,
    todayOpenTimestamp,
    latestBarTimestamp: bars[bars.length - 1].t,
  };
}

// !gap chart TICKER — fetch quote pour le code exchange, fetch 5D pour
// calculer le gap, render PNG via chart-img, reply avec attach + caption.
// Marche n'importe quand (anchor sur les bars, pas sur Date.now()).
async function handleGapChart(message, args, { yahoo, chartImg }) {
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

  // chart-img unavailable → graceful degradation. Le caller (index.js)
  // passe `chartImg = null` si CHART_IMG_API_KEY est absent.
  if (!chartImg) {
    return message.reply('❌ Chart rendering unavailable (CHART_IMG_API_KEY not configured).').catch(() => {});
  }

  // 1) Yahoo quote — sert à 2 choses :
  //    - valider le ticker (works on weekends, contrairement à getChart 1D)
  //    - récupérer `exchange` pour résoudre le préfixe TradingView
  let quote;
  try {
    quote = await yahoo.getQuote(ticker);
    if (!quote || !quote.symbol) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
  } catch (err) {
    if (isUnknownTicker(err)) {
      return message.reply(`❌ Unknown ticker $${ticker}`).catch(() => {});
    }
    return message.reply('❌ Yahoo Finance unavailable, try again in a few minutes').catch(() => {});
  }

  // 2) Yahoo 5D — pour calculer le gap (caption seulement, le chart est
  //    rendu par chart-img). Si Yahoo échoue ici, on continue sans gap
  //    précis dans la caption — le chart sera quand même affiché.
  let gap = null;
  try {
    const chart = await yahoo.getChart(ticker, '5D');
    const quotes = (chart && chart.quotes) || [];
    const bars = quotes
      .filter(q => Number.isFinite(q.close))
      .map(q => ({
        t: q.date instanceof Date ? q.date.getTime() : q.date,
        o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
      }));
    gap = computeGapFromBars(bars);
  } catch (err) {
    // Non-fatal : le chart chart-img reste utile sans la caption précise.
    console.warn('[gap] Yahoo 5D failed for ' + ticker + ': ' + (err && err.message));
  }

  // 3) Render chart via chart-img.
  //    Range '5D' = 15m bars sur 5 jours.
  //    Override studies = SEULEMENT Volume (pas de VWAP/EMAs/MAs des
  //    DEFAULT_STUDIES). Pour `!gap chart` on veut un chart minimal qui
  //    laisse la zone du gap respirer — les MAs/EMAs ajouteraient des lignes
  //    qui obscurcissent visuellement le rectangle orange. Le volume reste,
  //    car il aide à valider si le gap a été suivi de volume (gap + volume
  //    = signal fort, gap sans volume = souvent à fade).
  //
  //    Si on a calculé le gap, on annote la zone avec un rectangle orange.
  //    Le rectangle s'étend horizontalement de `prevCloseTimestamp` (moment
  //    du gap, bord gauche) jusqu'au DERNIER bar du chart (`latestBarTimestamp`,
  //    bord droit). Si on prenait `todayOpenTimestamp` à la place, le
  //    rectangle serait juste une fine bande verticale entre le dernier bar
  //    d'hier et le premier bar d'aujourd'hui — invisible sur 5D. En
  //    l'étendant jusqu'au bord droit, on obtient une zone horizontale claire
  //    qui surligne le RANGE de prix du gap [prevClose, todayOpen] sur toute
  //    la portion post-gap, avec le label "GAP +X.XX%" centré.
  const symbol = resolveSymbol(ticker, quote.exchange);
  const chartOpts = {
    studies: [{ name: 'Volume' }],
  };
  if (gap) {
    const sign = gap.gapPct >= 0 ? '+' : '';
    chartOpts.rectangles = [{
      startDatetime:   new Date(gap.prevCloseTimestamp).toISOString(),
      startPrice:      gap.prevSessionClose,
      endDatetime:     new Date(gap.latestBarTimestamp).toISOString(),
      endPrice:        gap.todayOpen,
      text:            `GAP ${sign}${gap.gapPct.toFixed(2)}%`,
      lineColor:       'rgb(255,165,0)',          // orange solid
      // chart-img validator only accepts single-decimal alpha (`rgba(r,g,b,0.X)`).
      // `0.25` → HTTP 422 "must be a valid rgb/rgba color". Use `0.3`.
      backgroundColor: 'rgba(255,165,0,0.3)',     // orange fill semi-transparent
      lineWidth:       2,
    }];
  }
  let png;
  try {
    png = await chartImg.getChart(symbol, '5D', chartOpts);
  } catch (err) {
    console.error('[gap] chart-img error for ' + symbol + ': ' + (err && err.message));
    return message.reply('❌ Chart rendering failed, try again in a few minutes').catch(() => {});
  }

  // 4) Caption : numbers from gap if available, sinon générique.
  const captionLines = [`📊 **$${ticker}** — overnight gap`];
  if (gap) {
    const sign = gap.gapPct >= 0 ? '+' : '';
    const arrow = gap.gapPct >= 0 ? '⬆️' : '⬇️';
    const direction = gap.gapPct >= 0 ? 'up' : 'down';
    captionLines[0] = `${arrow} **$${ticker}** — overnight gap ${direction} ${sign}${gap.gapPct.toFixed(2)}%`;
    captionLines.push(`Open ${fmtPrice(gap.todayOpen)} vs prev session close ${fmtPrice(gap.prevSessionClose)}`);
  }

  return message.reply({
    content: captionLines.join('\n'),
    files: [{ attachment: png, name: `gap-${ticker}-${Date.now()}.png` }],
  }).catch(e => console.error('[gap] chart reply', e.message));
}

function registerGapCommands(client, { yahoo, chartImg }) {
  client.on('messageCreate', async (message) => {
    if (!message || !message.content || message.author?.bot) return;
    const text = message.content.trim();
    if (!text.startsWith('!gap')) return;

    const args = text.slice('!gap'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      return message.reply('Usage: `!gap chart <TICKER>`').catch(() => {});
    }

    const sub = args[0].toLowerCase();
    if (sub === 'chart') return handleGapChart(message, args, { yahoo, chartImg });

    return message.reply('Usage: `!gap chart <TICKER>`').catch(() => {});
  });
}

module.exports = { registerGapCommands, computeGapFromBars };
