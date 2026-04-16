# Profits Review & Learning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every message received in the Discord `#profits` channel, provide a review UI on `/profits` to mark each as "good" or "not a profit", and have the bot learn blocked/allowed phrases from corrections.

**Architecture:** New daily files `profit-messages-YYYY-MM-DD.json` hold every message received in `#profits`. A new `profit-filters.json` stores learned phrases (separate from trading filters). The Discord handler consults these filters before counting. Three new API endpoints back a collapsible panel on `/profits`.

**Tech Stack:** Node.js, Express, discord.js — all changes live in `index.js`. No new dependencies.

---

## File Map

All changes in `index.js` (line numbers approximate — search by content):

| Section | Change |
|---------|--------|
| Helpers (~line 105, after `hasProfitPattern`) | Add `loadProfitMessages`, `saveProfitMessages`, `loadProfitFilters`, `saveProfitFilters`, `truncatePhrase`, `profitFiltersMatch`; init `let profitFilters = loadProfitFilters();` |
| `#profits` handler (~line 4573) | Replace to compute filter decision, store every message, count only when decision says count |
| API endpoints (in the existing `/api/*` zone, e.g. after `/api/profits-bot-silent` ~line 2290) | Add `GET /api/profit-messages`, `POST /api/profit-feedback`, `GET /api/profit-filters` |
| `PROFITS_PAGE_HTML` (~line 2320 + JS inside it) | Add collapsible panel CSS + HTML + JS (uses COMMON_CSS for base styles) |

---

## Task 1: Helpers and globals

**Files:**
- Modify: `index.js` — insert a new block right before `// Last generated promo image` (the line `let lastPromoImageBuffer = null;`)

- [ ] **Step 1: Insert the new helpers block**

Find this exact line in `index.js`:
```
// Last generated promo image
let lastPromoImageBuffer = null;
```

Insert the following block **immediately before** it:

```javascript
// ─────────────────────────────────────────────────────────────────────
//  Profits review — per-message storage + learning filters
// ─────────────────────────────────────────────────────────────────────
const PROFIT_FILTERS_PATH = path.join(__dirname, 'profit-filters.json');
const PROFIT_PHRASE_MAX = 120;

function loadProfitMessages(dateKey) {
  try {
    const filePath = path.join(DATA_DIR, 'profit-messages-' + dateKey + '.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('[profits-msg] Failed to load profit-messages-' + dateKey + '.json:', e.message);
  }
  return [];
}

function saveProfitMessages(dateKey, msgs) {
  try {
    const filePath = path.join(DATA_DIR, 'profit-messages-' + dateKey + '.json');
    fs.writeFileSync(filePath, JSON.stringify(msgs, null, 2), 'utf8');
  } catch (e) {
    console.error('[profits-msg] Failed to save profit-messages-' + dateKey + '.json:', e.message);
  }
}

function loadProfitFilters() {
  try {
    if (fs.existsSync(PROFIT_FILTERS_PATH)) {
      const data = JSON.parse(fs.readFileSync(PROFIT_FILTERS_PATH, 'utf8'));
      return { blocked: Array.isArray(data.blocked) ? data.blocked : [], allowed: Array.isArray(data.allowed) ? data.allowed : [] };
    }
  } catch (e) {
    console.error('[profit-filters] Failed to load profit-filters.json:', e.message);
  }
  return { blocked: [], allowed: [] };
}

function saveProfitFilters() {
  try {
    fs.writeFileSync(PROFIT_FILTERS_PATH, JSON.stringify(profitFilters, null, 2), 'utf8');
  } catch (e) {
    console.error('[profit-filters] Failed to save profit-filters.json:', e.message);
  }
}

function truncatePhrase(s) {
  const str = String(s || '').trim();
  return str.length > PROFIT_PHRASE_MAX ? str.slice(0, PROFIT_PHRASE_MAX) : str;
}

function profitFiltersMatch(list, content) {
  if (!content || !list || !list.length) return false;
  const lower = String(content).toLowerCase();
  for (const phrase of list) {
    if (!phrase) continue;
    if (lower.includes(String(phrase).toLowerCase())) return true;
  }
  return false;
}

let profitFilters = loadProfitFilters();
// ─────────────────────────────────────────────────────────────────────

```

