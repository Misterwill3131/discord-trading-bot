// ─────────────────────────────────────────────────────────────────────
// discord/jobs.js — Jobs périodiques (résumé quotidien + backup git)
// ─────────────────────────────────────────────────────────────────────
// Trois jobs pilotés par un unique setInterval(60_000) qui s'arme dès
// que le client Discord devient `ready` :
//
//   21:00 local     → sendDailySummary()          (résumé trading dans #trading)
//   20:00 EDT       → profitCounter.sendDailyProfitSummary()  (dans #profits)
//   00:00 EDT       → runGitBackup()              (commit+push de DATA_DIR)
//
// L'interval se déclenche toutes les minutes et vérifie l'heure courante
// — stratégie simple/robuste (pas de cron lib nécessaire). Chaque job
// trace un flag `lastXxxDate` pour s'exécuter UNE fois par jour même si
// le check tombe plusieurs fois dans la minute cible (peu probable mais
// robuste).
//
// Pour les jobs EDT : 20:00 EDT = 00:00 UTC (été) ou 01:00 UTC (hiver).
// On accepte les deux plages UTC au lieu de calculer DST (moins brittle
// qu'une lib de fuseau horaire pour ce besoin simple).
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const { BLOCKED_AUTHORS, getDisplayName } = require('../utils/authors');
const { DATA_DIR, todayKey } = require('../utils/persistence');
const { messageLog } = require('../state/messages');
const profitCounter = require('../profit/counter');
const { backupDb, purgeFilteredMessagesWithoutData } = require('../db/sqlite');
const { createMarketAlertsScheduler, registerMarketAlertCommands } = require('./market-alerts');
const { createFmpClient } = require('./fmp-client');
const { createFmpWsClient } = require('./fmp-ws-client');
const { createFmpWsMarketClient } = require('./fmp-ws-marketclient');
const milestoneChecker = require('./milestone-checker');

// Dernière exécution de chaque job — évite les doublons si
// l'intervalle de 60s tombe deux fois dans la même minute cible.
let lastSummaryDate = null;
let lastBackupDate = null;
// Used to throttle milestone-checker ticks to the configured cadence.
let lastMilestoneTickMin = null;

// Historique du backup (utile si on veut un jour exposer un endpoint
// de supervision). Gardé en module scope car non-critique et pas exposé.
const backupLog = [];

// ── Résumé quotidien ───────────────────────────────────────────────
// Scan de messageLog depuis minuit local → totaux + top 3 tickers + top 3
// auteurs canonicalisés. Posté dans le PREMIER salon dont le nom contient
// `tradingChannel` (le bot peut être dans plusieurs serveurs).
function sendDailySummary(client, tradingChannel) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayMsgs = messageLog.filter(m => new Date(m.ts) >= midnight);

  const total = todayMsgs.length;
  const accepted = todayMsgs.filter(m => m.passed).length;
  const filtered = total - accepted;
  const rate = total ? Math.round(accepted / total * 100) : 0;

  // Top 3 tickers (tous messages, passed ou non — ticker est un signal faible
  // de l'intérêt généré par un symbole, pas du taux d'acceptation).
  const tickerMap = {};
  todayMsgs.forEach(m => { if (m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker] || 0) + 1; });
  const topTickers = Object.keys(tickerMap)
    .map(k => [k, tickerMap[k]])
    .sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Top 3 auteurs canonicalisés (display name) en excluant les bloqués.
  const authorMap = {};
  todayMsgs.forEach(m => {
    if (!m.author || BLOCKED_AUTHORS.has(String(m.author).toLowerCase())) return;
    const key = getDisplayName(m.author);
    authorMap[key] = (authorMap[key] || 0) + 1;
  });
  const topAuthors = Object.keys(authorMap)
    .map(k => [k, authorMap[k]])
    .sort((a, b) => b[1] - a[1]).slice(0, 3);

  const tickersStr = topTickers.length
    ? topTickers.map(t => t[0] + ' (' + t[1] + ')').join(', ')
    : 'None';
  const authorsStr = topAuthors.length
    ? topAuthors.map(a => a[0] + ' (' + a[1] + ')').join(', ')
    : 'None';

  const summaryText = [
    '**BOOM Daily Summary** — ' + todayStr,
    '> Total messages: **' + total + '**',
    '> Accepted: **' + accepted + '** | Filtered: **' + filtered + '**',
    '> Acceptance rate: **' + rate + '%**',
    '> Top tickers: ' + tickersStr,
    '> Top analysts: ' + authorsStr,
  ].join('\n');

  try {
    const channel = client.channels.cache.find(ch =>
      ch.name && ch.name.includes(tradingChannel)
    );
    if (channel && channel.send) {
      channel.send(summaryText)
        .then(() => console.log('[summary] Resume journalier envoye dans #' + channel.name))
        .catch(err => console.error('[summary] Erreur envoi resume:', err.message));
    } else {
      console.warn('[summary] Channel introuvable pour le resume journalier');
    }
  } catch (e) {
    console.error('[summary] Erreur:', e.message);
  }
}

