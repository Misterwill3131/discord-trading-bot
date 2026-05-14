// ─────────────────────────────────────────────────────────────────────
// pages/welcome-log.js — Page dashboard /welcome-log
// ─────────────────────────────────────────────────────────────────────
// Affiche les 100 derniers événements du welcome listener (sends + erreurs
// + config-missing au boot). Lit l'état mémoire depuis state/welcome-log.
// Reset au restart du bot — pour de l'historique long terme, regarder
// Railway logs filtré sur "[welcome]".
//
// Spec : docs/superpowers/specs/2026-05-14-welcome-log-dashboard-design.md
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('sv-SE', { timeZone: 'America/New_York', hour12: false });
}

function typeChip(type) {
  const cls = type === 'sent' ? 'chip-ok'
    : type === 'config-missing' ? 'chip-warn'
    : 'chip-err';
  return '<span class="chip ' + cls + '">' + escHtml(type) + '</span>';
}

function userCell(entry) {
  if (!entry.userId && !entry.username) return '<span class="empty">—</span>';
  const name = entry.username ? escHtml(entry.username) : '';
  const id = entry.userId ? '<span class="uid">' + escHtml(entry.userId) + '</span>' : '';
  return name + (name && id ? ' ' : '') + id;
}

function renderWelcomeLogPage(entries) {
  // Most recent first
  const reversed = entries.slice().reverse();
  const rows = !reversed.length
    ? '<tr><td colspan="4" class="empty">Aucun événement welcome depuis le démarrage du bot.</td></tr>'
    : reversed.map(e => (
        '<tr>'
        + '<td class="ts">' + fmtTs(e.ts) + '</td>'
        + '<td class="type">' + typeChip(e.type) + '</td>'
        + '<td class="user">' + userCell(e) + '</td>'
        + '<td class="detail">' + (e.detail ? escHtml(e.detail) : '<span class="empty">—</span>') + '</td>'
        + '</tr>'
      )).join('');

  const counts = reversed.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
  const summary = reversed.length
    ? (counts['sent'] || 0) + ' sent / ' + ((counts['error-channel'] || 0) + (counts['error-send'] || 0)) + ' error(s) sur les ' + reversed.length + ' derniers événements'
    : '—';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Welcome Log</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 16px; max-width: 1200px; }
  .summary { font-size: 13px; color: #a0a0b0; }
  .summary strong { color: #fafafa; }
  .note { background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.2); color: #c7d2fe; border-radius: 8px; padding: 12px 16px; font-size: 12px; line-height: 1.5; }
  .note code { background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #e0e7ff; }
  table.welcome-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.welcome-table th { text-align: left; background: rgba(139,92,246,0.1); color: #c4b5fd; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  table.welcome-table td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  table.welcome-table td.ts { font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #e3e5e8; white-space: nowrap; }
  td.type { width: 130px; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .chip-ok   { background: rgba(59,165,93,0.15);  color: #6ee7b7; }
  .chip-err  { background: rgba(237,66,69,0.15);  color: #f87171; }
  .chip-warn { background: rgba(250,166,26,0.15); color: #fbbf24; }
  td.user .uid { color: #80848e; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 11px; }
  td.detail { color: #c5c8ce; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-word; }
  td.empty, .empty { color: #4f545c; }
  td.empty { text-align: center; font-style: italic; padding: 30px !important; }
</style>
</head>
<body>
${sidebarHTML('/welcome-log')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Welcome Log</h1>
  <span class="summary" style="margin-left:auto;">${summary}</span>
</div>
<div id="wrap">
  <div class="note">
    <strong>Rétention :</strong> 100 derniers événements en mémoire — reset au restart du bot.
    Pour l'historique long terme, filtre Railway logs sur <code>[welcome]</code>.
    Types : <code>sent</code> = welcome posté, <code>error-channel</code> / <code>error-send</code> = échec Discord API, <code>config-missing</code> = vars d'env manquantes au boot.
  </div>
  <div class="card" style="padding: 0;">
    <table class="welcome-table">
      <thead>
        <tr><th>Date (NY)</th><th>Type</th><th>User</th><th>Détail</th></tr>
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

module.exports = { renderWelcomeLogPage };
