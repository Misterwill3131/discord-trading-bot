// ─────────────────────────────────────────────────────────────────────
// pages/proof-generator.js — Template HTML de /proof-generator (mockup proof image)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/proof-generator')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const PROOF_GEN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Proof Generator</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; gap: 24px; max-width: 1200px; flex-wrap: wrap; }
  .panel { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; flex: 1; min-width: 320px; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
  .panel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 16px; }
  label { font-size: 12px; color: #b5bac1; display: block; margin-bottom: 5px; margin-top: 12px; }
  input, textarea, select { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #fafafa; padding: 8px 10px; font-size: 13px; font-family: inherit; }
  input:focus, textarea:focus { outline: none; border-color: rgba(139,92,246,0.5); }
  textarea { resize: vertical; min-height: 70px; }
  .btn { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; border: none; border-radius: 8px; padding: 11px 20px; cursor: pointer; font-size: 13px; font-weight: 600; width: 100%; margin-top: 16px; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-sm { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; width: auto; margin-top: 0; }
  .btn-sm:hover { background: rgba(16,185,129,0.2); }
  .alert-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-height: 300px; overflow-y: auto; }
  .alert-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 200ms; }
  .alert-item:hover { border-color: rgba(139,92,246,0.4); background: rgba(255,255,255,0.05); }
  .alert-item.selected { border-color: rgba(16,185,129,0.5); background: rgba(16,185,129,0.1); }
  .alert-author { font-weight: 700; color: #D649CC; font-size: 12px; }
  .alert-content { font-size: 13px; color: #fafafa; margin-top: 3px; }
  .alert-ts { font-size: 11px; color: #a0a0b0; margin-top: 2px; }
  .alert-type { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
  .type-entry { background: rgba(16,185,129,0.1); color: #10b981; }
  .type-neutral { background: rgba(59,130,246,0.1); color: #60a5fa; }
  #preview-wrap { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; flex: 0 0 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
  #preview-wrap img { max-width: 100%; border-radius: 6px; display: block; margin: 0 auto; }
  .search-row { display: flex; gap: 8px; align-items: flex-end; }
  .search-row input { flex: 1; }
  #status { font-size: 12px; color: #a0a0b0; margin-top: 8px; min-height: 16px; }
  .download-btn { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; border-radius: 8px; padding: 8px 20px; cursor: pointer; font-size: 13px; font-weight: 600; margin-top: 12px; display: none; }
  .download-btn:hover { transform: translateY(-1px); }
</style>
</head>
<body>
${sidebarHTML('/proof-generator')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Proof Generator</h1></div>
<div id="wrap">
  <!-- Left: Alert search -->
  <div class="panel">
    <div class="panel-title">1. Trouver l'alerte originale</div>
    <div class="search-row">
      <div style="flex:1;">
        <label>Ticker</label>
        <input id="ticker-input" type="text" placeholder="TSLA" maxlength="10">
      </div>
      <button class="btn-sm" id="search-btn" style="margin-bottom:1px;">Chercher</button>
    </div>
    <div id="status"></div>
    <div id="alert-list" class="alert-list"></div>
    <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;">
      <div class="panel-title" style="margin-bottom:8px;">Alerte sélectionnée</div>
      <label>Analyste</label>
      <input id="alert-author" type="text" placeholder="AR">
      <label>Message</label>
      <textarea id="alert-content" placeholder="$TSLA 150.00 entry..."></textarea>
      <label>Date/Heure</label>
      <input id="alert-ts" type="datetime-local">
    </div>
  </div>

  <!-- Right: Recap message -->
  <div class="panel">
    <div class="panel-title">2. Message recap (résultat)</div>
    <label>Analyste</label>
    <input id="recap-author" type="text" placeholder="Z">
    <label>Message</label>
    <textarea id="recap-content" placeholder="$TSLA 150.00-155.00 🔥"></textarea>
    <label>Date/Heure</label>
    <input id="recap-ts" type="datetime-local">
    <button class="btn" id="generate-btn">🖼️ Générer l'image proof</button>
  </div>

  <!-- Preview -->
  <div id="preview-wrap" style="display:none;">
    <div class="panel-title">Aperçu</div>
    <img id="preview-img" src="" alt="proof image">
    <a id="download-link" style="display:none;"><button class="download-btn" id="dl-btn" style="display:block;">⬇️ Télécharger</button></a>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTs(ts){
    if(!ts) return '';
    var d = new Date(ts);
    var pad = n => String(n).padStart(2,'0');
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  }

  var selectedAlert = null;

  document.getElementById('search-btn').addEventListener('click', function(){
    var ticker = document.getElementById('ticker-input').value.trim().toUpperCase().replace('$','');
    if(!ticker) return;
    document.getElementById('status').textContent = 'Recherche...';
    document.getElementById('alert-list').innerHTML = '';
    fetch('/api/find-alert?ticker='+encodeURIComponent(ticker)+'&days=30')
      .then(function(r){return r.json();})
      .then(function(data){
        var alerts = data.alerts || [];
        document.getElementById('status').textContent = alerts.length + ' alerte(s) trouvée(s)';
        if(!alerts.length){
          document.getElementById('alert-list').innerHTML = '<div style="color:#a0a0b0;font-size:12px;padding:8px;">Aucune alerte trouvée pour ' + esc(ticker) + '</div>';
          return;
        }
        var html = '';
        alerts.forEach(function(a, i){
          var typeHtml = a.type ? '<span class="alert-type type-'+(a.type||'neutral')+'">'+esc(a.type)+'</span>' : '';
          var d = new Date(a.ts);
          var dateStr = d.toLocaleDateString('fr-CA') + ' ' + d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
          html += '<div class="alert-item" data-idx="'+i+'">'
            + '<div class="alert-author">'+esc(a.author)+typeHtml+'</div>'
            + '<div class="alert-content">'+esc(a.content)+'</div>'
            + '<div class="alert-ts">'+dateStr+'</div>'
            + '</div>';
        });
        document.getElementById('alert-list').innerHTML = html;
        // Store alerts for click
        window._alerts = alerts;
        document.querySelectorAll('.alert-item').forEach(function(el){
          el.addEventListener('click', function(){
            document.querySelectorAll('.alert-item').forEach(function(e){e.classList.remove('selected');});
            el.classList.add('selected');
            var idx = parseInt(el.getAttribute('data-idx'));
            var a = window._alerts[idx];
            document.getElementById('alert-author').value = a.author || '';
            document.getElementById('alert-content').value = a.content || '';
            document.getElementById('alert-ts').value = fmtTs(a.ts);
          });
        });
      })
      .catch(function(){ document.getElementById('status').textContent = 'Erreur de recherche'; });
  });

  document.getElementById('ticker-input').addEventListener('keydown', function(e){
    if(e.key === 'Enter') document.getElementById('search-btn').click();
  });

  document.getElementById('generate-btn').addEventListener('click', function(){
    var alertAuthor = document.getElementById('alert-author').value.trim();
    var alertContent = document.getElementById('alert-content').value.trim();
    var alertTs = document.getElementById('alert-ts').value;
    var recapAuthor = document.getElementById('recap-author').value.trim();
    var recapContent = document.getElementById('recap-content').value.trim();
    var recapTs = document.getElementById('recap-ts').value;

    if(!alertContent || !recapContent){ alert('Remplis les deux messages.'); return; }

    var params = new URLSearchParams({
      alertAuthor, alertContent, recapAuthor, recapContent,
      alertTs: alertTs ? new Date(alertTs).toISOString() : new Date().toISOString(),
      recapTs: recapTs ? new Date(recapTs).toISOString() : new Date().toISOString(),
    });
    var url = '/api/proof-image?' + params.toString();
    var img = document.getElementById('preview-img');
    img.src = url;
    img.onload = function(){
      document.getElementById('preview-wrap').style.display = '';
      var link = document.getElementById('download-link');
      link.href = url;
      link.download = 'proof-' + (recapAuthor||'boom') + '.png';
      link.style.display = '';
    };
    img.onerror = function(){ alert('Erreur génération image'); };
  });
})();
</script>
</div>
</body>
</html>`;
module.exports = { PROOF_GEN_HTML };