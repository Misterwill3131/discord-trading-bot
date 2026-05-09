// ─────────────────────────────────────────────────────────────────────
// trading/trend-scanner.js — Boucle de scan trend + dispatch alertes
// ─────────────────────────────────────────────────────────────────────
// Tick 60s ; déclenche un scan toutes les TREND_SCAN_INTERVAL_MIN min
// pendant les heures de marché US régulières (lun-ven, 9:30-16:00 ET).
// Pour chaque ticker watché par au moins une guild :
//   1. Fetch candles via Yahoo (cached).
//   2. detectAll → verdict.
//   3. Compare à trend_state, génère alertes (transitions + events).
//   4. Dispatch chaque alerte aux guilds qui watch le ticker.
// ─────────────────────────────────────────────────────────────────────

// Détermine si NYSE est ouverte à la date donnée (heures régulières).
// Gère DST automatiquement via Intl.DateTimeFormat timezone NY.
// Pas de gestion des jours fériés US — on accepte de scanner pour rien
// le 4 juillet (~10 jours/an, coût négligeable).
function isUSMarketOpen(date = new Date()) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  let weekday = '', hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour')    hour = parseInt(p.value, 10);
    else if (p.type === 'minute')  minute = parseInt(p.value, 10);
  }

  // Intl peut produire 'hour' = '24' à minuit (selon le runtime). Normalise.
  if (hour === 24) hour = 0;

  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Returns the calendar date in America/New_York as 'YYYY-MM-DD'. Used as
