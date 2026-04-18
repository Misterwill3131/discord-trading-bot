// ─────────────────────────────────────────────────────────────────────
// pages/news.js — Template HTML de /news (flux news + SSE)
// ─────────────────────────────────────────────────────────────────────
// Route Express : app.get('C:/Program Files/Git/news')
// ─────────────────────────────────────────────────────────────────────
const { COMMON_CSS, sidebarHTML } = require('./common');
const NEWS_PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM News</title>
<style>
  ${COMMON_CSS}
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #ed4245; margin-left: auto; }
  #dot.ok { background: #3ba55d; }
  #lbl { font-size: 11px; color: #a0a0b0; }
  #wrap { padding: 24px; max-width: 800px; }
  .news-card {
    background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
    padding: 14px 18px; margin-bottom: 10px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    animation: fadeInUp 400ms cubic-bezier(0.4,0,0.2,1) both;
  }
  .news-card:hover { background: rgba(255,255,255,0.05); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(139,92,246,0.15); }
  .news-emoji { font-size: 18px; margin-right: 8px; }
  .news-title { font-weight: 600; color: #fafafa; font-size: 14px; letter-spacing: -0.01em; }
  .news-meta { display: flex; gap: 10px; margin-top: 8px; font-size: 11px; color: #a0a0b0; }
  .news-source { background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 4px; font-weight: 600; color: #fafafa; }
  .news-empty { text-align: center; padding: 80px; color: #a0a0b0; }
  .count-badge { font-size: 11px; color: #a0a0b0; margin-left: 8px; }
</style>
</head>
<body>
${sidebarHTML('/news')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">News</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting...</span>
</div>
<div id="wrap">
  <h2 style="color:#fff;font-size:15px;margin-bottom:16px;">&#x1F4F0; Live News Feed <span class="count-badge" id="count-badge"></span></h2>
  <div id="news-list"><div class="news-empty">Chargement...</div></div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTime(ts){
    if(!ts) return '';
    var d=new Date(ts);
    return d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'}) + ' — ' + d.toLocaleDateString('fr-CA');
  }
  function renderCard(n){
    return '<div class="news-card">'
      + '<span class="news-emoji">' + esc(n.emoji) + '</span>'
      + '<span class="news-title">' + esc(n.title) + '</span>'
      + '<div class="news-meta">'
      + '<span class="news-source">' + esc(n.source) + '</span>'
      + '<span>' + fmtTime(n.ts) + '</span>'
      + '</div></div>';
  }
  var list = document.getElementById('news-list');
  var badge = document.getElementById('count-badge');
  var allNews = [];

  function renderAll(){
    if(!allNews.length){ list.innerHTML='<div class="news-empty">Aucune actualite pour le moment</div>'; badge.textContent=''; return; }
    badge.textContent = '(' + allNews.length + ')';
    list.innerHTML = allNews.map(renderCard).join('');
  }

  fetch('/api/recent-news').then(function(r){return r.json();}).then(function(data){
    allNews = data || [];
    renderAll();
  });

  var es = new EventSource('/api/news-events');
  es.onopen = function(){ document.getElementById('dot').className='ok'; document.getElementById('lbl').textContent='Live'; };
  es.onerror = function(){ document.getElementById('dot').className=''; document.getElementById('lbl').textContent='Reconnecting...'; };
  es.onmessage = function(e){
    try {
      var n = JSON.parse(e.data);
      allNews.unshift(n);
      if(allNews.length > 50) allNews.pop();
      renderAll();
    } catch(_){}
  };
})();
</script>
</div>
</body>
</html>`;
module.exports = { NEWS_PAGE_HTML };