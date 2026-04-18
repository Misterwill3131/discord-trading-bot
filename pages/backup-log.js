// ─────────────────────────────────────────────────────────────────────
// pages/backup-log.js — Historique des runs du job git backup
// ─────────────────────────────────────────────────────────────────────
// Affiche les 30 derniers appels de runGitBackup (cron minuit EDT ou
// déclenchements manuels). Lit backupLog depuis discord/jobs — c'est
// un état en RAM, reset au restart du bot. Pour un historique long
// terme, consulter git log du repo (chaque backup = 1 commit).
//
// Rendu à la volée via renderBackupLogPage(entries) — la route passe
// les entries du moment.
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Formatte un ISO timestamp en YYYY-MM-DD HH:MM:SS fuseau NY (cohérent
// avec le reste du dashboard qui est calé sur les heures de marché).
function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const s = d.toLocaleString('sv-SE', { timeZone: 'America/New_York', hour12: false });
  return s;
}

function renderBackupLogPage(entries) {
  const rows = !entries.length
    ? '<tr><td colspan="4" class="empty">Aucun backup enregistré depuis le démarrage du bot. Le cron tourne à minuit EDT.</td></tr>'
    : entries.map(e => {
        const icon = e.success ? '<span class="ok">✓</span>' : '<span class="err">✗</span>';
        const detail = e.error
          ? '<span class="err-msg">' + escHtml(e.error) + '</span>'
          : (e.stdout ? '<span class="stdout">' + escHtml(e.stdout.split('\n')[0].slice(0, 200)) + '</span>' : '<span class="empty">—</span>');
        return (
          '<tr>'
          + '<td class="ts">' + fmtTs(e.date) + '</td>'
          + '<td class="status">' + icon + '</td>'
          + '<td class="detail">' + detail + '</td>'
          + '</tr>'
        );
      }).join('');

  const summary = entries.length
    ? entries.filter(e => e.success).length + ' succès / ' + entries.filter(e => !e.success).length + ' échec(s) sur les ' + entries.length + ' derniers runs'
    : '—';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Backup Log</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 16px; max-width: 1200px; }
  .summary { font-size: 13px; color: #a0a0b0; }
  .summary strong { color: #fafafa; }
  .note { background: rgba(250,166,26,0.08); border: 1px solid rgba(250,166,26,0.2); color: #fbbf24; border-radius: 8px; padding: 12px 16px; font-size: 12px; line-height: 1.5; }
  .note code { background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #fde68a; }
  table.backup-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.backup-table th { text-align: left; background: rgba(139,92,246,0.1); color: #c4b5fd; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  table.backup-table td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  table.backup-table td.ts { font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #e3e5e8; white-space: nowrap; }
  table.backup-table td.status { font-size: 18px; font-weight: 700; text-align: center; width: 60px; }
  .ok { color: #3ba55d; }
  .err { color: #ed4245; }
  .err-msg { color: #f87171; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-word; }
  .stdout { color: #80848e; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; }
  td.empty { color: #4f545c; text-align: center; font-style: italic; padding: 30px !important; }
</style>
</head>
<body>
${sidebarHTML('/backup-log')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Backup Log</h1>
  <span class="summary" style="margin-left:auto;">${summary}</span>
</div>
<div id="wrap">
  <div class="note">
    <strong>Rétention :</strong> 30 derniers runs en mémoire — reset au restart du bot.
    Pour l'historique complet, consulter <code>git log</code> du repo (chaque backup = 1 commit de <code>boom-backup.db</code>).
    Le cron tourne automatiquement à <strong>00:00 EDT</strong> chaque nuit.
  </div>
  <div class="card" style="padding: 0;">
    <table class="backup-table">
      <thead>
        <tr><th>Date (NY)</th><th style="text-align:center;">OK</th><th>Détail</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</div>
</div>
</body>
</html>`;
}

module.exports = { renderBackupLogPage };
