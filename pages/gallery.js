// ─────────────────────────────────────────────────────────────────────
// pages/gallery.js — Template HTML de la galerie /gallery
// ─────────────────────────────────────────────────────────────────────
// Grille d'images récentes (100 dernières) avec filtre proof/signal/all,
// modal de preview plein écran, load/render via fetch('/api/gallery').
//
// Les miniatures pointent vers /gallery/image/:id qui renvoie le PNG
// stocké en mémoire (voir state/images.js).
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

const GALLERY_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Galerie — BOOM</title>
<style>
${COMMON_CSS}
#wrap { padding: 24px; }
h1 { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
#count { color: #80848e; font-size: 13px; margin-left: 10px; }
.filters { display:flex; gap:10px; margin-bottom:20px; flex-wrap:wrap; }
.filter-btn { padding:6px 14px; border-radius:6px; border:1px solid #3f4147; background:#2b2d31; color:#b5bac1; cursor:pointer; font-size:13px; }
.filter-btn.active { background:#5865f2; border-color:#5865f2; color:#fff; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
.card { background:#2b2d31; border-radius:10px; overflow:hidden; border:1px solid #3f4147; cursor:pointer; transition:transform .15s,border-color .15s; }
.card:hover { transform:translateY(-2px); border-color:#5865f2; }
.card img { width:100%; display:block; }
.card-meta { padding:10px 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.badge { font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; text-transform:uppercase; }
.badge-proof { background:rgba(214,73,204,0.2); color:#d649cc; }
.badge-signal { background:rgba(88,101,242,0.2); color:#8891f2; }
.ticker { font-size:13px; font-weight:700; color:#e3e5e8; }
.author { font-size:12px; color:#80848e; }
.ts { font-size:11px; color:#4f545c; margin-left:auto; }
.empty { color:#4f545c; text-align:center; padding:60px 0; font-size:15px; }
/* Modal */
#modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:1000; align-items:center; justify-content:center; }
#modal.open { display:flex; }
#modal img { max-width:92vw; max-height:92vh; border-radius:8px; box-shadow:0 8px 40px rgba(0,0,0,.6); }
#modal-close { position:fixed; top:18px; right:22px; font-size:28px; color:#fff; cursor:pointer; opacity:.8; }
#modal-close:hover { opacity:1; }
</style></head>
<body>
${sidebarHTML('/gallery')}
<div class="main-content">
<div id="wrap">
  <h1>Galerie d&#39;images<span id="count"></span></h1>
  <div class="filters">
    <button class="filter-btn active" data-filter="all">Toutes</button>
    <button class="filter-btn" data-filter="proof">Proof</button>
    <button class="filter-btn" data-filter="signal">Signal</button>
  </div>
  <div class="grid" id="grid"><div class="empty">Aucune image générée depuis le démarrage du bot.</div></div>
</div>
</div>
<div id="modal"><span id="modal-close">&#x2715;</span><img id="modal-img" src="" alt=""></div>
<script>
let allItems = [];
let activeFilter = 'all';

async function load() {
  const r = await fetch('/api/gallery');
  allItems = await r.json();
  document.getElementById('count').textContent = ' (' + allItems.length + ')';
  render();
}

function render() {
  const items = activeFilter === 'all' ? allItems : allItems.filter(i => i.type === activeFilter);
  const grid = document.getElementById('grid');
  if (!items.length) { grid.innerHTML = '<div class="empty">Aucune image pour ce filtre.</div>'; return; }
  grid.innerHTML = items.map(i => {
    const d = new Date(i.ts);
    const ts = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
    return '<div class="card" onclick="openModal(\\'/gallery/image/' + i.id + '\\')"><img src="/gallery/image/' + i.id + '" loading="lazy" alt=""><div class="card-meta"><span class="badge badge-' + i.type + '">' + i.type + '</span>' + (i.ticker ? '<span class="ticker">$' + i.ticker + '</span>' : '') + (i.author ? '<span class="author">' + i.author + '</span>' : '') + '<span class="ts">' + ts + '</span></div></div>';
  }).join('');
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    render();
  });
});

function openModal(src) {
  document.getElementById('modal-img').src = src;
  document.getElementById('modal').classList.add('open');
}
document.getElementById('modal').addEventListener('click', e => { if (e.target === e.currentTarget || e.target.id === 'modal-close') document.getElementById('modal').classList.remove('open'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('modal').classList.remove('open'); });

load();
</script>
</body></html>`;

module.exports = { GALLERY_HTML };
