// ─────────────────────────────────────────────────────────────────────
// pages/profits.js — Template HTML de la page /profits (bar chart profits + milestones)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/profits')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const PROFITS_PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Profits</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 28px; }
  .card-title { display: flex; align-items: center; justify-content: space-between; }
  .period-btns { display: flex; gap: 6px; }
  .chart-wrap { position: relative; height: 220px; }
  svg.bar-chart { width: 100%; height: 100%; }
  .bar-chart .bar { fill: url(#profit-gradient); transition: opacity .15s; cursor: default; }
  .bar-chart .bar:hover { opacity: 0.8; }
  .bar-chart .axis-label { fill: #a0a0b0; font-size: 11px; font-family: 'Inter', system-ui, sans-serif; }
  .bar-chart .value-label { fill: #fafafa; font-size: 10px; font-family: 'Inter', system-ui, sans-serif; text-anchor: middle; }
  .summary-row { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 16px; }
  .stat-box { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 120px; }
  .stat-box .num { font-size: 30px; font-weight: 800; color: #fafafa; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .stat-box .lbl { font-size: 11px; color: #a0a0b0; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  /* Review panel */
  #review-panel { margin-top: 24px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; overflow: hidden; }
  #review-toggle { width: 100%; background: transparent; border: none; color: #fafafa; padding: 14px 20px; text-align: left; cursor: pointer; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
  #review-toggle:hover { background: rgba(255,255,255,0.03); }
  #review-body { display: none; padding: 16px 20px; background: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
  #review-body.open { display: block; }
  .review-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  .review-controls label { font-size: 12px; color: #a0a0b0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
  .review-controls input[type=date] { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
  .review-filter { display: flex; gap: 4px; }
  .rf-btn { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .rf-btn:hover { background: rgba(255,255,255,0.06); color: #fafafa; }
  .rf-btn.active { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.4); color: #c4b5fd; }
  .review-list { display: flex; flex-direction: column; gap: 8px; }
  .review-msg { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 12px 14px; font-size: 13px; }
  .review-msg.has-feedback { opacity: 0.5; }
  .rm-header { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }
  .rm-ts { color: #a0a0b0; font-size: 11px; font-variant-numeric: tabular-nums; }
  .rm-author { color: #D649CC; font-weight: 700; }
  .rm-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; }
  .rm-counted { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .rm-ignored { background: rgba(160,160,176,0.1); color: #a0a0b0; border: 1px solid rgba(160,160,176,0.3); }
  .rm-feedback-good { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .rm-feedback-bad  { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .rm-reason { color: #a0a0b0; font-size: 11px; }
  .rm-content { color: #fafafa; white-space: pre-wrap; word-break: break-word; margin-top: 4px; margin-bottom: 8px; }
  .rm-action { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .rm-action-bad { border-color: rgba(239,68,68,0.3); color: #f87171; }
  .rm-action-bad:hover { background: rgba(239,68,68,0.1); }
  .rm-action-good { border-color: rgba(16,185,129,0.3); color: #10b981; }
  .rm-action-good:hover { background: rgba(16,185,129,0.1); }
  .review-pager { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 12px; }
  .review-pager button { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .review-pager button:disabled { opacity: 0.3; cursor: default; }
  .review-pager span { font-size: 12px; color: #a0a0b0; font-variant-numeric: tabular-nums; }
  .review-phrases { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.06); }
  .review-phrases h4 { font-size: 11px; color: #a0a0b0; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
  .phrase-tag { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 10px; font-size: 12px; margin: 3px; max-width: 420px; word-break: break-all; color: #fafafa; }
  .phrase-tag button { background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
  .phrase-tag button:hover { color: #f87171; }
</style>
</head>
<body>
${sidebarHTML('/profits')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Profits</h1></div>
<div id="wrap">
  <div class="card">
    <div class="card-title">
      <span>Profits par jour</span>
      <div class="period-btns">
        <button class="btn-period active" id="btn-7d" data-days="7">7 jours</button>
        <button class="btn-period" id="btn-30d" data-days="30">30 jours</button>
      </div>
    </div>
    <div class="chart-wrap">
      <svg class="bar-chart" id="profit-chart" viewBox="0 0 800 200" preserveAspectRatio="none">
        <defs>
          <linearGradient id="profit-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#8b5cf6" />
            <stop offset="100%" stop-color="#3b82f6" />
          </linearGradient>
        </defs>
      </svg>
    </div>
    <div class="summary-row" id="summary-row">
      <div class="stat-box"><div class="num" id="stat-today">—</div><div class="lbl">Aujourd'hui</div></div>
      <div class="stat-box"><div class="num" id="stat-total">—</div><div class="lbl">Total periode</div></div>
      <div class="stat-box"><div class="num" id="stat-avg">—</div><div class="lbl">Moyenne / jour</div></div>
      <div class="stat-box"><div class="num" id="stat-best">—</div><div class="lbl">Meilleur jour</div></div>
    </div>
  </div>
  <!-- Modifier le count du jour -->
  <div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
    <div style="flex:1;min-width:160px;">
      <div style="color:#fafafa;font-size:13px;font-weight:600;margin-bottom:4px;">Modifier les profits d'aujourd'hui</div>
      <div style="color:#a0a0b0;font-size:12px;">Définir manuellement le compteur du jour</div>
    </div>
    <input type="number" id="input-set-count" min="0" step="1" placeholder="Nouveau total"
      style="width:120px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#fafafa;border-radius:8px;padding:9px 12px;font-size:14px;" />
    <button type="button" class="btn-add" id="btn-set-count">Modifier</button>
    <button type="button" class="btn-add" id="btn-add-profit" style="background:#4f545c;">+ Ajouter 1</button>
    <span id="add-msg" style="font-size:13px;color:#3ba55d;display:none;"></span>
  </div>

  <!-- Toggle messages bot dans #profits -->
  <div class="card" style="display:flex;align-items:center;gap:16px;">
    <div style="flex:1;">
      <div style="color:#fafafa;font-size:13px;font-weight:600;margin-bottom:4px;">Messages du bot dans #profits</div>
      <div style="color:#a0a0b0;font-size:12px;">Milestones et résumé quotidien</div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <span id="silent-label" style="font-size:13px;color:#a0a0b0;">Activés</span>
      <div id="toggle-silent" style="position:relative;width:42px;height:22px;background:#3ba55d;border-radius:11px;cursor:pointer;transition:background .2s;">
        <div id="toggle-thumb" style="position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .2s;"></div>
      </div>
    </label>
  </div>
<div id="review-panel">
  <button id="review-toggle">
    <span>📨 Messages #profits (revue & apprentissage)</span>
    <span id="review-arrow">▶</span>
  </button>
  <div id="review-body">
    <div class="review-controls">
      <label for="review-date">Date :</label>
      <input type="date" id="review-date">
      <div class="review-filter">
        <button class="rf-btn active" data-filter="all">Tous</button>
        <button class="rf-btn" data-filter="counted">Comptés</button>
        <button class="rf-btn" data-filter="ignored">Ignorés</button>
        <button class="rf-btn" data-filter="flagged">Marqués</button>
      </div>
    </div>
    <div id="review-list" class="review-list">
      <div style="color:#a0a0b0;font-size:12px;">Chargement...</div>
    </div>
    <div id="review-pager" class="review-pager" style="display:none;">
      <button id="review-prev">← Précédent</button>
      <span id="review-page-info">Page 1/1</span>
      <button id="review-next">Suivant →</button>
    </div>
    <div class="review-phrases">
      <h4>Phrases apprises — bloquées (<span id="pf-blocked-count">0</span>)</h4>
      <div id="pf-blocked">Aucune</div>
      <h4 style="margin-top:14px;">Phrases apprises — autorisées (<span id="pf-allowed-count">0</span>)</h4>
      <div id="pf-allowed">Aucune</div>
    </div>
  </div>
</div>
</div>
<script>
(function(){
  var currentDays = 7;

  function on(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderChart(data) {
    var svg = document.getElementById('profit-chart');
    svg.innerHTML = '<defs><linearGradient id="profit-gradient" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#8b5cf6" /><stop offset="100%" stop-color="#3b82f6" /></linearGradient></defs>';
    if (!data.length) return;
    var max = Math.max.apply(null, data.map(function(d){ return d.count; })) || 1;
    var W = 800, H = 200, padL = 30, padR = 10, padT = 20, padB = 30;
    var chartW = W - padL - padR;
    var chartH = H - padT - padB;
    var barW = Math.floor(chartW / data.length * 0.7);
    var gap  = Math.floor(chartW / data.length * 0.3);

    // Y axis labels
    for (var y = 0; y <= 4; y++) {
      var val = Math.round(max * y / 4);
      var yPos = padT + chartH - Math.round(chartH * y / 4);
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
      line.setAttribute('y1', yPos); line.setAttribute('y2', yPos);
      line.setAttribute('stroke', 'rgba(255,255,255,0.08)'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
      var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', padL - 4); txt.setAttribute('y', yPos + 4);
      txt.setAttribute('class', 'axis-label'); txt.setAttribute('text-anchor', 'end');
      txt.textContent = val;
      svg.appendChild(txt);
    }

    data.forEach(function(d, i) {
      var slotW = chartW / data.length;
      var x = padL + i * slotW + (slotW - barW) / 2;
      var barH = max ? Math.round(chartH * d.count / max) : 0;
      var y = padT + chartH - barH;

      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'bar');
      rect.setAttribute('x', x); rect.setAttribute('y', barH ? y : padT + chartH - 1);
      rect.setAttribute('width', barW); rect.setAttribute('height', barH || 1);
      rect.setAttribute('rx', '2');
      if (d.date === new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })) rect.setAttribute('fill', '#faa61a');
      var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = d.date + ': ' + d.count + ' profits';
      rect.appendChild(title);
      svg.appendChild(rect);

      if (d.count > 0) {
        var vt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        vt.setAttribute('class', 'value-label');
        vt.setAttribute('x', x + barW / 2); vt.setAttribute('y', y - 4);
        vt.textContent = d.count;
        svg.appendChild(vt);
      }

      // X label (MM-DD)
      var lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('class', 'axis-label');
      lbl.setAttribute('x', x + barW / 2); lbl.setAttribute('y', H - 4);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.textContent = d.date.slice(5);
      if (data.length > 14 && i % 2 !== 0) lbl.setAttribute('display', 'none');
      svg.appendChild(lbl);
    });
  }

  function loadData(days) {
    fetch('/api/profits-history?days=' + days)
      .then(function(r){ return r.json(); })
      .then(function(data) {
        renderChart(data);
        var today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        var todayEntry = data.find(function(d){ return d.date === today; });
        var total = data.reduce(function(s,d){ return s + d.count; }, 0);
        var avg = data.length ? (total / days).toFixed(1) : '0';
        var best = data.length ? Math.max.apply(null, data.map(function(d){ return d.count; })) : 0;
        document.getElementById('stat-today').textContent = todayEntry ? todayEntry.count : 0;
        document.getElementById('stat-total').textContent = total;
        document.getElementById('stat-avg').textContent = avg;
        document.getElementById('stat-best').textContent = best;
      })
      .catch(function(){ });
  }

  on('btn-7d', 'click', function(){
    currentDays = 7;
    document.querySelectorAll('.btn-period').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-days')==='7'); });
    loadData(7);
  });
  on('btn-30d', 'click', function(){
    currentDays = 30;
    document.querySelectorAll('.btn-period').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-days')==='30'); });
    loadData(30);
  });

  // Bouton +1
  on('btn-add-profit', 'click', function(){
    var btn = this;
    btn.disabled = true;
    fetch('/api/add-profit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function(r){ return r.json(); })
      .then(function(data){
        showMsg('Profit #' + data.count + ' enregistre !', '#3ba55d');
        loadData(currentDays);
        btn.disabled = false;
      })
      .catch(function(){ btn.disabled = false; });
  });

  // Bouton Modifier (set count)
  on('btn-set-count', 'click', function(){
    var input = document.getElementById('input-set-count');
    var val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) { showMsg('Valeur invalide', '#ed4245'); return; }
    var btn = this;
    btn.disabled = true;
    fetch('/api/set-profit-count', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: val }) })
      .then(function(r){
        if (!r.ok) return r.json().then(function(e){ throw new Error(e.error || 'Erreur ' + r.status); });
        return r.json();
      })
      .then(function(data){
        showMsg('Compteur mis à jour : ' + data.count, '#3ba55d');
        input.value = '';
        loadData(currentDays);
        btn.disabled = false;
      })
      .catch(function(e){ showMsg(e && e.message ? e.message : 'Erreur réseau', '#ed4245'); btn.disabled = false; });
  });

  function showMsg(text, color) {
    var msg = document.getElementById('add-msg');
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = color || '#3ba55d';
    msg.style.display = '';
    setTimeout(function(){ msg.style.display = 'none'; }, 4000);
  }

  // Toggle bot silent
  var silentToggle = document.getElementById('toggle-silent');
  var silentThumb  = document.getElementById('toggle-thumb');
  var silentLabel  = document.getElementById('silent-label');
  var isSilent = false;

  function applySilentUI(silent) {
    isSilent = silent;
    if (silentToggle) silentToggle.style.background = silent ? '#ed4245' : '#3ba55d';
    if (silentThumb) silentThumb.style.left = silent ? '23px' : '3px';
    if (silentLabel) { silentLabel.textContent = silent ? 'Désactivés' : 'Activés'; silentLabel.style.color = silent ? '#ed4245' : '#3ba55d'; }
  }

  fetch('/api/profits-bot-silent')
    .then(function(r){ return r.json(); })
    .then(function(d){ applySilentUI(d.silent); })
    .catch(function(){});

  on('toggle-silent', 'click', function(){
    var newVal = !isSilent;
    fetch('/api/profits-bot-silent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ silent: newVal }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ applySilentUI(d.silent); })
      .catch(function(){});
  });

  loadData(7);
})();
(function(){
  var toggle = document.getElementById('review-toggle');
  var body = document.getElementById('review-body');
  var arrow = document.getElementById('review-arrow');
  var dateInput = document.getElementById('review-date');
  var listEl = document.getElementById('review-list');
  var pager = document.getElementById('review-pager');
  var pageInfo = document.getElementById('review-page-info');
  var prevBtn = document.getElementById('review-prev');
  var nextBtn = document.getElementById('review-next');

  var currentFilter = 'all';
  var currentPage = 1;
  var totalPages = 1;
  var loaded = false;

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  dateInput.value = today();

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtTime(iso){
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
  }

  function renderMessages(data){
    var msgs = data.messages || [];
    if (!msgs.length) {
      listEl.innerHTML = '<div style="color:#a0a0b0;font-size:12px;padding:20px;text-align:center;">Aucun message</div>';
      pager.style.display = 'none';
      return;
    }
    listEl.innerHTML = msgs.map(function(m){
      var statusHtml = m.counted
        ? '<span class="rm-status rm-counted">✅ Compté</span>'
        : '<span class="rm-status rm-ignored">⚪ Ignoré</span>';
      var reasonHtml = '<span class="rm-reason">(' + esc(m.reason || '') + ')</span>';
      var feedbackHtml = '';
      if (m.feedback === 'good') feedbackHtml = '<span class="rm-status rm-feedback-good">feedback: ✅</span>';
      else if (m.feedback === 'bad') feedbackHtml = '<span class="rm-status rm-feedback-bad">feedback: ❌</span>';

      var actionHtml = '';
      if (m.feedback == null) {
        if (m.counted) {
          actionHtml = '<button class="rm-action rm-action-bad" data-id="' + esc(m.id) + '" data-content="' + esc((m.content || '').slice(0, 120)) + '" data-action="block">❌ Pas un profit</button>';
        } else {
          actionHtml = '<button class="rm-action rm-action-good" data-id="' + esc(m.id) + '" data-content="' + esc((m.content || '').slice(0, 120)) + '" data-action="allow">✅ C&#39;est un profit</button>';
        }
      }

      return '<div class="review-msg' + (m.feedback ? ' has-feedback' : '') + '" data-msg-id="' + esc(m.id) + '">'
        + '<div class="rm-header">'
        +   '<span class="rm-ts">' + fmtTime(m.ts) + '</span>'
        +   '<span class="rm-author">' + esc(m.author || '') + '</span>'
        +   statusHtml + ' ' + reasonHtml + ' ' + feedbackHtml
        + '</div>'
        + '<div class="rm-content">' + (m.hasImage && !(m.preview || m.content) ? '<em style="color:#a0a0b0;">[image]</em>' : esc(m.preview || m.content || '')) + '</div>'
        + actionHtml
        + '</div>';
    }).join('');

    totalPages = data.totalPages || Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 50)));
    pager.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfo.textContent = 'Page ' + currentPage + '/' + totalPages + ' (' + data.total + ' messages)';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  function loadMessages(){
    listEl.innerHTML = '<div style="color:#a0a0b0;font-size:12px;">Chargement...</div>';
    var url = '/api/profit-messages?date=' + encodeURIComponent(dateInput.value)
      + '&filter=' + encodeURIComponent(currentFilter)
      + '&page=' + currentPage;
    fetch(url).then(function(r){ return r.json(); }).then(renderMessages).catch(function(){
      listEl.innerHTML = '<div style="color:#f87171;font-size:12px;">Erreur de chargement</div>';
    });
  }

  function renderFilters(pf){
    var blocked = pf.blocked || [];
    var allowed = pf.allowed || [];
    document.getElementById('pf-blocked-count').textContent = blocked.length;
    document.getElementById('pf-allowed-count').textContent = allowed.length;
    var bl = document.getElementById('pf-blocked');
    var al = document.getElementById('pf-allowed');
    bl.innerHTML = blocked.length
      ? blocked.map(function(p){ return '<span class="phrase-tag">' + esc(p) + '<button data-phrase="' + esc(p) + '" data-list="blocked" title="Supprimer">✕</button></span>'; }).join('')
      : '<span style="color:#a0a0b0;font-size:12px;">Aucune</span>';
    al.innerHTML = allowed.length
      ? allowed.map(function(p){ return '<span class="phrase-tag">' + esc(p) + '<button data-phrase="' + esc(p) + '" data-list="allowed" title="Supprimer">✕</button></span>'; }).join('')
      : '<span style="color:#a0a0b0;font-size:12px;">Aucune</span>';
  }

  function loadFilters(){
    fetch('/api/profit-filters').then(function(r){ return r.json(); }).then(renderFilters).catch(function(){});
  }

  toggle.addEventListener('click', function(){
    var open = body.classList.toggle('open');
    arrow.textContent = open ? '▼' : '▶';
    if (open && !loaded) {
      loaded = true;
      loadMessages();
      loadFilters();
    }
  });

  dateInput.addEventListener('change', function(){ if (!loaded) return; currentPage = 1; loadMessages(); });

  document.querySelectorAll('.rf-btn').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.rf-btn').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      currentFilter = b.getAttribute('data-filter');
      currentPage = 1;
      loadMessages();
    });
  });

  prevBtn.addEventListener('click', function(){ if (currentPage > 1) { currentPage--; loadMessages(); } });
  nextBtn.addEventListener('click', function(){ if (currentPage < totalPages) { currentPage++; loadMessages(); } });

  listEl.addEventListener('click', function(ev){
    var btn = ev.target.closest('.rm-action');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var content = btn.getAttribute('data-content');
    var action = btn.getAttribute('data-action');
    btn.disabled = true; btn.textContent = '…';
    fetch('/api/profit-feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ id: id, content: content, action: action })
    }).then(function(r){ return r.json(); }).then(function(data){
      if (data.ok) {
        renderFilters(data.profitFilters);
        loadMessages();
      } else {
        btn.disabled = false;
        btn.textContent = action === 'block' ? '❌ Pas un profit' : "✅ C'est un profit";
      }
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = action === 'block' ? '❌ Pas un profit' : "✅ C'est un profit";
    });
  });

  var phrasesContainer = document.querySelector('.review-phrases');
  phrasesContainer.addEventListener('click', function(ev){
    var btn = ev.target.closest('button[data-phrase]');
    if (!btn) return;
    var phrase = btn.getAttribute('data-phrase');
    var list = btn.getAttribute('data-list');
    fetch('/api/profit-feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ content: phrase, action: 'unblock-' + list })
    }).then(function(r){ return r.json(); }).then(function(data){
      if (data.ok) renderFilters(data.profitFilters);
    }).catch(function(){});
  });
})();
</script>
</div>
</body>
</html>`;
module.exports = { PROFITS_PAGE_HTML };