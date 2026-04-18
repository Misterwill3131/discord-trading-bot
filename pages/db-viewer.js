// ─────────────────────────────────────────────────────────────────────
// pages/db-viewer.js — Explorateur SQL read-only pour /db-viewer
// ─────────────────────────────────────────────────────────────────────
// Textarea SQL + résultat tabulaire + presets. L'API côté serveur
// (POST /api/db-query) rejette tout ce qui n'est pas SELECT/WITH et
// plafonne les résultats — voir routes/db-viewer.js.
//
// Pas d'autocomplete ni de coloration syntaxique : minimaliste volontaire
// (les power users peuvent utiliser DB Browser for SQLite à la place).
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

// Presets : requêtes courantes qu'on veut à portée de clic. Ctrl/Cmd+Enter
// pour exécuter, le bouton "Run" fait pareil. `&#10;` = newline dans
// l'attribut HTML data-sql (permet d'avoir des queries multi-lignes).
const PRESETS = [
  {
    label: 'Total messages',
    sql: 'SELECT COUNT(*) AS total FROM messages',
  },
  {
    label: 'Top 10 tickers (30j, acceptés)',
    sql:
      "SELECT ticker, COUNT(*) AS n\n" +
      "FROM messages\n" +
      "WHERE passed = 1 AND ts >= datetime('now', '-30 days')\n" +
      "GROUP BY ticker\n" +
      'ORDER BY n DESC\n' +
      'LIMIT 10',
  },
  {
    label: 'Top 10 auteurs (30j)',
    sql:
      "SELECT author, COUNT(*) AS n\n" +
      "FROM messages\n" +
      "WHERE passed = 1 AND ts >= datetime('now', '-30 days')\n" +
      'GROUP BY author\n' +
      'ORDER BY n DESC\n' +
      'LIMIT 10',
  },
  {
    label: 'Profits 7 derniers jours',
    sql:
      'SELECT date, count\n' +
      'FROM profit_counts\n' +
      'ORDER BY date DESC\n' +
      'LIMIT 7',
  },
  {
    label: 'Messages récents (50)',
    sql:
      'SELECT ts, author, type, ticker, substr(preview, 1, 60) AS preview\n' +
      'FROM messages\n' +
      'ORDER BY ts DESC\n' +
      'LIMIT 50',
  },
  {
    label: 'Filtres appris',
    sql: 'SELECT kind, phrase FROM profit_filter_phrases ORDER BY kind, phrase',
  },
  {
    label: 'Toutes les tables',
    sql:
      "SELECT name FROM sqlite_master\n" +
      "WHERE type = 'table'\n" +
      'ORDER BY name',
  },
];

