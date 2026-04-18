// ─────────────────────────────────────────────────────────────────────
// pages/leaderboard.js — Template HTML de /leaderboard (classement 30j)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/leaderboard')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const LEADERBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Leaderboard</title>
<style>
  ${COMMON_CSS}
  body { overflow-x: hidden; }
  #wrap { padding: 24px; transition: margin-right .3s; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background .15s; cursor: pointer; }
  tbody tr:hover { background: rgba(255,255,255,0.04); }
  tbody tr.active-row { background: rgba(139,92,246,0.1); border-left: 3px solid #8b5cf6; }
  td { padding: 10px 10px; vertical-align: middle; }
  .rank { font-size: 18px; font-weight: 800; color: #a0a0b0; width: 40px; }
  .rank-1 { color: #ffd700; }
  .rank-2 { color: #c0c0c0; }
  .rank-3 { color: #cd7f32; }
  .author-name { font-weight: 700; color: #D649CC; font-size: 14px; }
  .author-name span { border-bottom: 1px dashed #D649CC55; }
  .signals-count { font-weight: 700; color: #3ba55d; font-size: 16px; }
  .ticker-badge { display: inline-block; background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.3); color: #a78bfa; border-radius: 6px; padding: 3px 10px; font-size: 12px; font-weight: 700; text-decoration: none; transition: background 150ms, color 150ms, border-color 150ms; }
  .ticker-badge:hover { background: rgba(139,92,246,0.25); color: #fafafa; border-color: rgba(139,92,246,0.5); }
  .bar-wrap { width: 120px; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
  .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); }
  .period-note { font-size: 12px; color: #a0a0b0; margin-bottom: 16px; }

  /* ── Side panel ── */
  #side-panel {
    position: fixed; top: 0; right: -480px; width: 460px; height: 100vh;
    background: rgba(15,15,20,0.95); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
    border-left: 1px solid rgba(255,255,255,0.08);
    box-shadow: -8px 0 32px rgba(0,0,0,0.4);
    display: flex; flex-direction: column;
    transition: right .3s ease; z-index: 100; overflow: hidden;
  }
  #side-panel.open { right: 0; }
  #panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
  }
  #panel-author { font-weight: 700; font-size: 16px; color: #D649CC; }
  #panel-count { font-size: 12px; color: #a0a0b0; margin-top: 2px; }
  #panel-close {
    background: none; border: none; color: #a0a0b0; font-size: 20px; cursor: pointer;
    padding: 4px 8px; border-radius: 4px; line-height: 1;
  }
  #panel-close:hover { background: rgba(255,255,255,0.08); color: #fafafa; }
  #panel-body { overflow-y: auto; flex: 1; padding: 12px 16px; }
  .signal-card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 10px;
  }
  .signal-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .signal-date { font-size: 11px; color: #a0a0b0; }
  .signal-channel { font-size: 11px; color: #a0a0b0; background: rgba(255,255,255,0.04); padding: 1px 6px; border-radius: 3px; }
  .signal-ticker { display: inline-block; background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.3); color: #a78bfa; border-radius: 6px; padding: 2px 8px; font-size: 12px; font-weight: 700; text-decoration: none; transition: background 150ms, color 150ms, border-color 150ms; }
  .signal-ticker:hover { background: rgba(139,92,246,0.25); color: #fafafa; border-color: rgba(139,92,246,0.5); }
  .signal-prices { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .price-pill { font-size: 12px; padding: 2px 10px; border-radius: 12px; font-weight: 600; }
  .price-entry { background: #1a3a2a; color: #3ba55d; border: 1px solid #3ba55d44; }
  .price-target { background: #1a2a3a; color: #5865f2; border: 1px solid #5865f244; }
  .price-stop { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .signal-content { font-size: 12px; color: #b5bac1; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  #panel-loading { text-align: center; padding: 40px; color: #a0a0b0; font-size: 13px; }
  #panel-empty { text-align: center; padding: 40px; color: #a0a0b0; font-size: 13px; }
  #overlay { display: none; position: fixed; inset: 0; background: #00000066; z-index: 99; }
  #overlay.show { display: block; }
</style>
</head>
<body>
${sidebarHTML('/leaderboard')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Leaderboard</h1></div>

<div id="overlay"></div>

<!-- Side panel -->
<div id="side-panel">
  <div id="panel-header">
    <div>
      <div id="panel-author">—</div>
      <div id="panel-count"></div>
    </div>
    <button id="panel-close">&#x2715;</button>
  </div>
  <div id="panel-body">
    <div id="panel-loading">Chargement...</div>
  </div>
</div>

<div id="wrap">
  <div class="card">
    <div class="card-title">&#x1F3C6; Leaderboard — 30 derniers jours</div>
    <div class="period-note" id="period-note">Chargement...</div>
    <div id="leaderboard-wrap"><span style="color:#a0a0b0;font-size:12px;">Chargement...</span></div>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString('fr-CA') + ' ' + d.toLocaleTimeString('fr-CA', {hour:'2-digit',minute:'2-digit'});
  }

  var currentDays = 30;
  var activeAuthor = null;

  // ── Panel logic ──
  var panel = document.getElementById('side-panel');
  var overlay = document.getElementById('overlay');
  var panelBody = document.getElementById('panel-body');
  var panelAuthor = document.getElementById('panel-author');
  var panelCount = document.getElementById('panel-count');

  function closePanel() {
    panel.classList.remove('open');
    overlay.classList.remove('show');
    document.querySelectorAll('tbody tr.active-row').forEach(function(r){ r.classList.remove('active-row'); });
    activeAuthor = null;
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);

  function openPanel(author, days) {
    activeAuthor = author;
    panelAuthor.textContent = author;
    panelCount.textContent = '';
    panelBody.innerHTML = '<div id="panel-loading">Chargement des alertes...</div>';
    panel.classList.add('open');
    overlay.classList.add('show');

    fetch('/api/leaderboard/analyst?author=' + encodeURIComponent(author) + '&days=' + days)
      .then(function(r){ return r.json(); })
      .then(function(data) {
        var signals = data.signals || [];
        panelCount.textContent = signals.length + ' alerte' + (signals.length !== 1 ? 's' : '');
        if (!signals.length) {
          panelBody.innerHTML = '<div id="panel-empty">Aucune alerte trouvee</div>';
          return;
        }
        var html = '';
        signals.forEach(function(s) {
          var prices = '';
          if (s.entry_price !== null && s.entry_price !== undefined)
            prices += '<span class="price-pill price-entry">Entree ' + s.entry_price + '</span>';
          if (s.target_price !== null && s.target_price !== undefined)
            prices += '<span class="price-pill price-target">Cible ' + s.target_price + '</span>';
          if (s.stop_price !== null && s.stop_price !== undefined)
            prices += '<span class="price-pill price-stop">Stop ' + s.stop_price + '</span>';
          html += '<div class="signal-card">'
            + '<div class="signal-meta">'
            + '<a href="/ticker/' + encodeURIComponent(s.ticker || '') + '" class="signal-ticker">$' + esc(s.ticker) + '</a>'
            + '<span class="signal-date">' + fmtDate(s.ts) + '</span>'
            + (s.channel ? '<span class="signal-channel">#' + esc(s.channel) + '</span>' : '')
            + '</div>'
            + (prices ? '<div class="signal-prices">' + prices + '</div>' : '')
            + '<div class="signal-content">' + esc(s.content) + '</div>'
            + '</div>';
        });
        panelBody.innerHTML = html;
      })
      .catch(function() {
        panelBody.innerHTML = '<div id="panel-empty" style="color:#ed4245;">Erreur de chargement</div>';
      });
  }

  // ── Leaderboard table ──
  fetch('/api/leaderboard?days=30')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var wrap = document.getElementById('leaderboard-wrap');
      var note = document.getElementById('period-note');
      note.textContent = data.period || '30 derniers jours';
      currentDays = 30;
      if (!data.rows || !data.rows.length) {
        wrap.innerHTML = '<span style="color:#a0a0b0;font-size:12px;">Aucune donnee sur cette periode</span>';
        return;
      }
      var maxSig = data.rows[0] ? data.rows[0].signals : 1;
      var html = '<table><thead><tr><th>#</th><th>Analyste</th><th>Signaux</th><th>Ticker favori</th><th>Progression</th></tr></thead><tbody>';
      data.rows.forEach(function(row, i) {
        var rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
        var medal = i === 0 ? '&#x1F947;' : i === 1 ? '&#x1F948;' : i === 2 ? '&#x1F949;' : (i+1);
        var pct = maxSig ? Math.round(row.signals / maxSig * 100) : 0;
        html += '<tr data-author="' + esc(row.author) + '">'
          + '<td class="rank ' + rankCls + '">' + medal + '</td>'
          + '<td class="author-name"><span>' + esc(row.author) + '</span></td>'
          + '<td class="signals-count">' + row.signals + '</td>'
          + '<td>' + (row.topTicker ? '<a href="/ticker/' + encodeURIComponent(row.topTicker) + '" class="ticker-badge">$' + esc(row.topTicker) + '</a>' : '—') + '</td>'
          + '<td><span class="bar-wrap"><span class="bar-fill" style="width:' + pct + '%;"></span></span>' + pct + '%</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
      wrap.innerHTML = html;

      // Attach click handlers
      wrap.querySelectorAll('tbody tr').forEach(function(tr) {
        tr.addEventListener('click', function() {
          var author = tr.getAttribute('data-author');
          if (!author) return;
          wrap.querySelectorAll('tbody tr').forEach(function(r){ r.classList.remove('active-row'); });
          tr.classList.add('active-row');
          openPanel(author, currentDays);
        });
      });
    })
    .catch(function() {
      document.getElementById('leaderboard-wrap').innerHTML = '<span style="color:#ed4245;font-size:12px;">Erreur de chargement</span>';
    });
})();
</script>
</div>
</body>
</html>`;
module.exports = { LEADERBOARD_HTML };