- [ ] **Step 2: Verify syntax**

Run: `node --check index.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(profits-review): add storage + filter helpers"
```

---

## Task 2: Modify `#profits` Discord handler

**Files:**
- Modify: `index.js` — the `client.on('messageCreate', ...)` handler that begins with `if (!PROFITS_CHANNEL_ID) return;` (~line 4573, inside the block titled "Profit counter — écoute #profits pour les messages avec images")

- [ ] **Step 1: Replace the entire handler body**

Find this exact block in `index.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
//  Profit counter — écoute #profits pour les messages avec images
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!PROFITS_CHANNEL_ID) return;
  if (message.channel.id !== PROFITS_CHANNEL_ID) return;

  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
  const hasImage = message.attachments.some(a =>
    (a.contentType && a.contentType.startsWith('image/')) ||
    (a.url && IMAGE_EXT.test(a.url)) ||
    (a.name && IMAGE_EXT.test(a.name))
  );
  const content = message.content || '';
  const textCount = countProfitEntries(content);
  const hasTicker = !!detectTicker(content);

  // Ignorer si aucun signal détecté (ni image, ni price range, ni ticker)
  if (!hasImage && textCount === 0 && !hasTicker) return;

  // Priorité : price ranges > image/ticker seul
  // Ticker seul ou image seule → 1 profit
  const profitCount = textCount > 0 ? textCount : 1;

  const reason = hasImage ? 'image' : (textCount > 0 ? 'price range(s)' : 'ticker');
  console.log('[profits] ' + reason + ' in #profits from ' + message.author.username + ' → ' + profitCount + ' profit(s)');
  await addProfitMessage(content);
});
```

Replace with:

```javascript
// ─────────────────────────────────────────────────────────────────────
//  Profit counter — écoute #profits pour les messages avec images
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!PROFITS_CHANNEL_ID) return;
  if (message.channel.id !== PROFITS_CHANNEL_ID) return;

  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
  const hasImage = message.attachments.some(a =>
    (a.contentType && a.contentType.startsWith('image/')) ||
    (a.url && IMAGE_EXT.test(a.url)) ||
    (a.name && IMAGE_EXT.test(a.name))
  );
  const content = message.content || '';
  const textCount = countProfitEntries(content);
  const hasTicker = !!detectTicker(content);

  // Decide whether to count, consulting learned filters first
  let counted;
  let reason;
  if (profitFiltersMatch(profitFilters.blocked, content)) {
    counted = false;
    reason = 'learned-blocked';
  } else if (profitFiltersMatch(profitFilters.allowed, content)) {
    counted = true;
    reason = 'learned-allowed';
  } else if (hasImage) {
    counted = true;
    reason = 'image';
  } else if (textCount > 0) {
    counted = true;
    reason = 'price range(s)';
  } else if (hasTicker) {
    counted = true;
    reason = 'ticker';
  } else {
    counted = false;
    reason = 'ignored';
  }

  // Always store the message, even ignored ones
  const dateKey = todayKey();
  const msgs = loadProfitMessages(dateKey);
  msgs.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    author: message.author.username,
    content,
    preview: content.length > PROFIT_PHRASE_MAX ? content.slice(0, PROFIT_PHRASE_MAX) + '…' : content,
    hasImage,
    hasTicker,
    textCount,
    counted,
    reason,
    feedback: null,
  });
  saveProfitMessages(dateKey, msgs);

  console.log('[profits] ' + reason + ' in #profits from ' + message.author.username + ' → counted=' + counted);

  if (counted) {
    await addProfitMessage(content);
  }
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check index.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(profits-review): store all #profits messages and apply learned filters"
```

---

## Task 3: API endpoints

