// ─────────────────────────────────────────────────────────────────────
// pages/raw-messages.js — Template HTML de /raw-messages (dump messages bruts)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/raw-messages')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const RAW_MESSAGES_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Messages Bruts</title>
<style>
  ${COMMON_CSS}
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #a0a0b0; }
  #cnt { margin-left: auto; font-size: 12px; color: #a0a0b0; }
  #wrap { padding: 16px 24px; }
  #search-bar { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; }
  #search-input { flex: 1; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #fafafa; padding: 9px 14px; font-size: 13px; outline: none; }
  #search-input:focus { border-color: rgba(139,92,246,0.5); background: rgba(255,255,255,0.06); }
  #search-input::placeholder { color: #a0a0b0; }
  #filter-author { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #fafafa; padding: 9px 12px; font-size: 13px; outline: none; cursor: pointer; }
  #filter-author:focus { border-color: rgba(139,92,246,0.5); }
  .msg-card { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px 18px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; transition: background 200ms, border-color 200ms; }
  .msg-card:hover { background: rgba(255,255,255,0.05); border-color: rgba(139,92,246,0.3); }
  .msg-card.new { animation: flash .8s ease-out; }
  .msg-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .msg-author { font-weight: 700; color: #D649CC; font-size: 14px; }
  .msg-channel { font-size: 12px; color: #a0a0b0; }
  .msg-time { font-size: 12px; color: #a0a0b0; margin-left: auto; }
  .msg-body { font-size: 14px; color: #fafafa; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .ticker-link { color:#a78bfa; text-decoration:none; font-weight:700; background:rgba(139,92,246,0.12); border-radius:4px; padding:1px 5px; transition:background 150ms, color 150ms; }
  .ticker-link:hover { background:rgba(139,92,246,0.25); color:#fafafa; }
  .msg-reply { font-size: 12px; color: #a0a0b0; border-left: 2px solid rgba(255,255,255,0.08); padding-left: 8px; margin-bottom: 4px; font-style: italic; }
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .b-exit    { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .b-neutral { background: rgba(59,130,246,0.1); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }
  .b-filter  { background: rgba(250,166,26,0.1); color: #faa61a; border: 1px solid rgba(250,166,26,0.3); }
  .b-convo   { background: rgba(160,160,176,0.08); color: #a0a0b0; border: 1px solid rgba(160,160,176,0.2); }
  #empty { padding: 60px 24px; text-align: center; color: #a0a0b0; }
  @keyframes flash { from { background: rgba(139,92,246,0.15); } to { background: rgba(255,255,255,0.03); } }
</style>
</head>
<body>
${sidebarHTML('/raw-messages')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Raw Messages</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</div>
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
  function linkifyTickers(html){ return String(html||'').replace(/\$([A-Z]{1,5})\b/g, function(_, s){ return '<a href="/ticker/' + s + '" class="ticker-link">$' + s + '</a>'; }); }

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
      reply = '<div class="msg-reply">Reponse a <strong>' + escHtml(e.parentAuthor || '?') + '</strong> : ' + linkifyTickers(escHtml(e.parentPreview)) + '</div>';
    }

    var body = '<div class="msg-body">' + linkifyTickers(escHtml(e.content || '')) + '</div>';

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
</div>
</body>
</html>`;
module.exports = { RAW_MESSAGES_HTML };