// sentinel for the daily reset of trend_state. Locale 'en-CA' is chosen
// because it natively formats as 'YYYY-MM-DD' (sortable, ISO-like).
function formatDateET(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

const { detectAll } = require('./trend-engine');

// Discord error codes for channel-write failures we want to handle specifically.
const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_MISSING_ACCESS = 50001;
const DISCORD_MISSING_PERMISSIONS = 50013;

const DEFAULT_DEDUP_MINUTES = 60;
const DEFAULT_THROTTLE_MS = 200;

// Adapt Yahoo bars { date, open, high, low, close, volume } to the
// engine's internal shape { t, o, h, l, c, v }. Skip rows with NaN closes.
function adaptYahooBars(quotes) {
  if (!Array.isArray(quotes)) return [];
  return quotes
    .filter(q => Number.isFinite(q.close))
    .map(q => ({
      t: q.date instanceof Date ? q.date.getTime() : q.date,
      o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume,
    }));
}

// Fetch daily chart (~22 days) and extract yesterday's OHLCV + today's
// open + cumulative volume. Yahoo arrange les quotes par ordre
// chronologique ; "today" est le dernier (en cours), "yesterday" l'avant-dernier,
// "dayBefore" l'antépénultième (pour calculer priorHigh/priorLow sur 2 jours).
//
// `priorHigh` / `priorLow` = max/min sur les 2 dernières daily bars complètes
// (yesterday + dayBefore). Sert de référence pour PDH/PDL break — capture la
// résistance/support 2-jour plutôt que juste la veille.
//
// Retourne null si erreur ou < 2 quotes (ticker très jeune / illiquide).
// Si seulement 2 quotes (today + yesterday, pas de dayBefore), priorHigh/Low
// retombent sur yesterday's high/low.
async function getDailyContext(yahoo, ticker) {
  let chart;
  try {
    chart = await yahoo.getChart(ticker, '1M');
  } catch (err) {
    console.warn(`[trend] getDailyContext failed for ${ticker}: ${err && err.message}`);
    return null;
  }
  const quotes = (chart && chart.quotes) || [];
  if (quotes.length < 2) return null;
  const today = quotes[quotes.length - 1];
  const yesterday = quotes[quotes.length - 2];
  const dayBefore = quotes.length >= 3 ? quotes[quotes.length - 3] : null;

  const priorHigh = dayBefore && Number.isFinite(dayBefore.high)
    ? Math.max(yesterday.high, dayBefore.high)
    : yesterday.high;
  const priorLow = dayBefore && Number.isFinite(dayBefore.low)
    ? Math.min(yesterday.low, dayBefore.low)
    : yesterday.low;

  // prevSessionClose : close de la dernière bougie d'hier en extended hours
  // (typiquement ~20:00 ET). Sert au detectGap pour mesurer le vrai gap
  // overnight (premarket open 4:00 vs after-hours close 20:00). Yahoo daily
  // bar = RTH close à 16:00 → on a besoin d'un fetch intraday multi-jours.
  // Best-effort : fallback null si erreur, le détecteur retombera sur
  // yesterday.close (gap RTH-only).
  let prevSessionClose = null;
  // fiveDay15mBars : bars adaptées au format engine {t,o,h,l,c,v}, exposées
  // pour le rendu du chart gap-alert (canvas/gap-chart.js). Empty si fetch
  // failed ou pas de données.
  let fiveDay15mBars = [];
  try {
    const intra5d = await yahoo.getChart(ticker, '5D');
    const bars = (intra5d && intra5d.quotes) || [];
    const todayDateET = formatDateET(new Date());
    for (let i = bars.length - 1; i >= 0; i--) {
      const ts = bars[i].date instanceof Date ? bars[i].date.getTime() : bars[i].date;
      if (!Number.isFinite(ts)) continue;
      if (formatDateET(new Date(ts)) !== todayDateET && Number.isFinite(bars[i].close)) {
        prevSessionClose = bars[i].close;
        break;
      }
    }
    // Adapt to engine bar shape for downstream consumers (chart renderer).
    fiveDay15mBars = bars
      .filter(b => Number.isFinite(b.close))
      .map(b => ({
        t: b.date instanceof Date ? b.date.getTime() : b.date,
        o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
      }));
  } catch (err) {
    console.warn(`[trend] prevSessionClose fetch failed for ${ticker}: ${err && err.message}`);
  }

  return {
    yesterday: {
      high: yesterday.high,
      low: yesterday.low,
      close: yesterday.close,
      volume: yesterday.volume,
    },
    priorHigh,
    priorLow,
    todayOpen: today.open,
    todayCumVolume: today.volume,
    prevSessionClose,
    fiveDay15mBars,
  };
}

function fmtPrice(v)  { return Number.isFinite(v) ? '$' + v.toFixed(2) : '—'; }
function fmtVolume(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

const DIRECTION_EMOJI = { uptrend: '📈', downtrend: '📉', sideways: '➡️' };

function formatDirectionAlert(ticker, fromDir, toDir, snap) {
  return [
    `${DIRECTION_EMOJI[toDir] || '📊'} **$${ticker}** — ${toDir}`,
    `Was: ${fromDir || 'unknown'} · Now: ${toDir}`,
    `Price: ${fmtPrice(snap.price)} · EMA9 ${fmtPrice(snap.ema9)} · EMA20 ${fmtPrice(snap.ema20)} · RSI ${snap.rsi != null ? snap.rsi.toFixed(0) : '—'}`,
  ].join('\n');
}

function formatBreakoutAlert(ticker, ev, snap) {
  const ratio = ev.avgVolume > 0 ? (ev.volume / ev.avgVolume).toFixed(1) : '—';
  return [
    `🚀 **$${ticker}** — breakout`,
    `Broke 20-bar high ${fmtPrice(ev.high)} on ${ratio}× volume`,
    `Price: ${fmtPrice(snap.price)} · Volume: ${fmtVolume(ev.volume)} (avg ${fmtVolume(ev.avgVolume)})`,
  ].join('\n');
}

function formatReversalAlert(ticker, ev, snap) {
  const isBullish = ev.type === 'bullish_reversal';
  const label = isBullish ? 'bullish reversal' : 'bearish reversal';
  const cause = isBullish
    ? `RSI was oversold (${ev.troughRsi.toFixed(0)}), EMA9 crossed above EMA20`
    : `RSI was overbought (${ev.peakRsi.toFixed(0)}), EMA9 crossed below EMA20`;
  return [
    `🔄 **$${ticker}** — ${label}`,
    cause,
    `Price: ${fmtPrice(snap.price)} · RSI ${ev.rsi != null ? ev.rsi.toFixed(0) : '—'} · EMA9 ${fmtPrice(ev.ema9)} · EMA20 ${fmtPrice(ev.ema20)}`,
  ].join('\n');
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toFixed(1) + '%';
}

// Formats today's cumulative volume + ratio vs yesterday. Used by PDH/PDL
// break alerts (where the per-bar volume from Yahoo is unreliable for the
// in-progress current bar). Returns "—" if dailyContext lacks data.
function fmtTodayVolume(dailyContext) {
  if (!dailyContext) return '—';
  const today = dailyContext.todayCumVolume;
  const yest  = dailyContext.yesterday && dailyContext.yesterday.volume;
  if (!Number.isFinite(today) || today <= 0) return '—';
  if (!Number.isFinite(yest) || yest <= 0) return fmtVolume(today);
  const overPct = ((today / yest) - 1) * 100;
  return `${fmtVolume(today)} (${fmtPct(overPct)} vs yesterday)`;
}

function formatPDHBreakAlert(ticker, ev, snap, dailyContext) {
  return [
    `🟢 **$${ticker}** — PDH break`,
    `Closed above 2-day high ${fmtPrice(ev.pdh)}`,
    `Price: ${fmtPrice(ev.price)} · Today vol: ${fmtTodayVolume(dailyContext)}`,
  ].join('\n');
}

function formatPDLBreakAlert(ticker, ev, snap, dailyContext) {
  return [
    `🔴 **$${ticker}** — PDL break`,
    `Closed below 2-day low ${fmtPrice(ev.pdl)}`,
    `Price: ${fmtPrice(ev.price)} · Today vol: ${fmtTodayVolume(dailyContext)}`,
  ].join('\n');
}

function formatPMHBreakAlert(ticker, ev, snap, dailyContext) {
  return [
    `🟩 **$${ticker}** — PMH break`,
    `Closed above premarket high ${fmtPrice(ev.pmh)}`,
    `Price: ${fmtPrice(ev.price)} · Today vol: ${fmtTodayVolume(dailyContext)}`,
  ].join('\n');
}

function formatPMLBreakAlert(ticker, ev, snap, dailyContext) {
  return [
    `🟥 **$${ticker}** — PML break`,
    `Closed below premarket low ${fmtPrice(ev.pml)}`,
    `Price: ${fmtPrice(ev.price)} · Today vol: ${fmtTodayVolume(dailyContext)}`,
  ].join('\n');
}

function formatGapAlert(ticker, ev, snap) {
  const arrow = ev.type === 'gap_up' ? '⬆️' : '⬇️';
  const label = ev.type === 'gap_up' ? 'overnight gap up' : 'overnight gap down';
  return [
    `${arrow} **$${ticker}** — ${label} ${fmtPct(ev.gapPct)}`,
    `Premarket open ${fmtPrice(ev.openPrice)} vs prev session close ${fmtPrice(ev.prevClose)}`,
  ].join('\n');
}

function formatVolumeAboveAlert(ticker, ev, snap, nowMs) {
  const overPct = ((ev.ratio - 1) * 100);
  const time = new Date(nowMs).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return [
    `📊 **$${ticker}** — volume above prev day`,
    `Today: ${fmtVolume(ev.todayVolume)} (${fmtPct(overPct)}) · Yesterday: ${fmtVolume(ev.prevDayVolume)}`,
    `Time: ${time} ET`,
  ].join('\n');
}

// channelType : 'main' (default) ou 'gap'. Détermine quel champ DB on
// nettoie quand le channel est UnknownChannel — on évite ainsi de purger
// la config principale quand c'est juste le salon gap qui a été supprimé.
//
// files : optionnel, array of { attachment: Buffer, name: string } passé
// au discord.js v14 channel.send pour attacher des PNG (chart gap, etc.).
async function postToChannel({ discord, store, guildId, channelId, content, channelType = 'main', files = null }) {
  try {
    const channel = await discord.channels.fetch(channelId);
    const payload = (Array.isArray(files) && files.length > 0)
      ? { content, files }
      : content;
    await channel.send(payload);
    return { ok: true };
  } catch (err) {
    if (err && err.code === DISCORD_UNKNOWN_CHANNEL) {
      console.warn(`[trend] ${channelType} channel ${channelId} unknown — clearing for guild ${guildId}`);
      if (channelType === 'gap') store.deleteGapChannel(guildId);
      else                       store.deleteChannel(guildId);
      return { ok: false, reason: 'unknown_channel' };
    }
    if (err && (err.code === DISCORD_MISSING_PERMISSIONS || err.code === DISCORD_MISSING_ACCESS)) {
      console.warn(`[trend] missing permissions for ${channelType} channel ${channelId} (guild ${guildId})`);
      return { ok: false, reason: 'missing_permissions' };
    }
    console.error(`[trend] postToChannel (${channelType}) failed: ${err && err.message}`);
    return { ok: false, reason: 'error' };
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Run one full scan cycle. Designed to be called every TREND_SCAN_INTERVAL_MIN
// minutes (gating logic lives in startTrendScanner).
async function runScanCycle({
  store,
  yahoo,
  discord,
  now = () => Date.now(),
  dedupMinutes = DEFAULT_DEDUP_MINUTES,
  throttleMs = DEFAULT_THROTTLE_MS,
  detectorOpts = {},
}) {
  const startedAt = now();
  const tickers = store.getDistinctTickers();
  let alerts = 0;
  let errors = 0;

  for (const ticker of tickers) {
    try {
      // 1. Daily reset if ET date has changed since last scan for this ticker
      const todayET = formatDateET(new Date(now()));
      const stateBefore = store.getState(ticker);
      if (!stateBefore || stateBefore.daily_state_date !== todayET) {
        store.resetDailyState(ticker, todayET);
      }

      // 2. Backfill quote_type if missing
      let quoteType = store.getQuoteType(ticker);
      if (quoteType == null && typeof yahoo.getQuote === 'function') {
        try {
          const q = await yahoo.getQuote(ticker);
          if (q && q.quoteType) {
            quoteType = q.quoteType;
            store.setQuoteType(ticker, quoteType);
          }
        } catch (err) {
          console.warn(`[trend] quote backfill failed for ${ticker}: ${err && err.message}`);
        }
      }

      // 3. Compute gap threshold from quote_type
      const isIndexLike = quoteType === 'ETF' || quoteType === 'INDEX' || quoteType === 'MUTUALFUND';
      const gapThresholdPct = isIndexLike
        ? (detectorOpts.gapThresholdIndexPct || 0.5)
        : (detectorOpts.gapThresholdStockPct || 1.5);

      // 4. Fetch intraday + daily context
      const chart = await yahoo.getChart(ticker, '1D');
      const candles = adaptYahooBars(chart && chart.quotes);
      const dailyContext = await getDailyContext(yahoo, ticker);

      // 5. Re-read state (after potential reset)
      const state = store.getState(ticker) || {};

      // 6. detectAll with the daily context + state
      const verdict = detectAll(candles, dailyContext, state, {
        breakoutLookback: detectorOpts.breakoutLookback,
        breakoutVolMult:  detectorOpts.breakoutVolMult,
        rsiOverbought:    detectorOpts.rsiOverbought,
        rsiOversold:      detectorOpts.rsiOversold,
        reentryMs:        detectorOpts.reentryMs,
        gapThresholdPct,
        volumeMultiplier: detectorOpts.volumeMultiplier,
        now:              now(),
      });
      if (!verdict) continue;

      // 7. Apply state updates from engine (new daily-event flags)
      if (verdict.stateUpdates && Object.keys(verdict.stateUpdates).length > 0) {
        store.applyStateUpdates(ticker, verdict.stateUpdates);
      }

      // 8. Direction transition. On track l'état (mise à jour de la DB) pour
      // toutes les transitions, mais on ne fire l'alerte QUE si la nouvelle
      // direction est uptrend ou downtrend. Skip les transitions vers
      // 'sideways' (signal trop fréquent, peu actionnable). Le state reste
      // à jour donc la prochaine transition (ex. sideways → uptrend) montre
      // bien "Was: sideways" dans son alerte.
      const tNow = now();
      const dedupMs = dedupMinutes * 60 * 1000;
      const messages = [];
      const prevDir = state.direction || null;
      if (verdict.direction !== prevDir) {
        store.updateDirection(ticker, verdict.direction, tNow);
        if (verdict.direction !== 'sideways') {
          messages.push({
            type: 'direction',
            content: formatDirectionAlert(ticker, prevDir, verdict.direction, verdict.snapshot),
          });
        }
      }

      // 9. Events: dispatch with appropriate dedup logic per type
      for (const ev of verdict.events) {
        let content = null;
        const lastTsCol =
          ev.type === 'breakout' ? 'last_breakout_at' :
          ev.type === 'bullish_reversal' ? 'last_bullish_reversal_at' :
          ev.type === 'bearish_reversal' ? 'last_bearish_reversal_at' : null;

        if (lastTsCol) {
          // Time-based dedup (existing logic)
          const lastTs = state[lastTsCol] || null;
          if (lastTs && (tNow - lastTs) < dedupMs) continue;
          content = ev.type === 'breakout'
            ? formatBreakoutAlert(ticker, ev, verdict.snapshot)
            : formatReversalAlert(ticker, ev, verdict.snapshot);
          store.updateEvent(ticker, ev.type, tNow);
        } else if (ev.type === 'pdh_break') {
          content = formatPDHBreakAlert(ticker, ev, verdict.snapshot, dailyContext);
        } else if (ev.type === 'pdl_break') {
          content = formatPDLBreakAlert(ticker, ev, verdict.snapshot, dailyContext);
        } else if (ev.type === 'pmh_break') {
          content = formatPMHBreakAlert(ticker, ev, verdict.snapshot, dailyContext);
        } else if (ev.type === 'pml_break') {
          content = formatPMLBreakAlert(ticker, ev, verdict.snapshot, dailyContext);
        } else if (ev.type === 'gap_up' || ev.type === 'gap_down') {
          content = formatGapAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'volume_above_prev_day') {
          content = formatVolumeAboveAlert(ticker, ev, verdict.snapshot, now());
        }

        if (!content) continue;
        // Pour les gaps : tente de rendre un PNG annoté (best-effort).
        // Si le rendu échoue ou retourne null, on envoie juste le texte.
        let files = null;
        if (ev.type === 'gap_up' || ev.type === 'gap_down') {
          try {
            const { renderGapChartPng } = require('../canvas/gap-chart');
            const png = renderGapChartPng({
              bars: (dailyContext && dailyContext.fiveDay15mBars) || [],
              prevSessionClose: ev.prevClose,
              todayOpen: ev.openPrice,
              gapPct: ev.gapPct,
              ticker,
            });
            if (png) {
              files = [{ attachment: png, name: `gap-${ticker}-${Date.now()}.png` }];
            }
          } catch (err) {
            console.warn(`[trend] gap chart render failed for ${ticker}: ${err && err.message}`);
          }
        }
        messages.push({ type: ev.type, content, files });
      }

      if (messages.length === 0) continue;

      const guilds = store.getGuildsWatching(ticker);
      // Dédup par-(channelId, msg.type) au sein de ce ticker : si plusieurs
      // serveurs partagent un même salon Discord (cas typique : un user a le
      // bot dans 4 serveurs perso pointant tous vers son #trends), on évite
      // le post 4× du même alert. La dédup est scoped au scan-cycle de ce
      // ticker, donc cross-scan le state-based dedup (pdh_alerts_today, etc.)
      // continue à fonctionner indépendamment.
      const sentKeys = new Set();
      for (const guildId of guilds) {
        const mainChannelId = store.getChannel(guildId);
        if (!mainChannelId) continue;
        // gap_channel_id (nullable) : si défini, gap_up/gap_down sont routés
        // ici au lieu du channel principal. Local var pour pouvoir le clear
        // au sein de la boucle si Yahoo retourne UnknownChannel.
        let gapChannelId = store.getGapChannel(guildId);
        // Per-guild toggle : si activé, on skip les messages 'direction'
        // (uptrend/downtrend). Le state continue à être tracké pour que la
        // ré-activation ultérieure montre les bonnes transitions.
        const directionDisabled = store.isDirectionDisabled(guildId);
        for (const msg of messages) {
          if (msg.type === 'direction' && directionDisabled) continue;
          const isGap = msg.type === 'gap_up' || msg.type === 'gap_down';
          const useGap = isGap && gapChannelId;
          const channelId = useGap ? gapChannelId : mainChannelId;
          const channelType = useGap ? 'gap' : 'main';
          const dedupKey = `${channelId}:${msg.type}`;
          if (sentKeys.has(dedupKey)) continue;  // déjà envoyé sur ce salon par un autre guild
          sentKeys.add(dedupKey);
          const result = await postToChannel({ discord, store, guildId, channelId, content: msg.content, channelType, files: msg.files || null });
          if (result.ok) alerts += 1;
          if (result.reason === 'unknown_channel') {
            if (channelType === 'main') break;  // main dead → skip remaining messages for this guild
            gapChannelId = null;                // gap dead → fallback to main for future gap msgs
          }
        }
      }
    } catch (err) {
      errors += 1;
      console.error(`[trend] scan failed for ${ticker}: ${err && err.message}`);
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }

  const elapsed = now() - startedAt;
  console.log(`[trend] scan: ${tickers.length} tickers, ${alerts} alerts, ${errors} errors, ${elapsed} ms`);
  return { tickers: tickers.length, alerts, errors, elapsed };
}

const TICK_MS = 60_000;

// Read env vars at start time. Defaults match the spec.
function readScannerConfig() {
  const num = (k, d) => {
    const v = parseFloat(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    intervalMin:           num('TREND_SCAN_INTERVAL_MIN', 5),
    dedupMinutes:          num('TREND_DEDUP_MINUTES', 60),
    rsiOverbought:         num('TREND_RSI_OVERBOUGHT', 70),
    rsiOversold:           num('TREND_RSI_OVERSOLD', 30),
    breakoutLookback:      num('TREND_BREAKOUT_LOOKBACK_BARS', 20),
    breakoutVolMult:       num('TREND_BREAKOUT_VOLUME_MULT', 1.5),
    pdhPdlReentryMin:      num('TREND_PDH_PDL_REENTRY_MIN', 15),
    gapThresholdIndexPct:  num('TREND_GAP_THRESHOLD_INDEX_PCT', 0.5),
    gapThresholdStockPct:  num('TREND_GAP_THRESHOLD_STOCK_PCT', 1.5),
    volumeVsPrevPct:       num('TREND_VOLUME_VS_PREV_PCT', 5),
  };
}

// Démarre le scanner. Appelé une fois après l'event Discord 'ready'.
// Retourne une fonction `stop()` pour arrêt propre (utile si un jour
// on veut redémarrer le module sans relancer le process).
function startTrendScanner({ client, store, yahoo, now = () => Date.now() }) {
  const cfg = readScannerConfig();
  const detectorOpts = {
    breakoutLookback:     cfg.breakoutLookback,
    breakoutVolMult:      cfg.breakoutVolMult,
    rsiOverbought:        cfg.rsiOverbought,
    rsiOversold:          cfg.rsiOversold,
    reentryMs:            cfg.pdhPdlReentryMin * 60_000,
    gapThresholdIndexPct: cfg.gapThresholdIndexPct,
    gapThresholdStockPct: cfg.gapThresholdStockPct,
    volumeMultiplier:     1 + (cfg.volumeVsPrevPct / 100),
  };

  let running = false;

  async function tick() {
    if (running) return;            // skip si un cycle précédent est en cours
    const date = new Date(now());
    if (!isUSMarketOpen(date))      return;
    if (date.getMinutes() % cfg.intervalMin !== 0) return;

    running = true;
    try {
      await runScanCycle({
        store, yahoo,
        discord: client,
        now,
        dedupMinutes: cfg.dedupMinutes,
        detectorOpts,
      });
    } catch (err) {
      console.error('[trend] runScanCycle threw:', err && err.stack || err);
    } finally {
      running = false;
    }
  }

  let handle = null;
  client.once('ready', () => {
    handle = setInterval(tick, TICK_MS);
    if (handle.unref) handle.unref(); // ne pas bloquer le shutdown du process
    console.log(`[trend] scanner started (interval ${cfg.intervalMin}min, dedup ${cfg.dedupMinutes}min)`);
  });

  return function stop() {
    if (handle) clearInterval(handle);
  };
}

module.exports = { isUSMarketOpen, formatDateET, getDailyContext, runScanCycle, startTrendScanner };
