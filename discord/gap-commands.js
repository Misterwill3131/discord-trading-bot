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

// Détecte TOUS les gaps overnight dans la fenêtre de bars (3M daily typiquement).
// Pour chaque paire de jours ET consécutifs, calcule le gap entre la
// dernière bougie du jour précédent et la première bougie du jour suivant.
//
// Renvoie un array de gap objects, ordonnés du plus ancien au plus récent.
// Chaque gap object :
//   - prevSessionClose, todayOpen, gapPct
//   - prevCloseTimestamp   : timestamp de la dernière bougie du jour précédent
//   - todayOpenTimestamp   : timestamp de la première bougie du jour courant
//   - latestBarTimestamp   : timestamp de la DERNIÈRE bougie du jour courant
//                            → utilisé comme bord droit du rectangle annoté.
//                            Pour le gap le plus récent, c'est aussi le bord
//                            droit du chart entier.
//
// Skip un gap si :
//   - prevClose ou todayOpen non-finite
//   - prevClose <= 0 (division par zéro)
//   - prevClose === todayOpen (pas de gap réel = rectangle dégénéré)
function computeAllGapsFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return [];

  // Construit la liste des dates ET dans l'ordre d'apparition + map
  // first/last bar pour chaque date (1 seule passe sur bars).
  const datesInOrder    = [];
  const firstBarOfDate  = new Map();
  const lastBarOfDate   = new Map();
  for (const b of bars) {
    const d = formatDateET(new Date(b.t));
    if (!firstBarOfDate.has(d)) {
      firstBarOfDate.set(d, b);
      datesInOrder.push(d);
    }
    lastBarOfDate.set(d, b);  // overwrite, garde le dernier
  }
  if (datesInOrder.length < 2) return [];

  const gaps = [];
  for (let i = 1; i < datesInOrder.length; i++) {
    const prevLast  = lastBarOfDate.get(datesInOrder[i - 1]);
    const currFirst = firstBarOfDate.get(datesInOrder[i]);
    const currLast  = lastBarOfDate.get(datesInOrder[i]);
    if (!prevLast || !currFirst || !currLast) continue;

    const prevSessionClose = prevLast.c;
    const todayOpen        = currFirst.o;
    if (!Number.isFinite(prevSessionClose) || !Number.isFinite(todayOpen)) continue;
    if (prevSessionClose <= 0)            continue;
    if (prevSessionClose === todayOpen)   continue;  // pas de gap réel

    gaps.push({
      prevSessionClose,
      todayOpen,
      gapPct: ((todayOpen - prevSessionClose) / prevSessionClose) * 100,
      prevCloseTimestamp: prevLast.t,
      todayOpenTimestamp: currFirst.t,
      latestBarTimestamp: currLast.t,
    });
  }
  return gaps;
}

// Backward-compat : retourne le gap le plus récent (= dernier élément de
// computeAllGapsFromBars), ou null si aucun. Exposé pour les tests
// existants et les éventuels consumers qui n'ont besoin que du dernier gap.
function computeGapFromBars(bars) {
  const gaps = computeAllGapsFromBars(bars);
  return gaps.length > 0 ? gaps[gaps.length - 1] : null;
}