const DB_VIEWER_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM DB Viewer</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
  .stats-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px 20px; }
  .stats-card h3 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 10px; }
  .stats-meta { display: flex; gap: 24px; flex-wrap: wrap; font-size: 12px; color: #a0a0b0; margin-bottom: 12px; }
  .stats-meta span strong { color: #fafafa; font-variant-numeric: tabular-nums; }
  .stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .stats-table th { text-align: left; color: #a0a0b0; font-weight: 600; padding: 6px 10px 6px 0; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .stats-table td { padding: 6px 10px 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .stats-table td.name { color: #c4b5fd; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .stats-table td.num { text-align: right; color: #fbbf24; font-variant-numeric: tabular-nums; font-weight: 600; }
  .stats-table td.empty { color: #4f545c; }
  .stats-table td.range { color: #80848e; font-size: 11px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .admin-actions { margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .btn-reclassify { background: rgba(250,166,26,0.1); border: 1px solid rgba(250,166,26,0.3); color: #fbbf24; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-reclassify:hover { background: rgba(250,166,26,0.2); }
  .btn-reclassify:disabled { opacity: 0.5; cursor: wait; }
  .admin-hint { font-size: 11px; color: #80848e; }
  .reclassify-status { font-size: 12px; font-weight: 600; }
  .reclassify-status.ok { color: #3ba55d; }
  .reclassify-status.err { color: #ed4245; }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .preset-btn { background: rgba(88,101,242,0.1); border: 1px solid rgba(88,101,242,0.3); color: #a5b4fc; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .preset-btn:hover { background: rgba(88,101,242,0.2); color: #c7d2fe; }
  .sql-area { width: 100%; min-height: 120px; background: #0f1014; color: #e3e5e8; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 14px 16px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.5; resize: vertical; }
  .sql-area:focus { outline: none; border-color: rgba(139,92,246,0.5); }
  .controls { display: flex; gap: 10px; align-items: center; }
  .btn-run { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); border: none; color: #fff; border-radius: 8px; padding: 9px 20px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .btn-run:hover { transform: translateY(-1px); }
  .btn-run:active { transform: translateY(0); }
  .hint { font-size: 11px; color: #80848e; }
  .status { font-size: 12px; color: #a0a0b0; }
  .status.err { color: #f87171; }
  .status.ok { color: #3ba55d; }
  .result { background: #0f1014; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 0; overflow-x: auto; }
  .result table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; }
  .result th { text-align: left; background: rgba(139,92,246,0.1); color: #c4b5fd; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); position: sticky; top: 0; font-weight: 600; }
  .result td { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); color: #e3e5e8; vertical-align: top; white-space: nowrap; max-width: 500px; overflow: hidden; text-overflow: ellipsis; }
  .result td.null { color: #4f545c; font-style: italic; }
  .result td.num { color: #fbbf24; text-align: right; font-variant-numeric: tabular-nums; }
  .result tr:hover td { background: rgba(255,255,255,0.02); }
  .empty { padding: 40px; text-align: center; color: #80848e; font-size: 13px; }
</style>
</head>
<body>
${sidebarHTML('/db-viewer')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">DB Viewer</h1>
  <span class="hint" style="margin-left:auto;">Read-only. SELECT / WITH seulement. Résultats limités à 1000 lignes.</span>
</div>
<div id="wrap">
  <div class="stats-card" id="stats-card">
    <h3>📊 État de la base</h3>
    <div id="stats-content" style="color:#80848e;font-size:12px;">Chargement…</div>
    <div class="admin-actions">
      <button class="btn-reclassify" id="btn-reclassify">🔄 Reclasser tous les messages</button>
      <span class="admin-hint">Ré-applique le classifier actuel sur l&#39;historique DB (après modif de filters/signal ou utils/prices).</span>
      <span class="reclassify-status" id="reclassify-status"></span>
    </div>
  </div>
  <div class="presets" id="presets"></div>
  <textarea class="sql-area" id="sql" spellcheck="false" placeholder="SELECT * FROM messages ORDER BY ts DESC LIMIT 10">SELECT COUNT(*) AS total FROM messages</textarea>
  <div class="controls">
    <button class="btn-run" id="run">Run (Ctrl+Enter)</button>
    <span class="status" id="status">Prêt.</span>
  </div>
  <div class="result" id="result"><div class="empty">Lance une query pour voir le résultat.</div></div>
</div>
</div>
<script>
(function() {
  var PRESETS = ${JSON.stringify(PRESETS)};
  var presetsDiv = document.getElementById('presets');
  var sqlArea = document.getElementById('sql');
  var runBtn = document.getElementById('run');
  var statusEl = document.getElementById('status');
  var resultDiv = document.getElementById('result');
  var statsContent = document.getElementById('stats-content');

  // Formatte un nombre d'octets en KB/MB pour lisibilité humaine.
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // Charge les stats au premier render. Non-bloquant — si l'endpoint
  // est KO on affiche une erreur sans empêcher l'utilisation du viewer.
  function loadStats() {
    fetch('/api/db-stats').then(function(r) { return r.json(); }).then(function(s) {
      if (s.error) { statsContent.textContent = 'Erreur: ' + s.error; return; }
      var meta = '<div class="stats-meta">'
        + '<span>Taille fichier: <strong>' + fmtBytes(s.fileSize) + '</strong></span>'
        + '<span>Pages: <strong>' + s.pageCount + '</strong> × ' + s.pageSize + ' B</span>'
        + '<span>Chemin: <strong>' + String(s.dbPath).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</strong></span>'
        + '</div>';
      var rows = '<table class="stats-table"><thead><tr><th>Table</th><th style="text-align:right;">Lignes</th><th>Plus ancien</th><th>Plus récent</th></tr></thead><tbody>';
      s.tables.forEach(function(t) {
        rows += '<tr>';
        rows += '<td class="name">' + t.name + '</td>';
        rows += '<td class="num' + (t.rowCount === 0 ? ' empty' : '') + '">' + (t.rowCount < 0 ? 'ERR' : t.rowCount.toLocaleString()) + '</td>';
        rows += '<td class="range">' + (t.oldest || '—') + '</td>';
        rows += '<td class="range">' + (t.newest || '—') + '</td>';
        rows += '</tr>';
      });
      rows += '</tbody></table>';
      statsContent.innerHTML = meta + rows;
    }).catch(function(e) {
      statsContent.textContent = 'Erreur réseau: ' + e.message;
    });
  }
  loadStats();

  // ── Reclassify button ──────────────────────────────────────────────
  var reclassifyBtn = document.getElementById('btn-reclassify');
  var reclassifyStatus = document.getElementById('reclassify-status');
  if (reclassifyBtn) {
    reclassifyBtn.addEventListener('click', function() {
      if (!confirm('Reclasser TOUS les messages en base ? Cette opération overwrite type/reason/ticker/entry_price selon le classifier actuel. Irréversible sans restore backup.')) return;

      reclassifyBtn.disabled = true;
      reclassifyStatus.className = 'reclassify-status';
      reclassifyStatus.textContent = 'En cours...';

      fetch('/api/reclassify', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          reclassifyBtn.disabled = false;
          if (data.error) {
            reclassifyStatus.className = 'reclassify-status err';
            reclassifyStatus.textContent = 'Erreur: ' + data.error;
            return;
          }
          reclassifyStatus.className = 'reclassify-status ok';
          reclassifyStatus.textContent = data.updated + '/' + data.total + ' updated';
          // Refresh stats panel to show new counts.
          loadStats();
        })
        .catch(function(e) {
          reclassifyBtn.disabled = false;
          reclassifyStatus.className = 'reclassify-status err';
          reclassifyStatus.textContent = 'Erreur réseau: ' + e.message;
        });
    });
  }

  // Rend les boutons presets.
  PRESETS.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = p.label;
    btn.addEventListener('click', function() {
      sqlArea.value = p.sql;
      sqlArea.focus();
    });
    presetsDiv.appendChild(btn);
  });

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function renderResult(rows, elapsedMs) {
    if (!rows.length) {
      resultDiv.innerHTML = '<div class="empty">Aucune ligne retournée.</div>';
      return;
    }
    var cols = Object.keys(rows[0]);
    var html = '<table><thead><tr>';
    cols.forEach(function(c) { html += '<th>' + esc(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function(row) {
      html += '<tr>';
      cols.forEach(function(c) {
        var v = row[c];
        if (v == null) html += '<td class="null">NULL</td>';
        else if (typeof v === 'number') html += '<td class="num">' + v + '</td>';
        else html += '<td>' + esc(v) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    resultDiv.innerHTML = html;
    statusEl.className = 'status ok';
    statusEl.textContent = rows.length + ' ligne(s) • ' + elapsedMs + 'ms';
  }

  function run() {
    var sql = sqlArea.value.trim();
    if (!sql) return;
    statusEl.className = 'status';
    statusEl.textContent = 'En cours...';
    resultDiv.innerHTML = '<div class="empty">…</div>';

    var t0 = performance.now();
    fetch('/api/db-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sql }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      var elapsed = Math.round(performance.now() - t0);
      if (data.error) {
        statusEl.className = 'status err';
        statusEl.textContent = 'Erreur: ' + data.error;
        resultDiv.innerHTML = '<div class="empty" style="color:#f87171;">' + esc(data.error) + '</div>';
        return;
      }
      renderResult(data.rows || [], elapsed);
    }).catch(function(e) {
      statusEl.className = 'status err';
      statusEl.textContent = 'Erreur réseau: ' + e.message;
    });
  }

  runBtn.addEventListener('click', run);
  sqlArea.addEventListener('keydown', function(e) {
    // Ctrl+Enter / Cmd+Enter pour exécuter (pattern attendu par les DB clients).
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
})();
</script>
</body>
</html>`;

module.exports = { DB_VIEWER_HTML };
