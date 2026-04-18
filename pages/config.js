// ─────────────────────────────────────────────────────────────────────
// pages/config.js — Template HTML de la page /config (read-only)
// ─────────────────────────────────────────────────────────────────────
// Contrairement aux autres pages (static templates), /config dépend de
// données runtime : customFilters muent au fil des feedbacks, les env
// changent entre local/Railway. D'où une FONCTION `renderConfigPage(data)`
// plutôt qu'une constante HTML.
//
// Les env sensibles sont masquées : on affiche juste "*** (defini)" ou
// "— (non defini)" pour PROFITS_CHANNEL_ID / MAKE_WEBHOOK_URL / password.
//
// La page est read-only : l'édition se fait via
//   • Dashboard (boutons feedback sur chaque message)
//   • Édition manuelle de config-overrides.json côté fichier
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

// Échappement HTML minimal — on n'utilise que `<` et `&` pour les cas
// concrets qu'on injecte (phrases filter + usernames).
function escHtml(s) {
  return String(s || '').replace(/</g, '&lt;');
}

function renderConfigPage({ aliases, safeFilters, channelOverrides }) {
  const aliasesHtml = Object.keys(aliases).length === 0
    ? '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun alias configure — editer config-overrides.json pour en ajouter.</span>'
    : '<table><thead><tr><th>Username Discord</th><th>Nom affiche</th></tr></thead><tbody>'
      + Object.keys(aliases).map(k =>
        '<tr><td class="alias-key">' + escHtml(k)
        + '</td><td class="alias-val">' + escHtml(aliases[k]) + '</td></tr>'
      ).join('')
      + '</tbody></table>';

  const blockedTags = safeFilters.blocked.length
    ? safeFilters.blocked.map(p => '<span class="tag tag-blocked">' + escHtml(p).substring(0, 60) + '</span>').join('')
    : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune</span>';

  const allowedTags = safeFilters.allowed.length
    ? safeFilters.allowed.map(p => '<span class="tag tag-allowed">' + escHtml(p).substring(0, 60) + '</span>').join('')
    : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune</span>';

  const blockedAuthorsTags = safeFilters.blockedAuthors.length
    ? safeFilters.blockedAuthors.map(a => '<span class="tag tag-blocked">' + escHtml(a) + '</span>').join('')
    : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun</span>';

  const allowedAuthorsTags = safeFilters.allowedAuthors.length
    ? safeFilters.allowedAuthors.map(a => '<span class="tag tag-allowed">' + escHtml(a) + '</span>').join('')
    : '<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun</span>';

  const extraChannelsHtml = channelOverrides.map(c =>
    '<span class="tag tag-channel">' + escHtml(c) + '</span>'
  ).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Config</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
  td { padding: 7px 8px; font-size: 13px; vertical-align: middle; }
  .alias-key { font-weight: 700; color: #D649CC; }
  .alias-val { color: #fafafa; }
  .tag { display: inline-block; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 10px; font-size: 12px; margin: 3px; }
  .tag-blocked { border-color: rgba(239,68,68,0.3); color: #f87171; background: rgba(239,68,68,0.1); }
  .tag-allowed { border-color: rgba(16,185,129,0.3); color: #10b981; background: rgba(16,185,129,0.1); }
  .tag-author  { border-color: rgba(214,73,204,0.3); color: #D649CC; background: rgba(214,73,204,0.1); }
  .tag-channel { border-color: rgba(59,130,246,0.3); color: #60a5fa; background: rgba(59,130,246,0.1); }
  .env-row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .env-key { font-size: 12px; color: #a0a0b0; width: 220px; flex-shrink: 0; }
  .env-val { font-size: 12px; color: #fafafa; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 12px; flex: 1; font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { font-size: 12px; color: #a0a0b0; margin-top: 8px; font-style: italic; }
</style>
</head>
<body>
${sidebarHTML('/config')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Config</h1></div>
<div id="wrap">
  <div class="card">
    <div class="card-title">Variables d'environnement</div>
    <div class="env-row"><span class="env-key">TRADING_CHANNEL</span><span class="env-val">${escHtml(process.env.TRADING_CHANNEL || 'trading-floor (defaut)')}</span></div>
    <div class="env-row"><span class="env-key">PROFITS_CHANNEL_ID</span><span class="env-val">${process.env.PROFITS_CHANNEL_ID ? '*** (defini)' : '— (non defini)'}</span></div>
    <div class="env-row"><span class="env-key">DASHBOARD_PASSWORD</span><span class="env-val">*** (masque)</span></div>
    <div class="env-row"><span class="env-key">MAKE_WEBHOOK_URL</span><span class="env-val">${process.env.MAKE_WEBHOOK_URL ? '*** (defini)' : '— (non defini)'}</span></div>
    <div class="env-row"><span class="env-key">RAILWAY_PUBLIC_DOMAIN</span><span class="env-val">${escHtml(process.env.RAILWAY_PUBLIC_DOMAIN || '— (local)')}</span></div>
    <div class="note">Les variables d'environnement sont definies dans Railway ou le fichier .env local.</div>
  </div>

  <div class="card">
    <div class="card-title">Aliases auteurs (AUTHOR_ALIASES)</div>
    ${aliasesHtml}
    <div class="note">Editer <code>config-overrides.json</code> dans DATA_DIR pour modifier les aliases.</div>
  </div>

  <div class="card">
    <div class="card-title">Filtres actifs (customFilters)</div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Phrases bloqu&#233;es (${safeFilters.blocked.length})</div>
      ${blockedTags}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Phrases autoris&#233;es (${safeFilters.allowed.length})</div>
      ${allowedTags}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Auteurs bloqu&#233;s (${safeFilters.blockedAuthors.length})</div>
      ${blockedAuthorsTags}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#a0a0b0;margin-bottom:6px;">Auteurs autoris&#233;s (${safeFilters.allowedAuthors.length})</div>
      ${allowedAuthorsTags}
    </div>
    <div class="note">Modifier les filtres depuis le Dashboard (boutons ✕ ❌ ✅ sur chaque message).</div>
  </div>

  <div class="card">
    <div class="card-title">Canaux de trading autoris&#233;s</div>
    <span class="tag tag-channel">${escHtml(process.env.TRADING_CHANNEL || 'trading-floor')}</span>
    ${extraChannelsHtml}
    <div class="note">Canal principal defini par TRADING_CHANNEL. Canaux additionnels via config-overrides.json.</div>
  </div>
</div>
</div>
</body>
</html>`;
}

module.exports = { renderConfigPage };
