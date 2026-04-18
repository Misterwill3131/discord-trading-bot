// ─────────────────────────────────────────────────────────────────────
// pages/ticker.js — Template HTML de /ticker/:symbol (détail par ticker)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('/ticker/:symbol')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const TICKER_PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Ticker</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px 32px; display: flex; flex-direction: column; gap: 20px; }
  .grid-stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .stat-box { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px 20px; }
  .stat-box .num { font-size: 28px; font-weight: 800; color: #fafafa; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .stat-box .lbl { font-size: 11px; color: #a0a0b0; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .breakdown-row { display: flex; gap: 14px; flex-wrap: wrap; }
  .breakdown-pill { flex: 1; min-width: 120px; display: flex; flex-direction: column; align-items: center; padding: 14px 18px; border-radius: 10px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid; }
  .breakdown-pill .n { font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; margin-bottom: 4px; }
  .bp-entry { background: rgba(16,185,129,0.1); color: #10b981; border-color: rgba(16,185,129,0.3); }
  .bp-exit { background: rgba(239,68,68,0.1); color: #f87171; border-color: rgba(239,68,68,0.3); }
  .bp-neutral { background: rgba(88,101,242,0.1); color: #a78bfa; border-color: rgba(139,92,246,0.3); }
  .bp-filter { background: rgba(250,166,26,0.1); color: #faa61a; border-color: rgba(250,166,26,0.3); }
  .author-row { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 6px; }
  .author-row:hover { background: rgba(255,255,255,0.04); }
  .author-name { font-weight: 700; color: #D649CC; font-size: 13px; flex: 0 0 120px; }
  .author-bar-wrap { flex: 1; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
  .author-bar-fill { height: 100%; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); border-radius: 4px; }
  .author-count { font-variant-numeric: tabular-nums; color: #fafafa; font-weight: 600; font-size: 13px; width: 40px; text-align: right; }
  .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 100px; margin-top: 8px; }
  .hour-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .hour-bar { width: 100%; background: linear-gradient(180deg, #8b5cf6, #3b82f6); border-radius: 2px 2px 0 0; min-height: 1px; transition: opacity .15s; }
  .hour-bar:hover { opacity: 0.75; }
  .hour-lbl { font-size: 9px; color: #a0a0b0; font-variant-numeric: tabular-nums; }
  .weekday-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-top: 8px; }
  .weekday-cell { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 4px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); }
  .weekday-cell .wd-n { font-size: 20px; font-weight: 800; color: #fafafa; font-variant-numeric: tabular-nums; }
  .weekday-cell .wd-lbl { font-size: 10px; color: #a0a0b0; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  .signals-table { width: 100%; border-collapse: collapse; }
  .signals-table th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .signals-table td { padding: 9px 10px; vertical-align: middle; line-height: 1.45; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
  .signals-table .ts { color: #a0a0b0; font-size: 12px; white-space: nowrap; }
  .signals-table .auth { font-weight: 600; color: #D649CC; white-space: nowrap; }
  .signals-table .prev { max-width: 440px; word-break: break-word; color: #fafafa; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .b-exit    { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .b-neutral { background: rgba(88,101,242,0.1); color: #a78bfa; border: 1px solid rgba(139,92,246,0.3); }
  .b-filter  { background: rgba(250,166,26,0.1); color: #faa61a; border: 1px solid rgba(250,166,26,0.3); }
  #empty { text-align: center; padding: 60px 24px; color: #a0a0b0; }
  .ticker-badge { display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; font-weight: 800; padding: 3px 12px; border-radius: 8px; font-size: 18px; letter-spacing: -0.01em; margin-right: 10px; }
</style>
</head>
<body>
${sidebarHTML('')}
<div class="page-content">
<div class="page-header">
  <span class="ticker-badge" id="ticker-badge">—</span>
  <h1 class="page-title">Ticker</h1>
  <div class="period-btns" style="margin-left:auto;display:flex;gap:6px;">
    <button class="btn-period" data-days="7">7 jours</button>
    <button class="btn-period active" data-days="30">30 jours</button>
    <button class="btn-period" data-days="90">90 jours</button>
  </div>
</div>
<div id="wrap">
  <div id="empty" style="display:none;">Aucun signal trouvé pour ce ticker sur la période.</div>
  <div id="main-content">
    <div class="grid-stats">
      <div class="stat-box"><div class="num" id="stat-total">—</div><div class="lbl">Signaux</div></div>
      <div class="stat-box"><div class="num" id="stat-authors">—</div><div class="lbl">Auteurs distincts</div></div>
      <div class="stat-box"><div class="num" id="stat-first-entry">—</div><div class="lbl">Prix d&#39;entrée initial</div></div>
      <div class="stat-box"><div class="num" id="stat-first-exit">—</div><div class="lbl">Prix de sortie initial</div></div>
      <div class="stat-box"><div class="num" id="stat-first">—</div><div class="lbl">Première mention</div></div>
      <div class="stat-box"><div class="num" id="stat-last">—</div><div class="lbl">Dernière mention</div></div>
    </div>

    <div class="card">
      <div class="card-title">Répartition par type</div>
      <div class="breakdown-row" id="breakdown-row"></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Top auteurs</div>
        <div id="top-authors"></div>
      </div>
      <div class="card">
        <div class="card-title">Activité par heure (0–23h)</div>
        <div class="hour-chart" id="hour-chart"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Activité par jour de la semaine</div>
      <div class="weekday-row" id="weekday-row"></div>
    </div>

    <div class="card">
      <div class="card-title">Historique des signaux (<span id="sig-count">0</span>)</div>
      <div style="overflow-x:auto;">
        <table class="signals-table">
          <thead><tr><th>Date</th><th>Auteur</th><th>Type</th><th>Aperçu</th></tr></thead>
          <tbody id="signals-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>
</div>
<script>
(function(){
  var symbol = window.location.pathname.split('/').pop().toUpperCase();
  var currentDays = 30;

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtFullTs(iso){ if(!iso) return '—'; var d = new Date(iso); if(isNaN(d)) return '—'; return d.toLocaleString('fr-CA',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
  function fmtRelDays(iso){ if(!iso) return '—'; var d = new Date(iso); if(isNaN(d)) return '—'; var diff = Math.floor((Date.now()-d.getTime())/86400000); if(diff<=0) return 'aujourd\\'hui'; if(diff===1) return 'hier'; return 'il y a ' + diff + 'j'; }

  function typeBadge(m){
    if(!m.passed){
      return '<span class="badge b-filter">FILTER — ' + esc(m.reason || '') + '</span>';
    }
    if(m.type === 'entry') return '<span class="badge b-entry">ENTRY</span>';
    if(m.type === 'exit')  return '<span class="badge b-exit">EXIT</span>';
    return '<span class="badge b-neutral">' + esc((m.type || 'NEUTRAL').toUpperCase()) + '</span>';
  }

  function renderBreakdown(bd){
    var total = (bd.entry||0) + (bd.exit||0) + (bd.neutral||0) + (bd.filter||0);
    function pct(n){ return total ? Math.round(n/total*100) : 0; }
    document.getElementById('breakdown-row').innerHTML =
      '<div class="breakdown-pill bp-entry"><div class="n">' + (bd.entry||0) + '</div>Entry <span style="opacity:0.7">(' + pct(bd.entry||0) + '%)</span></div>' +
      '<div class="breakdown-pill bp-exit"><div class="n">' + (bd.exit||0) + '</div>Exit <span style="opacity:0.7">(' + pct(bd.exit||0) + '%)</span></div>' +
      '<div class="breakdown-pill bp-neutral"><div class="n">' + (bd.neutral||0) + '</div>Neutral <span style="opacity:0.7">(' + pct(bd.neutral||0) + '%)</span></div>' +
      '<div class="breakdown-pill bp-filter"><div class="n">' + (bd.filter||0) + '</div>Filter <span style="opacity:0.7">(' + pct(bd.filter||0) + '%)</span></div>';
  }

  function renderTopAuthors(authors){
    var wrap = document.getElementById('top-authors');
    if(!authors.length){ wrap.innerHTML = '<div style="color:#a0a0b0;font-size:12px;">Aucun auteur</div>'; return; }
    var maxCount = authors[0].count || 1;
    wrap.innerHTML = authors.map(function(a){
      var pct = Math.round(a.count / maxCount * 100);
      return '<div class="author-row">'
        + '<span class="author-name">' + esc(a.name) + '</span>'
        + '<span class="author-bar-wrap"><span class="author-bar-fill" style="width:' + pct + '%"></span></span>'
        + '<span class="author-count">' + a.count + '</span>'
        + '</div>';
    }).join('');
  }

  function renderHourChart(hourly){
    var max = Math.max.apply(null, hourly) || 1;
    var cols = '';
    for(var h=0; h<24; h++){
      var val = hourly[h] || 0;
      var height = Math.round(val/max*90);
      cols += '<div class="hour-col" title="' + h + 'h : ' + val + ' signaux">'
        + '<div class="hour-bar" style="height:' + height + '%;" ></div>'
        + '<div class="hour-lbl">' + h + '</div>'
        + '</div>';
    }
    document.getElementById('hour-chart').innerHTML = cols;
  }

  function renderWeekday(weekday){
    var labels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    var html = '';
    for(var i=1; i<=7; i++){
      var idx = i % 7;
      html += '<div class="weekday-cell">'
        + '<div class="wd-n">' + (weekday[idx]||0) + '</div>'
        + '<div class="wd-lbl">' + labels[idx] + '</div>'
        + '</div>';
    }
    document.getElementById('weekday-row').innerHTML = html;
  }

  function renderSignals(signals){
    document.getElementById('sig-count').textContent = signals.length;
    var tb = document.getElementById('signals-body');
    if(!signals.length){
      tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:#a0a0b0;">Aucun signal</td></tr>';
      return;
    }
    tb.innerHTML = signals.map(function(m){
      return '<tr>'
        + '<td class="ts">' + fmtFullTs(m.ts) + '</td>'
        + '<td class="auth">' + esc(m.author || '—') + '</td>'
        + '<td>' + typeBadge(m) + '</td>'
        + '<td class="prev">' + esc(m.preview || m.content || '') + '</td>'
        + '</tr>';
    }).join('');
  }

  function loadData(days){
    currentDays = days;
    document.querySelectorAll('.btn-period').forEach(function(b){
      b.classList.toggle('active', parseInt(b.getAttribute('data-days'),10) === days);
    });

    fetch('/api/ticker/' + encodeURIComponent(symbol) + '?days=' + days)
      .then(function(r){ return r.json(); })
      .then(function(data){
        document.getElementById('ticker-badge').textContent = '$' + (data.ticker || symbol);
        document.title = 'BOOM Ticker — ' + (data.ticker || symbol);
        var empty = document.getElementById('empty');
        var main = document.getElementById('main-content');
        if(!data.total){
          empty.style.display = 'block';
          main.style.display = 'none';
          return;
        }
        empty.style.display = 'none';
        main.style.display = '';

        document.getElementById('stat-total').textContent = data.total;
        document.getElementById('stat-authors').textContent = data.distinctAuthors || 0;
        document.getElementById('stat-first-entry').textContent = data.firstEntryPrice != null ? ('$' + Number(data.firstEntryPrice).toFixed(2)) : '—';
        document.getElementById('stat-first-exit').textContent = data.firstExitPrice != null ? ('$' + Number(data.firstExitPrice).toFixed(2)) : '—';
        document.getElementById('stat-first').textContent = fmtRelDays(data.firstSeen);
        document.getElementById('stat-last').textContent = fmtRelDays(data.lastSeen);

        renderBreakdown(data.breakdown || {});
        renderTopAuthors(data.topAuthors || []);
        renderHourChart((data.heatmap && data.heatmap.hourly) || new Array(24).fill(0));
        renderWeekday((data.heatmap && data.heatmap.weekday) || new Array(7).fill(0));
        renderSignals(data.signals || []);
      })
      .catch(function(err){
        console.error(err);
        document.getElementById('empty').style.display = 'block';
        document.getElementById('empty').textContent = 'Erreur de chargement.';
        document.getElementById('main-content').style.display = 'none';
      });
  }

  document.querySelectorAll('.btn-period').forEach(function(b){
    b.addEventListener('click', function(){
      var d = parseInt(b.getAttribute('data-days'),10);
      if(d && d !== currentDays) loadData(d);
    });
  });

  loadData(30);
})();
</script>
</body>
</html>`;
module.exports = { TICKER_PAGE_HTML };