**Files:**
- Modify: `index.js` — insert three new routes after the existing `app.post('/api/profits-bot-silent', ...)` handler. Search for the line containing `app.post('/api/profits-bot-silent'` and find the closing `});` that ends it.

- [ ] **Step 1: Insert the three endpoints**

Find this exact line in `index.js`:
```
app.post('/api/webhook/profits', async (req, res) => {
```

Insert the following block **immediately before** it:

```javascript
// ─────────────────────────────────────────────────────────────────────
//  Profits review API — messages list, feedback, filters
// ─────────────────────────────────────────────────────────────────────
app.get('/api/profit-messages', requireAuth, (req, res) => {
  const date = String(req.query.date || todayKey());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });
  const filter = String(req.query.filter || 'all');
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 50;

  let msgs = loadProfitMessages(date);
  if (filter === 'counted') msgs = msgs.filter(m => m.counted === true);
  else if (filter === 'ignored') msgs = msgs.filter(m => m.counted === false);
  else if (filter === 'flagged') msgs = msgs.filter(m => m.feedback != null);

  msgs.sort((a, b) => (a.ts || '') < (b.ts || '') ? 1 : -1);

  const total = msgs.length;
  const start = (page - 1) * pageSize;
  const pageMsgs = msgs.slice(start, start + pageSize);

  res.json({ date, total, page, pageSize, messages: pageMsgs });
});

app.post('/api/profit-feedback', requireAuth, (req, res) => {
  const id = String(req.body?.id || '');
  const content = String(req.body?.content || '');
  const action = String(req.body?.action || '');

  if (action === 'unblock-blocked') {
    profitFilters.blocked = (profitFilters.blocked || []).filter(p => p !== content);
    saveProfitFilters();
    return res.json({ ok: true, profitFilters });
  }
  if (action === 'unblock-allowed') {
    profitFilters.allowed = (profitFilters.allowed || []).filter(p => p !== content);
    saveProfitFilters();
    return res.json({ ok: true, profitFilters });
  }

  const phrase = truncatePhrase(content);
  if (!phrase) return res.status(400).json({ error: 'empty content' });

  if (action === 'block') {
    if (!profitFilters.blocked.includes(phrase)) profitFilters.blocked.push(phrase);
  } else if (action === 'allow') {
    if (!profitFilters.allowed.includes(phrase)) profitFilters.allowed.push(phrase);
  } else {
    return res.status(400).json({ error: 'invalid action' });
  }
  saveProfitFilters();

  // Update feedback on the stored message (search today + last 30 days)
  if (id) {
    const targetFeedback = action === 'block' ? 'bad' : 'good';
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dk = d.toISOString().slice(0, 10);
      const msgs = loadProfitMessages(dk);
      let changed = false;
      for (const m of msgs) {
        if (m.id === id) { m.feedback = targetFeedback; changed = true; break; }
      }
      if (changed) { saveProfitMessages(dk, msgs); break; }
    }
  }

  res.json({ ok: true, profitFilters });
});

app.get('/api/profit-filters', requireAuth, (req, res) => {
  res.json(profitFilters);
});

```

- [ ] **Step 2: Verify syntax**

Run: `node --check index.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(profits-review): add API endpoints for messages, feedback, filters"
```

---

## Task 4: Extend `PROFITS_PAGE_HTML` with collapsible review panel

**Files:**
- Modify: `index.js` — `PROFITS_PAGE_HTML` constant

This task has three focused sub-steps: add CSS, add HTML, add JS.

- [ ] **Step 1: Add CSS rules**

Find the line in `PROFITS_PAGE_HTML`'s `<style>` block that ends with the `.btn-add` (or the last rule — look for the `</style>` tag that closes this page's style block). Just before `</style>`, insert the new rules.

Find:
```
</style>
</head>
<body>
${sidebarHTML('/profits')}
```

