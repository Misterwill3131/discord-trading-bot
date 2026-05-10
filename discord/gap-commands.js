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

// Returns true if the timestamp falls within US regular trading hours
// (9:30 AM ≤ ET time < 4:00 PM ET). Pre-market et after-hours = false.
//
// CRITIQUE pour `!gap chart` : Yahoo retourne des bars extended-hours
// (4h-20h ET) mais chart-img n'affiche QUE les regular hours sur son
// chart. Si on calcule les gaps avec des bars extended-hours :
//   - prevCloseTimestamp = ~20h ET (after-hours close, INVISIBLE sur chart-img)
//   - todayOpenTimestamp = ~04h ET (pre-market open, INVISIBLE sur chart-img)
//   → Le rectangle atterrit à des positions imprévisibles (chart-img doit
//     "snapper" les timestamps invisibles à un bar visible le plus proche).
//
// En filtrant aux regular hours :
//   - prevCloseTimestamp = ~15:45 ET (dernier 15min bar régulier)
//   - todayOpenTimestamp = ~09:30 ET (premier bar régulier)
//   → Ces timestamps sont sur des bars visibles, le rectangle est positionné
//     précisément au boundary entre 2 sessions affichées.
function isRegularHoursET(timestamp) {
  const date = new Date(timestamp);
  // toLocaleTimeString avec timeZone gère DST automatiquement (EDT/EST).
  const etHM = date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12:   false,
    hour:     '2-digit',
    minute:   '2-digit',
  });
  // etHM = "HH:MM" (en-US 24h avec ces options)
  const [hh, mm] = etHM.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
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

// Détecte si/quand un gap est "rempli" (filled) par le price action subséquent.
//
// Définition trader standard : un gap up est filled quand le prix retombe
// dans la zone [prevClose, todayOpen]. Symétrique pour gap down.
// Concrètement, on cherche la première bougie POST-gap dont le range [low, high]
// chevauche la zone du gap.
//
// Use case : détermine la longueur du rectangle d'annotation sur le chart.
// Si filled → rectangle s'arrête au moment du fill. Sinon → rectangle s'étend
// jusqu'au bord droit du chart (caller passe `latestBarTimestamp` en fallback).
//
// Renvoie le timestamp de la première bougie qui remplit le gap, ou null si
// le gap reste open dans la fenêtre des bars fournis.
function findGapFillTimestamp(bars, gap) {
  if (!Array.isArray(bars) || !gap) return null;
  if (!Number.isFinite(gap.prevSessionClose) || !Number.isFinite(gap.todayOpen)) {
    return null;
  }
  const zoneLow  = Math.min(gap.prevSessionClose, gap.todayOpen);
  const zoneHigh = Math.max(gap.prevSessionClose, gap.todayOpen);
  for (const bar of bars) {
    // Skip les bars AVANT ou AU moment de l'open (le bar d'open lui-même
    // crée le gap, il ne peut pas le remplir).
    if (bar.t <= gap.todayOpenTimestamp) continue;
    if (!Number.isFinite(bar.l) || !Number.isFinite(bar.h)) continue;
    // Bar's [low, high] range chevauche la zone [zoneLow, zoneHigh] ?
    if (bar.l <= zoneHigh && bar.h >= zoneLow) {
      return bar.t;
    }
  }
  return null;
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

  // 2) Yahoo 5D — pour détecter TOUS les gaps de la fenêtre (1 rectangle
  //    par gap) ET pour la caption (chiffres du gap le plus récent).
  //    Si Yahoo échoue ici, on continue avec un chart sans annotations.
  //
  //    On FILTRE aux regular hours (9:30-16:00 ET) avant de calculer les
  //    gaps : chart-img n'affiche que les regular hours sur son chart, donc
  //    nos timestamps anchor doivent être sur des bars visibles. Voir
  //    isRegularHoursET pour le détail.
  let gaps = [];
  let regularBars = [];
  try {
    const chart = await yahoo.getChart(ticker, '5D');
    const quotes = (chart && chart.quotes) || [];
    regularBars = quotes
      .filter(q => Number.isFinite(q.close))
      .map(q => ({
        t: q.date instanceof Date ? q.date.getTime() : q.date,
        o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
      }))
      .filter(b => isRegularHoursET(b.t));
    gaps = computeAllGapsFromBars(regularBars);
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
  //    Style "Fair Value Gap" / "open gap" — convention trader standard :
  //    Pour chaque gap, le rectangle :
  //      - X gauche : `todayOpenTimestamp` (1er bar de la session post-gap,
  //                   = exactement où le gap est visible sur chart-img)
  //      - X droit  : timestamp où le gap est "filled" (price re-entre
  //                   dans la zone). Si jamais filled, étend jusqu'au
  //                   dernier bar du chart (= bord droit visible).
  //      - Y : [prevSessionClose, todayOpen] = la zone de prix gappée.
  //      - Label "GAP" centré (sans %, le caption Discord donne le chiffre
  //        précis pour le gap le plus récent).
  //      - Couleur amber/sienna pour matcher l'esthétique TradingView FVG
  //        (alpha 0.2, lineWidth 1 — discret mais visible).
  const symbol = resolveSymbol(ticker, quote.exchange);
  const chartOpts = {
    studies: [{ name: 'Volume' }],
  };
  const lastBarT = regularBars.length > 0
    ? regularBars[regularBars.length - 1].t
    : null;
  if (gaps.length > 0 && lastBarT !== null) {
    chartOpts.rectangles = gaps.map(g => {
      const fillT = findGapFillTimestamp(regularBars, g);
      const endT  = fillT !== null ? fillT : lastBarT;
      return {
        startDatetime:   new Date(g.todayOpenTimestamp).toISOString(),
        startPrice:      g.prevSessionClose,
        endDatetime:     new Date(endT).toISOString(),
        endPrice:        g.todayOpen,
        text:            'GAP',
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
  isRegularHoursET,
  findGapFillTimestamp,
};
