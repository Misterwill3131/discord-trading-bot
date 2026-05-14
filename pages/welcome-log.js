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
const { DEFAULT_WELCOME_TEMPLATE } = require('../discord/welcome-template');

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

// Static preview: render the template with example user/channel placeholders.
// Pure string operation; does NOT touch Discord or DB.
function applyTemplatePreview(template) {
  return String(template == null ? '' : template)
    .split('{user}').join('@newuser')
    .split('{start_here}').join('#🚩│start-here');
}

function renderWelcomeLogPage(entries, tpl) {
  // Default to the hardcoded template when called without the second arg
  // (existing callers + tests that pass only `entries`).
  const effective = tpl && typeof tpl.template === 'string'
    ? tpl
    : { template: DEFAULT_WELCOME_TEMPLATE, isDefault: true };
  const tplText = effective.template;
  const previewText = applyTemplatePreview(tplText);

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
  .template-card { background: rgba(99,102,241,0.04); border: 1px solid rgba(99,102,241,0.15); border-radius: 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
  .template-card-header { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #c4b5fd; }
  .template-card textarea { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: #e3e5e8; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; padding: 10px 12px; resize: vertical; min-height: 80px; line-height: 1.5; }
  .template-card textarea:focus { outline: none; border-color: rgba(139,92,246,0.5); }
  .template-help { font-size: 11px; color: #a0a0b0; }
  .template-help code { background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; color: #c7d2fe; }
  .template-preview { font-size: 12px; color: #a0a0b0; }
  .template-preview-label { color: #80848e; margin-right: 6px; }
  #tpl-preview { color: #e3e5e8; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .template-actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .template-actions button { background: #6366f1; color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .template-actions button:hover { background: #4f46e5; }
  .template-actions button.secondary { background: transparent; color: #c4b5fd; border: 1px solid rgba(139,92,246,0.4); }
  .template-actions button.secondary:hover { background: rgba(139,92,246,0.1); }
  .template-status { font-size: 12px; }
  .template-status.ok { color: #6ee7b7; }
  .template-status.err { color: #f87171; }
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
  <div class="template-card">
    <div class="template-card-header">
      <strong>Template du message de bienvenue</strong>
      ${effective.isDefault
        ? '<span class="chip chip-warn">default (hardcoded)</span>'
        : '<span class="chip chip-ok">override actif</span>'}
    </div>
    <textarea id="tpl-input" rows="4" maxlength="2000">${escHtml(tplText)}</textarea>
    <div class="template-help">
      Placeholders : <code>{user}</code> = ping du nouveau membre · <code>{start_here}</code> = lien vers <code>🚩│start-here</code>
    </div>
    <div class="template-preview">
      <span class="template-preview-label">Preview :</span>
      <span id="tpl-preview">${escHtml(previewText)}</span>
    </div>
    <div class="template-actions">
      <button id="tpl-save" type="button">Save</button>
      <button id="tpl-reset" type="button" class="secondary">Reset to default</button>
      <span id="tpl-status" class="template-status"></span>
    </div>
  </div>
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
<script>
(function () {
  var input = document.getElementById('tpl-input');
  var preview = document.getElementById('tpl-preview');
  var status = document.getElementById('tpl-status');
  var saveBtn = document.getElementById('tpl-save');
  var resetBtn = document.getElementById('tpl-reset');
  if (!input || !preview || !status || !saveBtn || !resetBtn) return;

  function previewOf(text) {
    return String(text == null ? '' : text)
      .split('{user}').join('@newuser')
      .split('{start_here}').join('#🚩│start-here');
  }
  function setStatus(kind, text) {
    status.className = 'template-status ' + kind;
    status.textContent = text;
  }
  input.addEventListener('input', function () {
    preview.textContent = previewOf(input.value);
    setStatus('', '');
  });
  saveBtn.addEventListener('click', function () {
    var body = JSON.stringify({ template: input.value });
    setStatus('', 'Saving…');
    fetch('/api/welcome-message', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      credentials: 'same-origin',
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.json.ok) {
          setStatus('ok', 'Saved ✓');
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          setStatus('err', res.json.error || 'Save failed');
        }
      })
      .catch(function (err) { setStatus('err', String(err)); });
  });
  resetBtn.addEventListener('click', function () {
    if (!window.confirm('Reset to the default template ?')) return;
    setStatus('', 'Resetting…');
    fetch('/api/welcome-message', {
      method: 'DELETE',
      credentials: 'same-origin',
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.json.ok) {
          setStatus('ok', 'Reset ✓');
          setTimeout(function () { window.location.reload(); }, 600);
        } else {
          setStatus('err', res.json.error || 'Reset failed');
        }
      })
      .catch(function (err) { setStatus('err', String(err)); });
  });
})();
</script>
</body>
</html>`;
}

module.exports = { renderWelcomeLogPage };