Replace with:
```
  /* Review panel */
  #review-panel { margin-top: 24px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; overflow: hidden; }
  #review-toggle { width: 100%; background: transparent; border: none; color: #fafafa; padding: 14px 20px; text-align: left; cursor: pointer; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
  #review-toggle:hover { background: rgba(255,255,255,0.03); }
  #review-body { display: none; padding: 16px 20px; background: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
  #review-body.open { display: block; }
  .review-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  .review-controls label { font-size: 12px; color: #a0a0b0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
  .review-controls input[type=date] { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
  .review-filter { display: flex; gap: 4px; }
  .rf-btn { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .rf-btn:hover { background: rgba(255,255,255,0.06); color: #fafafa; }
  .rf-btn.active { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.4); color: #c4b5fd; }
  .review-list { display: flex; flex-direction: column; gap: 8px; }
  .review-msg { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 12px 14px; font-size: 13px; }
  .review-msg.has-feedback { opacity: 0.5; }
  .rm-header { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }
  .rm-ts { color: #a0a0b0; font-size: 11px; font-variant-numeric: tabular-nums; }
  .rm-author { color: #D649CC; font-weight: 700; }
  .rm-status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; }
  .rm-counted { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .rm-ignored { background: rgba(160,160,176,0.1); color: #a0a0b0; border: 1px solid rgba(160,160,176,0.3); }
  .rm-feedback-good { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .rm-feedback-bad  { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .rm-reason { color: #a0a0b0; font-size: 11px; }
  .rm-content { color: #fafafa; white-space: pre-wrap; word-break: break-word; margin-top: 4px; margin-bottom: 8px; }
  .rm-action { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .rm-action-bad { border-color: rgba(239,68,68,0.3); color: #f87171; }
  .rm-action-bad:hover { background: rgba(239,68,68,0.1); }
  .rm-action-good { border-color: rgba(16,185,129,0.3); color: #10b981; }
  .rm-action-good:hover { background: rgba(16,185,129,0.1); }
  .review-pager { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 12px; }
  .review-pager button { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .review-pager button:disabled { opacity: 0.3; cursor: default; }
  .review-pager span { font-size: 12px; color: #a0a0b0; font-variant-numeric: tabular-nums; }
  .review-phrases { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.06); }
  .review-phrases h4 { font-size: 11px; color: #a0a0b0; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
  .phrase-tag { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 10px; font-size: 12px; margin: 3px; max-width: 420px; word-break: break-all; color: #fafafa; }
  .phrase-tag button { background: none; border: none; color: #a0a0b0; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
  .phrase-tag button:hover { color: #f87171; }
</style>
</head>
<body>
${sidebarHTML('/profits')}
```

- [ ] **Step 2: Add the HTML panel**

Find the closing `</div>` that ends the profits page main content before `<script>`. Search for the line that starts with `<script>` and the `</div>` directly above it.

Locate this structure (near the end of PROFITS_PAGE_HTML, before the `<script>` tag):
```
</div>
<script>
```

Replace with:
```
<div id="review-panel">
  <button id="review-toggle">
    <span>📨 Messages #profits (revue & apprentissage)</span>
    <span id="review-arrow">▶</span>
  </button>
  <div id="review-body">
    <div class="review-controls">
      <label for="review-date">Date :</label>
      <input type="date" id="review-date">
      <div class="review-filter">
        <button class="rf-btn active" data-filter="all">Tous</button>
        <button class="rf-btn" data-filter="counted">Comptés</button>
        <button class="rf-btn" data-filter="ignored">Ignorés</button>
        <button class="rf-btn" data-filter="flagged">Marqués</button>
      </div>
    </div>
    <div id="review-list" class="review-list">
      <div style="color:#a0a0b0;font-size:12px;">Chargement...</div>
    </div>
    <div id="review-pager" class="review-pager" style="display:none;">
      <button id="review-prev">← Précédent</button>
      <span id="review-page-info">Page 1/1</span>
      <button id="review-next">Suivant →</button>
    </div>
    <div class="review-phrases">
      <h4>Phrases apprises — bloquées (<span id="pf-blocked-count">0</span>)</h4>
      <div id="pf-blocked">Aucune</div>
      <h4 style="margin-top:14px;">Phrases apprises — autorisées (<span id="pf-allowed-count">0</span>)</h4>
      <div id="pf-allowed">Aucune</div>
    </div>
  </div>
</div>
</div>
<script>
```

