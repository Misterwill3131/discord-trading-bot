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
// chronologique ; "today" est le dernier (en cours), "yesterday" l'avant-dernier.
//
// Retourne null si erreur ou < 2 quotes (ticker très jeune / illiquide).
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
  return {
    yesterday: {
      high: yesterday.high,
      low: yesterday.low,
      close: yesterday.close,
      volume: yesterday.volume,
    },
    todayOpen: today.open,
    todayCumVolume: today.volume,
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

async function postToChannel({ discord, store, guildId, channelId, content }) {
  try {
    const channel = await discord.channels.fetch(channelId);
    await channel.send(content);
    return { ok: true };
  } catch (err) {
    if (err && err.code === DISCORD_UNKNOWN_CHANNEL) {
      console.warn(`[trend] channel ${channelId} unknown — clearing for guild ${guildId}`);
      store.deleteChannel(guildId);
      return { ok: false, reason: 'unknown_channel' };
    }
    if (err && (err.code === DISCORD_MISSING_PERMISSIONS || err.code === DISCORD_MISSING_ACCESS)) {
      console.warn(`[trend] missing permissions for channel ${channelId} (guild ${guildId})`);
      return { ok: false, reason: 'missing_permissions' };
    }
    console.error(`[trend] postToChannel failed: ${err && err.message}`);
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

      // 8. Direction transition (existing logic, unchanged)
      const tNow = now();
      const dedupMs = dedupMinutes * 60 * 1000;
      const messages = [];
      const prevDir = state.direction || null;
      if (verdict.direction !== prevDir) {
        messages.push({
          type: 'direction',
          content: formatDirectionAlert(ticker, prevDir, verdict.direction, verdict.snapshot),
        });
        store.updateDirection(ticker, verdict.direction, tNow);
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
          content = formatPDHBreakAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'pdl_break') {
          content = formatPDLBreakAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'gap_up' || ev.type === 'gap_down') {
          content = formatGapAlert(ticker, ev, verdict.snapshot);
        } else if (ev.type === 'volume_above_prev_day') {
          content = formatVolumeAboveAlert(ticker, ev, verdict.snapshot, now());
        }

        if (content) messages.push({ type: ev.type, content });
      }

      if (messages.length === 0) continue;

      const guilds = store.getGuildsWatching(ticker);
      for (const guildId of guilds) {
        const channelId = store.getChannel(guildId);
        if (!channelId) continue;
        for (const msg of messages) {
          const result = await postToChannel({ discord, store, guildId, channelId, content: msg.content });
          if (result.ok) alerts += 1;
          if (result.reason === 'unknown_channel') break;
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
    intervalMin:    num('TREND_SCAN_INTERVAL_MIN', 5),
    dedupMinutes:   num('TREND_DEDUP_MINUTES', 60),
    rsiOverbought:  num('TREND_RSI_OVERBOUGHT', 70),
    rsiOversold:    num('TREND_RSI_OVERSOLD', 30),
    breakoutLookback: num('TREND_BREAKOUT_LOOKBACK_BARS', 20),
    breakoutVolMult:  num('TREND_BREAKOUT_VOLUME_MULT', 1.5),
  };
}

// Démarre le scanner. Appelé une fois après l'event Discord 'ready'.
// Retourne une fonction `stop()` pour arrêt propre (utile si un jour
// on veut redémarrer le module sans relancer le process).
function startTrendScanner({ client, store, yahoo, now = () => Date.now() }) {
  const cfg = readScannerConfig();
  const detectorOpts = {
    breakoutLookback: cfg.breakoutLookback,
    breakoutVolMult:  cfg.breakoutVolMult,
    rsiOverbought:    cfg.rsiOverbought,
    rsiOversold:      cfg.rsiOversold,
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
