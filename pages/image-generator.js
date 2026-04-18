// ─────────────────────────────────────────────────────────────────────
// pages/image-generator.js — Template HTML de /image-generator (générateur signal image)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/image-generator')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const IMAGE_GEN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Image Generator</title>
<style>
  ${COMMON_CSS}
  .page-content { overflow: hidden; }
  .main { display: grid; grid-template-columns: 360px 1fr; gap: 0; height: 100vh; }
  .sidebar { background: rgba(255,255,255,0.02); border-right: 1px solid rgba(255,255,255,0.06); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
  .content { padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #a0a0b0; margin-bottom: 10px; }
  label { display: block; font-size: 13px; color: #b5bac1; margin-bottom: 6px; }
  input[type=text], textarea, input[type=time] {
    width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
    color: #fafafa; padding: 8px 10px; font-size: 14px; font-family: inherit;
    outline: none; transition: border-color .15s;
  }
  input[type=text]:focus, textarea:focus, input[type=time]:focus { border-color: rgba(139,92,246,0.5); }
  textarea { resize: vertical; min-height: 90px; }
  .field { margin-bottom: 14px; }
  .row { display: flex; gap: 10px; }
  .row .field { flex: 1; }
  .hint { font-size: 11px; color: #a0a0b0; margin-top: 4px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; padding: 10px 18px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn:active { transform: translateY(0); filter: brightness(0.9); }
  .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; width: 100%; justify-content: center; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-primary:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-success { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; }
  .btn-success:hover { transform: translateY(-1px); }
  .btn-secondary { background: rgba(255,255,255,0.06); color: #fafafa; border: 1px solid rgba(255,255,255,0.08); }
  .btn-secondary:hover { background: rgba(255,255,255,0.1); transform: translateY(-1px); }
  .preview-box { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 140px; justify-content: center; }
  .preview-box img { max-width: 100%; border-radius: 6px; display: block; box-shadow: 0 4px 24px rgba(0,0,0,0.6); image-rendering: crisp-edges; }
  .preview-placeholder { color: #a0a0b0; font-size: 13px; width: 100%; text-align: center; padding: 30px 0; }
  #preview-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .history-grid { display: flex; flex-direction: column; gap: 10px; }
  .history-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; transition: border-color 200ms, transform 200ms; }
  .history-item:hover { border-color: rgba(139,92,246,0.3); transform: translateY(-1px); }
  .history-item img { width: 100%; display: block; }
  .history-meta { padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; }
  .history-meta span { font-size: 11px; color: #a0a0b0; }
  .history-meta button { background: none; border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; border-radius: 3px; font-size: 11px; padding: 2px 8px; cursor: pointer; }
  .history-meta button:hover { background: rgba(255,255,255,0.04); color: #fafafa; }
  .avatar-list { display: flex; flex-direction: column; gap: 8px; }
  .avatar-item { display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; }
  .avatar-circle { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; overflow: hidden; }
  .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-name { flex: 1; font-size: 13px; font-weight: 600; color: #D649CC; }
  .avatar-url { font-size: 11px; color: #a0a0b0; word-break: break-all; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #ffffff44; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-bar { padding: 8px 12px; border-radius: 4px; font-size: 13px; display: none; }
  .status-bar.ok { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; display: block; border-radius: 8px; }
  .status-bar.err { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #f87171; display: block; border-radius: 8px; }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
</style>
</head>
<body>
${sidebarHTML('/image-generator')}
<div class="page-content">
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
        <div style="color:#a0a0b0;font-size:12px;">Chargement...</div>
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
        <div style="color:#a0a0b0;font-size:12px;">Aucune image generee dans cette session.</div>
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
      grid.innerHTML = '<div style="color:#a0a0b0;font-size:12px;">Aucune image generee dans cette session.</div>';
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
        list.innerHTML = '<div style="color:#a0a0b0;font-size:12px;">Aucun auteur vu pour l instant.</div>';
        return;
      }
      list.innerHTML = '';
      authors.forEach(function(a) {
        var item = document.createElement('div');
        item.className = 'avatar-item';
        var useBtn = document.createElement('button');
        useBtn.textContent = 'Utiliser';
        useBtn.style.cssText = 'background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.3);color:#a78bfa;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;';
        useBtn.addEventListener('click', (function(name){ return function(){ document.getElementById('inp-author').value = name; }; })(a));
        item.innerHTML = '<div class="avatar-circle">' + escHtml(a.slice(0,2).toUpperCase()) + '</div>' +
          '<div style="flex:1"><div class="avatar-name">' + escHtml(a) + '</div></div>';
        item.appendChild(useBtn);
        list.appendChild(item);
      });
    })
    .catch(function() {
      document.getElementById('avatar-list').innerHTML = '<div style="color:#a0a0b0;font-size:12px;">Impossible de charger les auteurs.</div>';
    });
})();
</script>
</div>
</body>
</html>`;
module.exports = { IMAGE_GEN_HTML };