- [ ] **Step 3: Add the JS logic**

Find the end of the profits page's existing `<script>` IIFE, specifically the closing `})();` followed by `</script>`. Look for the last `})();` before `</script>` in `PROFITS_PAGE_HTML`.

Insert the following block **immediately after** the existing `})();` and **before** `</script>`:

```javascript
(function(){
  var toggle = document.getElementById('review-toggle');
  var body = document.getElementById('review-body');
  var arrow = document.getElementById('review-arrow');
  var dateInput = document.getElementById('review-date');
  var listEl = document.getElementById('review-list');
  var pager = document.getElementById('review-pager');
  var pageInfo = document.getElementById('review-page-info');
  var prevBtn = document.getElementById('review-prev');
  var nextBtn = document.getElementById('review-next');

  var currentFilter = 'all';
  var currentPage = 1;
  var totalPages = 1;
  var loaded = false;

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  dateInput.value = today();

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtTime(iso){
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
  }

  function renderMessages(data){
    var msgs = data.messages || [];
    if (!msgs.length) {
      listEl.innerHTML = '<div style="color:#a0a0b0;font-size:12px;padding:20px;text-align:center;">Aucun message</div>';
      pager.style.display = 'none';
      return;
    }
    listEl.innerHTML = msgs.map(function(m){
      var statusHtml = m.counted
        ? '<span class="rm-status rm-counted">✅ Compté</span>'
        : '<span class="rm-status rm-ignored">⚪ Ignoré</span>';
      var reasonHtml = '<span class="rm-reason">(' + esc(m.reason || '') + ')</span>';
      var feedbackHtml = '';
      if (m.feedback === 'good') feedbackHtml = '<span class="rm-status rm-feedback-good">feedback: ✅</span>';
      else if (m.feedback === 'bad') feedbackHtml = '<span class="rm-status rm-feedback-bad">feedback: ❌</span>';

      var actionHtml = '';
      if (m.feedback == null) {
        if (m.counted) {
          actionHtml = '<button class="rm-action rm-action-bad" data-id="' + esc(m.id) + '" data-content="' + esc(m.content || '') + '" data-action="block">❌ Pas un profit</button>';
        } else {
          actionHtml = '<button class="rm-action rm-action-good" data-id="' + esc(m.id) + '" data-content="' + esc(m.content || '') + '" data-action="allow">✅ C\\'est un profit</button>';
        }
      }

      return '<div class="review-msg' + (m.feedback ? ' has-feedback' : '') + '" data-msg-id="' + esc(m.id) + '">'
        + '<div class="rm-header">'
        +   '<span class="rm-ts">' + fmtTime(m.ts) + '</span>'
        +   '<span class="rm-author">' + esc(m.author || '') + '</span>'
        +   statusHtml + ' ' + reasonHtml + ' ' + feedbackHtml
        + '</div>'
        + '<div class="rm-content">' + esc(m.preview || m.content || '') + '</div>'
        + actionHtml
        + '</div>';
    }).join('');

    totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 50)));
    pager.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfo.textContent = 'Page ' + currentPage + '/' + totalPages + ' (' + data.total + ' messages)';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  function loadMessages(){
    listEl.innerHTML = '<div style="color:#a0a0b0;font-size:12px;">Chargement...</div>';
    var url = '/api/profit-messages?date=' + encodeURIComponent(dateInput.value)
      + '&filter=' + encodeURIComponent(currentFilter)
      + '&page=' + currentPage;
    fetch(url).then(function(r){ return r.json(); }).then(renderMessages).catch(function(){
      listEl.innerHTML = '<div style="color:#f87171;font-size:12px;">Erreur de chargement</div>';
    });
  }

  function renderFilters(pf){
    var blocked = pf.blocked || [];
    var allowed = pf.allowed || [];
    document.getElementById('pf-blocked-count').textContent = blocked.length;
    document.getElementById('pf-allowed-count').textContent = allowed.length;
    var bl = document.getElementById('pf-blocked');
    var al = document.getElementById('pf-allowed');
    bl.innerHTML = blocked.length
      ? blocked.map(function(p){ return '<span class="phrase-tag">' + esc(p) + '<button data-phrase="' + esc(p) + '" data-list="blocked" title="Supprimer">✕</button></span>'; }).join('')
      : '<span style="color:#a0a0b0;font-size:12px;">Aucune</span>';
    al.innerHTML = allowed.length
      ? allowed.map(function(p){ return '<span class="phrase-tag">' + esc(p) + '<button data-phrase="' + esc(p) + '" data-list="allowed" title="Supprimer">✕</button></span>'; }).join('')
      : '<span style="color:#a0a0b0;font-size:12px;">Aucune</span>';
  }

  function loadFilters(){
    fetch('/api/profit-filters').then(function(r){ return r.json(); }).then(renderFilters).catch(function(){});
  }

  toggle.addEventListener('click', function(){
    var open = body.classList.toggle('open');
    arrow.textContent = open ? '▼' : '▶';
    if (open && !loaded) {
      loaded = true;
      loadMessages();
      loadFilters();
    }
  });

  dateInput.addEventListener('change', function(){ currentPage = 1; loadMessages(); });

  document.querySelectorAll('.rf-btn').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.rf-btn').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      currentFilter = b.getAttribute('data-filter');
      currentPage = 1;
      loadMessages();
    });
  });

  prevBtn.addEventListener('click', function(){ if (currentPage > 1) { currentPage--; loadMessages(); } });
  nextBtn.addEventListener('click', function(){ if (currentPage < totalPages) { currentPage++; loadMessages(); } });

  listEl.addEventListener('click', function(ev){
    var btn = ev.target.closest('.rm-action');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var content = btn.getAttribute('data-content');
    var action = btn.getAttribute('data-action');
    btn.disabled = true; btn.textContent = '…';
    fetch('/api/profit-feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ id: id, content: content, action: action })
    }).then(function(r){ return r.json(); }).then(function(data){
      if (data.ok) {
        renderFilters(data.profitFilters);
        loadMessages();
      } else {
        btn.disabled = false;
        btn.textContent = action === 'block' ? '❌ Pas un profit' : '✅ C\\'est un profit';
      }
    }).catch(function(){
      btn.disabled = false;
      btn.textContent = action === 'block' ? '❌ Pas un profit' : '✅ C\\'est un profit';
    });
  });

  var phrasesContainer = document.querySelector('.review-phrases');
  phrasesContainer.addEventListener('click', function(ev){
    var btn = ev.target.closest('button[data-phrase]');
    if (!btn) return;
    var phrase = btn.getAttribute('data-phrase');
    var list = btn.getAttribute('data-list');
    fetch('/api/profit-feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ content: phrase, action: 'unblock-' + list })
    }).then(function(r){ return r.json(); }).then(function(data){
      if (data.ok) renderFilters(data.profitFilters);
    });
  });
})();
```

- [ ] **Step 4: Verify syntax**

Run: `node --check index.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(profits-review): add collapsible review panel UI on /profits"
```

---

## Task 5: Final verification

- [ ] **Step 1: Syntax check**

Run: `node --check index.js`
Expected: exit 0, no output.

- [ ] **Step 2: Grep to confirm no leftover or duplicate rules**

Run:
```bash
grep -c "loadProfitMessages\|saveProfitMessages\|loadProfitFilters\|saveProfitFilters\|profitFilters\b" index.js
```
Expected: at least 10 matches (definitions + usages in handler + API + UI).

- [ ] **Step 3: Review recent commits**

Run: `git log --oneline -6`
Expected: the 4 feat commits from tasks 1-4 at the top.
