// ─────────────────────────────────────────────────────────────────────
// discord/market-alerts.js — Alertes prix/volume sur watchlist statique
// ─────────────────────────────────────────────────────────────────────
// Cinq types d'alertes déclenchées en live durant les heures de marché
// US régulières (RTH 09:30–16:00 ET, lun-ven) sur la watchlist définie
// par l'env var WATCHED_TICKERS :
//
//   yday_high     : prix actuel > high d'hier
//   yday_low      : prix actuel < low d'hier
//   week_high     : prix actuel > high des 5 dernières sessions
//   week_low      : prix actuel < low des 5 dernières sessions
//   volume_spike  : volume cumulé du jour ≥ volume d'hier × 1.10
//
// Provider-agnostic : le caller injecte un `marketClient` qui doit
// satisfaire le contrat suivant :
//
//   getQuote(ticker)     → { price: number, volume: number }
//                          (volume = cumulé depuis l'ouverture)
//   getDailyBars(ticker) → [{ date: Date, open, high, low, close, volume }, ...]
//                          (ordre chronologique croissant ; ≥10 barres récentes)
//
// Implémentations existantes : discord/fmp-client.js (Financial Modeling
// Prep — défaut). On peut brancher Yahoo, IBKR ou un mock ; la logique
// de seuil/dedup reste identique.
//
// Dedup : (ticker, alert_type, ET-date) avec INSERT OR IGNORE atomique
// dans SQLite. Mark-then-send : on marque AVANT d'envoyer, donc une
// panne Discord transitoire perd une alerte plutôt que d'en spammer
// 60 (le rejouer N fois est pire que ne pas l'envoyer une fois).
//
// Architecture : pure-logic. Pas de setInterval ici — c'est jobs.js
// qui drive tick(now) selon la cadence configurée.
// ─────────────────────────────────────────────────────────────────────

const dbDefault = require('../db/sqlite');
const { formatPrice, formatVolume } = require('./market-commands');

