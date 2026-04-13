const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const express = require('express');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://discord-trading-bot-production-f159.up.railway.app';

// ─────────────────────────────────────────────────────────────────────
//  Filtre adaptatif — chargement / sauvegarde des règles apprises
// ─────────────────────────────────────────────────────────────────────
const FILTERS_PATH = path.join(__dirname, 'custom-filters.json');

function loadCustomFilters() {
  try {
    if (fs.existsSync(FILTERS_PATH)) {
      return JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[filters] Failed to load custom-filters.json:', e.message);
  }
  return { blocked: [], allowed: [] };
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
</style>
</head>
<body>
<header>
  <div id="dot"></div>
  <h1>BOOM Signal Monitor</h1>
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

<div id="filters-panel" style="margin:0 24px 24px">
  <button id="filters-toggle">
    <span>Règles apprises : <span id="rule-count">0</span></span>
    <span id="filters-arrow">▶</span>
  </button>
  <div id="filters-body">
    <div class="filter-section">
      <h3>Phrases bloquées (faux-positifs corrigés) ❌</h3>
      <div id="blocked-tags"><span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l'instant</span></div>
    </div>
    <div class="filter-section">
      <h3>Phrases autorisées (faux-négatifs corrigés) ✅</h3>
      <div id="allowed-tags"><span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l'instant</span></div>
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
      btn='<button class="btn-fp" data-id="'+esc(e.id)+'" data-content="'+esc(e.content||e.preview)+'" title="Marquer comme faux-positif (bloquer à l\'avenir)">❌</button>';
      return '<span class="badge '+cls+'"><span class="dot '+dc+'"></span>'+e.type.toUpperCase()+'</span>'+btn;
    }
    var bc=(e.reason==='Conversational'||e.reason==='No content')?'b-convo':'b-filter';
    var dd=(e.reason==='Conversational'||e.reason==='No content')?'dz':'do';
    btn='<button class="btn-fn" data-id="'+esc(e.id)+'" data-content="'+esc(e.content||e.preview)+'" title="Marquer comme faux-négatif (autoriser à l\'avenir)">✅</button>';
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
    bt.innerHTML=blocked.length?'':'<span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l\'instant</span>';
    at.innerHTML=allowed.length?'':'<span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l\'instant</span>';
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

  fetch('/api/custom-filters').then(function(r){return r.json();}).then(renderFilters).catch(function(){});

  (function connect(){
    var es=new EventSource('/api/events');
    es.onopen=function(){ dot.className='on'; lbl.textContent='Live'; };
    es.onmessage=function(ev){
      var e; try{ e=JSON.parse(ev.data); }catch(_){ return; }
      tb.insertBefore(makeRow(e,true),tb.firstChild);
      total++; upd(); empty.style.display='none';
    };
    es.onerror=function(){ dot.className='off'; lbl.textContent='Reconnecting…'; };
  })();
})();
</script>
</body>
</html>`;

const app = express();
app.use(express.json());

let lastImageBuffer = null;
let lastImageId = null;

const MAX_LOG = 200;
const messageLog = [];
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
    isReply:       extra?.isReply || false,
    parentPreview: extra?.parentPreview || null,
    parentAuthor:  extra?.parentAuthor || null,
  };
  messageLog.unshift(entry);
  if (messageLog.length > MAX_LOG) messageLog.pop();
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].res.write(payload); } catch (_) { sseClients.splice(i, 1); }
  }
}

app.get('/preview', async (req, res) => {
  try {
    const author = req.query.author || 'Z';
    const message = req.query.message || '$TSLA 150.00-155.00';
    const buf = await generateImage(author, message, new Date().toISOString());
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.get('/api/messages', (req, res) => {
  res.json(messageLog);
});

app.get('/api/events', (req, res) => {
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

app.get('/api/custom-filters', (req, res) => {
  res.json(customFilters);
});

app.post('/api/feedback', (req, res) => {
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

app.get('/dashboard', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(DASHBOARD_HTML);
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

  // BOOM badge
  const BADGE_H = 16;
  const BADGE_PAD_X = 5;
  const BADGE_RADIUS = 3;
  const BADGE_LABEL = 'BOOM';
  const FLAME_W = 9;
  const BADGE_GAP = 3;

  ctx.font = 'bold 10px ' + FONT;
  const labelW = ctx.measureText(BADGE_LABEL).width;

  const BADGE_W = BADGE_PAD_X + FLAME_W + BADGE_GAP + labelW + BADGE_PAD_X;
  const badgeX = CONTENT_X + nameW + 6;
  const badgeY = nameY - BADGE_H + 2;

  ctx.fillStyle = CONFIG.BADGE_BG;
  roundRect(ctx, badgeX, badgeY, BADGE_W, BADGE_H, BADGE_RADIUS);
  ctx.fill();

  ctx.strokeStyle = CONFIG.BADGE_BORDER;
  ctx.lineWidth = 0.5;
  roundRect(ctx, badgeX, badgeY, BADGE_W, BADGE_H, BADGE_RADIUS);
  ctx.stroke();

  // Flamme Canvas — fidele au logo de reference (base large, pointe fine)
  const flameX = badgeX + BADGE_PAD_X;
  const flameY = badgeY + 0.5;
  const fw = FLAME_W;
  const fh = BADGE_H - 1;
  ctx.save();
  const flameGrad = ctx.createLinearGradient(flameX + fw/2, flameY + fh, flameX + fw/2, flameY);
  flameGrad.addColorStop(0,    CONFIG.FLAME_BOTTOM);
  flameGrad.addColorStop(0.45, CONFIG.FLAME_MID);
  flameGrad.addColorStop(1,    CONFIG.FLAME_TOP);
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.moveTo(flameX + fw * 0.50, flameY);
  ctx.bezierCurveTo(
    flameX + fw * 0.75, flameY + fh * 0.18,
    flameX + fw * 1.00, flameY + fh * 0.42,
    flameX + fw * 0.92, flameY + fh * 0.70
  );
  ctx.bezierCurveTo(
    flameX + fw * 0.88, flameY + fh * 0.85,
    flameX + fw * 0.80, flameY + fh * 0.95,
    flameX + fw * 0.50, flameY + fh * 1.00
  );
  ctx.bezierCurveTo(
    flameX + fw * 0.20, flameY + fh * 0.95,
    flameX + fw * 0.12, flameY + fh * 0.85,
    flameX + fw * 0.08, flameY + fh * 0.70
  );
  ctx.bezierCurveTo(
    flameX + fw * 0.00, flameY + fh * 0.42,
    flameX + fw * 0.25, flameY + fh * 0.18,
    flameX + fw * 0.50, flameY
  );
  ctx.closePath();
  ctx.fill();
  const innerGrad = ctx.createLinearGradient(flameX + fw/2, flameY + fh * 0.9, flameX + fw/2, flameY + fh * 0.35);
  innerGrad.addColorStop(0, 'rgba(255,255,180,0.55)');
  innerGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.moveTo(flameX + fw * 0.50, flameY + fh * 0.38);
  ctx.bezierCurveTo(flameX + fw * 0.65, flameY + fh * 0.52, flameX + fw * 0.70, flameY + fh * 0.72, flameX + fw * 0.50, flameY + fh * 0.90);
  ctx.bezierCurveTo(flameX + fw * 0.30, flameY + fh * 0.72, flameX + fw * 0.35, flameY + fh * 0.52, flameX + fw * 0.50, flameY + fh * 0.38);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.font = 'bold 10px ' + FONT;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(BADGE_LABEL, badgeX + BADGE_PAD_X + FLAME_W + BADGE_GAP, badgeY + BADGE_H / 2);
  ctx.textBaseline = 'alphabetic';

  // Time
  const d = timestamp ? new Date(timestamp) : new Date();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const timeStr = 'Today at ' + hh + ':' + mm;
  const timeX = badgeX + BADGE_W + 6;
  ctx.fillStyle = CONFIG.TIME_COLOR;
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, timeX, nameY - 1);

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
function classifySignal(content) {
  if (!content) return { type: null, reason: 'No content' };
  const lower = content.toLowerCase();

  // 1. Liste blanche custom — bypass tous les filtres (corrections faux-négatifs)
  for (const phrase of customFilters.allowed) {
    if (lower.includes(phrase.toLowerCase())) {
      return { type: 'neutral', reason: 'Accepted' };
    }
  }

  // 2. Liste noire custom — règles apprises (faux-positifs corrigés)
  for (const phrase of customFilters.blocked) {
    if (lower.includes(phrase.toLowerCase())) {
      return { type: null, reason: 'Learned filter' };
    }
  }

  // 3. Mots-clés bloqués (hardcodés)
  const blocked = ['news', 'sec', 'ipo', 'offering', 'halted', 'form 8-k', 'reverse stock split'];
  for (const b of blocked) {
    if (lower.includes(b)) return { type: null, reason: 'Blocked keyword' };
  }
  // REQUIS: ticker ($TSLA, AAPL, NCT...)
  const hasTicker = /\$[A-Z]{1,6}/i.test(content) || /\b[A-Z]{2,5}\b/.test(content);
  if (!hasTicker) {
    console.log('[FILTER] No ticker, ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'No ticker' };
  }
  if (lower.includes('entree') || lower.includes('entry') || lower.includes('long') || lower.includes('scalp')) return { type: 'entry', reason: 'Accepted' };
  if (lower.includes('sortie') || lower.includes('exit') || lower.includes('stop')) return { type: 'exit', reason: 'Accepted' };
  // FILTRE: messages conversationnels (questions/chat sans prix)
  const hasPrice = /\d+(?:\.\d+)?/.test(content);
  const isQuestion = content.trim().endsWith('?');
  const startsConvo = /^(and\s+)?(how|who|what|when|why|did|do|are|is|can|any|anyone|has|have|congrats|gg|nice|good|great|lol|haha|check|look|wow|reminder|just|btw|fyi|ok|okay)\b/i.test(content.trim());
  if ((isQuestion || startsConvo) && !hasPrice) {
    console.log('[FILTER] Conversational ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'Conversational' };
  }
  return { type: 'neutral', reason: 'Accepted' };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const channelName = message.channel.name || '';
  console.log('Message received - channel: "' + channelName + '", author: ' + message.author.username);
  if (!channelName.includes(TRADING_CHANNEL)) return;

  const content = message.content;

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

  const { type: signalType, reason: signalReason } = classifySignal(classifyContent);
  if (!signalType) {
    console.log('Filtered (' + signalReason + '): ' + content.substring(0, 80));
    logEvent(message.author.username, channelName, content, null, signalReason, extra);
    return;
  }
  logEvent(message.author.username, channelName, content, signalType, 'Accepted', extra);
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