// ── Backup git : DB SQLite → snapshot → commit + push ──────────────
// Commits toutes les nuits — seul moyen de survivre à un crash du volume
// Railway sans perdre les données. Avant la migration SQLite on versionnait
// les JSON ; maintenant on crée un snapshot `boom-backup.db` via l'API
// .backup() de better-sqlite3 (safe même pendant des writes concurrents,
// contrairement à un simple cp qui peut attraper un état WAL incohérent).
//
// Les fichiers JSON legacy (messages-*.json, profits-*.json, etc.) sont
// aussi ajoutés — ils ne sont plus écrits mais on garde l'historique au
// cas où on voudrait les régénérer.
//
// --allow-empty : commit même si rien n'a changé (crée un point dans
// l'historique pour savoir que le backup a tourné).
async function runGitBackup() {
  const dateKey = todayKey();
  const projectRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');
  const backupPath = path.join(projectRoot, 'boom-backup.db');
  const jsonGlob = path.join(DATA_DIR, '*.json').replace(/\\/g, '/');
  const git = 'git -C "' + projectRoot + '"';

  const logResult = (success, stdout, error) => {
    backupLog.unshift({
      date: new Date().toISOString(),
      success,
      stdout: (stdout || '').trim().substring(0, 300),
      stderr: '',
      error: error ? String(error).substring(0, 300) : null,
    });
    if (backupLog.length > 30) backupLog.pop();
  };

  console.log('[backup] Running git backup for ' + dateKey);

  // 0. Purge des messages filtrés sans valeur avant le snapshot.
  //    Le backup reflète donc un état déjà nettoyé (plus petit, plus utile).
  try {
    const purged = purgeFilteredMessagesWithoutData();
    if (purged > 0) console.log('[backup] Pre-purge: removed ' + purged + ' filtered messages');
  } catch (err) {
    // Non-bloquant : on continue vers le snapshot même si la purge a échoué.
    console.error('[backup] Pre-purge failed (non-blocking):', err.message);
  }

  // 1. Snapshot DB — si échec on ne touche pas à git.
  try {
    await backupDb(backupPath);
  } catch (err) {
    console.error('[backup] DB snapshot failed:', err.message);
    logResult(false, '', 'DB snapshot: ' + err.message);
    return;
  }

  // 2. git add (séparé par fichier, tolère les globs sans match) — exec
  //    par étape pour être portable Windows/Linux sans chaînage shell.
  try {
    await execAsync(git + ' add "' + backupPath.replace(/\\/g, '/') + '"');
  } catch (err) {
    console.error('[backup] git add backup failed:', err.message);
    logResult(false, '', err.message);
    return;
  }

  // add JSON legacy : le glob peut ne matcher aucun fichier, on ignore l'erreur.
  try {
    await execAsync(git + ' add "' + jsonGlob + '"');
  } catch (_) { /* no JSON files = OK */ }

  // 3. commit + push. --allow-empty garantit un point dans l'historique
  //    même si les données n'ont pas changé (indicateur "le job a tourné").
  try {
    await execAsync(git + ' commit -m "Auto backup ' + dateKey + '" --allow-empty');
    const { stdout } = await execAsync(git + ' push');
    console.log('[backup] Git backup success:', (stdout || '').trim().substring(0, 100));
    logResult(true, stdout, null);
  } catch (err) {
    console.error('[backup] Git commit/push failed:', err.message);
    logResult(false, '', err.message);
  }
}

