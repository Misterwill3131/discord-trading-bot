// ─────────────────────────────────────────────────────────────────────
// pages/video-studio.js — /video-studio
// ─────────────────────────────────────────────────────────────────────
// Browse les images canvas générées par le bot (gallery) et lance des
// renders Remotion à la volée :
//
//   1. Grid des images de la gallery (proof + signal)
//   2. Click une image → modal avec :
//      - Template dropdown (aggressive-red, classic-green, gold-celebration, ...)
//      - Composition autodéterminée selon le type (signal → BoomEntry,
//        proof → ChartTemplate)
//      - Override CTA URL
//      - Bouton "Render"
//   3. Render → POST /api/video-studio/render → enqueue render_jobs
//   4. Le worker local pull et render → MP4 posté sur le canal Discord
//      configuré (RENDER_OUTPUT_CHANNEL_ID)
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

const VIDEO_STUDIO_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Video Studio — BOOM</title>
<style>
${COMMON_CSS}
#wrap { padding: 24px; }
h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.sub { color: #a0a0b0; font-size: 13px; margin-bottom: 20px; }
#count { color: #80848e; font-size: 13px; margin-left: 10px; font-weight: 400; }
.filters { display:flex; gap:10px; margin-bottom:20px; flex-wrap:wrap; align-items:center; }
.filter-btn { padding:6px 14px; border-radius:6px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04); color:#a0a0b0; cursor:pointer; font-size:13px; font-weight:500; }
.filter-btn.active { background:linear-gradient(135deg,#3b82f6 0%, #8b5cf6 100%); border-color:transparent; color:#fff; }
.filter-divider { width:1px; height:24px; background:rgba(255,255,255,0.1); margin: 0 4px; }
.filter-input { padding:6px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.04); color:#fafafa; font-size:12px; font-family:inherit; min-width: 120px; }
.filter-input:focus { outline:none; border-color:#8b5cf6; }
.filter-input::placeholder { color: #6b7280; }
.filter-clear { background:transparent; border:none; color:#80848e; cursor:pointer; font-size:12px; padding: 4px 8px; }
.filter-clear:hover { color:#fafafa; }
.filter-clear:disabled { opacity:0.3; cursor: default; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:16px; }
.card-img { background:rgba(255,255,255,0.03); border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.08); cursor:pointer; transition:all .2s; position:relative; }
.card-img:hover { transform:translateY(-2px); border-color:#8b5cf6; box-shadow: 0 8px 24px rgba(139,92,246,0.2); }
.card-img img { width:100%; display:block; }
.card-meta { padding:10px 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.badge { font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; text-transform:uppercase; letter-spacing:0.5px; }
.badge-proof { background:rgba(214,73,204,0.2); color:#d649cc; }
.badge-signal { background:rgba(59,130,246,0.2); color:#60a5fa; }
.ticker { font-size:13px; font-weight:700; color:#fafafa; }
.author { font-size:12px; color:#a0a0b0; }
.ts { font-size:11px; color:#6b7280; margin-left:auto; }
.empty { color:#6b7280; text-align:center; padding:60px 0; font-size:15px; grid-column: 1 / -1; }
.cta-overlay { position:absolute; top:8px; right:8px; background: linear-gradient(135deg, #ef4444 0%, #f97316 100%); color:white; padding:6px 12px; border-radius:8px; font-size:12px; font-weight:700; opacity:0; transition: opacity .2s; pointer-events:none; }
.card-img:hover .cta-overlay { opacity:1; }

/* Modal */
#modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:1000; align-items:center; justify-content:center; padding:30px; }
#modal.open { display:flex; }
.modal-box { background:#0f0f14; border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:24px; max-width:520px; width:100%; max-height:90vh; overflow-y:auto; }
.modal-box h2 { font-size:18px; font-weight:700; margin-bottom:12px; }
.modal-img { width:100%; border-radius:8px; margin-bottom:16px; max-height:200px; object-fit:contain; background:#000; }
.modal-meta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; align-items:center; }
.field { margin-bottom:14px; }
.field label { display:block; font-size:11px; color:#a0a0b0; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600; }
.field select, .field input[type="text"] { width:100%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:9px 12px; color:#fafafa; font-size:13px; font-family:inherit; }
.field select:focus, .field input:focus { outline:none; border-color:#8b5cf6; }
.tpl-desc { font-size:11px; color:#6b7280; margin-top:4px; font-style:italic; }
.modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
.btn { padding:10px 18px; border:none; border-radius:6px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
.btn-primary { background:linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color:white; }
.btn-primary:hover:not(:disabled) { opacity:0.9; transform:translateY(-1px); }
.btn-primary:disabled { opacity:0.4; cursor:wait; }
.btn-secondary { background:rgba(255,255,255,0.06); color:#a0a0b0; border:1px solid rgba(255,255,255,0.1); }
.btn-secondary:hover { background:rgba(255,255,255,0.1); color:#fafafa; }
#status-msg { margin-top:14px; padding:12px; border-radius:6px; font-size:13px; display:none; }
#status-msg.success { display:block; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3); color:#10b981; }
#status-msg.error { display:block; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:#ef4444; }

/* Render history */
#render-history { margin-bottom: 28px; }
.section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 12px; }
.section-head h2 { font-size:16px; font-weight:700; margin:0; }
.section-head .sub-info { font-size:12px; color:#80848e; }
.jobs-list { display:flex; gap:10px; overflow-x:auto; padding-bottom: 8px; scroll-snap-type: x proximity; }
.jobs-list::-webkit-scrollbar { height: 8px; }
.jobs-list::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); border-radius: 4px; }
.jobs-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
.job-card { flex: 0 0 240px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px; scroll-snap-align: start; transition: border-color .2s; }
.job-card:hover { border-color: rgba(139,92,246,0.4); }
.job-row { display:flex; align-items:center; justify-content:space-between; margin-bottom: 6px; }
.job-row:last-child { margin-bottom: 0; }
.job-ticker { font-size:14px; font-weight:800; color:#fafafa; }
.job-pnl { font-size:12px; font-weight:700; color:#10b981; }
.job-pnl.neg { color:#ef4444; }
.job-meta { font-size:11px; color:#80848e; }
.job-status { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; }
.job-status.pending  { background:rgba(245,158,11,0.18); color:#f59e0b; }
.job-status.done     { background:rgba(16,185,129,0.18); color:#10b981; }
.job-status.failed   { background:rgba(239,68,68,0.18); color:#ef4444; }
.job-status .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.job-status.pending .dot { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.job-tpl { font-size:11px; color:#a0a0b0; margin-top: 4px; font-style: italic; }
.job-err { font-size:11px; color:#ef4444; margin-top: 4px; word-break: break-word; max-height: 36px; overflow: hidden; }
.jobs-empty { color:#6b7280; font-size:13px; padding: 18px 0; text-align:center; width: 100%; }
.live-indicator { display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#10b981; font-weight:600; }
.live-indicator .dot { width:6px; height:6px; border-radius:50%; background:#10b981; animation: pulse 1.2s ease-in-out infinite; }
</style></head>
<body>
${sidebarHTML('/video-studio')}
<div class="page-content">
<div class="page-header"><div class="page-title">🎬 Video Studio</div></div>
<div id="wrap">
  <h1>Génère une vidéo depuis une alerte<span id="count"></span></h1>
  <p class="sub">Pick une image canvas générée par le bot (gallery) et transforme-la en vidéo Remotion auto-postée sur Discord.</p>

  <!-- Render history + live status (auto-refresh 5s) -->
  <section id="render-history">
    <div class="section-head">
      <h2>🎬 Renders récents</h2>
      <span class="sub-info"><span class="live-indicator"><span class="dot"></span>Live</span> &nbsp;·&nbsp; <span id="jobs-count">0</span> jobs</span>
    </div>
    <div class="jobs-list" id="jobs-list"><div class="jobs-empty">Chargement…</div></div>
  </section>

  <div class="section-head" style="margin-top: 8px;">
    <h2>🖼 Gallery</h2>
  </div>
  <div class="filters">
    <button class="filter-btn active" data-filter="all">Toutes</button>
    <button class="filter-btn" data-filter="proof">Proof (entry+exit)</button>
    <button class="filter-btn" data-filter="signal">Signal (entry seul)</button>
    <span class="filter-divider"></span>
    <input type="text"   id="f-ticker" class="filter-input" placeholder="Ticker (ex: TSLA)" maxlength="10" />
    <input type="text"   id="f-author" class="filter-input" placeholder="Auteur" maxlength="32" />
    <input type="date"   id="f-from"   class="filter-input" title="Date min" />
    <input type="date"   id="f-to"     class="filter-input" title="Date max" />
    <select id="f-sort" class="filter-input">
      <option value="recent">Plus récent ↓</option>
      <option value="oldest">Plus ancien ↑</option>
      <option value="ticker">Ticker A→Z</option>
    </select>
    <button class="filter-clear" id="f-clear" disabled>✕ reset</button>
  </div>
  <div class="grid" id="grid"><div class="empty">Aucune image. Le bot doit avoir traité au moins une alerte/exit pour qu'elle apparaisse ici.</div></div>
</div>
</div>

<!-- Modal -->
<div id="modal">
  <div class="modal-box">
    <h2>Render this image as video</h2>
    <img id="modal-img" class="modal-img" src="" alt="">
    <div class="modal-meta">
      <span class="badge" id="modal-type-badge"></span>
      <span class="ticker" id="modal-ticker"></span>
      <span class="author" id="modal-author"></span>
      <span class="ts" id="modal-ts"></span>
    </div>

    <div class="field">
      <label for="modal-template">Template</label>
      <select id="modal-template"></select>
      <div class="tpl-desc" id="modal-tpl-desc"></div>
    </div>

    <div class="field">
      <label for="modal-cta-url">CTA URL (override)</label>
      <input type="text" id="modal-cta-url" placeholder="discord.gg/templeofboom">
    </div>

    <div id="status-msg"></div>

    <div class="modal-actions">
      <button class="btn btn-secondary" id="btn-cancel">Cancel</button>
      <button class="btn btn-primary" id="btn-render">🎬 Render</button>
    </div>
  </div>
</div>

<script>
let allItems = [];
let templates = [];
let selectedItem = null;
let activeFilter = 'all';
let filterTicker = '';
let filterAuthor = '';
let filterFrom = '';   // YYYY-MM-DD or ''
let filterTo = '';     // YYYY-MM-DD or ''
let filterSort = 'recent';

const TEMPLATES_BY_COMPOSITION = {
  ChartTemplate: [],
  BoomEntry: [],
};

async function load() {
  // Charge gallery + templates en parallèle
  const [g, t] = await Promise.all([
    fetch('/api/gallery').then(r => r.json()),
    fetch('/api/video-studio/templates').then(r => r.json()),
  ]);
  allItems = g;
  templates = t.templates || [];
  templates.forEach(tpl => {
    if (TEMPLATES_BY_COMPOSITION[tpl.composition]) {
      TEMPLATES_BY_COMPOSITION[tpl.composition].push(tpl);
    }
  });
  render();
}

function isFilterActive() {
  return activeFilter !== 'all' || filterTicker || filterAuthor || filterFrom || filterTo || filterSort !== 'recent';
}

function applyFilters(items) {
  const tickerNeedle = filterTicker.trim().toUpperCase().replace(/^\$+/, '');
  const authorNeedle = filterAuthor.trim().toLowerCase();
  const fromMs = filterFrom ? new Date(filterFrom + 'T00:00:00').getTime() : null;
  // Date "to" est inclusive : on prend jusqu'à 23:59:59 du jour sélectionné.
  const toMs = filterTo ? new Date(filterTo + 'T23:59:59.999').getTime() : null;

  let filtered = items.filter(i => {
    if (activeFilter !== 'all' && i.type !== activeFilter) return false;
    if (tickerNeedle && !(i.ticker || '').toUpperCase().includes(tickerNeedle)) return false;
    if (authorNeedle && !(i.author || '').toLowerCase().includes(authorNeedle)) return false;
    if (fromMs || toMs) {
      const t = new Date(i.ts).getTime();
      if (fromMs && t < fromMs) return false;
      if (toMs && t > toMs) return false;
    }
    return true;
  });

  if (filterSort === 'oldest') {
    filtered.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  } else if (filterSort === 'ticker') {
    filtered.sort((a, b) => (a.ticker || '').localeCompare(b.ticker || ''));
  } else {
    // recent (default)
    filtered.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  }
  return filtered;
}

function render() {
  const grid = document.getElementById('grid');
  const filtered = applyFilters(allItems);
  document.getElementById('count').textContent = ' ' + filtered.length;
  document.getElementById('f-clear').disabled = !isFilterActive();
  if (filtered.length === 0) {
    const desc = isFilterActive() ? 'Aucune image ne matche tes filtres.' : 'Aucune image.';
    grid.innerHTML = '<div class="empty">' + desc + '</div>';
    return;
  }
  grid.innerHTML = filtered.map(i => {
    const date = new Date(i.ts);
    const fmt = date.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return '<div class="card-img" data-id="' + i.id + '" onclick="openModal(\\''+i.id+'\\')">' +
      '<span class="cta-overlay">🎬 Render</span>' +
      '<img loading="lazy" src="/gallery/image/' + i.id + '" alt="">' +
      '<div class="card-meta">' +
        '<span class="badge badge-' + i.type + '">' + i.type + '</span>' +
        '<span class="ticker">' + (i.ticker ? '$' + i.ticker.toUpperCase() : '—') + '</span>' +
        '<span class="author">' + (i.author || '?') + '</span>' +
        '<span class="ts">' + fmt + '</span>' +
      '</div></div>';
  }).join('');
}

function openModal(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  selectedItem = item;

  document.getElementById('modal-img').src = '/gallery/image/' + id;
  document.getElementById('modal-ticker').textContent = item.ticker ? '$' + item.ticker.toUpperCase() : '—';
  document.getElementById('modal-author').textContent = item.author || '?';
  const date = new Date(item.ts);
  document.getElementById('modal-ts').textContent = date.toLocaleString('fr-FR');

  const badge = document.getElementById('modal-type-badge');
  badge.textContent = item.type;
  badge.className = 'badge badge-' + item.type;

  // Composition selon le type
  const composition = item.type === 'proof' ? 'ChartTemplate' : 'BoomEntry';
  const eligibleTemplates = TEMPLATES_BY_COMPOSITION[composition] || [];

  const sel = document.getElementById('modal-template');
  sel.innerHTML = eligibleTemplates.map(t =>
    '<option value="' + t.id + '">' + t.name + ' [' + t.composition + ']</option>'
  ).join('') || '<option value="">(no template)</option>';
  updateTplDesc();
  sel.onchange = updateTplDesc;

  document.getElementById('modal-cta-url').value = '';
  document.getElementById('status-msg').className = '';
  document.getElementById('status-msg').textContent = '';
  document.getElementById('btn-render').disabled = false;

  document.getElementById('modal').classList.add('open');
}

function updateTplDesc() {
  const id = document.getElementById('modal-template').value;
  const tpl = templates.find(t => t.id === id);
  document.getElementById('modal-tpl-desc').textContent = tpl ? (tpl.description || '') : '';
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  selectedItem = null;
}

async function doRender() {
  if (!selectedItem) return;
  const templateId = document.getElementById('modal-template').value;
  const ctaUrl = document.getElementById('modal-cta-url').value.trim();

  const btn = document.getElementById('btn-render');
  btn.disabled = true;
  btn.textContent = '⏳ Enqueuing...';

  const status = document.getElementById('status-msg');
  status.className = '';
  status.textContent = '';

  try {
    const res = await fetch('/api/video-studio/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        galleryId: selectedItem.id,
        templateId,
        ctaUrl: ctaUrl || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    status.className = 'success';
    status.textContent = '✅ Job #' + data.jobId + ' enqueued. Le worker local va render dans les 30s puis poster sur Discord.';
    // Force-refresh la liste tout de suite pour voir le job apparaître
    // sans attendre le prochain tick du polling 5s.
    refreshJobs();
  } catch (e) {
    status.className = 'error';
    status.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🎬 Render';
  }
}

// ── Render history (auto-refresh) ──────────────────────────────────
let jobsCache = [];

function fmtRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.round((now - d) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.round(sec / 60) + 'm ago';
  if (sec < 86400) return Math.round(sec / 3600) + 'h ago';
  return Math.round(sec / 86400) + 'd ago';
}

function renderJobs() {
  const list = document.getElementById('jobs-list');
  const counter = document.getElementById('jobs-count');
  counter.textContent = jobsCache.length;
  if (jobsCache.length === 0) {
    list.innerHTML = '<div class="jobs-empty">Aucun render. Lance ton premier ci-dessous.</div>';
    return;
  }
  list.innerHTML = jobsCache.map(j => {
    const pnlNeg = /^-/.test(j.pnl || '');
    const ticker = j.ticker ? '$' + String(j.ticker).toUpperCase() : '—';
    const tplLabel = j.templateName || j.composition || '';
    const safePnl = (j.pnl || '').replace(/</g, '&lt;');
    const safeErr = (j.error || '').replace(/</g, '&lt;');
    return '<div class="job-card" data-id="' + j.id + '">' +
      '<div class="job-row">' +
        '<span class="job-ticker">' + ticker + '</span>' +
        '<span class="job-pnl' + (pnlNeg ? ' neg' : '') + '">' + safePnl + '</span>' +
      '</div>' +
      '<div class="job-row">' +
        '<span class="job-status ' + j.status + '"><span class="dot"></span>' + j.status + '</span>' +
        '<span class="job-meta">#' + j.id + ' · ' + fmtRelativeTime(j.createdAt) + '</span>' +
      '</div>' +
      (tplLabel ? '<div class="job-tpl">' + tplLabel + '</div>' : '') +
      (j.status === 'failed' && j.error ? '<div class="job-err">⚠ ' + safeErr + '</div>' : '') +
    '</div>';
  }).join('');
}

async function refreshJobs() {
  try {
    const res = await fetch('/api/video-studio/jobs?limit=30');
    const data = await res.json();
    if (Array.isArray(data.jobs)) {
      jobsCache = data.jobs;
      renderJobs();
    }
  } catch (e) {
    console.warn('[video-studio] refreshJobs failed:', e.message);
  }
}

// Polling toutes les 5s pour le statut live. Pause quand l'onglet est
// caché (économise CPU + requests si le user a la page ouverte 8h).
let jobsTimer = null;
function startJobsPolling() {
  if (jobsTimer) return;
  refreshJobs();
  jobsTimer = setInterval(refreshJobs, 5000);
}
function stopJobsPolling() {
  if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopJobsPolling();
  else startJobsPolling();
});

// Wire up filter buttons + inputs + modal close
document.querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  activeFilter = b.dataset.filter;
  render();
}));

// Filter inputs (text/date/sort). Debounce light pour les inputs texte
// (sinon ça re-render à chaque keypress sur 100+ images).
let filterDebounce = null;
function onFilterChange() {
  if (filterDebounce) clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => {
    filterTicker = document.getElementById('f-ticker').value;
    filterAuthor = document.getElementById('f-author').value;
    filterFrom = document.getElementById('f-from').value;
    filterTo = document.getElementById('f-to').value;
    filterSort = document.getElementById('f-sort').value;
    render();
  }, 120);
}
['f-ticker','f-author','f-from','f-to','f-sort'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', onFilterChange);
  if (el) el.addEventListener('change', onFilterChange);
});

document.getElementById('f-clear').addEventListener('click', () => {
  activeFilter = 'all';
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  ['f-ticker','f-author','f-from','f-to'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('f-sort').value = 'recent';
  filterTicker = ''; filterAuthor = ''; filterFrom = ''; filterTo = ''; filterSort = 'recent';
  render();
});
document.getElementById('btn-cancel').addEventListener('click', closeModal);
document.getElementById('btn-render').addEventListener('click', doRender);
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

load();
startJobsPolling();
</script>
</body></html>`;

module.exports = { VIDEO_STUDIO_HTML };
