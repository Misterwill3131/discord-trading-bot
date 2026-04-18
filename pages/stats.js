// ─────────────────────────────────────────────────────────────────────
// pages/stats.js — Template HTML de la page /stats
// ─────────────────────────────────────────────────────────────────────
// Page focalisée sur la performance des auteurs : taux acceptation,
// répartition signaux, P&L moyen, durée entry→exit, comparateur,
// heatmap jour×heure, volume par heure, perf 30j.
//
// Toute la logique de rendu est côté client (dans le <script> inline).
// Le serveur n'expose que /api/messages et /api/analyst-performance.
//
// AUTHOR_ALIASES et BLOCKED_AUTHORS sont injectés en JSON pour que
// le client canonicalise les auteurs (traderzz1m → Z) sans appel API.
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');
const { AUTHOR_ALIASES, BLOCKED_AUTHORS } = require('../utils/authors');

const STATS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Stats</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card-full { grid-column: 1 / -1; }
  .progress-bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,0.06); margin-top: 14px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 5px; transition: width .4s; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-label { width: 80px; font-size: 12px; color: #a0a0b0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { flex: 1; height: 14px; background: rgba(255,255,255,0.06); border-radius: 6px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; transition: width .4s; }
  .bar-val { width: 30px; font-size: 12px; color: #a0a0b0; text-align: left; }
  .badge-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-badge { display: flex; flex-direction: column; align-items: center; padding: 14px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; min-width: 80px; }
  .stat-badge .num { font-size: 28px; font-weight: 800; }
  .b-entry { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-top: 10px; }
  .hour-col { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .hour-bar { width: 100%; border-radius: 2px 2px 0 0; min-height: 1px; }
  .hour-lbl { font-size: 9px; color: #a0a0b0; margin-top: 3px; }
  .period-btns { display: flex; gap: 6px; margin-left: 16px; }
  .perf-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .perf-table th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .perf-table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; vertical-align: middle; }
  .perf-table tr:last-child td { border-bottom: none; }
  .perf-author { font-weight: 700; color: #D649CC; }
  .perf-acc { color: #3ba55d; }
  .perf-flt { color: #faa61a; }
  .perf-bar-wrap { width: 80px; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
  .perf-bar-fill { height: 100%; border-radius: 4px; }
  .perf-ticker { color: #5865f2; font-size: 11px; }
  /* P&L / durée numériques mis en avant */
  .pnl-pos { color: #3ba55d; font-weight: 700; font-variant-numeric: tabular-nums; }
  .pnl-neg { color: #ed4245; font-weight: 700; font-variant-numeric: tabular-nums; }
  .pnl-zero { color: #a0a0b0; font-variant-numeric: tabular-nums; }
  .big-number.pnl-pos { color: #3ba55d; }
  .big-number.pnl-neg { color: #ed4245; }
  /* Heatmap 7 jours × 24h */
  .heatmap { display: grid; grid-template-columns: 32px repeat(24, 1fr); gap: 2px; margin-top: 10px; }
  .heatmap-hdr { font-size: 9px; color: #a0a0b0; text-align: center; font-variant-numeric: tabular-nums; padding: 2px 0; }
  .heatmap-daylbl { font-size: 10px; color: #a0a0b0; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; }
  .heatmap-cell { height: 18px; border-radius: 2px; background: rgba(255,255,255,0.04); cursor: default; }
  /* Comparateur */
  .cmp-ctrls { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; flex-wrap: wrap; }
  .cmp-ctrls select { background: #1e1f22; color: #fafafa; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 6px 8px; font-family: inherit; font-size: 12px; min-width: 180px; }
  .cmp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .cmp-col { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 12px 14px; }
  .cmp-col h4 { margin: 0 0 10px; color: #D649CC; font-size: 14px; font-weight: 700; }
  .cmp-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .cmp-row:last-child { border-bottom: none; }
  .cmp-row .k { color: #a0a0b0; }
  .cmp-row .v { color: #fafafa; font-variant-numeric: tabular-nums; font-weight: 600; }
  .cmp-row.best .v { color: #3ba55d; }
  .cmp-hint { font-size: 11px; color: #a0a0b0; }
  @media (max-width: 700px) { #wrap { grid-template-columns: 1fr; } .card-full { grid-column: 1; } .heatmap { grid-template-columns: 28px repeat(24, 1fr); } }
</style>
</head>
<body>
${sidebarHTML('/stats')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Stats</h1>
  <div class="period-btns">
    <button class="btn-period active" id="btn-today" data-period="today">Aujourd&#39;hui</button>
    <button class="btn-period" id="btn-7d" data-period="7d">7 jours</button>
    <button class="btn-period" id="btn-30d" data-period="30d">30 jours</button>
  </div>
  <button class="btn-refresh" id="btn-refresh">Actualiser</button>
</div>
<div id="wrap">
  <!-- ROW 1 — KPI haut niveau -->
  <div class="card">
    <div class="card-title">Taux acceptation</div>
    <div class="big-number" id="accept-pct">—</div>
    <div class="big-sub" id="accept-sub">chargement...</div>
    <div class="progress-bar"><div class="progress-fill" id="accept-bar" style="width:0%;background:#3ba55d;"></div></div>
  </div>
  <div class="card">
    <div class="card-title">Repartition des signaux</div>
    <div class="badge-row" id="type-badges">
      <div class="stat-badge b-entry"><span class="num" id="cnt-entry">0</span>Entry</div>
      <div class="stat-badge b-exit"><span class="num" id="cnt-exit">0</span>Exit</div>
      <div class="stat-badge b-neutral"><span class="num" id="cnt-neutral">0</span>Neutral</div>
      <div class="stat-badge b-filter"><span class="num" id="cnt-filtered">0</span>Filtre</div>
    </div>
  </div>

  <!-- ROW 2 — KPIs auteur (NEW) -->
  <div class="card">
    <div class="card-title">P&amp;L moyen par auteur</div>
    <div id="pnl-authors"><span style="color:#a0a0b0;font-size:12px;">Chargement...</span></div>
  </div>
  <div class="card">
    <div class="card-title">Durée moyenne entry&nbsp;&rarr;&nbsp;exit</div>
    <div class="big-number" id="avg-duration">—</div>
    <div class="big-sub" id="avg-duration-sub">chargement...</div>
  </div>

  <!-- ROW 3 — Performance par auteur (étendu) -->
  <div class="card card-full">
    <div class="card-title">Performance par auteur</div>
    <div id="author-perf-wrap"><span style="color:#a0a0b0;font-size:12px;">Chargement...</span></div>
  </div>

  <!-- ROW 4 — Comparateur d'auteurs (NEW) -->
  <div class="card card-full">
    <div class="card-title">Comparateur d&#39;auteurs</div>
    <div class="cmp-ctrls">
      <select id="cmp-select" multiple size="6"></select>
      <div class="cmp-hint">
        Ctrl/Cmd+clic pour en sélectionner jusqu&#39;à 3.<br>
        Le meilleur score par métrique est mis en vert.
      </div>
    </div>
    <div class="cmp-grid" id="cmp-grid"><span style="color:#a0a0b0;font-size:12px;">Sélectionne au moins 1 auteur.</span></div>
  </div>

  <!-- ROW 5 — Top bars compacts -->
  <div class="card">
    <div class="card-title">Top 5 auteurs</div>
    <div id="top-authors"></div>
  </div>
  <div class="card">
    <div class="card-title">Top 5 tickers</div>
    <div id="top-tickers"></div>
  </div>

  <!-- ROW 6 — Heatmap succès jour × heure (NEW) -->
  <div class="card card-full">
    <div class="card-title">Heatmap succès — jour &times; heure</div>
    <div id="heatmap-wrap"><span style="color:#a0a0b0;font-size:12px;">Chargement...</span></div>
  </div>

  <!-- ROW 7 — Volume par heure/jour -->
  <div class="card card-full">
    <div class="card-title" id="vol-chart-title">Volume par heure (24h)</div>
    <div class="hour-chart" id="hour-chart"></div>
  </div>

  <!-- ROW 8 — Analyst Performance 30j -->
  <div class="card card-full">
    <div class="card-title">Analyst Performance — 30 jours</div>
    <div id="perf-chart"><span style="color:#a0a0b0;font-size:12px;">Chargement...</span></div>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Aliases serveur injectés : regroupe les stats par nom canonique affiché
  // (ex. "traderzz1m" et "ZZ" → "Z") plutôt que par username Discord brut.
  var AUTHOR_ALIASES = ${JSON.stringify(AUTHOR_ALIASES)};
  var BLOCKED_AUTHORS = ${JSON.stringify(Array.from(BLOCKED_AUTHORS))};
  function canonical(a){ return AUTHOR_ALIASES[a] || a; }
  function isBlocked(a){
    if (!a) return false;
    var low = String(a).toLowerCase();
    for (var i = 0; i < BLOCKED_AUTHORS.length; i++) {
      if (BLOCKED_AUTHORS[i] === low) return true;
    }
    return false;
  }

  var currentPeriod = 'today';

  function periodFromTs() {
    var now = new Date();
    if (currentPeriod === 'today') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
    } else if (currentPeriod === '7d') {
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (currentPeriod === '30d') {
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    return null;
  }

  function renderBars(containerId, data, color) {
    var container = document.getElementById(containerId);
    if (!data.length) { container.innerHTML = '<span style="color:#a0a0b0;font-size:12px;">Aucune donnee</span>'; return; }
    var max = data[0][1] || 1;
    container.innerHTML = '';
    data.forEach(function(item) {
      var pct = Math.round(item[1] / max * 100);
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = '<span class="bar-label" title="' + esc(item[0]) + '">' + esc(item[0]) + '</span>'
        + '<div class="bar-wrap"><div class="bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>'
        + '<span class="bar-val">' + item[1] + '</span>';
      container.appendChild(row);
    });
  }

  // ── Appariement entry→exit (FIFO par auteur canonique + ticker) ───────────
  // Pourquoi FIFO : permet de gérer "scaling in" (plusieurs entries avant un
  // exit) sans en perdre — chaque exit ferme la plus ancienne entry ouverte.
  function computePairs(msgs) {
    var sorted = msgs.slice().sort(function(a, b) { return new Date(a.ts) - new Date(b.ts); });
    var open = {}; // key = "author|ticker" → array of entry msgs (queue)
    var pairs = [];
    var unpaired = [];
    sorted.forEach(function(m) {
      if (!m.author || isBlocked(m.author)) return;
      if (!m.ticker || !m.passed) return;
      var auth = canonical(m.author);
      var key = auth + '|' + m.ticker;
      if (m.type === 'entry' && m.entry_price != null) {
        if (!open[key]) open[key] = [];
        open[key].push(m);
      } else if (m.type === 'exit' && m.exit_price != null) {
        var q = open[key];
        if (q && q.length) {
          var entry = q.shift();
          var pnl = (m.exit_price - entry.entry_price) / entry.entry_price * 100;
          var dur = new Date(m.ts) - new Date(entry.ts);
          pairs.push({ author: auth, ticker: m.ticker, entryMsg: entry, exitMsg: m, pnlPct: pnl, durationMs: dur });
        }
        // exit sans entry matchée : probablement hors période — ignoré
      }
    });
    Object.keys(open).forEach(function(k) { open[k].forEach(function(e) { unpaired.push(e); }); });
    return { pairs: pairs, unpaired: unpaired };
  }

  function formatDuration(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    var mins = Math.round(ms / 60000);
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    var rm = mins % 60;
    if (hrs < 24) return hrs + 'h' + (rm ? ' ' + rm + 'm' : '');
    var days = Math.floor(hrs / 24);
    var rh = hrs % 24;
    return days + 'j' + (rh ? ' ' + rh + 'h' : '');
  }

  function pnlClass(v) { return v > 0 ? 'pnl-pos' : v < 0 ? 'pnl-neg' : 'pnl-zero'; }
  function pnlFmt(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }

  // Regroupe les paires par auteur canonique → { total, avgPnl, avgDur, pairs }
  function pairsByAuthor(pairs) {
    var by = {};
    pairs.forEach(function(p) {
      if (!by[p.author]) by[p.author] = { count: 0, sumPnl: 0, sumDur: 0, pairs: [] };
      by[p.author].count++;
      by[p.author].sumPnl += p.pnlPct;
      by[p.author].sumDur += p.durationMs;
      by[p.author].pairs.push(p);
    });
    Object.keys(by).forEach(function(a) {
      by[a].avgPnl = by[a].sumPnl / by[a].count;
      by[a].avgDur = by[a].sumDur / by[a].count;
    });
    return by;
  }

  function renderPnlByAuthor(pairs) {
    var wrap = document.getElementById('pnl-authors');
    var by = pairsByAuthor(pairs);
    var rows = Object.keys(by).map(function(a) { return [a, by[a].avgPnl, by[a].count]; })
      .sort(function(x, y) { return y[1] - x[1]; }).slice(0, 5);
    if (!rows.length) { wrap.innerHTML = '<span style="color:#a0a0b0;font-size:12px;">Aucune paire entry→exit</span>'; return; }
    var absMax = Math.max.apply(null, rows.map(function(r) { return Math.abs(r[1]); })) || 1;
    wrap.innerHTML = '';
    rows.forEach(function(r) {
      var name = r[0], avg = r[1], n = r[2];
      var pct = Math.round(Math.abs(avg) / absMax * 100);
      var color = avg >= 0 ? '#3ba55d' : '#ed4245';
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = '<span class="bar-label" title="' + esc(name) + '">' + esc(name) + '</span>'
        + '<div class="bar-wrap"><div class="bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>'
        + '<span class="bar-val ' + pnlClass(avg) + '" title="' + n + ' paires">' + pnlFmt(avg) + '</span>';
      wrap.appendChild(row);
    });
  }

  function renderAvgDuration(pairs, unpaired) {
    var el = document.getElementById('avg-duration');
    var sub = document.getElementById('avg-duration-sub');
    if (!pairs.length) {
      el.textContent = '—';
      sub.textContent = 'Aucune paire entry→exit' + (unpaired.length ? ' (' + unpaired.length + ' entries encore ouvertes)' : '');
      return;
    }
    var sorted = pairs.slice().sort(function(a, b) { return a.durationMs - b.durationMs; });
    var sum = pairs.reduce(function(acc, p) { return acc + p.durationMs; }, 0);
    var avg = sum / pairs.length;
    var med = sorted[Math.floor(sorted.length / 2)].durationMs;
    el.textContent = formatDuration(avg);
    sub.textContent = 'médiane ' + formatDuration(med)
      + ' • ' + pairs.length + ' paires'
      + (unpaired.length ? ' • ' + unpaired.length + ' ouvertes' : '');
  }

  function renderAuthorPerf(msgs, pairs) {
    var wrap = document.getElementById('author-perf-wrap');
    var authorStats = {};
    msgs.forEach(function(m) {
      if (!m.author) return;
      if (isBlocked(m.author)) return;
      var key = canonical(m.author);
      if (!authorStats[key]) authorStats[key] = { total: 0, accepted: 0, filtered: 0, tickers: {} };
      var s = authorStats[key];
      s.total++;
      if (m.passed) s.accepted++; else s.filtered++;
      if (m.ticker) s.tickers[m.ticker] = (s.tickers[m.ticker] || 0) + 1;
    });
    var byPair = pairsByAuthor(pairs || []);
    var rows = Object.keys(authorStats).map(function(a) { return [a, authorStats[a]]; })
      .sort(function(x, y) { return y[1].total - x[1].total; }).slice(0, 10);
    if (!rows.length) { wrap.innerHTML = '<span style="color:#a0a0b0;font-size:12px;">Aucune donnee</span>'; return; }
    var html = '<table class="perf-table"><thead><tr>'
      + '<th>Auteur</th><th>Total</th><th>Acceptes</th><th>Filtres</th><th>Taux</th>'
      + '<th>Paires</th><th>P&amp;L moy</th><th>Durée moy</th><th>Ticker top</th>'
      + '</tr></thead><tbody>';
    rows.forEach(function(row) {
      var name = row[0], s = row[1];
      var rate = s.total ? Math.round(s.accepted / s.total * 100) : 0;
      var barColor = rate >= 50 ? '#3ba55d' : rate >= 25 ? '#faa61a' : '#ed4245';
      var topTicker = '';
      var topCount = 0;
      Object.keys(s.tickers).forEach(function(t) { if (s.tickers[t] > topCount) { topCount = s.tickers[t]; topTicker = t; } });
      var pa = byPair[name];
      var pairCell = pa ? pa.count : '—';
      var pnlCell = pa ? '<span class="' + pnlClass(pa.avgPnl) + '">' + pnlFmt(pa.avgPnl) + '</span>' : '<span style="color:#4f5660;">—</span>';
      var durCell = pa ? formatDuration(pa.avgDur) : '<span style="color:#4f5660;">—</span>';
      html += '<tr>'
        + '<td class="perf-author">' + esc(name) + '</td>'
        + '<td>' + s.total + '</td>'
        + '<td class="perf-acc">' + s.accepted + '</td>'
        + '<td class="perf-flt">' + s.filtered + '</td>'
        + '<td><span class="perf-bar-wrap"><span class="perf-bar-fill" style="width:' + rate + '%;background:' + barColor + ';"></span></span>' + rate + '%</td>'
        + '<td>' + pairCell + '</td>'
        + '<td>' + pnlCell + '</td>'
        + '<td>' + durCell + '</td>'
        + '<td class="perf-ticker">' + esc(topTicker) + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  // ── Heatmap 7 jours × 24h, couleur = taux acceptation ─────────────────────
  function renderHeatmap(msgs) {
    var wrap = document.getElementById('heatmap-wrap');
    // grid[day 0=dim..6=sam][hour 0..23] = { total, accepted }
    var grid = [];
    for (var d = 0; d < 7; d++) {
      grid.push([]);
      for (var h = 0; h < 24; h++) grid[d].push({ total: 0, accepted: 0 });
    }
    msgs.forEach(function(m) {
      if (!m.ts) return;
      var dt = new Date(m.ts);
      var dow = dt.getDay(); // 0 = dimanche
      var hr = dt.getHours();
      grid[dow][hr].total++;
      if (m.passed) grid[dow][hr].accepted++;
    });
    // Jours affichés L-Sa-Di (lundi en haut, culturel FR)
    var dayOrder = [1, 2, 3, 4, 5, 6, 0];
    var dayLabels = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
    var dayFull = { 0: 'Dim', 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Jeu', 5: 'Ven', 6: 'Sam' };
    var html = '<div class="heatmap">';
    // Header : coin vide + 24 heures
    html += '<div class="heatmap-hdr"></div>';
    for (var h2 = 0; h2 < 24; h2++) {
      html += '<div class="heatmap-hdr">' + (h2 % 3 === 0 ? h2 : '') + '</div>';
    }
    // Lignes jours
    dayOrder.forEach(function(dow, idx) {
      html += '<div class="heatmap-daylbl">' + dayLabels[idx] + '</div>';
      for (var h3 = 0; h3 < 24; h3++) {
        var cell = grid[dow][h3];
        var rate = cell.total ? cell.accepted / cell.total : null;
        var bg = 'rgba(255,255,255,0.04)';
        if (cell.total > 0) {
          // Rouge(0) → orange(0.5) → vert(1)
          if (rate <= 0.5) {
            var t = rate / 0.5;
            var r = Math.round(237 + (250 - 237) * t);
            var g = Math.round(66 + (166 - 66) * t);
            var b = Math.round(69 + (26 - 69) * t);
            bg = 'rgb(' + r + ',' + g + ',' + b + ')';
          } else {
            var t2 = (rate - 0.5) / 0.5;
            var r2 = Math.round(250 + (59 - 250) * t2);
            var g2 = Math.round(166 + (165 - 166) * t2);
            var b2 = Math.round(26 + (93 - 26) * t2);
            bg = 'rgb(' + r2 + ',' + g2 + ',' + b2 + ')';
          }
        }
        var tip = dayFull[dow] + ' ' + h3 + 'h · ' + cell.accepted + '/' + cell.total + (cell.total ? ' (' + Math.round(rate * 100) + '%)' : '');
        html += '<div class="heatmap-cell" style="background:' + bg + ';" title="' + tip + '"></div>';
      }
    });
    html += '</div>';
    wrap.innerHTML = html;
  }

  // ── Comparateur d'auteurs ─────────────────────────────────────────────────
  var cmpSelected = [];
  function renderComparateur(msgs, pairs) {
    var sel = document.getElementById('cmp-select');
    var grid = document.getElementById('cmp-grid');

    // Collecte auteurs présents dans la période
    var authorStats = {};
    msgs.forEach(function(m) {
      if (!m.author || isBlocked(m.author)) return;
      var key = canonical(m.author);
      if (!authorStats[key]) authorStats[key] = { total: 0, accepted: 0, tickers: {} };
      authorStats[key].total++;
      if (m.passed) authorStats[key].accepted++;
      if (m.ticker) authorStats[key].tickers[m.ticker] = (authorStats[key].tickers[m.ticker] || 0) + 1;
    });
    var authors = Object.keys(authorStats).sort();

    // Reconstruit le select en préservant la sélection existante
    var previous = cmpSelected.slice();
    sel.innerHTML = '';
    authors.forEach(function(a) {
      var opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      if (previous.indexOf(a) !== -1) opt.selected = true;
      sel.appendChild(opt);
    });

    // Limite dure à 3 — désélectionne les extras au change
    sel.onchange = function() {
      var chosen = Array.prototype.map.call(sel.selectedOptions, function(o) { return o.value; });
      if (chosen.length > 3) {
        for (var i = 3; i < sel.selectedOptions.length; i++) sel.selectedOptions[i].selected = false;
        chosen = chosen.slice(0, 3);
      }
      cmpSelected = chosen;
      renderCmpGrid(chosen, authorStats, pairs);
    };

    // Rendu initial (synchronise cmpSelected avec le DOM au cas où la liste a changé)
    cmpSelected = previous.filter(function(a) { return authors.indexOf(a) !== -1; });
    renderCmpGrid(cmpSelected, authorStats, pairs);
  }

  function renderCmpGrid(chosen, authorStats, pairs) {
    var grid = document.getElementById('cmp-grid');
    if (!chosen.length) { grid.innerHTML = '<span style="color:#a0a0b0;font-size:12px;">Sélectionne au moins 1 auteur.</span>'; return; }
    var byPair = pairsByAuthor(pairs || []);

    // Métriques pour chaque auteur
    var cards = chosen.map(function(name) {
      var s = authorStats[name] || { total: 0, accepted: 0, tickers: {} };
      var rate = s.total ? (s.accepted / s.total) : 0;
      var pa = byPair[name];
      var topT = '', topC = 0;
      Object.keys(s.tickers).forEach(function(t) { if (s.tickers[t] > topC) { topC = s.tickers[t]; topT = t; } });
      return {
        name: name,
        total: s.total,
        rate: rate,
        pairs: pa ? pa.count : 0,
        pnl: pa ? pa.avgPnl : null,
        dur: pa ? pa.avgDur : null,
        topTicker: topT,
      };
    });

    // Meilleur par métrique → classe .best
    function bestIdx(key, higher) {
      var best = -1, bestV = null;
      cards.forEach(function(c, i) {
        var v = c[key];
        if (v == null) return;
        if (bestV == null || (higher ? v > bestV : v < bestV)) { bestV = v; best = i; }
      });
      return best;
    }
    var bTotal = bestIdx('total', true);
    var bRate = bestIdx('rate', true);
    var bPairs = bestIdx('pairs', true);
    var bPnl = bestIdx('pnl', true);
    var bDur = bestIdx('dur', false); // durée plus courte = meilleur

    var html = '';
    cards.forEach(function(c, i) {
      html += '<div class="cmp-col">'
        + '<h4>' + esc(c.name) + '</h4>'
        + '<div class="cmp-row' + (i === bTotal ? ' best' : '') + '"><span class="k">Signaux</span><span class="v">' + c.total + '</span></div>'
        + '<div class="cmp-row' + (i === bRate ? ' best' : '') + '"><span class="k">Taux</span><span class="v">' + Math.round(c.rate * 100) + '%</span></div>'
        + '<div class="cmp-row' + (i === bPairs ? ' best' : '') + '"><span class="k">Paires</span><span class="v">' + c.pairs + '</span></div>'
        + '<div class="cmp-row' + (i === bPnl && c.pnl != null ? ' best' : '') + '"><span class="k">P&amp;L moy</span><span class="v ' + (c.pnl != null ? pnlClass(c.pnl) : '') + '">' + (c.pnl != null ? pnlFmt(c.pnl) : '—') + '</span></div>'
        + '<div class="cmp-row' + (i === bDur && c.dur != null ? ' best' : '') + '"><span class="k">Durée moy</span><span class="v">' + (c.dur != null ? formatDuration(c.dur) : '—') + '</span></div>'
        + '<div class="cmp-row"><span class="k">Top ticker</span><span class="v" style="color:#5865f2;">' + esc(c.topTicker || '—') + '</span></div>'
        + '</div>';
    });
    grid.innerHTML = html;
  }

  function renderVolumeChart(msgs) {
    var isMultiDay = currentPeriod === '7d' || currentPeriod === '30d';
    var chart = document.getElementById('hour-chart');
    var title = document.getElementById('vol-chart-title');
    chart.innerHTML = '';

    if (isMultiDay) {
      title.textContent = currentPeriod === '7d' ? 'Volume par jour (7 jours)' : 'Volume par jour (30 jours)';
      var dayMap = {};
      msgs.forEach(function(m) {
        var d = m.ts ? m.ts.slice(0, 10) : '';
        if (!d) return;
        if (!dayMap[d]) dayMap[d] = { total: 0, accepted: 0 };
        dayMap[d].total++;
        if (m.passed) dayMap[d].accepted++;
      });
      var days = Object.keys(dayMap).sort();
      var maxV = 0;
      days.forEach(function(d) { if (dayMap[d].total > maxV) maxV = dayMap[d].total; });
      maxV = maxV || 1;
      days.forEach(function(d) {
        var v = dayMap[d].total;
        var acc = dayMap[d].accepted;
        var heightPct = Math.round(v / maxV * 100);
        var accRate = v ? acc / v : 0;
        var barColor = accRate >= 0.5 ? '#3ba55d' : accRate >= 0.25 ? '#faa61a' : '#ed4245';
        if (v === 0) barColor = 'rgba(255,255,255,0.08)';
        var lbl = d.slice(5); // MM-DD
        var col = document.createElement('div');
        col.className = 'hour-col';
        col.innerHTML = '<div class="hour-bar" title="' + v + ' msg" style="height:' + heightPct + '%;background:' + barColor + ';"></div>'
          + '<span class="hour-lbl">' + esc(lbl) + '</span>';
        chart.appendChild(col);
      });
    } else {
      title.textContent = 'Volume par heure (24h)';
      var hourBuckets = new Array(24).fill(0);
      var hourAccepted = new Array(24).fill(0);
      msgs.forEach(function(m) {
        var h = new Date(m.ts).getHours();
        hourBuckets[h]++;
        if (m.passed) hourAccepted[h]++;
      });
      var maxH = Math.max.apply(null, hourBuckets) || 1;
      for (var i = 0; i < 24; i++) {
        var v = hourBuckets[i];
        var heightPct = Math.round(v / maxH * 100);
        var accRate = v ? hourAccepted[i] / v : 0;
        var barColor = accRate >= 0.5 ? '#3ba55d' : accRate >= 0.25 ? '#faa61a' : '#ed4245';
        if (v === 0) barColor = 'rgba(255,255,255,0.08)';
        var col = document.createElement('div');
        col.className = 'hour-col';
        col.innerHTML = '<div class="hour-bar" title="' + v + ' msg" style="height:' + heightPct + '%;background:' + barColor + ';"></div>'
          + '<span class="hour-lbl">' + String(i).padStart(2, '0') + '</span>';
        chart.appendChild(col);
      }
    }
  }

  function loadStats() {
    var fromTs = periodFromTs();
    var url = '/api/messages' + (fromTs ? '?from=' + encodeURIComponent(fromTs) : '');
    fetch(url)
      .then(function(r){ return r.json(); })
      .then(function(msgs) {
        var total = msgs.length;
        var accepted = msgs.filter(function(m){ return m.passed; }).length;
        var pct = total ? Math.round(accepted / total * 100) : 0;

        document.getElementById('accept-pct').textContent = pct + '%';
        document.getElementById('accept-sub').textContent = accepted + ' acceptes sur ' + total + ' total';
        document.getElementById('accept-bar').style.width = pct + '%';
        document.getElementById('accept-bar').style.background = pct >= 50 ? '#3ba55d' : pct >= 25 ? '#faa61a' : '#ed4245';

        var cEntry = 0, cExit = 0, cNeutral = 0, cFiltered = 0;
        msgs.forEach(function(m){
          if (!m.passed) { cFiltered++; return; }
          if (m.type === 'entry') cEntry++;
          else if (m.type === 'exit') cExit++;
          else cNeutral++;
        });
        document.getElementById('cnt-entry').textContent = cEntry;
        document.getElementById('cnt-exit').textContent = cExit;
        document.getElementById('cnt-neutral').textContent = cNeutral;
        document.getElementById('cnt-filtered').textContent = cFiltered;

        var authorMap = {};
        msgs.forEach(function(m){
          if (!m.author || isBlocked(m.author)) return;
          var key = canonical(m.author);
          authorMap[key] = (authorMap[key]||0) + 1;
        });
        var topAuthors = Object.keys(authorMap).map(function(k){ return [k, authorMap[k]]; })
          .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);
        renderBars('top-authors', topAuthors, '#D649CC');

        var tickerMap = {};
        msgs.forEach(function(m){ if(m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker]||0) + 1; });
        var topTickers = Object.keys(tickerMap).map(function(k){ return [k, tickerMap[k]]; })
          .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);
        renderBars('top-tickers', topTickers, '#5865f2');

        var paired = computePairs(msgs);
        renderPnlByAuthor(paired.pairs);
        renderAvgDuration(paired.pairs, paired.unpaired);
        renderAuthorPerf(msgs, paired.pairs);
        renderComparateur(msgs, paired.pairs);
        renderHeatmap(msgs);
        renderVolumeChart(msgs);
      })
      .catch(function(){ document.getElementById('accept-sub').textContent = 'Erreur de chargement'; });
  }

  function setPeriod(p) {
    currentPeriod = p;
    document.querySelectorAll('.btn-period').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-period') === p);
    });
    loadStats();
  }

  document.getElementById('btn-today').addEventListener('click', function() { setPeriod('today'); });
  document.getElementById('btn-7d').addEventListener('click', function() { setPeriod('7d'); });
  document.getElementById('btn-30d').addEventListener('click', function() { setPeriod('30d'); });

  loadStats();
  document.getElementById('btn-refresh').addEventListener('click', loadStats);

  // ── Analyst Performance Chart ──
  fetch('/api/analyst-performance?days=30')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var wrap = document.getElementById('perf-chart');
      if (!data.datasets || !data.datasets.length) {
        wrap.innerHTML = '<span style="color:#a0a0b0;font-size:12px;">Aucune donnee</span>';
        return;
      }
      var labels = data.labels || [];
      var datasets = data.datasets;
      var maxVal = 1;
      datasets.forEach(function(ds){ ds.data.forEach(function(v){ if(v>maxVal) maxVal=v; }); });

      var W = 760, H = 220, PAD_L = 30, PAD_B = 24, PAD_T = 10, PAD_R = 10;
      var chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;
      var stepX = labels.length > 1 ? chartW / (labels.length - 1) : chartW;

      var svg = '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;">';
      // Grid lines
      for (var g = 0; g <= 4; g++) {
        var gy = PAD_T + chartH - (g/4)*chartH;
        svg += '<line x1="'+PAD_L+'" y1="'+gy+'" x2="'+(W-PAD_R)+'" y2="'+gy+'" stroke="rgba(255,255,255,0.08)" stroke-width="0.5"/>';
        svg += '<text x="'+(PAD_L-4)+'" y="'+(gy+3)+'" fill="#a0a0b0" font-size="9" text-anchor="end">'+Math.round(maxVal*g/4)+'</text>';
      }
      // Lines
      datasets.forEach(function(ds) {
        var pts = [];
        ds.data.forEach(function(v, i){
          var x = PAD_L + i * stepX;
          var y = PAD_T + chartH - (v / maxVal) * chartH;
          pts.push(x+','+y);
        });
        svg += '<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+ds.color+'" stroke-width="2" stroke-linejoin="round"/>';
        // Dots
        ds.data.forEach(function(v, i){
          if (v > 0) {
            var x = PAD_L + i * stepX;
            var y = PAD_T + chartH - (v / maxVal) * chartH;
            svg += '<circle cx="'+x+'" cy="'+y+'" r="2.5" fill="'+ds.color+'"/>';
          }
        });
      });
      svg += '</svg>';

      // Legend
      var legend = '<div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap;">';
      datasets.forEach(function(ds){
        legend += '<div style="display:flex;align-items:center;gap:5px;font-size:12px;"><span style="width:10px;height:10px;border-radius:2px;background:'+ds.color+';display:inline-block;"></span><span style="color:#fafafa;">'+ds.author+'</span></div>';
      });
      legend += '</div>';
      wrap.innerHTML = svg + legend;
    });
})();
</script>
</div>
</body>
</html>`;

module.exports = { STATS_HTML };