// Lit l'heure dans le fuseau America/New_York. Même pattern que
// discord/jobs.js:210-216 — Intl gère la DST automatiquement, plus
// robuste que de jouer avec les offsets EDT/EST en dur.
function getETParts(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

// 'YYYY-MM-DD' en heure ET. C'est la clé de dedup — au changement
// de minuit ET, une nouvelle alerte du même type peut re-fire.
function getETDateKey(date) {
  const p = getETParts(date);
  return p.year + '-' + p.month + '-' + p.day;
}

// Regular Trading Hours US : Lun-Ven 09:30 ≤ HH:mm < 16:00 ET.
// Hors RTH on no-op (pas de poll Yahoo, pas d'alerte). Pre/post-market
// volatiles + Yahoo regularMarketVolume reset à 09:30 → comparer avec
// hier ne fait pas sens avant l'ouverture.
function isRTH(date) {
  const p = getETParts(date);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Format des messages — plain text English (cf memory feedback note).
// Réutilise formatPrice / formatVolume de market-commands.js pour la
// cohérence visuelle avec !price.
function buildMessage(alertType, ticker, snap, ctx) {
  const p = formatPrice(snap.price);
  switch (alertType) {
    case 'yday_high':
      return '**' + ticker + '** broke yesterday’s high — now $' + p
        + ', yesterday’s high $' + formatPrice(ctx.yHigh);
    case 'yday_low':
      return '**' + ticker + '** broke yesterday’s low — now $' + p
        + ', yesterday’s low $' + formatPrice(ctx.yLow);
    case 'week_high':
      return '**' + ticker + '** broke 5-day high — now $' + p
        + ', 5-day high $' + formatPrice(ctx.weekHigh);
    case 'week_low':
      return '**' + ticker + '** broke 5-day low — now $' + p
        + ', 5-day low $' + formatPrice(ctx.weekLow);
    case 'volume_spike': {
      const pct = ctx.yVolume > 0
        ? ((snap.todayVolume - ctx.yVolume) / ctx.yVolume) * 100
        : 0;
      const sign = pct >= 0 ? '+' : '';
      return '**' + ticker + '** volume spike — today '
        + formatVolume(snap.todayVolume) + ' vs yesterday '
        + formatVolume(ctx.yVolume) + ' (' + sign + pct.toFixed(1) + '%)';
    }
    default:
      return '**' + ticker + '** ' + alertType;
  }
}

// Pure : décide quels alert_types sont déclenchés par le couple
// (snapshot live, contexte daily). Ordre déterministe — utilisé par les
// tests pour matcher.
function evaluate({ snap, ctx }) {
  const fires = [];
  if (!snap || !ctx) return fires;
  if (!Number.isFinite(snap.price)) return fires;

  if (Number.isFinite(ctx.yHigh) && snap.price > ctx.yHigh) fires.push('yday_high');
  if (Number.isFinite(ctx.yLow)  && snap.price < ctx.yLow)  fires.push('yday_low');
  if (Number.isFinite(ctx.weekHigh) && snap.price > ctx.weekHigh) fires.push('week_high');
  if (Number.isFinite(ctx.weekLow)  && snap.price < ctx.weekLow)  fires.push('week_low');
  // Comparaison volume en arithmétique entière pour éviter le piège
  // flottant : 100_000 * 1.10 = 110_000.00000000001 → exactement
  // 110_000 ne déclencherait jamais. v_today * 10 >= v_yday * 11 est
  // strictement équivalent à v_today >= v_yday * 1.10 sans imprécision.
  if (Number.isFinite(ctx.yVolume) && ctx.yVolume > 0
      && Number.isFinite(snap.todayVolume)
      && snap.todayVolume * 10 >= ctx.yVolume * 11) {
    fires.push('volume_spike');
  }
  return fires;
}

// Extrait le contexte daily depuis un chart Yahoo (interval 1d).
// `bars` = chart.quotes filtré aux barres avec date valide. On filtre
// ensuite les barres dont l'ET-date est strictement < etDate (today).
// Le dernier élément = "yesterday" ; les 5 derniers = fenêtre weekly.
//
// Robustesse : Mon-after-weekend ne demande aucune logique spéciale —
// Yahoo ne renvoie que les jours de trading, donc le dernier bar
// avant lundi est naturellement vendredi. Idem pour les jours fériés.
function extractContext(bars, etDate) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const past = [];
  for (const b of bars) {
    if (!b || !(b.date instanceof Date)) continue;
    if (!Number.isFinite(b.high) || !Number.isFinite(b.low)) continue;
    if (getETDateKey(b.date) >= etDate) continue;
    past.push(b);
  }
  if (past.length === 0) return null;

  const yday = past[past.length - 1];
  const week = past.slice(-5);
  const highs = week.map(b => b.high).filter(Number.isFinite);
  const lows  = week.map(b => b.low).filter(Number.isFinite);

  return {
    yHigh: yday.high,
    yLow: yday.low,
    yVolume: Number.isFinite(yday.volume) ? yday.volume : 0,
    weekHigh: highs.length ? Math.max(...highs) : null,
    weekLow:  lows.length  ? Math.min(...lows)  : null,
    asOfDate: etDate,
  };
}

function createMarketAlertsScheduler({
  marketClient,
  sendAlert,
  tickers = [],
  db = dbDefault,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!marketClient) throw new Error('marketClient required');
  if (typeof marketClient.getQuote !== 'function') throw new Error('marketClient.getQuote required');
  if (typeof marketClient.getDailyBars !== 'function') throw new Error('marketClient.getDailyBars required');
  if (typeof sendAlert !== 'function') throw new Error('sendAlert (function) required');
  if (!Array.isArray(tickers)) throw new Error('tickers must be an array');

  // Cache du contexte daily : 1 fetch / ticker / ET-date. Map<ticker,
  // { etDate, ctx }>. Refresh automatique au changement de jour ET.
  const dailyCache = new Map();

  // Compteurs internes — utiles aux tests + futur monitoring.
  const stats = { ticks: 0, alertsFired: 0, errors: 0 };

  async function getYesterdayContext(ticker, etDate) {
    const hit = dailyCache.get(ticker);
    if (hit && hit.etDate === etDate) return hit.ctx;
    let bars;
    try {
      bars = await marketClient.getDailyBars(ticker);
    } catch (err) {
      logger.error('[market-alerts] getDailyBars failed for ' + ticker + ': ' + err.message);
      stats.errors++;
      return null;
    }
    const ctx = extractContext(bars, etDate);
    if (ctx) dailyCache.set(ticker, { etDate, ctx });
    return ctx;
  }

  async function getCurrentSnapshot(ticker) {
    let quote;
    try {
      quote = await marketClient.getQuote(ticker);
    } catch (err) {
      logger.error('[market-alerts] getQuote failed for ' + ticker + ': ' + err.message);
      stats.errors++;
      return null;
    }
    if (!quote) return null;
    return {
      price: Number.isFinite(quote.price) ? quote.price : null,
      todayVolume: Number.isFinite(quote.volume) ? quote.volume : 0,
    };
  }

  async function processTicker(ticker, etDate, firedAtMs) {
    const ctx = await getYesterdayContext(ticker, etDate);
    if (!ctx) return;
    const snap = await getCurrentSnapshot(ticker);
    if (!snap || !Number.isFinite(snap.price)) return;

    const fires = evaluate({ snap, ctx });
    for (const alertType of fires) {
      // Mark-then-send : si l'INSERT OR IGNORE retourne true, c'est
      // qu'on est le premier à fire ce combo aujourd'hui — on envoie.
      // Sinon, déjà fired → skip silencieux.
      const claimed = db.markAlertFired(ticker, alertType, etDate, firedAtMs);
      if (!claimed) continue;
      stats.alertsFired++;
      const message = buildMessage(alertType, ticker, snap, ctx);
      logger.log('[market-alerts] FIRED ' + alertType + ' ' + ticker
        + ' price=' + snap.price);
      try {
        await sendAlert(message);
      } catch (err) {
        // Send failed — dedup row reste pour ne pas spammer au prochain
        // tick. Documenté comme trade-off préféré (perdre 1 alerte vs
        // risquer 60 messages identiques sur une panne réseau brève).
        logger.error('[market-alerts] sendAlert failed for ' + alertType
          + ' ' + ticker + ': ' + err.message);
      }
    }
  }

  async function tick(when) {
    const refDate = when instanceof Date ? when : now();
    if (!isRTH(refDate)) return { skipped: 'not-RTH' };
    if (tickers.length === 0) return { skipped: 'no-tickers' };

    stats.ticks++;
    const etDate = getETDateKey(refDate);
    const firedAtMs = refDate.getTime();

    // Process tickers en séquence — simplifie le rate-limit Yahoo.
    // À 4-10 tickers c'est largement sous la seconde par tick.
    for (const ticker of tickers) {
      try {
        await processTicker(ticker, etDate, firedAtMs);
      } catch (err) {
        logger.error('[market-alerts] processTicker error for ' + ticker
          + ': ' + err.message);
        stats.errors++;
      }
    }
    return { ticks: stats.ticks, alertsFired: stats.alertsFired };
  }

  function getState() {
    return {
      tickers: tickers.slice(),
      stats: { ...stats },
      cachedTickers: Array.from(dailyCache.keys()),
    };
  }

  return { tick, getState };
}

// ─────────────────────────────────────────────────────────────────────
// Commandes Discord de diagnostic — registerMarketAlertCommands
// ─────────────────────────────────────────────────────────────────────
// Deux commandes admin/test :
//
//   !testalert        → envoie un message témoin sur MARKET_ALERTS_CHANNEL_ID
//                       via le sendAlert injecté. Permet de vérifier en 1 call
//                       que le salon, les permissions et le wiring sont OK
//                       sans attendre qu'un seuil réel se casse.
//
//   !alertstatus      → affiche l'état courant du scheduler (watchlist, RTH,
//                       stats, dernière erreur).
//
// Pas d'auth dédiée — vise à être utilisé dans un salon où seuls les
// admins ont accès (typiquement le salon de test). Le bot répond au
// message dans le même salon.
// ─────────────────────────────────────────────────────────────────────

function registerMarketAlertCommands(client, { sendAlert, scheduler } = {}) {
  if (!client) throw new Error('client required');
  if (typeof sendAlert !== 'function') throw new Error('sendAlert required');

  // !testalert — envoie un message synthétique via sendAlert. Le destinataire
  // est le salon configuré (MARKET_ALERTS_CHANNEL_ID), pas le salon d'invocation.
  client.on('messageCreate', async (message) => {
    if (message.author?.bot) return;
    if (message.content.trim() !== '!testalert') return;
    const author = message.author?.username || 'someone';
    console.log('[market-alerts] !testalert invoked by ' + author
      + ' in #' + (message.channel?.name || message.channel?.id));
    const stamp = new Date().toISOString().slice(11, 19) + 'Z';
    const sample = '**TEST** market-alerts wiring check at ' + stamp
      + ' — if you see this in the configured alerts channel, the pipeline works.';
    try {
      await sendAlert(sample);
      // Confirmation dans le salon d'invocation pour que l'utilisateur sache
      // si c'est partie. Ne dit PAS que ça a atterri (sendAlert peut être
      // un no-op silencieux si la channel ID est vide), juste qu'on a tenté.
      try {
        await message.reply('✅ Test alert dispatched — check the configured market-alerts channel.');
      } catch (_) {}
    } catch (err) {
      console.error('[market-alerts] !testalert send failed:', err.message);
      try {
        await message.reply('❌ Test alert failed: ' + err.message);
      } catch (_) {}
    }
  });

  // !alertstatus — bilan rapide de l'état du module.
  client.on('messageCreate', async (message) => {
    if (message.author?.bot) return;
    if (message.content.trim() !== '!alertstatus') return;
    const lines = ['📊 **Market alerts status**'];
    if (!scheduler) {
      lines.push('> Scheduler: **not initialized** (WATCHED_TICKERS or FMP_API_KEY missing at boot)');
    } else {
      const state = scheduler.getState();
      const inRth = isRTH(new Date());
      lines.push('> Tickers: `' + (state.tickers.join(', ') || '(none)') + '`');
      lines.push('> RTH right now: ' + (inRth ? '✅ yes' : '❌ no — alerts will not fire'));
      lines.push('> Stats: ticks=' + state.stats.ticks
        + ', alerts fired=' + state.stats.alertsFired
        + ', errors=' + state.stats.errors);
      lines.push('> Daily-bars cached for: `' + (state.cachedTickers.join(', ') || '(none)') + '`');
    }
    try { await message.reply(lines.join('\n')); }
    catch (err) { console.error('[market-alerts] !alertstatus reply failed:', err.message); }
  });
}

module.exports = {
  createMarketAlertsScheduler,
  registerMarketAlertCommands,
  // Exposed for tests
  getETParts,
  getETDateKey,
  isRTH,
  evaluate,
  extractContext,
  buildMessage,
};
