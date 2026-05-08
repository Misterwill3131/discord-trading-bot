// ─────────────────────────────────────────────────────────────────────
// editor/app.js — Frontend du Boom Editor
// ─────────────────────────────────────────────────────────────────────
// Form intelligent qui :
//   - Charge la liste des templates depuis /api/templates
//   - Quand on click un template, charge ses props et build le form
//   - Détecte le type de chaque champ (color, number, boolean, string)
//     et rend le widget adapté (color picker, slider, checkbox, etc.)
//   - Groupe par catégorie (Identity / Texts / Visuals / Audio / Etc.)
//   - Bouton "Preview frame" appelle /api/still pour preview rapide
//   - Bouton "Render MP4" appelle /api/render + stream les logs
// ─────────────────────────────────────────────────────────────────────

'use strict';

// ── État global ──
let currentTemplate = null;  // { composition, name, description, props } chargé / en cours d'édit
let currentTemplateId = null;

// ── Catégorisation des champs (heuristique) ──
const FIELD_GROUPS = [
  { title: 'Identité du trade', match: ['ticker', 'author', 'message', 'timestamp', 'pnl', 'entry', 'target', 'stop', 'direction', 'type', 'entryAuthor', 'exitAuthor', 'entryMessage', 'exitMessage', 'entryTimestamp', 'exitTimestamp'] },
  { title: 'Textes affichés', match: ['Text', 'Action', 'Subtext', 'Label', 'Title', 'Url', 'Subtitle'] },
  { title: 'Couleurs', match: ['Color', 'color'] },
  { title: 'Audio', match: ['music', 'sfx', 'audio', 'volume'] },
  { title: 'Tailles & font', match: ['FontSize', 'fontSize', 'size', 'transition'] },
  { title: 'Lifestyle', match: ['lifestyle', 'Lifestyle'] },
  { title: 'Image', match: ['Image', 'image', 'DataUrl'] },
  { title: 'Autre', match: [] },  // catch-all
];

// Champs à NE PAS afficher dans le form (data URLs, etc.)
const HIDDEN_FIELDS = ['proofImageDataUrl', 'entryImageDataUrl'];

function categorizeField(key) {
  for (let i = 0; i < FIELD_GROUPS.length; i++) {
    const g = FIELD_GROUPS[i];
    if (i === FIELD_GROUPS.length - 1) return i; // catch-all
    if (g.match.some(m => key.includes(m))) return i;
  }
  return FIELD_GROUPS.length - 1;
}

// ── Loaders ──
async function loadTemplates() {
  const res = await fetch('/api/templates');
  const { templates } = await res.json();
  const ul = document.getElementById('templates-list');
  ul.innerHTML = '';
  templates.forEach(t => {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    li.innerHTML = `
      <div class="tpl-name">${escapeHtml(t.name)}</div>
      <div class="tpl-comp">${escapeHtml(t.composition)}</div>
    `;
    li.onclick = () => loadTemplate(t.id);
    ul.appendChild(li);
  });
}

async function loadTemplate(id) {
  const res = await fetch(`/api/template/${id}`);
  if (!res.ok) return toast('Failed to load template', 'error');
  const data = await res.json();
  currentTemplate = data;
  currentTemplateId = id;

  // Highlight selected
  document.querySelectorAll('#templates-list li').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  // Fill header
  document.getElementById('template-id').value = id;
  document.getElementById('template-composition').value = data.composition;
  document.getElementById('template-name').value = data.name || '';
  document.getElementById('template-description').value = data.description || '';

  buildForm(data.props || {});
  enableActions(true);
}

// ── Build form dynamique selon les types ──
function buildForm(props) {
  const container = document.getElementById('props-form');
  container.innerHTML = '';

  // Group fields
  const groups = FIELD_GROUPS.map(g => ({ ...g, fields: [] }));
  Object.entries(props).forEach(([key, value]) => {
    if (HIDDEN_FIELDS.includes(key)) return;
    groups[categorizeField(key)].fields.push({ key, value });
  });

  groups.forEach(g => {
    if (g.fields.length === 0) return;
    const section = document.createElement('div');
    section.className = 'section';
    section.innerHTML = `<div class="section-title">${g.title}</div>`;
    g.fields.forEach(({ key, value }) => {
      section.appendChild(buildField(key, value));
    });
    container.appendChild(section);
  });
}

// Champs texte qui supportent l'AI suggest (les champs marketing-y).
const AI_ELIGIBLE_FIELDS = new Set([
  'stingerText', 'teaseAction', 'teaseSubtext',
  'cardLabel', 'ctaTitle', 'ctaUrl', 'ctaSubtitle',
]);

