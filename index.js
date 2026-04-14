const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://discord-trading-bot-production-f159.up.railway.app';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'boom2024';
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

// ─────────────────────────────────────────────────────────────────────
//  Filtre adaptatif — chargement / sauvegarde des règles apprises
// ─────────────────────────────────────────────────────────────────────
const FILTERS_PATH = path.join(__dirname, 'custom-filters.json');
const MESSAGES_PATH = path.join(__dirname, 'messages.json');

function loadCustomFilters() {
  try {
    if (fs.existsSync(FILTERS_PATH)) {
      return JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[filters] Failed to load custom-filters.json:', e.message);
  }
  return { blocked: [], allowed: [], blockedAuthors: [], allowedAuthors: [] };
}

function saveCustomFilters() {
  try {
    fs.writeFileSync(FILTERS_PATH, JSON.stringify(customFilters, null, 2), 'utf8');
  } catch (e) {
    console.error('[filters] Failed to save custom-filters.json:', e.message);
  }
}

let customFilters = loadCustomFilters();
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  SECTION AVATARS — Ajouter ici les avatars personnalisés par Discord username
//  Format : 'NomExact': 'URL_de_l_image'
//  Si un utilisateur n'est pas dans cette liste, ses initiales seront utilisées.
// ─────────────────────────────────────────────────────────────────────
const CUSTOM_AVATARS = {
  'Z': 'https://raw.githubusercontent.com/Misterwill3131/discord-trading-bot/main/z-avatar.jpg',
  // Ajoutez d'autres utilisateurs ici:
  // 'Will': 'https://url-de-l-avatar-de-will.jpg',
  // 'Alex': 'https://url-de-l-avatar-alex.jpg',
};
// ─────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
//  🎨 CUSTOMISATION — Modifie ici l'apparence des images facilement
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // ── Dimensions ──────────────────────────────────────────────────────────
  IMAGE_W:              740,           // Largeur image (px)
  IMAGE_H:              80,            // Hauteur image (px)

  // ── Couleurs fond ────────────────────────────────────────────────────────
  BG_COLOR:             '#1e1f22',     // Fond principal de la carte

  // ── Avatar ───────────────────────────────────────────────────────────────
  AVATAR_SIZE:          44,            // Diamètre du cercle avatar (px)
  AVATAR_COLOR:         '#5865f2',     // Couleur cercle sans photo (blurple)
  AVATAR_TEXT_COLOR:    '#ffffff',     // Couleur initiales

  // ── Badge BOOM ───────────────────────────────────────────────────────────
  BADGE_BG:             '#36393f',     // Fond du badge
  BADGE_BORDER:         '#4f5660',     // Bordure du badge
  BADGE_TEXT:           'BOOM',        // Texte affiché dans le badge
  BADGE_TEXT_COLOR:     '#ffffff',     // Couleur texte badge
  BADGE_FONT_SIZE:      10,            // Taille police badge (px)
  BADGE_HEIGHT:         16,            // Hauteur du badge (px)
  BADGE_RADIUS:         3,             // Arrondi coins badge (px)

  // ── Flamme (badge) ───────────────────────────────────────────────────────
  FLAME_BOTTOM:         '#e65c00',     // Couleur bas flamme (orange foncé)
  FLAME_MID:            '#ff8c00',     // Couleur milieu flamme (orange)
  FLAME_TOP:            '#ffd000',     // Couleur sommet flamme (jaune-or)

  // ── Nom utilisateur ──────────────────────────────────────────────────────
  USERNAME_COLOR:       '#D649CC',     // Couleur du nom (violet/rose)
  USERNAME_FONT_SIZE:   16,            // Taille police nom (px)

  // ── Horodatage ───────────────────────────────────────────────────────────
  TIME_COLOR:           '#80848e',     // Couleur de l'heure
  TIME_FONT_SIZE:       12,            // Taille police heure (px)

  // ── Texte du message ─────────────────────────────────────────────────────
  MESSAGE_COLOR:        '#dcddde',     // Couleur du message
  MESSAGE_FONT_SIZE:    14,            // Taille police message (px)

  // ── Police globale ───────────────────────────────────────────────────────
  FONT:                 'Noto Sans, sans-serif',
};
// ═══════════════════════════════════════════════════════════════════════════
const FONT = CONFIG.FONT; // alias de compatibilité

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Signal Monitor</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on  { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  #wrap { padding: 16px 24px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 10px 10px; border-bottom: 1px solid #3f4147; white-space: nowrap; }
  tbody tr { border-bottom: 1px solid #2b2d31; transition: background .15s; }
  tbody tr:hover { background: #2b2d31; }
  td { padding: 9px 10px; vertical-align: middle; line-height: 1.45; }
  .ts   { color: #80848e; font-size: 12px; white-space: nowrap; }
  .auth { font-weight: 600; color: #D649CC; white-space: nowrap; }
  .chan { color: #80848e; white-space: nowrap; }
  .prev { max-width: 380px; word-break: break-word; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit    { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter  { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .b-convo   { background: #2e2e2e; color: #80848e; border: 1px solid #80848e44; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dg { background: #3ba55d; } .dr { background: #ed4245; } .do { background: #faa61a; } .dz { background: #80848e; }
  #empty { padding: 60px 24px; text-align: center; color: #80848e; }
  @keyframes flash { from { background: #2a3040; } to { background: transparent; } }
  tr.new { animation: flash .8s ease-out; }
  tr.learned { opacity: 0.45; }
  tr.unblocked { opacity: 0.45; }
  .btn-fp { background:none; border:1px solid #ed424588; color:#ed4245; border-radius:4px; font-size:11px; padding:1px 6px; cursor:pointer; margin-left:6px; line-height:1.6; }
  .btn-fp:hover { background:#ed424522; }
  .btn-fn { background:none; border:1px solid #3ba55d88; color:#3ba55d; border-radius:4px; font-size:11px; padding:1px 6px; cursor:pointer; margin-left:6px; line-height:1.6; }
  .btn-fn:hover { background:#3ba55d22; }
  #filters-panel { margin-top:24px; border:1px solid #3f4147; border-radius:6px; overflow:hidden; }
  #filters-toggle { width:100%; background:#2b2d31; border:none; color:#dcddde; padding:10px 16px; text-align:left; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; align-items:center; }
  #filters-toggle:hover { background:#32353b; }
  #filters-body { display:none; padding:12px 16px; background:#1e1f22; }
  #filters-body.open { display:block; }
  .filter-section { margin-bottom:12px; }
  .filter-section h3 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#80848e; margin-bottom:8px; }
  .filter-tag { display:inline-flex; align-items:center; gap:6px; background:#2b2d31; border:1px solid #3f4147; border-radius:4px; padding:3px 8px; font-size:12px; margin:3px; max-width:420px; word-break:break-all; }
  .filter-tag button { background:none; border:none; color:#80848e; cursor:pointer; font-size:14px; line-height:1; padding:0; }
  .filter-tag button:hover { color:#ed4245; }
  .reply-badge { display:inline-block; font-size:10px; background:#2b2d31; border:1px solid #3f4147; color:#80848e; border-radius:3px; padding:1px 5px; margin-right:5px; vertical-align:middle; white-space:nowrap; }
  .reply-badge span { color:#D649CC; font-weight:600; }
  .reply-parent { display:block; font-size:11px; color:#80848e; margin-top:2px; font-style:italic; border-left:2px solid #3f4147; padding-left:6px; }
  #authors-panel { margin:0 24px 16px; border:1px solid #3f4147; border-radius:6px; overflow:hidden; }
  #authors-toggle { width:100%; background:#2b2d31; border:none; color:#dcddde; padding:10px 16px; text-align:left; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; align-items:center; }
  #authors-toggle:hover { background:#32353b; }
  #authors-body { display:none; padding:12px 16px; background:#1e1f22; }
  #authors-body.open { display:block; }
  .author-row { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:4px; margin-bottom:4px; background:#2b2d31; }
  .author-row:hover { background:#32353b; }
  .author-name { font-weight:600; color:#D649CC; font-size:13px; flex:1; }
  .author-status { font-size:11px; color:#80848e; margin:0 10px; white-space:nowrap; }
  .author-status.blocked  { color:#ed4245; }
  .author-status.allowed  { color:#3ba55d; }
  .author-actions { display:flex; gap:5px; }
  .btn-allow-author { background:none; border:1px solid #3ba55d88; color:#3ba55d; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-allow-author:hover { background:#3ba55d22; }
  .btn-block-author { background:none; border:1px solid #ed424588; color:#ed4245; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-block-author:hover { background:#ed424522; }
  .btn-reset-author { background:none; border:1px solid #80848e55; color:#80848e; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-reset-author:hover { background:#80848e22; }
</style>
</head>
<body>
<header>
  <h1>🔥 BOOM</h1>
  <a href="/dashboard" class="nav-link active">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</header>
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
    <div id="authors-list"><span style="color:#80848e;font-size:12px;font-style:italic">Aucun auteur vu pour l&#39;instant</span></div>
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
      <div id="blocked-tags"><span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l&#39;instant</span></div>
    </div>
    <div class="filter-section">
      <h3>Phrases autorisées (faux-négatifs corrigés) ✅</h3>
      <div id="allowed-tags"><span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l&#39;instant</span></div>
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
    previewHtml+=esc(e.preview);
    if(e.isReply && e.parentPreview){
      previewHtml+='<span class="reply-parent">'+esc(e.parentPreview)+'</span>';
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
    bt.innerHTML=blocked.length?'':'<span style="color:#80848e;font-size:12px;font-style:italic">Aucune regle</span>';
    at.innerHTML=allowed.length?'':'<span style="color:#80848e;font-size:12px;font-style:italic">Aucune regle</span>';
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
    if(!authors.length){ list.innerHTML='<span style="color:#80848e;font-size:12px;font-style:italic">Aucun auteur vu</span>'; return; }
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
</body>
</html>`;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(cookieHeader) {
  var result = {};
  if (!cookieHeader) return result;
  cookieHeader.split(';').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    var key = pair.slice(0, idx).trim();
    var val = pair.slice(idx + 1).trim();
    result[key] = decodeURIComponent(val);
  });
  return result;
}

function requireAuth(req, res, next) {
  var cookies = parseCookies(req.headers.cookie);
  if (cookies['boom_session'] === SESSION_TOKEN) return next();
  res.redirect('/login');
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 36px 40px; width: 340px; }
  h1 { font-size: 22px; font-weight: 700; color: #fff; text-align: center; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #80848e; text-align: center; margin-bottom: 28px; }
  label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #b5bac1; margin-bottom: 6px; }
  input[type=password] { width: 100%; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 10px 12px; font-size: 14px; outline: none; margin-bottom: 20px; }
  input[type=password]:focus { border-color: #5865f2; }
  button { width: 100%; background: #5865f2; border: none; border-radius: 4px; color: #fff; font-size: 15px; font-weight: 600; padding: 11px; cursor: pointer; }
  button:hover { background: #4752c4; }
  .err { background: #3a1e1e; border: 1px solid #ed424544; color: #ed4245; border-radius: 4px; padding: 8px 12px; font-size: 13px; margin-bottom: 16px; display: none; }
  .err.show { display: block; }
</style>
</head>
<body>
<div class="card">
  <h1>&#x1F525; BOOM</h1>
  <p class="sub">Signal Monitor Dashboard</p>
  <form method="POST" action="/login">
    <div id="err" class="err">Mot de passe incorrect</div>
    <label for="pw">Mot de passe</label>
    <input type="password" id="pw" name="password" autofocus placeholder="••••••••">
    <button type="submit">Se connecter</button>
  </form>
</div>
</body>
</html>`;

app.get('/login', (req, res) => {
  var cookies = parseCookies(req.headers.cookie);
  if (cookies['boom_session'] === SESSION_TOKEN) return res.redirect('/dashboard');
  res.set('Content-Type', 'text/html');
  res.send(LOGIN_HTML);
});

app.post('/login', (req, res) => {
  var pw = (req.body && req.body.password) || '';
  if (pw === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', 'boom_session=' + SESSION_TOKEN + '; Path=/; HttpOnly');
    return res.redirect('/dashboard');
  }
  res.set('Content-Type', 'text/html');
  var html = LOGIN_HTML.replace('id="err" class="err"', 'id="err" class="err show"');
  res.send(html);
});

let lastImageBuffer = null;
let lastImageId = null;

const MAX_LOG = 200;
const messageLog = (function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_PATH)) {
      const data = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
      if (Array.isArray(data)) return data.slice(0, MAX_LOG);
    }
  } catch (e) {
    console.error('[messages] Failed to load messages.json:', e.message);
  }
  return [];
})();
const sseClients = [];

function logEvent(author, channel, content, signalType, reason, extra) {
  const entry = {
    id:      Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ts:      new Date().toISOString(),
    author,
    channel,
    content: content || '',
    preview: content && content.length > 120 ? content.slice(0, 120) + '…' : (content || ''),
    passed:  signalType !== null,
    type:    signalType,
    reason,
    confidence: extra?.confidence != null ? extra.confidence : null,
    ticker:     extra?.ticker     != null ? extra.ticker     : null,
    isReply:       extra?.isReply || false,
    parentPreview: extra?.parentPreview || null,
    parentAuthor:  extra?.parentAuthor || null,
  };
  messageLog.unshift(entry);
  if (messageLog.length > MAX_LOG) messageLog.pop();
  try { fs.writeFileSync(MESSAGES_PATH, JSON.stringify(messageLog, null, 2), 'utf8'); } catch (_) {}
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].res.write(payload); } catch (_) { sseClients.splice(i, 1); }
  }
}


app.get('/image/latest', (req, res) => {
  if (!lastImageBuffer) return res.status(404).json({ error: 'No image available' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-cache');
  res.send(lastImageBuffer);
});

app.options('/generate-and-store', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/generate-and-store', (req, res) => {
  const { author = 'Will', content = '', timestamp = new Date().toISOString() } = req.body;
  generateImage(author, content, timestamp).then(imgBuf => {
    lastImageBuffer = imgBuf;
    lastImageId = Date.now();
    const imageUrl = RAILWAY_URL + '/image/latest?t=' + lastImageId;
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ image_url: imageUrl });
  }).catch(err => res.status(500).json({ error: err.message }));
});

app.post('/generate', (req, res) => {
  const { username = 'Unknown', content = '', timestamp = new Date().toISOString() } = req.body;
  generateImage(username, content, timestamp).then(imgBuf => {
    res.set('Content-Type', 'image/png');
    res.send(imgBuf);
  }).catch(err => res.status(500).json({ error: err.message }));
});

app.get('/health', async (req, res) => {
  // Envoie un signal test à Make automatiquement (sauf si ?send=0)
  const autoSend = req.query.send !== '0';

  let makeStatus = null;
  let imageUrl = null;
  let makeError = null;

  if (autoSend && MAKE_WEBHOOK_URL) {
    try {
      const testAuthor  = req.query.author  || 'Will';
      const testContent = req.query.message || '$TSLA 150.00-155.00';
      const testSignal  = req.query.signal  || 'entry';
      const buf = await generateImage(testAuthor, testContent, new Date().toISOString());
      lastImageBuffer = buf;
      lastImageId = Date.now();
      imageUrl = RAILWAY_URL + '/image/latest?id=' + lastImageId;

      const makeRes = await fetch(MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content:     enrichContent(testContent),
          author:      testAuthor,
          channel:     'trading-floor',
          signal_type: testSignal,
          timestamp:   new Date().toISOString(),
          image_url:   imageUrl,
                        ticker: extractTicker(testContent),
          ...extractPrices(testContent)
        }),
      });
      makeStatus = makeRes.status;
      console.log('[/health] Signal envoye a Make, status:', makeStatus);
    } catch (err) {
      makeError = err.message;
      console.error('[/health] Erreur Make:', err.message);
    }
  }

  res.json({
    status:      'online',
    make_sent:   autoSend && !!MAKE_WEBHOOK_URL,
    make_status: makeStatus,
    make_error:  makeError,
    image_url:   imageUrl,
    timestamp:   new Date().toISOString(),
    tip:         'Params optionnels: ?author=Z&message=$AAPL+180&signal=entry | ?send=0 pour desactiver'
  });
});

app.get('/api/messages', requireAuth, (req, res) => {
  let msgs = messageLog;
  if (req.query.from) {
    const from = new Date(req.query.from).getTime();
    if (!isNaN(from)) msgs = msgs.filter(m => new Date(m.ts).getTime() >= from);
  }
  if (req.query.to) {
    const to = new Date(req.query.to).getTime();
    if (!isNaN(to)) msgs = msgs.filter(m => new Date(m.ts).getTime() <= to);
  }
  res.json(msgs);
});

app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const client = { res };
  sseClients.push(client);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    const i = sseClients.indexOf(client);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

app.get('/api/custom-filters', requireAuth, (req, res) => {
  res.json(customFilters);
});

app.post('/api/feedback', requireAuth, (req, res) => {
  const { id, content, action } = req.body || {};
  const validActions = ['block', 'allow', 'unblock-blocked', 'unblock-allowed'];
  if (!content || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }
  const phrase = content.trim();
  if (action === 'block') {
    if (!customFilters.blocked.includes(phrase)) customFilters.blocked.push(phrase);
  } else if (action === 'allow') {
    if (!customFilters.allowed.includes(phrase)) customFilters.allowed.push(phrase);
  } else if (action === 'unblock-blocked') {
    customFilters.blocked = customFilters.blocked.filter(p => p !== phrase);
  } else if (action === 'unblock-allowed') {
    customFilters.allowed = customFilters.allowed.filter(p => p !== phrase);
  }
  saveCustomFilters();
  console.log('[feedback] action=' + action + ' phrase=' + phrase.substring(0, 60));
  res.json({ ok: true, customFilters });
});

app.post('/api/author-filter', requireAuth, (req, res) => {
  const { username, action } = req.body || {};
  const validActions = ['block', 'allow', 'remove-blocked', 'remove-allowed'];
  if (!username || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }
  if (!customFilters.blockedAuthors)  customFilters.blockedAuthors  = [];
  if (!customFilters.allowedAuthors) customFilters.allowedAuthors = [];
  const u = username.trim();
  if (action === 'block') {
    customFilters.allowedAuthors  = customFilters.allowedAuthors.filter(a => a !== u);
    if (!customFilters.blockedAuthors.includes(u)) customFilters.blockedAuthors.push(u);
  } else if (action === 'allow') {
    customFilters.blockedAuthors = customFilters.blockedAuthors.filter(a => a !== u);
    if (!customFilters.allowedAuthors.includes(u)) customFilters.allowedAuthors.push(u);
  } else if (action === 'remove-blocked') {
    customFilters.blockedAuthors = customFilters.blockedAuthors.filter(a => a !== u);
  } else if (action === 'remove-allowed') {
    customFilters.allowedAuthors = customFilters.allowedAuthors.filter(a => a !== u);
  }
  saveCustomFilters();
  console.log('[author-filter] action=' + action + ' user=' + u);
  res.json({ ok: true, customFilters });
});

app.get('/api/export-csv', requireAuth, (req, res) => {
  function csvField(val) {
    var s = String(val == null ? '' : val);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  var msgs = messageLog;
  if (req.query.from) {
    var from = new Date(req.query.from).getTime();
    if (!isNaN(from)) msgs = msgs.filter(function(m) { return new Date(m.ts).getTime() >= from; });
  }
  if (req.query.to) {
    var to = new Date(req.query.to).getTime();
    if (!isNaN(to)) msgs = msgs.filter(function(m) { return new Date(m.ts).getTime() <= to; });
  }
  var dateStr = new Date().toISOString().slice(0, 10);
  var rows = ['timestamp,author,channel,ticker,type,reason,confidence,preview'];
  msgs.forEach(function(m) {
    rows.push([
      csvField(m.ts),
      csvField(m.author),
      csvField(m.channel),
      csvField(m.ticker || ''),
      csvField(m.type || 'filtered'),
      csvField(m.reason),
      csvField(m.confidence != null ? m.confidence : ''),
      csvField(m.preview)
    ].join(','));
  });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="boom-signals-' + dateStr + '.csv"');
  res.send(rows.join('\n'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(DASHBOARD_HTML);
});

// ─────────────────────────────────────────────────────────────────────
//  Interface Generateur d'Images
// ─────────────────────────────────────────────────────────────────────
const IMAGE_GEN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Image Generator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  .main { display: grid; grid-template-columns: 360px 1fr; gap: 0; height: calc(100vh - 53px); }
  .sidebar { background: #2b2d31; border-right: 1px solid #3f4147; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
  .content { padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 10px; }
  label { display: block; font-size: 13px; color: #b5bac1; margin-bottom: 6px; }
  input[type=text], textarea, input[type=time] {
    width: 100%; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px;
    color: #dcddde; padding: 8px 10px; font-size: 14px; font-family: inherit;
    outline: none; transition: border-color .15s;
  }
  input[type=text]:focus, textarea:focus, input[type=time]:focus { border-color: #5865f2; }
  textarea { resize: vertical; min-height: 90px; }
  .field { margin-bottom: 14px; }
  .row { display: flex; gap: 10px; }
  .row .field { flex: 1; }
  .hint { font-size: 11px; color: #80848e; margin-top: 4px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; transition: filter .15s; }
  .btn:hover { filter: brightness(1.1); }
  .btn:active { filter: brightness(0.9); }
  .btn-primary { background: #5865f2; color: #fff; width: 100%; justify-content: center; }
  .btn-success { background: #3ba55d; color: #fff; }
  .btn-secondary { background: #4f5660; color: #fff; }
  .preview-box { background: #111214; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 140px; justify-content: center; }
  .preview-box img { max-width: 100%; border-radius: 6px; display: block; box-shadow: 0 4px 24px rgba(0,0,0,0.6); image-rendering: crisp-edges; }
  .preview-placeholder { color: #80848e; font-size: 13px; width: 100%; text-align: center; padding: 30px 0; }
  #preview-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .history-grid { display: flex; flex-direction: column; gap: 10px; }
  .history-item { background: #111214; border: 1px solid #3f4147; border-radius: 6px; overflow: hidden; }
  .history-item img { width: 100%; display: block; }
  .history-meta { padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; }
  .history-meta span { font-size: 11px; color: #80848e; }
  .history-meta button { background: none; border: 1px solid #3f4147; color: #80848e; border-radius: 3px; font-size: 11px; padding: 2px 8px; cursor: pointer; }
  .history-meta button:hover { background: #2b2d31; color: #dcddde; }
  .avatar-list { display: flex; flex-direction: column; gap: 8px; }
  .avatar-item { display: flex; align-items: center; gap: 10px; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 8px 10px; }
  .avatar-circle { width: 32px; height: 32px; border-radius: 50%; background: #5865f2; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; overflow: hidden; }
  .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-name { flex: 1; font-size: 13px; font-weight: 600; color: #D649CC; }
  .avatar-url { font-size: 11px; color: #80848e; word-break: break-all; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #ffffff44; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-bar { padding: 8px 12px; border-radius: 4px; font-size: 13px; display: none; }
  .status-bar.ok { background: #1e3a2f; border: 1px solid #3ba55d44; color: #3ba55d; display: block; }
  .status-bar.err { background: #3a1e1e; border: 1px solid #ed424544; color: #ed4245; display: block; }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #3f4147; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>🔥 BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link active">Image Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
</header>

<div class="main">
  <!-- Panneau gauche : formulaire -->
  <div class="sidebar">
    <div>
      <div class="section-title">Parametres de l'image</div>

      <div class="field">
        <label for="inp-author">Auteur</label>
        <input type="text" id="inp-author" placeholder="ex: Z" value="Z" autocomplete="off">
        <div class="hint">Doit correspondre exactement au username Discord pour l'avatar</div>
      </div>

      <div class="field">
        <label for="inp-msg">Message</label>
        <textarea id="inp-msg" placeholder="ex: $TSLA 150.00-155.00 entry long&#10;target 160 stop 148">$TSLA 150.00-155.00 entry long</textarea>
      </div>

      <div class="row">
        <div class="field">
          <label for="inp-time">Heure</label>
          <input type="time" id="inp-time" value="">
        </div>
        <div class="field">
          <label>&nbsp;</label>
          <button class="btn btn-secondary" id="btn-now" style="width:100%;justify-content:center;">Maintenant</button>
        </div>
      </div>

      <div id="status-msg" class="status-bar"></div>

      <button class="btn btn-primary" id="btn-generate" style="margin-top:8px;">
        <span id="gen-icon">⚡</span> Generer l'image
      </button>
    </div>

    <!-- Avatars connus -->
    <div>
      <div class="section-title">Avatars personnalises</div>
      <div class="avatar-list" id="avatar-list">
        <div style="color:#80848e;font-size:12px;">Chargement...</div>
      </div>
    </div>
  </div>

  <!-- Panneau droit : apercu + historique -->
  <div class="content">
    <div>
      <div class="section-title">Apercu</div>
      <div class="preview-box" id="preview-box">
        <div class="preview-placeholder" id="preview-placeholder">Cliquez sur "Generer l'image" pour voir un apercu</div>
        <img id="preview-img" style="display:none;" alt="apercu">
      </div>
      <div id="preview-actions" style="margin-top:12px; display:none;">
        <button class="btn btn-success" id="btn-download">⬇ Telecharger PNG</button>
        <button class="btn btn-secondary" id="btn-copy-url">🔗 Copier URL</button>
      </div>
    </div>

    <div>
      <div class="section-title">Historique de session <span id="hist-count" style="font-weight:400;"></span></div>
      <div class="history-grid" id="history-grid">
        <div style="color:#80848e;font-size:12px;">Aucune image generee dans cette session.</div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  var timeNow = function() {
    var d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  };
  document.getElementById('inp-time').value = timeNow();
  document.getElementById('btn-now').addEventListener('click', function() {
    document.getElementById('inp-time').value = timeNow();
  });

  var history = [];
  var lastUrl = null;

  function showStatus(msg, type) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = 'status-bar ' + type;
    if (type === 'ok') { setTimeout(function() { el.className = 'status-bar'; }, 6000); }
  }

  function buildPreviewUrl(author, message, timeVal) {
    var ts = '';
    if (timeVal) {
      var parts = timeVal.split(':');
      var d = new Date();
      d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
      ts = d.toISOString();
    }
    return '/preview?author=' + encodeURIComponent(author) + '&message=' + encodeURIComponent(message) + (ts ? '&ts=' + encodeURIComponent(ts) : '');
  }

  document.getElementById('btn-generate').addEventListener('click', function() {
    var author = document.getElementById('inp-author').value.trim() || 'Z';
    var msg = document.getElementById('inp-msg').value.trim();
    var timeVal = document.getElementById('inp-time').value;
    if (!msg) { showStatus('Le message ne peut pas etre vide.', 'err'); return; }

    var btn = document.getElementById('btn-generate');
    var icon = document.getElementById('gen-icon');
    btn.disabled = true;
    icon.innerHTML = '<span class="spinner"></span>';

    var url = buildPreviewUrl(author, msg, timeVal);
    var img = document.getElementById('preview-img');
    var placeholder = document.getElementById('preview-placeholder');
    var actions = document.getElementById('preview-actions');

    var tempImg = new Image();
    tempImg.onload = function() {
      img.src = url + '&nocache=' + Date.now();
      img.style.display = 'block';
      placeholder.style.display = 'none';
      actions.style.display = 'flex';
      lastUrl = url;
      btn.disabled = false;
      icon.textContent = '\u26a1';
      showStatus('Image generee avec succes !', 'ok');
      addHistory(author, msg, timeVal, url);
    };
    tempImg.onerror = function() {
      btn.disabled = false;
      icon.textContent = '\u26a1';
      showStatus('Erreur lors de la generation de l image.', 'err');
    };
    tempImg.src = url + '&nocache=' + Date.now();
  });

  document.getElementById('btn-download').addEventListener('click', function() {
    if (!lastUrl) return;
    fetch(lastUrl + '&nocache=' + Date.now())
      .then(function(r) { return r.blob(); })
      .then(function(blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        var author = document.getElementById('inp-author').value.trim() || 'signal';
        a.download = 'boom-signal-' + author + '-' + Date.now() + '.png';
        a.click();
      })
      .catch(function() { showStatus('Erreur lors du telechargement.', 'err'); });
  });

  document.getElementById('btn-copy-url').addEventListener('click', function() {
    if (!lastUrl) return;
    var fullUrl = window.location.origin + lastUrl;
    navigator.clipboard.writeText(fullUrl).then(function() {
      showStatus('URL copiee dans le presse-papier !', 'ok');
    });
  });

  function addHistory(author, msg, timeVal, url) {
    var entry = { author: author, msg: msg, timeVal: timeVal, url: url, ts: new Date().toLocaleTimeString('fr-FR') };
    history.unshift(entry);
    if (history.length > 20) history.pop();
    renderHistory();
  }

  function renderHistory() {
    var grid = document.getElementById('history-grid');
    var cnt = document.getElementById('hist-count');
    if (history.length === 0) {
      grid.innerHTML = '<div style="color:#80848e;font-size:12px;">Aucune image generee dans cette session.</div>';
      cnt.textContent = '';
      return;
    }
    cnt.textContent = '(' + history.length + ')';
    grid.innerHTML = '';
    history.forEach(function(e, i) {
      var item = document.createElement('div');
      item.className = 'history-item';
      var imgEl = document.createElement('img');
      imgEl.src = e.url + '&nocache=' + (i + '_' + Date.now());
      imgEl.alt = e.author;
      imgEl.loading = 'lazy';
      var meta = document.createElement('div');
      meta.className = 'history-meta';
      meta.innerHTML = '<span>' + e.ts + ' — ' + escHtml(e.author) + '</span>';
      var dlBtn = document.createElement('button');
      dlBtn.textContent = 'Telecharger';
      dlBtn.addEventListener('click', (function(eu, ea) {
        return function() {
          fetch(eu + '&nocache=' + Date.now()).then(function(r) { return r.blob(); }).then(function(blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'boom-' + ea + '-' + Date.now() + '.png';
            a.click();
          });
        };
      })(e.url, e.author));
      meta.appendChild(dlBtn);
      item.appendChild(imgEl);
      item.appendChild(meta);
      grid.appendChild(item);
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Charger avatars connus depuis /api/custom-filters (ou affichage statique)
  fetch('/api/custom-filters')
    .then(function(r) { return r.json(); })
    .then(function() {
      // On affiche les auteurs vus dans le log
      return fetch('/api/messages');
    })
    .then(function(r) { return r.json(); })
    .then(function(msgs) {
      var seen = {};
      msgs.forEach(function(m) { if (m.author) seen[m.author] = true; });
      var authors = Object.keys(seen);
      var list = document.getElementById('avatar-list');
      if (authors.length === 0) {
        list.innerHTML = '<div style="color:#80848e;font-size:12px;">Aucun auteur vu pour l instant.</div>';
        return;
      }
      list.innerHTML = '';
      authors.forEach(function(a) {
        var item = document.createElement('div');
        item.className = 'avatar-item';
        var useBtn = document.createElement('button');
        useBtn.textContent = 'Utiliser';
        useBtn.style.cssText = 'background:#5865f222;border:1px solid #5865f244;color:#5865f2;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;';
        useBtn.addEventListener('click', (function(name){ return function(){ document.getElementById('inp-author').value = name; }; })(a));
        item.innerHTML = '<div class="avatar-circle">' + escHtml(a.slice(0,2).toUpperCase()) + '</div>' +
          '<div style="flex:1"><div class="avatar-name">' + escHtml(a) + '</div></div>';
        item.appendChild(useBtn);
        list.appendChild(item);
      });
    })
    .catch(function() {
      document.getElementById('avatar-list').innerHTML = '<div style="color:#80848e;font-size:12px;">Impossible de charger les auteurs.</div>';
    });
})();
</script>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────
//  Page Messages Bruts — tous les messages Discord sans filtre
// ─────────────────────────────────────────────────────────────────────
const RAW_MESSAGES_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Messages Bruts</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
  #wrap { padding: 16px 24px; }
  #search-bar { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; }
  #search-input { flex: 1; background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 7px 12px; font-size: 13px; outline: none; }
  #search-input:focus { border-color: #5865f2; }
  #search-input::placeholder { color: #80848e; }
  #filter-author { background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 7px 10px; font-size: 13px; outline: none; cursor: pointer; }
  #filter-author:focus { border-color: #5865f2; }
  .msg-card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
  .msg-card.new { animation: flash .8s ease-out; }
  .msg-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .msg-author { font-weight: 700; color: #D649CC; font-size: 14px; }
  .msg-channel { font-size: 12px; color: #80848e; }
  .msg-time { font-size: 12px; color: #80848e; margin-left: auto; }
  .msg-body { font-size: 14px; color: #dcddde; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .msg-reply { font-size: 12px; color: #80848e; border-left: 2px solid #3f4147; padding-left: 8px; margin-bottom: 4px; font-style: italic; }
  .badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit    { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter  { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .b-convo   { background: #2e2e2e; color: #80848e; border: 1px solid #80848e44; }
  #empty { padding: 60px 24px; text-align: center; color: #80848e; }
  @keyframes flash { from { background: #2a3040; } to { background: #2b2d31; } }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #3f4147; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>🔥 BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link active">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</header>
<div id="wrap">
  <div id="search-bar">
    <input type="text" id="search-input" placeholder="Rechercher dans les messages...">
    <select id="filter-author"><option value="">Tous les auteurs</option></select>
  </div>
  <div id="msg-list"><div id="empty">Aucun message pour l instant...</div></div>
</div>
<script>
(function(){
  var dot = document.getElementById('dot');
  var lbl = document.getElementById('lbl');
  var cnt = document.getElementById('cnt');
  var list = document.getElementById('msg-list');
  var searchInput = document.getElementById('search-input');
  var filterAuthor = document.getElementById('filter-author');

  var allMessages = [];
  var authorsSet = {};

  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function badgeClass(e) {
    if (e.passed) {
      if (e.type === 'entry') return 'b-entry';
      if (e.type === 'exit') return 'b-exit';
      return 'b-neutral';
    }
    if (e.reason === 'Conversational' || e.reason === 'No content') return 'b-convo';
    return 'b-filter';
  }

  function badgeLabel(e) {
    if (e.passed) return e.type ? e.type.toUpperCase() : 'ACCEPTE';
    return 'FILTRE — ' + (e.reason || '');
  }

  function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function buildCard(e, isNew) {
    var card = document.createElement('div');
    card.className = 'msg-card' + (isNew ? ' new' : '');
    card.dataset.id = e.id;
    card.dataset.author = e.author || '';
    card.dataset.content = (e.content || '').toLowerCase();

    var header = '<div class="msg-header">' +
      '<span class="msg-author">' + escHtml(e.author) + '</span>' +
      '<span class="msg-channel">#' + escHtml(e.channel) + '</span>' +
      '<span class="badge ' + badgeClass(e) + '">' + escHtml(badgeLabel(e)) + '</span>' +
      '<span class="msg-time">' + fmtTime(e.ts) + '</span>' +
      '</div>';

    var reply = '';
    if (e.isReply && e.parentPreview) {
      reply = '<div class="msg-reply">Reponse a <strong>' + escHtml(e.parentAuthor || '?') + '</strong> : ' + escHtml(e.parentPreview) + '</div>';
    }

    var body = '<div class="msg-body">' + escHtml(e.content || '') + '</div>';

    card.innerHTML = header + reply + body;
    return card;
  }

  function applyFilters() {
    var search = searchInput.value.toLowerCase();
    var author = filterAuthor.value;
    var cards = list.querySelectorAll('.msg-card');
    var visible = 0;
    cards.forEach(function(c) {
      var matchAuthor = !author || c.dataset.author === author;
      var matchSearch = !search || c.dataset.content.includes(search);
      c.style.display = (matchAuthor && matchSearch) ? '' : 'none';
      if (matchAuthor && matchSearch) visible++;
    });
    cnt.textContent = visible + ' message' + (visible > 1 ? 's' : '');
  }

  function addAuthorOption(name) {
    if (authorsSet[name]) return;
    authorsSet[name] = true;
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    filterAuthor.appendChild(opt);
  }

  function prependCard(e, isNew) {
    var empty = document.getElementById('empty');
    if (empty) empty.remove();
    var card = buildCard(e, isNew);
    list.insertBefore(card, list.firstChild);
    addAuthorOption(e.author || '');
    applyFilters();
  }

  // Charger les messages existants
  fetch('/api/messages')
    .then(function(r) { return r.json(); })
    .then(function(msgs) {
      allMessages = msgs;
      // msgs est newest-first, on les affiche dans l ordre (newest en haut)
      msgs.forEach(function(m) {
        var empty = document.getElementById('empty');
        if (empty) empty.remove();
        var card = buildCard(m, false);
        list.appendChild(card);
        addAuthorOption(m.author || '');
      });
      cnt.textContent = msgs.length + ' message' + (msgs.length > 1 ? 's' : '');
    })
    .catch(function() { lbl.textContent = 'Erreur chargement'; });

  // SSE pour les nouveaux messages en temps reel
  var es = new EventSource('/api/events');
  es.onopen = function() { dot.className = 'on'; lbl.textContent = 'Live'; };
  es.onerror = function() { dot.className = 'off'; lbl.textContent = 'Deconnecte'; };
  es.onmessage = function(ev) {
    try {
      var e = JSON.parse(ev.data);
      prependCard(e, true);
    } catch(_) {}
  };

  searchInput.addEventListener('input', applyFilters);
  filterAuthor.addEventListener('change', applyFilters);
})();
</script>
</body>
</html>`;

app.get('/raw-messages', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(RAW_MESSAGES_HTML);
});

app.get('/image-generator', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(IMAGE_GEN_HTML);
});

// Mise a jour de /preview pour supporter le parametre ?ts=
app.get('/preview', async (req, res) => {
  try {
    const author = req.query.author || 'Z';
    const message = req.query.message || '$TSLA 150.00-155.00';
    const ts = req.query.ts || new Date().toISOString();
    const buf = await generateImage(author, message, ts);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  Page Statistiques /stats
// ─────────────────────────────────────────────────────────────────────
const STATS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Stats</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  #wrap { padding: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-full { grid-column: 1 / -1; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 16px; }
  .big-number { font-size: 52px; font-weight: 800; color: #fff; line-height: 1; }
  .big-sub { font-size: 13px; color: #80848e; margin-top: 6px; }
  .progress-bar { height: 10px; border-radius: 5px; background: #3f4147; margin-top: 14px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 5px; transition: width .4s; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-label { width: 80px; font-size: 12px; color: #b5bac1; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { flex: 1; height: 14px; background: #3f4147; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width .4s; }
  .bar-val { width: 30px; font-size: 12px; color: #80848e; text-align: left; }
  .badge-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-badge { display: flex; flex-direction: column; align-items: center; padding: 14px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; min-width: 80px; }
  .stat-badge .num { font-size: 28px; font-weight: 800; }
  .b-entry { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-top: 10px; }
  .hour-col { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .hour-bar { width: 100%; border-radius: 2px 2px 0 0; min-height: 1px; }
  .hour-lbl { font-size: 9px; color: #80848e; margin-top: 3px; }
  .btn-refresh { background: #5865f222; border: 1px solid #5865f244; color: #5865f2; border-radius: 4px; padding: 6px 16px; cursor: pointer; font-size: 13px; font-weight: 600; margin-left: auto; }
  .btn-refresh:hover { background: #5865f244; }
  @media (max-width: 700px) { #wrap { grid-template-columns: 1fr; } .card-full { grid-column: 1; } }
</style>
</head>
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/stats" class="nav-link active">Stats</a>
  <button class="btn-refresh" id="btn-refresh">Actualiser</button>
</header>
<div id="wrap">
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
  <div class="card">
    <div class="card-title">Top 5 auteurs</div>
    <div id="top-authors"></div>
  </div>
  <div class="card">
    <div class="card-title">Top 5 tickers</div>
    <div id="top-tickers"></div>
  </div>
  <div class="card card-full">
    <div class="card-title">Volume par heure (24h)</div>
    <div class="hour-chart" id="hour-chart"></div>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderBars(containerId, data, color) {
    var container = document.getElementById(containerId);
    if (!data.length) { container.innerHTML = '<span style="color:#80848e;font-size:12px;">Aucune donnee</span>'; return; }
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

  function loadStats() {
    fetch('/api/messages')
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
        msgs.forEach(function(m){ if(m.author) authorMap[m.author] = (authorMap[m.author]||0) + 1; });
        var topAuthors = Object.keys(authorMap).map(function(k){ return [k, authorMap[k]]; })
          .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);
        renderBars('top-authors', topAuthors, '#D649CC');

        var tickerMap = {};
        msgs.forEach(function(m){ if(m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker]||0) + 1; });
        var topTickers = Object.keys(tickerMap).map(function(k){ return [k, tickerMap[k]]; })
          .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);
        renderBars('top-tickers', topTickers, '#5865f2');

        var hourBuckets = new Array(24).fill(0);
        var hourAccepted = new Array(24).fill(0);
        msgs.forEach(function(m){
          var h = new Date(m.ts).getHours();
          hourBuckets[h]++;
          if(m.passed) hourAccepted[h]++;
        });
        var maxH = Math.max.apply(null, hourBuckets) || 1;
        var chart = document.getElementById('hour-chart');
        chart.innerHTML = '';
        for (var i = 0; i < 24; i++) {
          var v = hourBuckets[i];
          var heightPct = Math.round(v / maxH * 100);
          var accRate = v ? hourAccepted[i] / v : 0;
          var barColor = accRate >= 0.5 ? '#3ba55d' : accRate >= 0.25 ? '#faa61a' : '#ed4245';
          if (v === 0) barColor = '#3f4147';
          var col = document.createElement('div');
          col.className = 'hour-col';
          col.innerHTML = '<div class="hour-bar" title="' + v + ' msg" style="height:' + heightPct + '%;background:' + barColor + ';"></div>'
            + '<span class="hour-lbl">' + String(i).padStart(2,'0') + '</span>';
          chart.appendChild(col);
        }
      })
      .catch(function(){ document.getElementById('accept-sub').textContent = 'Erreur de chargement'; });
  }

  loadStats();
  document.getElementById('btn-refresh').addEventListener('click', loadStats);
})();
</script>
</body>
</html>`;

app.get('/stats', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(STATS_HTML);
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));

async function generateImage(author, content, timestamp) {
  const W = 740;
  const PADDING_V = 18;
  const PADDING_L = 16;
  const AVATAR_D = 40;
  const AVATAR_X = PADDING_L;
  const CONTENT_X = PADDING_L + AVATAR_D + 16;
  const MAX_TW = W - CONTENT_X - PADDING_L;

  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px ' + FONT;
  const lines = wrapText(tmpCtx, content, MAX_TW);

  const LINE_H = 22;
  const NAME_H = 20;
  const H = PADDING_V + NAME_H + (lines.length * LINE_H) + PADDING_V + 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = CONFIG.BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  // ── Avatar ──
  const avatarCX = AVATAR_X + AVATAR_D / 2;
  const avatarCY = PADDING_V + NAME_H / 2 + 2;
  const avatarR = AVATAR_D / 2;

  // Clip circulaire pour l'avatar
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const customAvatarUrl = CUSTOM_AVATARS[author];
  if (customAvatarUrl) {
    // Charger et dessiner la photo de profil personnalisée
    try {
      const img = await loadImage(customAvatarUrl);
      // Dessiner l'image dans le cercle en gardant le ratio (cover)
      const size = AVATAR_D;
      const imgRatio = img.width / img.height;
      let drawW = size, drawH = size;
      let drawX = avatarCX - avatarR, drawY = avatarCY - avatarR;
      if (imgRatio > 1) {
        drawW = size * imgRatio;
        drawX = avatarCX - drawW / 2;
      } else {
        drawH = size / imgRatio;
        drawY = avatarCY - drawH / 2;
      }
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } catch (e) {
      // Fallback: cercle blurple avec initiales
      ctx.fillStyle = CONFIG.AVATAR_COLOR;
      ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
    }
  } else {
    // Avatar par défaut: cercle blurple avec initiales
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
  }
  ctx.restore();

  // Initiales (uniquement si pas d'avatar personnalisé)
  if (!customAvatarUrl) {
    const initials = (author || 'W').slice(0, 2).toUpperCase();
    ctx.fillStyle = CONFIG.AVATAR_TEXT_COLOR;
    ctx.font = 'bold 14px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, avatarCX, avatarCY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  const nameY = PADDING_V + NAME_H - 3;

  // Username
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = CONFIG.USERNAME_COLOR;
  ctx.font = 'bold 16px ' + FONT;
  ctx.fillText(author || 'Z', CONTENT_X, nameY);
  const nameW = ctx.measureText(author || 'Z').width;

  // tag_boom.png — remplace le badge dessiné
  const TAG_H = 18;
  const badgeX = CONTENT_X + nameW + 6;
  const badgeY = nameY - TAG_H + 2;
  let BADGE_W = 0;
  try {
    const tagImg = await loadImage(path.join(__dirname, 'tag_boom.png'));
    // Conserver le ratio de l'image
    const tagRatio = tagImg.width / tagImg.height;
    BADGE_W = Math.round(TAG_H * tagRatio);
    ctx.drawImage(tagImg, badgeX, badgeY, BADGE_W, TAG_H);
  } catch(e) {
    // Fallback texte si image manquante
    ctx.font = 'bold 10px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOOM', badgeX, badgeY + TAG_H / 2);
    ctx.textBaseline = 'alphabetic';
    BADGE_W = 50;
  }

  // Logo BOOM circulaire entre le badge et l'heure
  const LOGO_SIZE = 18;
  const logoX = badgeX + BADGE_W + 6;
  const logoCY = badgeY + TAG_H / 2;
  let logoEndX = logoX;
  try {
    const logoImg = await loadImage(path.join(__dirname, 'logo_boom.png'));
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, logoCY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, logoX, logoCY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();
    logoEndX = logoX + LOGO_SIZE + 6;
  } catch(e) {
    logoEndX = logoX;
  }

  // Time
  const d = timestamp ? new Date(timestamp) : new Date();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const timeStr = hh + ':' + mm;
  ctx.fillStyle = CONFIG.TIME_COLOR;
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, logoEndX, nameY - 1);

  // (gain% in X post text, not in image)

  // Message text
  ctx.fillStyle = CONFIG.MESSAGE_COLOR;
  ctx.font = '16px ' + FONT;
  let ty = nameY + LINE_H;
  for (const line of lines) {
    ctx.fillText(line, CONTENT_X, ty);
    ty += LINE_H;
  }

  return canvas.toBuffer('image/png');
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// ─────────────────────────────────────────────────────────────────────
// extractPrices — Detecte prix d'entree ET de sortie dans un message
// ─────────────────────────────────────────────────────────────────────
function extractPrices(content) {
  if (!content) return { entry_price: null, exit_price: null, gain_pct: null };
  const c = content.replace(/,/g, '.');
  let entry = null;
  let exit  = null;

  // Priorite 1: TICKER PRIX-PRIX (ex: $TSLA 150.00-155.00 ou NCT 2.60-4.06)
  const rangeM = c.match(/(?:\$?[A-Z]{1,6}\s+)(\d+(?:\.\d+)?)\s*[-\u2013]\s*(\d+(?:\.\d+)?)/i);
  if (rangeM) {
    const a = parseFloat(rangeM[1]), b = parseFloat(rangeM[2]);
    entry = Math.min(a, b);
    exit  = Math.max(a, b);
  }

  // Priorite 2: "in at PRIX" / "entry PRIX" / "long PRIX"
  if (!entry) {
    const em = c.match(/(?:in\s+at|entry|bought?|long at|achat|entree)\s+\$?(\d+(?:\.\d+)?)/i);
    if (em) entry = parseFloat(em[1]);
  }

  // Priorite 3: "out at PRIX" / "exit PRIX" / "target PRIX" / "tp PRIX"
  if (!exit) {
    const xm = c.match(/(?:out\s+at|exit\s+at|sold?\s+at|target|tp|sortie|objectif)\s+\$?(\d+(?:\.\d+)?)/i);
    if (xm) exit = parseFloat(xm[1]);
  }

  // Priorite 4: Niveaux separes par ... ou to (ex: 2.50...3.50)
  if (!entry || !exit) {
    const lm = c.match(/\$?(\d+(?:\.\d+)?)\s*(?:\.{2,}|\bto\b)\s*\$?(\d+(?:\.\d+)?)/i);
    if (lm) {
      const a = parseFloat(lm[1]), b = parseFloat(lm[2]);
      if (!entry) entry = Math.min(a, b);
      if (!exit)  exit  = Math.max(a, b);
    }
  }

  let gain_pct = null;
  if (entry !== null && exit !== null && entry > 0) {
    gain_pct = parseFloat((((exit - entry) / entry) * 100).toFixed(2));
  }

  return { entry_price: entry, exit_price: exit, gain_pct };
}
// ─────────────────────────────────────────────────────────────────────

function extractTicker(content) {
    if (!content) return '';
    const m = content.match(/\$([A-Z]{1,6})/i) || content.match(/\b([A-Z]{2,6})\b/);
    return m ? m[1].toUpperCase() : '';
}
function enrichContent(content) {
  const { gain_pct } = extractPrices(content);
  if (gain_pct === null) return content;
  const sign = gain_pct >= 0 ? '+' : '';
  return content + ' | Gain: ' + sign + gain_pct + '%';
}
const TICKER_IGNORE = new Set(['I','A','THE','AND','OR','TO','IN','AT','ON','BY','FOR','OF','UP','OK']);
function detectTicker(content) {
  if (!content) return null;
  const m1 = content.match(/\$([A-Z]{1,6})/i);
  if (m1) return m1[1].toUpperCase();
  const m2 = content.match(/\b([A-Z]{2,5})\b/g);
  if (m2) {
    for (const t of m2) {
      if (!TICKER_IGNORE.has(t)) return t;
    }
  }
  return null;
}

function classifySignal(content) {
  if (!content) return { type: null, reason: 'No content', confidence: 90, ticker: null };
  const lower = content.toLowerCase();
  const ticker = detectTicker(content);

  // 1. Liste blanche custom — bypass tous les filtres (corrections faux-negatifs)
  for (const phrase of customFilters.allowed) {
    if (lower.includes(phrase.toLowerCase())) {
      return { type: 'neutral', reason: 'Accepted', confidence: 90, ticker };
    }
  }

  // 2. Liste noire custom — regles apprises (faux-positifs corriges)
  for (const phrase of customFilters.blocked) {
    if (lower.includes(phrase.toLowerCase())) {
      return { type: null, reason: 'Learned filter', confidence: 90, ticker };
    }
  }

  // 3. Mots-cles bloques (hardcodes)
  const blocked = ['news', 'sec', 'ipo', 'offering', 'halted', 'form 8-k', 'reverse stock split'];
  for (const b of blocked) {
    if (lower.includes(b)) return { type: null, reason: 'Blocked keyword', confidence: 95, ticker };
  }
  // REQUIS: ticker ($TSLA, AAPL, NCT...)
  const hasTicker = /\$[A-Z]{1,6}/i.test(content) || /\b[A-Z]{2,5}\b/.test(content);
  if (!hasTicker) {
    console.log('[FILTER] No ticker, ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'No ticker', confidence: 90, ticker: null };
  }
  if (lower.includes('entree') || lower.includes('entry') || lower.includes('long') || lower.includes('scalp')) {
    const hasPrice = /\d+(?:\.\d+)?/.test(content);
    return { type: 'entry', reason: 'Accepted', confidence: hasPrice ? 90 : 70, ticker };
  }
  if (lower.includes('sortie') || lower.includes('exit') || lower.includes('stop')) {
    const hasPrice = /\d+(?:\.\d+)?/.test(content);
    return { type: 'exit', reason: 'Accepted', confidence: hasPrice ? 90 : 70, ticker };
  }
  // FILTRE: messages conversationnels (questions/chat sans prix)
  const hasPrice = /\d+(?:\.\d+)?/.test(content);
  const isQuestion = content.trim().endsWith('?');
  const startsConvo = /^(and\s+)?(how|who|what|when|why|did|do|are|is|can|any|anyone|has|have|congrats|gg|nice|good|great|lol|haha|check|look|wow|reminder|just|btw|fyi|ok|okay)\b/i.test(content.trim());
  if ((isQuestion || startsConvo) && !hasPrice) {
    console.log('[FILTER] Conversational ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'Conversational', confidence: 75, ticker };
  }
  return { type: 'neutral', reason: 'Accepted', confidence: 60, ticker };
}

// ─────────────────────────────────────────────────────────────────────
//  Resume journalier Discord — envoye a 18h00 heure locale
// ─────────────────────────────────────────────────────────────────────
let lastSummaryDate = null;

function sendDailySummary() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayMsgs = messageLog.filter(function(m) { return new Date(m.ts) >= midnight; });
  const total = todayMsgs.length;
  const accepted = todayMsgs.filter(function(m) { return m.passed; }).length;
  const filtered = total - accepted;
  const rate = total ? Math.round(accepted / total * 100) : 0;

  const tickerMap = {};
  todayMsgs.forEach(function(m) { if (m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker] || 0) + 1; });
  const topTickers = Object.keys(tickerMap).map(function(k) { return [k, tickerMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);

  const authorMap = {};
  todayMsgs.forEach(function(m) { if (m.author) authorMap[m.author] = (authorMap[m.author] || 0) + 1; });
  const topAuthors = Object.keys(authorMap).map(function(k) { return [k, authorMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);

  const tickersStr = topTickers.length ? topTickers.map(function(t) { return t[0] + ' (' + t[1] + ')'; }).join(', ') : 'Aucun';
  const authorsStr = topAuthors.length ? topAuthors.map(function(a) { return a[0] + ' (' + a[1] + ')'; }).join(', ') : 'Aucun';

  const summaryText = [
    '**Resume journalier BOOM** — ' + todayStr,
    '> Messages totaux : **' + total + '**',
    '> Acceptes : **' + accepted + '** | Filtres : **' + filtered + '**',
    '> Taux acceptation : **' + rate + '%**',
    '> Top tickers : ' + tickersStr,
    '> Top auteurs : ' + authorsStr,
  ].join('\n');

  try {
    const channel = client.channels.cache.find(function(ch) {
      return ch.name && ch.name.includes(TRADING_CHANNEL);
    });
    if (channel && channel.send) {
      channel.send(summaryText).then(function() {
        console.log('[summary] Resume journalier envoye dans #' + channel.name);
      }).catch(function(err) {
        console.error('[summary] Erreur envoi resume:', err.message);
      });
    } else {
      console.warn('[summary] Channel introuvable pour le resume journalier');
    }
  } catch (e) {
    console.error('[summary] Erreur:', e.message);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);

  // Verification toutes les minutes pour le resume a 18h00
  setInterval(function() {
    const now = new Date();
    if (now.getHours() === 18 && now.getMinutes() === 0) {
      const todayStr = now.toISOString().slice(0, 10);
      if (lastSummaryDate !== todayStr) {
        lastSummaryDate = todayStr;
        sendDailySummary();
      }
    }
  }, 60000);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const channelName = message.channel.name || '';
  console.log('Message received - channel: "' + channelName + '", author: ' + message.author.username);
  if (!channelName.includes(TRADING_CHANNEL)) return;

  const content = message.content;
  const authorName = message.author.username;

  // ── Filtre par auteur ──────────────────────────────────────────────────────
  if ((customFilters.blockedAuthors || []).includes(authorName)) {
    console.log('[AUTHOR BLOCKED] ' + authorName);
    logEvent(authorName, channelName, content, null, 'Auteur bloqué');
    return;
  }
  const authorAllowed = (customFilters.allowedAuthors || []).includes(authorName);
  // ──────────────────────────────────────────────────────────────────────────

  // ── Détection de réponse + enrichissement de contexte ─────────────────────
  let parentContent = null;
  let parentAuthor  = null;
  let isReply       = false;

  if (message.reference?.messageId) {
    try {
      const parentMsg = await message.channel.messages.fetch(message.reference.messageId);
      parentContent = parentMsg.content || '';
      parentAuthor  = parentMsg.author?.username || null;
      isReply       = true;
      console.log('[REPLY] Parent: ' + parentContent.substring(0, 60));
    } catch (e) {
      console.warn('[REPLY] Could not fetch parent message:', e.message);
    }
  }

  // Contenu enrichi : si c'est une réponse, on fusionne parent + reply
  // pour que le ticker/prix du parent bénéficient à la classification de la réponse
  const classifyContent = isReply && parentContent
    ? parentContent + ' ' + content
    : content;

  const extra = {
    isReply,
    parentPreview: parentContent ? (parentContent.length > 80 ? parentContent.slice(0, 80) + '…' : parentContent) : null,
    parentAuthor,
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Auteur autorise → bypass du filtre de contenu
  let signalType, signalReason, signalConfidence, signalTicker;
  if (authorAllowed) {
    signalType       = 'neutral';
    signalReason     = 'Accepted';
    signalConfidence = 80;
    signalTicker     = detectTicker(classifyContent);
    console.log('[AUTHOR ALLOWED] bypass filter for ' + authorName);
  } else {
    const result     = classifySignal(classifyContent);
    signalType       = result.type;
    signalReason     = result.reason;
    signalConfidence = result.confidence;
    signalTicker     = result.ticker;
  }
  const extraWithSignal = Object.assign({}, extra, { confidence: signalConfidence, ticker: signalTicker });
  if (!signalType) {
    console.log('Filtered (' + signalReason + '): ' + content.substring(0, 80));
    logEvent(authorName, channelName, content, null, signalReason, extraWithSignal);
    return;
  }
  logEvent(authorName, channelName, content, signalType, 'Accepted', extraWithSignal);
  console.log('[' + signalType.toUpperCase() + ']' + (isReply ? ' [REPLY]' : '') + ' ' + content);

  let imageUrl = null;
  try {
    const imgBuf = await generateImage(message.author.username, content, message.createdAt.toISOString());
    lastImageBuffer = imgBuf;
    lastImageId = Date.now();
    imageUrl = RAILWAY_URL + '/image/latest?t=' + lastImageId;
    console.log('Image generated, URL: ' + imageUrl);
  } catch (err) {
    console.error('Image generation error:', err.message);
  }

  try {
    const result = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        author: message.author.username,
        channel: channelName,
        signal_type: signalType,
        timestamp: message.createdAt.toISOString(),
        image_url: imageUrl,
        ticker: extractTicker(classifyContent),
        is_reply: isReply,
        parent_content: parentContent,
        parent_author: parentAuthor,
        ...extractPrices(classifyContent)
      }),
    });
    console.log('Sent to Make, status: ' + result.status);
  } catch (err) {
    console.error('Error sending to Make:', err.message);
  }
});

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

client.login(DISCORD_TOKEN);