// ── Scheduler ───────────────────────────────────────────────────────
// Attend le ready, puis arme un setInterval(60_000) qui vérifie l'heure
// et déclenche les jobs quand ça tombe. Chaque job a son propre flag de
// déduplication journalier.
function startScheduler({ client, tradingChannel, sendAlert } = {}) {
  client.once('ready', () => {
    // ── Market alerts (FMP) ────────────────────────────────────────
    // Activé seulement si WATCHED_TICKERS et FMP_API_KEY sont définis.
    // Cadence par défaut = 5 min (free tier ~250 req/jour). Ajustable
    // via MARKET_ALERTS_INTERVAL_MIN.
    const tickers = (process.env.WATCHED_TICKERS || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const fmpKey = process.env.FMP_API_KEY || '';
    const useWs = String(process.env.MARKET_ALERTS_USE_WS || 'false').toLowerCase() === 'true';
    const intervalMin = Math.max(1, parseInt(
      process.env.MARKET_ALERTS_INTERVAL_MIN || '5', 10) || 5);
    const evalIntervalSec = Math.max(1, parseInt(
      process.env.MARKET_ALERTS_EVAL_INTERVAL_SEC || (useWs ? '5' : String(intervalMin * 60)), 10) || 5);
    let marketAlerts = null;
    let marketClientRef = null;
    if (tickers.length > 0 && fmpKey && typeof sendAlert === 'function') {
      try {
        const restClient = createFmpClient({ apiKey: fmpKey });
        let marketClient;
        if (useWs) {
          const streamsCsv = process.env.FMP_WS_STREAMS || 'fmp-us-equities-stream';
          const streams = streamsCsv.split(',').map(s => s.trim()).filter(Boolean);
          const wsClient = createFmpWsClient({
            apiKey: fmpKey,
            streams,
            endpoint: process.env.FMP_WS_ENDPOINT || undefined,
          });
          const maxStalenessMs = Math.max(0, parseInt(
            process.env.FMP_WS_MAX_STALENESS_MS || '900000', 10) || 900000);
          marketClient = createFmpWsMarketClient({
            apiKey: fmpKey, tickers, wsClient, restClient, maxStalenessMs,
          });
          marketClient.start();
          console.log('[market-alerts] watching ' + tickers.length + ' tickers via WS (eval every '
            + evalIntervalSec + 's): ' + tickers.join(', '));
        } else {
          marketClient = restClient;
          console.log('[market-alerts] watching ' + tickers.length + ' tickers via REST (every '
            + intervalMin + ' min): ' + tickers.join(', '));
          // Free-tier guard : >3 tickers à cadence 5min sature les 250 req/jour.
          const dailyBudget = (390 / intervalMin) * tickers.length + tickers.length;
          if (dailyBudget > 250) {
            console.warn('[market-alerts] estimated ' + Math.round(dailyBudget)
              + ' FMP calls/day exceeds free-tier 250/day budget — consider raising '
              + 'MARKET_ALERTS_INTERVAL_MIN or upgrading FMP plan');
          }
        }
        marketClientRef = marketClient;
        marketAlerts = createMarketAlertsScheduler({
          marketClient,
          sendAlert,
          tickers,
        });
      } catch (err) {
        console.error('[market-alerts] init failed:', err.message);
      }
    } else {
      const reasons = [];
      if (tickers.length === 0) reasons.push('WATCHED_TICKERS empty');
      if (!fmpKey) reasons.push('FMP_API_KEY missing');
      if (typeof sendAlert !== 'function') reasons.push('sendAlert not provided');
      console.log('[market-alerts] disabled (' + reasons.join(', ') + ')');
    }

    // Diagnostic commands (!testalert, !alertstatus) — actives même si
    // marketAlerts est null, pour que `!alertstatus` puisse signaler la
    // raison du disabled.
    if (typeof sendAlert === 'function') {
      registerMarketAlertCommands(client, {
        sendAlert,
        scheduler: marketAlerts,
      });
    }

    setInterval(() => {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);

      // 21:00 heure locale → résumé trading.
      if (now.getHours() === 21 && now.getMinutes() === 0 && lastSummaryDate !== todayStr) {
        lastSummaryDate = todayStr;
        sendDailySummary(client, tradingChannel);
      }

      // 20:00 ET → résumé profits (lundi-vendredi uniquement).
      // On lit l'heure DIRECTEMENT en fuseau NY plutôt que de jouer avec
      // les offsets UTC EDT/EST — ça évite le double déclenchement à la
      // transition d'horaires été/hiver et le bug "redémarrage entre les
      // deux fenêtres" qui faisait reposter le rapport.
      const nyParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
      }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
      const nyHour = parseInt(nyParts.hour, 10);
      const nyMin  = parseInt(nyParts.minute, 10);
      const nyDayName = nyParts.weekday; // "Mon", "Sat", etc.
      const isWeekday = !['Sat', 'Sun'].includes(nyDayName);

      if (isWeekday && nyHour === 20 && nyMin === 0
          && profitCounter.getLastSummaryDate() !== todayStr) {
        // On envoie d'abord ; on ne marque comme "déjà fait" que sur succès.
        // Comme ça, si Discord est down on retentera à la minute suivante.
        profitCounter.sendDailyProfitSummary()
          .then(() => profitCounter.setLastSummaryDate(todayStr))
          .catch(err => console.error('[profits] Daily summary retry-able:', err.message));
      }

      // Minuit ET → backup git. Lecture en fuseau NY pour la même raison.
      if (nyHour === 0 && nyMin === 0 && lastBackupDate !== todayStr) {
        lastBackupDate = todayStr;
        runGitBackup();
      }

      // Market alerts — cadence configurable. Le tick lui-même filtre
      // sur RTH (no-op hors marché), donc fire-and-forget chaque
      // intervalle suffit. WS mode: tick driven by a separate fast
      // setInterval below (every evalIntervalSec seconds). REST mode:
      // continues at the original minute-aligned cadence.
      if (!useWs && marketAlerts && now.getMinutes() % intervalMin === 0) {
        marketAlerts.tick(now).catch(err =>
          console.error('[market-alerts] tick failed:', err.message));
      }

      // Milestone checker — cadence configurable (défaut 30 min).
      // Le tick lui-même filtre RTH, donc fire-and-forget. On déduplique
      // par minute pour éviter de fire 2× dans la même minute cible.
      const milestoneIntervalMin = Math.max(1, parseInt(
        process.env.MILESTONE_POLL_INTERVAL_MIN || '30', 10) || 30);
      const minuteKey = now.getHours() * 60 + now.getMinutes();
      if (now.getMinutes() % milestoneIntervalMin === 0
          && lastMilestoneTickMin !== minuteKey) {
        lastMilestoneTickMin = minuteKey;
        const fmpKeyForMilestone = process.env.FMP_API_KEY || '';
        if (fmpKeyForMilestone) {
          let milestoneMarketClient = null;
          try {
            milestoneMarketClient = createFmpClient({ apiKey: fmpKeyForMilestone });
          } catch (err) {
            console.error('[milestone-checker] FMP init failed:', err.message);
          }
          if (milestoneMarketClient) {
            milestoneChecker.tick(client, now.getTime(), {
              marketClient: milestoneMarketClient,
            }).catch(err =>
              console.error('[milestone-checker] tick failed:', err.message));
          }
        }
      }
    }, 60000);

    // WS mode: drive market-alerts.tick at the configured sub-minute
    // cadence. Independent of the master 60s scheduler so we get
    // sub-minute reactivity without polluting the other jobs.
    if (useWs && marketAlerts) {
      setInterval(() => {
        marketAlerts.tick(new Date()).catch(err =>
          console.error('[market-alerts] tick failed:', err.message));
      }, evalIntervalSec * 1000);
      console.log('[market-alerts] fast-tick interval ' + evalIntervalSec + 's armed (WS mode)');
    }

  });
}

// Copie défensive du backupLog pour la page /backup-log — évite que
// le caller mute le state interne par accident.
function getBackupLog() {
  return backupLog.slice();
}

module.exports = {
  startScheduler,
  // Exposés pour tests / déclenchement manuel éventuel.
  sendDailySummary,
  runGitBackup,
  getBackupLog,
};
