// ─────────────────────────────────────────────────────────────────────
// pages/dashboard.js — Template HTML de la page /dashboard
// ─────────────────────────────────────────────────────────────────────
// Page de monitoring temps réel : branche SSE (/api/events) pour afficher
// les signaux au fil de l'eau, gestion des filtres custom (allow/block),
// panneau auteurs triable, export CSV, reco feedback.
//
// Seules dépendances externes : COMMON_CSS + sidebarHTML.
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Signal Monitor</title>
<style>
  ${COMMON_CSS}
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on  { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #a0a0b0; }
  #cnt { margin-left: auto; font-size: 12px; color: #a0a0b0; }
  #wrap { padding: 16px 24px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background .15s; }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
  td { padding: 9px 10px; vertical-align: middle; line-height: 1.45; }
  .ts   { color: #a0a0b0; font-size: 12px; white-space: nowrap; }
  .auth { font-weight: 600; color: #D649CC; white-space: nowrap; }
  .chan { color: #a0a0b0; white-space: nowrap; }
  .prev { max-width: 380px; word-break: break-word; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit    { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter  { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .b-convo   { background: #2e2e2e; color: #a0a0b0; border: 1px solid #a0a0b044; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dg { background: #3ba55d; } .dr { background: #ed4245; } .do { background: #faa61a; } .dz { background: #a0a0b0; }
  #empty { padding: 60px 24px; text-align: center; color: #a0a0b0; }
  @keyframes flash { from { background: #2a3040; } to { background: transparent; } }
  tr.new { animation: flash .8s ease-out; }
  tr.learned { opacity: 0.45; }
  tr.unblocked { opacity: 0.45; }
  .btn-fp { background:none; border:1px solid #ed424588; color:#ed4245; border-radius:4px; font-size:11px; padding:1px 6px; cursor:pointer; margin-left:6px; line-height:1.6; }
  .btn-fp:hover { background:#ed424522; }
  .btn-fn { background:none; border:1px solid #3ba55d88; color:#3ba55d; border-radius:4px; font-size:11px; padding:1px 6px; cursor:pointer; margin-left:6px; line-height:1.6; }
  .btn-fn:hover { background:#3ba55d22; }
  #filters-panel { margin-top:24px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; }
  #filters-toggle { width:100%; background:transparent; border:none; color:#fafafa; padding:14px 20px; text-align:left; cursor:pointer; font-size:13px; font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  #filters-toggle:hover { background:rgba(255,255,255,0.03); }
  #filters-body { display:none; padding:16px 20px; background:rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
  #filters-body.open { display:block; }
  .filter-section { margin-bottom:12px; }
  .filter-section h3 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#a0a0b0; margin-bottom:8px; }
  .filter-tag { display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:3px 8px; font-size:12px; margin:3px; max-width:420px; word-break:break-all; }
  .filter-tag button { background:none; border:none; color:#a0a0b0; cursor:pointer; font-size:14px; line-height:1; padding:0; }
  .filter-tag button:hover { color:#ed4245; }
  .reply-badge { display:inline-block; font-size:10px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); color:#a0a0b0; border-radius:4px; padding:2px 6px; margin-right:5px; vertical-align:middle; white-space:nowrap; }
  .reply-badge span { color:#D649CC; font-weight:600; }
  .reply-parent { display:block; font-size:11px; color:#a0a0b0; margin-top:2px; font-style:italic; border-left:2px solid rgba(255,255,255,0.1); padding-left:6px; }
  .ticker-link { color:#a78bfa; text-decoration:none; font-weight:700; background:rgba(139,92,246,0.12); border-radius:4px; padding:1px 5px; transition:background 150ms, color 150ms; }
  .ticker-link:hover { background:rgba(139,92,246,0.25); color:#fafafa; }
  #authors-panel { margin:0 24px 16px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; }
  #authors-toggle { width:100%; background:transparent; border:none; color:#fafafa; padding:14px 20px; text-align:left; cursor:pointer; font-size:13px; font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  #authors-toggle:hover { background:rgba(255,255,255,0.03); }
  #authors-body { display:none; padding:16px 20px; background:rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
  #authors-body.open { display:block; }
  .author-row { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:6px; margin-bottom:4px; background:rgba(255,255,255,0.03); }
  .author-row:hover { background:rgba(255,255,255,0.06); }
  .author-name { font-weight:600; color:#D649CC; font-size:13px; flex:1; }
  .author-status { font-size:11px; color:#a0a0b0; margin:0 10px; white-space:nowrap; }
  .author-status.blocked  { color:#ed4245; }
  .author-status.allowed  { color:#3ba55d; }
  .author-actions { display:flex; gap:5px; }
  .btn-allow-author { background:none; border:1px solid #3ba55d88; color:#3ba55d; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-allow-author:hover { background:#3ba55d22; }
  .btn-block-author { background:none; border:1px solid #ed424588; color:#ed4245; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-block-author:hover { background:#ed424522; }
  .btn-reset-author { background:none; border:1px solid rgba(160,160,176,0.3); color:#a0a0b0; border-radius:6px; font-size:11px; padding:3px 10px; cursor:pointer; }
  .btn-reset-author:hover { background:rgba(160,160,176,0.12); color:#fafafa; }
</style>
</head>
<body>
${sidebarHTML('/dashboard')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Dashboard</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</div>
<div id="wrap">
  <table>
    <thead><tr><th>Time</th><th>Author</th><th>Channel</th><th>Preview</th><th>Result</th></tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div id="empty">No messages yet — waiting for activity on #trading-floor…</div>
</div>

<div id="authors-panel">
  <button id="authors-toggle">
    <span>Gestion des auteurs</span>
    <span id="authors-arrow">▶</span>
  </button>
  <div id="authors-body">
    <div id="authors-list"><span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun auteur vu pour l&#39;instant</span></div>
  </div>
</div>

<div id="filters-panel" style="margin:0 24px 24px">
  <button id="filters-toggle">
    <span>Règles apprises : <span id="rule-count">0</span></span>
    <span id="filters-arrow">▶</span>
  </button>
  <div id="filters-body">
    <div class="filter-section">
      <h3>Phrases bloquées (faux-positifs corrigés) ❌</h3>
      <div id="blocked-tags"><span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune règle pour l&#39;instant</span></div>
    </div>
    <div class="filter-section">
      <h3>Phrases autorisées (faux-négatifs corrigés) ✅</h3>
      <div id="allowed-tags"><span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune règle pour l&#39;instant</span></div>
    </div>
  </div>
</div>
<script>
(function(){
  var tb=document.getElementById('tb'),cnt=document.getElementById('cnt'),
      dot=document.getElementById('dot'),lbl=document.getElementById('lbl'),
      empty=document.getElementById('empty'),total=0;

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmt(iso){ var d=new Date(iso); return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
  function linkifyTickers(html){ return String(html||'').replace(/\\$([A-Z]{1,5})\\b/g, function(_, s){ return '<a href="/ticker/' + s + '" class="ticker-link">$' + s + '</a>'; }); }

  function badge(e){
    var btn='';
    if(e.passed){
      var cls=e.type==='entry'?'b-entry':e.type==='exit'?'b-exit':'b-neutral';
      var dc =e.type==='entry'?'dg':e.type==='exit'?'dr':'dg';
      btn='<button class="btn-fp" data-id="'+esc(e.id)+'" data-content="'+esc(e.content||e.preview)+'" title="Faux-positif: bloquer ce message">❌</button>';
      return '<span class="badge '+cls+'"><span class="dot '+dc+'"></span>'+e.type.toUpperCase()+'</span>'+btn;
    }
    var bc=(e.reason==='Conversational'||e.reason==='No content')?'b-convo':'b-filter';
    var dd=(e.reason==='Conversational'||e.reason==='No content')?'dz':'do';
    btn='<button class="btn-fn" data-id="'+esc(e.id)+'" data-content="'+esc(e.content||e.preview)+'" title="Faux-negatif: autoriser ce message">✅</button>';
    return '<span class="badge '+bc+'"><span class="dot '+dd+'"></span>FILTERED — '+esc(e.reason)+'</span>'+btn;
  }

  function makeRow(e,isNew){
    var tr=document.createElement('tr');
    if(isNew) tr.className='new';
    var previewHtml='';
    if(e.isReply){
      var who=e.parentAuthor?'<span>'+esc(e.parentAuthor)+'</span>':'';
      previewHtml+='<span class="reply-badge">↩ réponse à '+who+'</span>';
    }
    previewHtml+=linkifyTickers(esc(e.preview));
    if(e.isReply && e.parentPreview){
      previewHtml+='<span class="reply-parent">'+linkifyTickers(esc(e.parentPreview))+'</span>';
    }
    tr.innerHTML='<td class="ts">'+fmt(e.ts)+'</td><td class="auth">'+esc(e.author)+'</td>'
      +'<td class="chan">#'+esc(e.channel)+'</td><td class="prev">'+previewHtml+'</td>'
      +'<td>'+badge(e)+'</td>';
    return tr;
  }

  function upd(){ cnt.textContent=total+' message'+(total===1?'':'s'); }

  // Délégation d'événements sur le tableau pour les boutons feedback
  tb.addEventListener('click', function(ev){
    var btn=ev.target.closest('.btn-fp,.btn-fn');
    if(!btn) return;
    var id=btn.getAttribute('data-id');
    var content=btn.getAttribute('data-content');
    var action=btn.classList.contains('btn-fp')?'block':'allow';
    btn.disabled=true; btn.textContent='…';
    fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,content:content,action:action})})
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.ok){
          var tr=btn.closest('tr');
          var badgeEl=tr.querySelector('.badge');
          if(action==='block'){
            tr.classList.add('learned');
            if(badgeEl) badgeEl.outerHTML='<span class="badge b-filter"><span class="dot do"></span>APPRIS: Bloqué</span>';
          } else {
            tr.classList.add('unblocked');
            if(badgeEl) badgeEl.outerHTML='<span class="badge b-entry"><span class="dot dg"></span>DÉBLOQUÉ</span>';
          }
          btn.remove();
          renderFilters(data.customFilters);
        } else { btn.disabled=false; btn.textContent=action==='block'?'❌':'✅'; }
      })
      .catch(function(){ btn.disabled=false; btn.textContent=action==='block'?'❌':'✅'; });
  });

  // Panneau des règles apprises
  function renderFilters(cf){
    var blocked=cf.blocked||[], allowed=cf.allowed||[];
    document.getElementById('rule-count').textContent=blocked.length+allowed.length;
    var bt=document.getElementById('blocked-tags');
    var at=document.getElementById('allowed-tags');
    bt.innerHTML=blocked.length?'':'<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune regle</span>';
    at.innerHTML=allowed.length?'':'<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucune regle</span>';
    blocked.forEach(function(phrase){
      var tag=document.createElement('span'); tag.className='filter-tag';
      tag.innerHTML=esc(phrase)+'<button data-phrase="'+esc(phrase)+'" data-list="blocked" title="Supprimer">✕</button>';
      bt.appendChild(tag);
    });
    allowed.forEach(function(phrase){
      var tag=document.createElement('span'); tag.className='filter-tag';
      tag.innerHTML=esc(phrase)+'<button data-phrase="'+esc(phrase)+'" data-list="allowed" title="Supprimer">✕</button>';
      at.appendChild(tag);
    });
  }

  // Suppression d'une règle apprise
  document.getElementById('filters-body').addEventListener('click', function(ev){
    var btn=ev.target.closest('button[data-phrase]');
    if(!btn) return;
    var phrase=btn.getAttribute('data-phrase');
    var list=btn.getAttribute('data-list');
    fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:phrase,action:'unblock-'+list})})
      .then(function(r){return r.json();}).then(function(data){ if(data.ok) renderFilters(data.customFilters); });
  });

  // Accordéon du panneau
  document.getElementById('filters-toggle').addEventListener('click', function(){
    var body=document.getElementById('filters-body');
    var arrow=document.getElementById('filters-arrow');
    body.classList.toggle('open');
    arrow.textContent=body.classList.contains('open')?'▼':'▶';
  });

  fetch('/api/messages').then(function(r){return r.json();}).then(function(ms){
    ms.forEach(function(e){ tb.appendChild(makeRow(e,false)); total++; });
    upd(); if(total>0) empty.style.display='none';
  }).catch(function(){});

  fetch('/api/custom-filters').then(function(r){return r.json();}).then(function(cf){
    renderFilters(cf);
    renderAuthors(cf);
  }).catch(function(){});

  // ── Gestion des auteurs ───────────────────────────────────────────────────
  function getAuthorsFromLog(){
    var seen={};
    var rows=tb.querySelectorAll('tr');
    rows.forEach(function(tr){
      var a=tr.querySelector('.auth');
      if(a) seen[a.textContent.trim()]=true;
    });
    return Object.keys(seen);
  }

  function renderAuthors(cf){
    var blocked=cf.blockedAuthors||[], allowed=cf.allowedAuthors||[];
    var authors=getAuthorsFromLog();
    // Ajouter les auteurs déjà dans les listes même s'ils ne sont pas dans le log visible
    blocked.forEach(function(a){ if(!authors.includes(a)) authors.push(a); });
    allowed.forEach(function(a){ if(!authors.includes(a)) authors.push(a); });
    var list=document.getElementById('authors-list');
    if(!authors.length){ list.innerHTML='<span style="color:#a0a0b0;font-size:12px;font-style:italic">Aucun auteur vu</span>'; return; }
    list.innerHTML='';
    authors.sort().forEach(function(name){
      var isBlocked=blocked.includes(name), isAllowed=allowed.includes(name);
      var statusCls=isBlocked?'blocked':isAllowed?'allowed':'';
      var statusTxt=isBlocked?'⛔ Bloqué':isAllowed?'✅ Autorisé':'— Neutre';
      var row=document.createElement('div'); row.className='author-row';
      row.innerHTML='<span class="author-name">'+esc(name)+'</span>'
        +'<span class="author-status '+statusCls+'">'+statusTxt+'</span>'
        +'<span class="author-actions">'
        +(isAllowed?'':'<button class="btn-allow-author" data-user="'+esc(name)+'">✅ Autoriser</button>')
        +(isBlocked?'':'<button class="btn-block-author" data-user="'+esc(name)+'">⛔ Bloquer</button>')
        +((isBlocked||isAllowed)?'<button class="btn-reset-author" data-user="'+esc(name)+'" data-list="'+(isBlocked?'blocked':'allowed')+'">✕ Réinitialiser</button>':'')
        +'</span>';
      list.appendChild(row);
    });
  }

  document.getElementById('authors-body').addEventListener('click', function(ev){
    var btn=ev.target.closest('button[data-user]');
    if(!btn) return;
    var username=btn.getAttribute('data-user');
    var action;
    if(btn.classList.contains('btn-allow-author'))  action='allow';
    else if(btn.classList.contains('btn-block-author')) action='block';
    else { var list=btn.getAttribute('data-list'); action='remove-'+list; }
    fetch('/api/author-filter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username,action:action})})
      .then(function(r){return r.json();}).then(function(data){ if(data.ok) renderAuthors(data.customFilters); });
  });

  document.getElementById('authors-toggle').addEventListener('click', function(){
    var body=document.getElementById('authors-body');
    var arrow=document.getElementById('authors-arrow');
    body.classList.toggle('open');
    arrow.textContent=body.classList.contains('open')?'▼':'▶';
  });

  (function connect(){
    var es=new EventSource('/api/events');
    es.onopen=function(){ dot.className='on'; lbl.textContent='Live'; };
    es.onmessage=function(ev){
      var e; try{ e=JSON.parse(ev.data); }catch(_){ return; }
      tb.insertBefore(makeRow(e,true),tb.firstChild);
      total++; upd(); empty.style.display='none';
      // Rafraîchir la liste des auteurs si nouveau auteur
      fetch('/api/custom-filters').then(function(r){return r.json();}).then(renderAuthors).catch(function(){});
    };
    es.onerror=function(){ dot.className='off'; lbl.textContent='Reconnecting…'; };
  })();
})();
</script>
</div>
</body>
</html>`;

module.exports = { DASHBOARD_HTML };