// !gap chart TICKER — fetch quote pour le code exchange, fetch 3M daily pour
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

  // 2) Yahoo 3M — bougies daily sur 3 mois. On détecte TOUS les gaps de la
  //    fenêtre puis on sélectionne CELUI avec la plus grande amplitude
  //    (|gapPct| desc). Raison : sur SPY/QQQ et autres mega-caps, le gap
  //    overnight strict (Friday close → Monday open) est typiquement
  //    ~0.05-0.2% — quasi invisible sur un chart 3M. Le gap LE PLUS
  //    SIGNIFICATIF de la fenêtre est ce que le trader veut voir
  //    (correspond au "vrai" gap, généralement 1%+).
  let biggestGap = null;
  let allBars = [];
  try {
    const chart = await yahoo.getChart(ticker, '3M');
    const quotes = (chart && chart.quotes) || [];
    allBars = quotes
      .filter(q => Number.isFinite(q.close))
      .map(q => ({
        t: q.date instanceof Date ? q.date.getTime() : q.date,
        o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
      }));
    const gaps = computeAllGapsFromBars(allBars);
    if (gaps.length > 0) {
      biggestGap = gaps.reduce((a, b) =>
        Math.abs(a.gapPct) >= Math.abs(b.gapPct) ? a : b
      );
    }
  } catch (err) {
    // Non-fatal : le chart chart-img reste utile sans annotation.
    console.warn('[gap] Yahoo 3M failed for ' + ticker + ': ' + (err && err.message));
  }

  // 3) Render chart via chart-img.
  //    Range '3M' = bougies daily sur 3 mois (~66 bars).
  //    Override studies = SEULEMENT Volume.
  //
  //    Un seul rectangle, sur le gap LE PLUS SIGNIFICATIF :
  //      - X : centré sur le moment du gap, avec ±3 jours de padding
  //            pour la visibilité (~6 jours = ~9% du chart)
  //      - Y : [prevSessionClose, todayOpen] = la zone de prix gappée
  //      - Label = le % du gap centré (ex: "+1.42%", "-2.15%")
  //      - Couleur amber/dark-goldenrod (alpha 0.2, lineWidth 1)
  const symbol = resolveSymbol(ticker, quote.exchange);
  const chartOpts = {
    studies: [{ name: 'Volume' }],
  };
  const lastBarT = allBars.length > 0
    ? allBars[allBars.length - 1].t
    : null;
  if (biggestGap && lastBarT !== null) {
    const sign = biggestGap.gapPct >= 0 ? '+' : '';
    // Padding ±3 jours autour du gap pour visibilité. Math.min/max protège
    // contre dépasser le bord droit du chart (lastBarT) ou aller plus tôt
    // que le premier bar (allBars[0].t).
    const X_PADDING_MS = 3 * 86_400_000;
    const startTime = Math.max(
      allBars[0].t,
      biggestGap.prevCloseTimestamp - X_PADDING_MS
    );
    const endTime = Math.min(
      lastBarT,
      biggestGap.todayOpenTimestamp + X_PADDING_MS
    );
    chartOpts.rectangles = [{
      startDatetime:   new Date(startTime).toISOString(),
      startPrice:      biggestGap.prevSessionClose,
      endDatetime:     new Date(endTime).toISOString(),
      endPrice:        biggestGap.todayOpen,
      text:            `${sign}${biggestGap.gapPct.toFixed(2)}%`,
      lineColor:       'rgb(184,134,11)',          // dark goldenrod (amber border)
      // chart-img validator only accepts single-decimal alpha (`rgba(r,g,b,0.X)`).
      backgroundColor: 'rgba(184,134,11,0.2)',     // amber fill, subtil
      lineWidth:       1,
    }];
  }
  let png;
  try {
    png = await chartImg.getChart(symbol, '3M', chartOpts);
  } catch (err) {
    console.error('[gap] chart-img error for ' + symbol + ': ' + (err && err.message));
    return message.reply('❌ Chart rendering failed, try again in a few minutes').catch(() => {});
  }

  // 4) Caption : chiffres du gap le plus significatif détecté dans la fenêtre.
  const captionLines = [`📊 **$${ticker}** — overnight gap`];
  if (biggestGap) {
    const sign = biggestGap.gapPct >= 0 ? '+' : '';
    const arrow = biggestGap.gapPct >= 0 ? '⬆️' : '⬇️';
    const direction = biggestGap.gapPct >= 0 ? 'up' : 'down';
    captionLines[0] = `${arrow} **$${ticker}** — biggest overnight gap ${direction} ${sign}${biggestGap.gapPct.toFixed(2)}%`;
    captionLines.push(`Open ${fmtPrice(biggestGap.todayOpen)} vs prev session close ${fmtPrice(biggestGap.prevSessionClose)}`);
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

module.exports = {
  registerGapCommands,
  computeGapFromBars,
  computeAllGapsFromBars,
};
