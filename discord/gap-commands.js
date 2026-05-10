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

// Détecte TOUS les gaps overnight dans la fenêtre de bars (5D typiquement).
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

  // 2) Yahoo 5D — pour détecter TOUS les gaps de la fenêtre.
  //    On ne filtre PAS aux regular hours : convention trader que le gap est
  //    entre la dernière bougie ~20h ET (after-hours close) et la première
  //    bougie ~04h ET (pre-market open). chart-img sera configuré ci-dessous
  //    avec `session: 'extended'` pour afficher cette même fenêtre, donc
  //    nos timestamps anchor (extended-hours bars) sont visibles sur le chart.
  let gaps = [];
  let allBars = [];
  try {
    const chart = await yahoo.getChart(ticker, '5D');
    const quotes = (chart && chart.quotes) || [];
    allBars = quotes
      .filter(q => Number.isFinite(q.close))
      .map(q => ({
        t: q.date instanceof Date ? q.date.getTime() : q.date,
        o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
      }));
    gaps = computeAllGapsFromBars(allBars);
  } catch (err) {
    // Non-fatal : le chart chart-img reste utile sans annotations.
    console.warn('[gap] Yahoo 5D failed for ' + ticker + ': ' + (err && err.message));
  }

  // 3) Render chart via chart-img.
  //    Range '5D' = 15m bars sur 5 jours.
  //    Override studies = SEULEMENT Volume (pas de VWAP/EMAs/MAs des
  //    DEFAULT_STUDIES). Pour `!gap chart` on veut un chart minimal qui
  //    laisse les zones de gap respirer.
  //
  //    Pour CHAQUE gap on dessine un rectangle ambré qui s'étend jusqu'au
  //    PROCHAIN gap (et le dernier va jusqu'au bord droit du chart). Cette
  //    chaîne de rectangles segmente l'axe temporel par "périodes entre
  //    gaps", ce qui rend chaque zone gappée immédiatement reconnaissable
  //    et permet de voir comment le prix s'est comporté dans chaque tranche.
  //
  //    Format de chaque rectangle :
  //      - X gauche : `todayOpenTimestamp` (1er bar de la session post-gap)
  //      - X droit  : `todayOpenTimestamp` du gap suivant, OU `latestBarTimestamp`
  //                   pour le dernier (= bord droit du chart)
  //      - Y : [prevSessionClose, todayOpen] = la zone de prix gappée
  //      - Label = le % du gap centré (ex: "+0.28%", "-1.45%") — chiffre
  //        directement sur le rectangle pour identifier visuellement
  //        l'amplitude de chaque gap sans avoir à lire la caption.
  //      - Couleur amber/dark-goldenrod (alpha 0.2, lineWidth 1 — discret
  //        mais visible)
  const symbol = resolveSymbol(ticker, quote.exchange);
  const chartOpts = {
    studies:  [{ name: 'Volume' }],
    session:  'extended',                // affiche pre-market + after-hours
    timezone: 'America/New_York',        // X-axis labels en ET (cohérent avec ouverture/fermeture)
  };
  const lastBarT = allBars.length > 0
    ? allBars[allBars.length - 1].t
    : null;
  // Marge avant le gap suivant : 4h. Permet aux rectangles de respirer
  // visuellement (un petit espace blanc entre 2 zones gappées) au lieu
  // de se toucher bord à bord. Math.max protège contre le cas dégénéré
  // où 2 gaps seraient à < 4h l'un de l'autre (impossible en pratique
  // sur du daily, mais évite un rectangle inversé).
  const MARGIN_BEFORE_NEXT_MS = 4 * 60 * 60 * 1000;
  if (gaps.length > 0 && lastBarT !== null) {
    chartOpts.rectangles = gaps.map((g, i) => {
      // Bord droit = (prochain gap - 4h) si présent, sinon bord du chart.
      const nextGap = gaps[i + 1];
      const endT    = nextGap
        ? Math.max(g.todayOpenTimestamp, nextGap.todayOpenTimestamp - MARGIN_BEFORE_NEXT_MS)
        : lastBarT;
      const sign    = g.gapPct >= 0 ? '+' : '';
      return {
        startDatetime:   new Date(g.todayOpenTimestamp).toISOString(),
        startPrice:      g.prevSessionClose,
        endDatetime:     new Date(endT).toISOString(),
        endPrice:        g.todayOpen,
        text:            `${sign}${g.gapPct.toFixed(2)}%`,
        lineColor:       'rgb(184,134,11)',          // dark goldenrod (amber border)
        // chart-img validator only accepts single-decimal alpha (`rgba(r,g,b,0.X)`).
        // `0.25` → HTTP 422 "must be a valid rgb/rgba color". Use `0.2`.
        backgroundColor: 'rgba(184,134,11,0.2)',     // amber fill, subtil
        lineWidth:       1,
      };
    });
  }
  let png;
  try {
    png = await chartImg.getChart(symbol, '5D', chartOpts);
  } catch (err) {
    console.error('[gap] chart-img error for ' + symbol + ': ' + (err && err.message));
    return message.reply('❌ Chart rendering failed, try again in a few minutes').catch(() => {});
  }

  // 4) Caption : highlight le gap le plus récent (= dernier de l'array,
  //    le plus utile actionnable), + count si plusieurs gaps détectés.
  const captionLines = [`📊 **$${ticker}** — overnight gap`];
  if (gaps.length > 0) {
    const latest = gaps[gaps.length - 1];
    const sign = latest.gapPct >= 0 ? '+' : '';
    const arrow = latest.gapPct >= 0 ? '⬆️' : '⬇️';
    const direction = latest.gapPct >= 0 ? 'up' : 'down';
    captionLines[0] = `${arrow} **$${ticker}** — overnight gap ${direction} ${sign}${latest.gapPct.toFixed(2)}%`;
    captionLines.push(`Open ${fmtPrice(latest.todayOpen)} vs prev session close ${fmtPrice(latest.prevSessionClose)}`);
    if (gaps.length > 1) {
      captionLines.push(`(${gaps.length} gaps detected in last 5 days — see chart)`);
    }
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
