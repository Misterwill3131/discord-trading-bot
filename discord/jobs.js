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

// Dernière exécution de chaque job — évite les doublons si
// l'intervalle de 60s tombe deux fois dans la même minute cible.
let lastSummaryDate = null;
let lastBackupDate = null;

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
function startScheduler({ client, tradingChannel }) {
  client.once('ready', () => {
    setInterval(() => {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);

      // 21:00 heure locale → résumé trading.
      if (now.getHours() === 21 && now.getMinutes() === 0 && lastSummaryDate !== todayStr) {
        lastSummaryDate = todayStr;
        sendDailySummary(client, tradingChannel);
      }

      // 20:00 EDT → résumé profits. EDT = UTC-4 (été) ou UTC-5 (hiver),
      // donc 20:00 EDT = 00:00 UTC (été) ou 01:00 UTC (hiver).
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      if ((utcH === 0 || utcH === 1) && utcM === 0
          && profitCounter.getLastSummaryDate() !== todayStr) {
        profitCounter.setLastSummaryDate(todayStr);
        profitCounter.sendDailyProfitSummary();
      }

      // Minuit EDT → backup git. Minuit EDT = 04:00 UTC (été) ou 05:00 UTC (hiver).
      if ((utcH === 4 || utcH === 5) && utcM === 0 && lastBackupDate !== todayStr) {
        lastBackupDate = todayStr;
        runGitBackup();
      }
    }, 60000);
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
