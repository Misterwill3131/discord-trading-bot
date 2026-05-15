// ─────────────────────────────────────────────────────────────────────
// pages/video-templates-editor.js — /video-studio/templates
// ─────────────────────────────────────────────────────────────────────
// Liste les templates Remotion (video/templates/*.json) et permet :
//   - Voir leurs métadonnées (name, composition, description)
//   - Éditer les props en JSON inline (avec validation)
//   - Save → écrit le fichier sur disque (côté server)
//
// Backend : GET/PUT /api/video-studio/templates et :id (cf routes/video-studio.js)
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

const VIDEO_TEMPLATES_EDITOR_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Templates Editor — BOOM</title>
<style>
${COMMON_CSS}
#wrap { padding: 24px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.sub { color: #a0a0b0; font-size: 13px; margin-bottom: 20px; }

.layout { display: grid; grid-template-columns: 280px 1fr; gap: 18px; align-items: start; }
.tpl-list { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px; max-height: calc(100vh - 200px); overflow-y: auto; }
.tpl-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; transition: all .15s; }
.tpl-item:hover { background: rgba(255,255,255,0.04); }
.tpl-item.active { background: linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(139,92,246,0.18) 100%); border-left: 3px solid #8b5cf6; padding-left: 9px; }
.tpl-row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.tpl-swatch { width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0; }
.tpl-name { font-size: 13px; font-weight: 700; color: #fafafa; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.tpl-comp { font-size: 10px; color: #80848e; text-transform: uppercase; letter-spacing: 0.5px; }
.tpl-desc { font-size: 11px; color: #a0a0b0; font-style: italic; line-height: 1.3; }

.editor { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 18px; }
.editor h2 { font-size: 16px; font-weight: 700; margin: 0 0 12px 0; display: flex; align-items: center; gap: 10px; }
.editor h2 .swatch-lg { width: 24px; height: 24px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 11px; color: #a0a0b0; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.field input, .field textarea, .field select { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 9px 12px; color: #fafafa; font-size: 13px; font-family: inherit; }
.field input:focus, .field textarea:focus, .field select:focus { outline: none; border-color: #8b5cf6; }
.field input[readonly] { color: #80848e; cursor: not-allowed; }
.field textarea { font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace; font-size: 12px; line-height: 1.5; min-height: 280px; resize: vertical; }
.helper { font-size: 11px; color: #80848e; margin-top: 4px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); }
.btn { padding: 9px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
.btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: white; }
.btn-primary:disabled { opacity: 0.4; cursor: wait; }
.btn-secondary { background: rgba(255,255,255,0.06); color: #a0a0b0; border: 1px solid rgba(255,255,255,0.1); }
.btn-secondary:hover { background: rgba(255,255,255,0.1); color: #fafafa; }
#status { margin-top: 12px; padding: 10px 12px; border-radius: 6px; font-size: 12px; display: none; }
#status.success { display: block; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; }
#status.error { display: block; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; }
.empty-state { color: #6b7280; text-align: center; padding: 40px 20px; font-size: 14px; }
</style></head>
<body>
${sidebarHTML('/video-studio')}
<div class="page-content">
<div class="page-header"><div class="page-title">🎬 Templates Editor</div></div>
<div id="wrap">
  <h1>Templates Remotion</h1>
  <p class="sub">Édite les presets <code>video/templates/*.json</code> directement. Les changements sont écrits sur disque immédiatement.</p>

  <div class="layout">
    <div class="tpl-list" id="tpl-list">Chargement…</div>
    <div class="editor" id="editor">
      <div class="empty-state">← Sélectionne un template à gauche pour l'éditer.</div>
    </div>
  </div>
</div>
</div>

<script>
let templates = [];
let currentId = null;
let currentTpl = null;

async function loadList() {
  const r = await fetch('/api/video-studio/templates');
  const data = await r.json();
  templates = data.templates || [];
  renderList();
}

function renderList() {
  const list = document.getElementById('tpl-list');
  if (templates.length === 0) {
    list.innerHTML = '<div class="empty-state">Aucun template.</div>';
    return;
  }
  list.innerHTML = templates.map(t => {
    const accent = (t.props && t.props.accentColor) || '#6b7280';
    const active = t.id === currentId ? ' active' : '';
    const safeName = (t.name || t.id).replace(/</g, '&lt;');
    const safeDesc = (t.description || '').replace(/</g, '&lt;');
    return '<div class="tpl-item' + active + '" data-id="' + t.id + '" onclick="selectTpl(\\''+t.id+'\\')">' +
      '<div class="tpl-row1">' +
        '<span class="tpl-swatch" style="background:' + accent + ';"></span>' +
        '<span class="tpl-name">' + safeName + '</span>' +
        '<span class="tpl-comp">' + t.composition + '</span>' +
      '</div>' +
      (safeDesc ? '<div class="tpl-desc">' + safeDesc + '</div>' : '') +
    '</div>';
  }).join('');
}

async function selectTpl(id) {
  currentId = id;
  renderList();
  const editor = document.getElementById('editor');
  editor.innerHTML = '<div class="empty-state">Chargement de ' + id + '…</div>';
  try {
    const r = await fetch('/api/video-studio/templates/' + encodeURIComponent(id));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    currentTpl = await r.json();
    renderEditor();
  } catch (e) {
    editor.innerHTML = '<div class="empty-state">❌ Échec chargement : ' + e.message + '</div>';
  }
}

function renderEditor() {
  if (!currentTpl) return;
  const accent = (currentTpl.props && currentTpl.props.accentColor) || '#6b7280';
  const propsJson = JSON.stringify(currentTpl.props || {}, null, 2);
  const editor = document.getElementById('editor');
  editor.innerHTML =
    '<h2><span class="swatch-lg" style="background:' + accent + ';"></span>Edit: ' + currentTpl.id + '</h2>' +
    '<div class="field">' +
      '<label>ID (filename)</label>' +
      '<input type="text" id="ed-id" value="' + currentTpl.id + '" readonly>' +
      '<div class="helper">Le filename est immuable. Pour renommer, crée un nouveau fichier.</div>' +
    '</div>' +
    '<div class="field">' +
      '<label>Nom (lisible)</label>' +
      '<input type="text" id="ed-name" value="' + (currentTpl.name || '').replace(/"/g,'&quot;') + '">' +
    '</div>' +
    '<div class="field">' +
      '<label>Composition</label>' +
      '<select id="ed-comp">' +
        ['ChartTemplate', 'BoomEntry', 'BoomRecap', 'TobTradeRecap', 'TobBrandStory', 'SignalAlert', 'BrandPromo']
          .map(c => '<option value="' + c + '"' + (c === currentTpl.composition ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select>' +
    '</div>' +
    '<div class="field">' +
      '<label>Description</label>' +
      '<input type="text" id="ed-desc" value="' + (currentTpl.description || '').replace(/"/g,'&quot;') + '">' +
    '</div>' +
    '<div class="field">' +
      '<label>Props (JSON)</label>' +
      '<textarea id="ed-props" spellcheck="false">' + propsJson + '</textarea>' +
      '<div class="helper">Tout l\\'objet props du template. Valide JSON requis. Surchargeable par job via <code>props_override</code>.</div>' +
    '</div>' +
    '<div id="status"></div>' +
    '<div class="actions">' +
      '<button class="btn btn-secondary" onclick="selectTpl(currentId)">Cancel (reload)</button>' +
      '<button class="btn btn-primary" id="btn-save" onclick="saveTpl()">💾 Save</button>' +
    '</div>';
}

async function saveTpl() {
  if (!currentTpl) return;
  const status = document.getElementById('status');
  status.className = '';
  status.textContent = '';

  // Parse + valide les props JSON.
  let props;
  try {
    props = JSON.parse(document.getElementById('ed-props').value);
  } catch (e) {
    status.className = 'error';
    status.textContent = '❌ JSON props invalide : ' + e.message;
    return;
  }
  if (typeof props !== 'object' || Array.isArray(props)) {
    status.className = 'error';
    status.textContent = '❌ Props doit être un objet (pas un array ni primitive).';
    return;
  }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = '⏳ Saving…';
  try {
    const body = {
      composition: document.getElementById('ed-comp').value,
      name: document.getElementById('ed-name').value,
      description: document.getElementById('ed-desc').value,
      props,
    };
    const r = await fetch('/api/video-studio/templates/' + encodeURIComponent(currentTpl.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    status.className = 'success';
    status.textContent = '✅ Template "' + currentTpl.id + '" sauvegardé. Le worker l\\'utilisera au prochain render.';
    // Reload la liste pour refresh accent swatch + name si changés.
    await loadList();
    currentTpl = { ...currentTpl, ...body };
  } catch (e) {
    status.className = 'error';
    status.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save';
  }
}

loadList();
</script>
</body></html>`;

module.exports = { VIDEO_TEMPLATES_EDITOR_HTML };