function buildField(key, value) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.key = key;
  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = humanize(key);
  wrap.appendChild(label);

  // Detect type
  if (typeof value === 'boolean') {
    wrap.appendChild(buildBoolInput(key, value));
  } else if (typeof value === 'number') {
    wrap.appendChild(buildRangeInput(key, value));
  } else if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
    wrap.appendChild(buildColorInput(key, value));
  } else if (typeof value === 'string' && (key.toLowerCase().includes('message') || (typeof value === 'string' && value.length > 50))) {
    wrap.appendChild(buildTextarea(key, value));
  } else if (value === null || value === undefined) {
    wrap.appendChild(buildTextInputWithAi(key, ''));
  } else {
    wrap.appendChild(buildTextInputWithAi(key, String(value)));
  }
  return wrap;
}

// Text input + bouton ✨ AI (uniquement pour les champs eligible).
function buildTextInputWithAi(key, val) {
  if (!AI_ELIGIBLE_FIELDS.has(key)) {
    return buildTextInput(key, val);
  }
  const wrap = document.createElement('div');
  wrap.className = 'field-with-ai';
  const i = document.createElement('input');
  i.type = 'text';
  i.value = val;
  i.dataset.key = key;
  i.className = 'prop-input';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-ai';
  btn.title = 'Suggérer des variations via IA';
  btn.innerHTML = '<span class="icon">✨</span>';
  btn.onclick = (e) => onAiSuggest(e, key, i, btn);
  wrap.appendChild(i);
  wrap.appendChild(btn);
  return wrap;
}

async function onAiSuggest(e, key, inputEl, btnEl) {
  e.preventDefault();
  const composition = document.getElementById('template-composition').value;
  const props = collectProps();
  const currentValue = inputEl.value;

  // UI : spinner + disable
  btnEl.disabled = true;
  const icon = btnEl.querySelector('.icon');
  icon.classList.add('spinning');
  icon.textContent = '⟳';

  try {
    const res = await fetch('/api/ai/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: key,
        currentValue,
        context: { composition, ...props },
        count: 5,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'AI failed', 'error');
      return;
    }
    showSuggestions(inputEl, data.suggestions || []);
  } catch (err) {
    toast('AI error: ' + err.message, 'error');
  } finally {
    btnEl.disabled = false;
    icon.classList.remove('spinning');
    icon.textContent = '✨';
  }
}

function showSuggestions(inputEl, suggestions) {
  // Retire un popup existant.
  const existing = inputEl.parentElement.parentElement.querySelector('.suggestions-popup');
  if (existing) existing.remove();

  if (!suggestions.length) {
    toast('No suggestions returned', 'error');
    return;
  }

  const popup = document.createElement('div');
  popup.className = 'suggestions-popup';

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.onclick = () => popup.remove();
  popup.appendChild(close);

  suggestions.forEach(s => {
    const opt = document.createElement('div');
    opt.className = 'suggestion';
    opt.textContent = s;
    opt.onclick = () => {
      inputEl.value = s;
      // Trigger 'input' event for any listeners
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      popup.remove();
      toast('Applied', 'success');
    };
    popup.appendChild(opt);
  });

  // Insert after the field-with-ai
  inputEl.parentElement.parentElement.appendChild(popup);
}

function buildTextInput(key, val) {
  const i = document.createElement('input');
  i.type = 'text';
  i.value = val;
  i.dataset.key = key;
  i.className = 'prop-input';
  return i;
}
function buildTextarea(key, val) {
  const t = document.createElement('textarea');
  t.value = val;
  t.dataset.key = key;
  t.className = 'prop-input';
  return t;
}
function buildBoolInput(key, val) {
  const wrap = document.createElement('div');
  wrap.className = 'field-bool';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!val;
  cb.dataset.key = key;
  cb.className = 'prop-input';
  cb.id = `cb-${key}`;
  const span = document.createElement('label');
  span.htmlFor = cb.id;
  span.textContent = val ? 'Activé' : 'Désactivé';
  span.style.color = 'var(--muted)';
  cb.onchange = () => { span.textContent = cb.checked ? 'Activé' : 'Désactivé'; };
  wrap.appendChild(cb);
  wrap.appendChild(span);
  return wrap;
}
function buildRangeInput(key, val) {
  const wrap = document.createElement('div');
  wrap.className = 'field-range';
  const r = document.createElement('input');
  r.type = 'range';
  // Heuristic min/max selon le nom
  if (/volume/i.test(key)) { r.min = 0; r.max = 1; r.step = 0.05; }
  else if (/FontSize|fontSize/.test(key)) { r.min = 80; r.max = 400; r.step = 5; }
  else { r.min = 0; r.max = Math.max(val * 2, 100); r.step = 1; }
  r.value = val;
  r.dataset.key = key;
  r.className = 'prop-input';
  const display = document.createElement('span');
  display.className = 'range-value';
  display.textContent = val;
  r.oninput = () => { display.textContent = r.value; };
  wrap.appendChild(r);
  wrap.appendChild(display);
  return wrap;
}
function buildColorInput(key, val) {
  const wrap = document.createElement('div');
  wrap.className = 'field-color';
  const c = document.createElement('input');
  c.type = 'color';
  c.value = val;
  const t = document.createElement('input');
  t.type = 'text';
  t.value = val;
  t.dataset.key = key;
  t.className = 'prop-input';
  c.oninput = () => { t.value = c.value; };
  t.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(t.value)) c.value = t.value; };
  wrap.appendChild(c);
  wrap.appendChild(t);
  return wrap;
}

// ── Collect form data → props object ──
function collectProps() {
  const props = { ...(currentTemplate?.props || {}) };
  document.querySelectorAll('.prop-input').forEach(el => {
    const key = el.dataset.key;
    if (!key) return;
    if (el.type === 'checkbox') props[key] = el.checked;
    else if (el.type === 'range' || el.type === 'number') props[key] = parseFloat(el.value);
    else props[key] = el.value;
  });
  return props;
}

// ── Action handlers ──
function enableActions(enabled) {
  ['btn-preview', 'btn-save', 'btn-render'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
}

document.getElementById('btn-new').onclick = () => {
  const id = prompt('ID du nouveau template (slug) :');
  if (!id || !/^[a-z0-9-]+$/i.test(id)) return toast('ID invalid (alphanumeric + dashes only)', 'error');
  // Default à BoomEntry pour un nouveau template
  currentTemplate = {
    composition: 'BoomEntry',
    name: id,
    description: '',
    props: {
      ticker: 'TSLA', author: 'Z',
      message: '$TSLA 150-155 entry long',
      timestamp: '2026-04-25T13:32:00-04:00',
      stingerText: '🚨 LIVE',
      teaseAction: 'just called this.',
      teaseSubtext: 'Watch live →',
      cardLabel: '🚨 LIVE SIGNAL',
      ctaTitle: 'JOIN', ctaUrl: 'discord.gg/boom',
      ctaSubtitle: 'Get every signal live',
      accentColor: '#ef4444',
      musicVolume: 0.55, sfxEnabled: true,
      stingerFontSize: 220, tickerFontSize: 280, ctaTitleFontSize: 200,
      transitionType: 'fade',
    },
  };
  currentTemplateId = id;
  document.getElementById('template-id').value = id;
  document.getElementById('template-composition').value = 'BoomEntry';
  document.getElementById('template-name').value = id;
  document.getElementById('template-description').value = '';
  buildForm(currentTemplate.props);
  enableActions(true);
};

document.getElementById('btn-save').onclick = async () => {
  const id = document.getElementById('template-id').value.trim();
  if (!/^[a-z0-9-]+$/i.test(id)) return toast('ID invalid', 'error');
  const body = {
    composition: document.getElementById('template-composition').value,
    name: document.getElementById('template-name').value,
    description: document.getElementById('template-description').value,
    props: collectProps(),
  };
  const res = await fetch(`/api/template/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    return toast(`Save failed: ${err.error}`, 'error');
  }
  toast(`Saved ${id}.json`, 'success');
  loadTemplates();
};

document.getElementById('btn-preview').onclick = async () => {
  const composition = document.getElementById('template-composition').value;
  const props = collectProps();
  const frame = composition === 'BoomEntry' ? 220 : composition === 'BoomProof' ? 380 : 130;
  const url = `/api/still?composition=${composition}&frame=${frame}&props=${encodeURIComponent(JSON.stringify(props))}`;
  toast('Rendering preview...', '');
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(`Preview failed: ${err.error || res.statusText}`, 'error');
  }
  const { dataUrl } = await res.json();
  const frameEl = document.getElementById('preview-frame');
  frameEl.innerHTML = `<img src="${dataUrl}" alt="preview frame ${frame}">`;
  toast('Preview ready', 'success');
};

document.getElementById('btn-render').onclick = async () => {
  const composition = document.getElementById('template-composition').value;
  const props = collectProps();
  const id = document.getElementById('template-id').value.trim() || 'untitled';
  const filename = `${id}.mp4`;

  const out = document.getElementById('render-output');
  out.innerHTML = `<span class="ok">▶ Starting render...</span>\n`;

  const res = await fetch('/api/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ composition, props, outFilename: filename }),
  });
  const { jobId } = await res.json();

  // Stream logs via SSE
  const evt = new EventSource(`/api/render-stream/${jobId}`);
  evt.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.log) out.textContent += data.log;
    if (data.done !== undefined) {
      if (data.exitCode === 0) {
        out.innerHTML += `\n<span class="ok">✅ Done.</span> <a href="/out/${data.filename}" target="_blank">▶ Open ${data.filename}</a>`;
        toast('Render complete', 'success');
      } else {
        out.innerHTML += `\n<span class="err">❌ Render failed (exit ${data.exitCode}).</span>`;
        toast('Render failed', 'error');
      }
      evt.close();
    }
    out.scrollTop = out.scrollHeight;
  };
};

// ── Helpers ──
function humanize(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (type || '');
  setTimeout(() => el.classList.add('hidden'), 3000);
  el.classList.remove('hidden');
}

// ── Boot ──
loadTemplates();
