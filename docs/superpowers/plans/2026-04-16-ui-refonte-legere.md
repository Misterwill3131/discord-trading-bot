# UI Refonte Légère — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top header nav on all 9 authenticated pages with a fixed left sidebar, modernise the font to Inter, and update the body layout to `display: flex` — without touching any business logic or JS.

**Architecture:** A `COMMON_CSS` string constant and a `sidebarHTML(activePath)` function are defined once in `index.js` just before the HTML template constants. Each template injects `${COMMON_CSS}` at the top of its `<style>` block and `${sidebarHTML('/route')}` at the start of its `<body>`. The existing `<header>` block is replaced by a thin `.page-header` div carrying the page title (and any status indicators that previously lived in the header). All page content is wrapped in `<div class="page-content">`.

**Tech Stack:** Node.js / Express, vanilla JS, inline HTML template strings. No new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `index.js:244` | Insert `COMMON_CSS` constant and `sidebarHTML()` function |
| `index.js:245` | `DASHBOARD_HTML` — CSS + body refactor |
| `index.js:902` | `IMAGE_GEN_HTML` — CSS + body refactor (special: keeps `.sidebar` class) |
| `index.js:1225` | `RAW_MESSAGES_HTML` — CSS + body refactor |
| `index.js:1499` | `PROOF_GEN_HTML` — CSS + body refactor |
| `index.js:1697` | `STATS_HTML` — CSS + body refactor (header had period buttons + refresh btn) |
| `index.js:2323` | `PROFITS_PAGE_HTML` — CSS + body refactor |
| `index.js:2612` | `NEWS_PAGE_HTML` — CSS + body refactor (header had #dot + #lbl) |
| `index.js:2762` | `LEADERBOARD_HTML` — CSS + body refactor |
| `index.js:3076` | `configPageHtml` (inline in route) — CSS + body refactor |

---

## Task 1: Add COMMON_CSS and sidebarHTML()

**Files:**
- Modify: `index.js` — insert before line 244 (`const DASHBOARD_HTML`)

- [ ] **Step 1: Insert COMMON_CSS and sidebarHTML just before `const DASHBOARD_HTML`**

Find this exact line in `index.js`:
```
const DASHBOARD_HTML = `<!DOCTYPE html>
```

Insert the following block immediately before it:

```javascript
const COMMON_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #f2f3f5; font-family: 'Inter', system-ui, sans-serif; font-size: 14px; display: flex; min-height: 100vh; }
  .nav-sidebar { width: 220px; min-width: 220px; background: #1a1b1e; border-right: 1px solid #2e3035; display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; overflow-y: auto; z-index: 20; flex-shrink: 0; }
  .nav-sidebar-logo { padding: 20px 16px 14px; font-size: 17px; font-weight: 700; color: #fff; border-bottom: 1px solid #2e3035; margin-bottom: 8px; }
  .nav-sidebar a { display: flex; align-items: center; gap: 10px; padding: 9px 16px; font-size: 13px; font-weight: 500; color: #80848e; text-decoration: none; border-left: 3px solid transparent; transition: background .15s, color .15s; }
  .nav-sidebar a:hover { background: #25262a; color: #f2f3f5; }
  .nav-sidebar a.active { background: rgba(88,101,242,0.12); color: #5865f2; border-left-color: #5865f2; font-weight: 600; }
  .nav-sidebar-icon { font-size: 15px; min-width: 20px; text-align: center; }
  .page-content { flex: 1; min-width: 0; overflow-y: auto; }
  .page-header { display: flex; align-items: center; gap: 10px; padding: 14px 24px; border-bottom: 1px solid #3f4147; background: #1e1f22; position: sticky; top: 0; z-index: 10; }
  .page-title { font-size: 15px; font-weight: 700; color: #fff; flex-shrink: 0; }
`;

function sidebarHTML(active) {
  const links = [
    { href: '/dashboard',       icon: '📡', label: 'Dashboard' },
    { href: '/stats',           icon: '📊', label: 'Stats' },
    { href: '/profits',         icon: '💰', label: 'Profits' },
    { href: '/news',            icon: '📰', label: 'News' },
    { href: '/leaderboard',     icon: '🏆', label: 'Leaderboard' },
    { href: '/image-generator', icon: '🖼️', label: 'Image Generator' },
    { href: '/proof-generator', icon: '🔍', label: 'Proof Generator' },
    { href: '/raw-messages',    icon: '📋', label: 'Raw Messages' },
    { href: '/config',          icon: '⚙️', label: 'Config' },
  ];
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${links.map(l => `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}><span class="nav-sidebar-icon">${l.icon}</span>${l.label}</a>`).join('\n  ')}
</nav>`;
}

```

- [ ] **Step 2: Verify the file parses correctly**

```bash
node -e "require('./index.js')" 2>&1 | head -5
```
Expected: process starts (may hang waiting for Discord token — Ctrl+C after 2s). No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add COMMON_CSS and sidebarHTML() shared UI helpers"
```

---

## Task 2: Refactor DASHBOARD_HTML

**Files:**
- Modify: `index.js` — `DASHBOARD_HTML` constant (starts ~line 245)

The dashboard header contains `#dot`, `#lbl`, `#cnt` status spans used by the SSE JS. These move into the `.page-header`.

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `DASHBOARD_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on  { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
```

Replace with:
```
  ${COMMON_CSS}
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on  { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>🔥 BOOM</h1>
  <a href="/dashboard" class="nav-link active">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link">News</a>
  <a href="/config" class="nav-link">Config</a>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</header>
<div id="wrap">
```

Replace with:
```
<body>
${sidebarHTML('/dashboard')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Dashboard</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</div>
<div id="wrap">
```

- [ ] **Step 3: Close `.page-content` before `</body>`**

Find (near end of DASHBOARD_HTML):
```
</body>
</html>`;

const app = express();
```

Replace with:
```
</div>
</body>
</html>`;

const app = express();
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Dashboard"
```

---

## Task 3: Refactor IMAGE_GEN_HTML

**Files:**
- Modify: `index.js` — `IMAGE_GEN_HTML` constant (~line 902)

Note: this template has its own `.sidebar` class (left parameter panel) — no conflict since our nav uses `.nav-sidebar`. The `.main` grid height must change from `calc(100vh - 53px)` to `100vh`.

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `IMAGE_GEN_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  .main { display: grid; grid-template-columns: 360px 1fr; gap: 0; height: calc(100vh - 53px); }
```

Replace with:
```
  ${COMMON_CSS}
  .page-content { overflow: hidden; }
  .main { display: grid; grid-template-columns: 360px 1fr; gap: 0; height: 100vh; }
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>🔥 BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link active">Image Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link">News</a>
  <a href="/config" class="nav-link">Config</a>
</header>

<div class="main">
```

Replace with:
```
<body>
${sidebarHTML('/image-generator')}
<div class="page-content">
<div class="main">
```

- [ ] **Step 3: Close `.page-content` before `</body>`**

Find the end of IMAGE_GEN_HTML (before its closing `` </html>`; ``):
```
</body>
</html>`;

app.get('/image-generator',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/image-generator',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Image Generator"
```

---

## Task 4: Refactor RAW_MESSAGES_HTML

**Files:**
- Modify: `index.js` — `RAW_MESSAGES_HTML` constant (~line 1225)

The header contains `#dot`, `#lbl`, `#cnt` status spans — move them to `.page-header`.

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `RAW_MESSAGES_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
```

Replace with:
```
  ${COMMON_CSS}
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
```

Also find and remove the scrollbar rule already defined in this template (it will come from COMMON_CSS):
```
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #3f4147; border-radius: 3px; }
```
Replace with: *(remove the line entirely)*

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>🔥 BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link active">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link">News</a>
  <a href="/config" class="nav-link">Config</a>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</header>
<div id="wrap">
```

Replace with:
```
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
```

- [ ] **Step 3: Close `.page-content`**

Find end of RAW_MESSAGES_HTML:
```
</body>
</html>`;

app.get('/raw-messages',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/raw-messages',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Raw Messages"
```

---

## Task 5: Refactor PROOF_GEN_HTML

**Files:**
- Modify: `index.js` — `PROOF_GEN_HTML` constant (~line 1499)

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `PROOF_GEN_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
```

Replace with:
```
  ${COMMON_CSS}
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link active">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link">News</a>
  <a href="/config" class="nav-link">Config</a>
</header>
<div id="wrap">
```

Replace with:
```
<body>
${sidebarHTML('/proof-generator')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Proof Generator</h1></div>
<div id="wrap">
```

- [ ] **Step 3: Close `.page-content`**

Find end of PROOF_GEN_HTML:
```
</body>
</html>`;

app.get('/proof-generator',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/proof-generator',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Proof Generator"
```

---

## Task 6: Refactor STATS_HTML

**Files:**
- Modify: `index.js` — `STATS_HTML` constant (~line 1697)

The stats header contains period buttons (`#btn-today`, `#btn-7d`, `#btn-30d`) and `#btn-refresh`. These are referenced by the stats JS and must remain in the DOM — they move into `.page-header`.

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `STATS_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
```

Replace with:
```
  ${COMMON_CSS}
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/stats" class="nav-link active">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link">News</a>
  <a href="/config" class="nav-link">Config</a>
  <div class="period-btns">
    <button class="btn-period active" id="btn-today" data-period="today">Aujourd&#39;hui</button>
    <button class="btn-period" id="btn-7d" data-period="7d">7 jours</button>
    <button class="btn-period" id="btn-30d" data-period="30d">30 jours</button>
  </div>
  <button class="btn-refresh" id="btn-refresh">Actualiser</button>
</header>
<div id="wrap">
```

Replace with:
```
<body>
${sidebarHTML('/stats')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Stats</h1>
  <div class="period-btns">
    <button class="btn-period active" id="btn-today" data-period="today">Aujourd&#39;hui</button>
    <button class="btn-period" id="btn-7d" data-period="7d">7 jours</button>
    <button class="btn-period" id="btn-30d" data-period="30d">30 jours</button>
  </div>
  <button class="btn-refresh" id="btn-refresh">Actualiser</button>
</div>
<div id="wrap">
```

- [ ] **Step 3: Close `.page-content`**

Find end of STATS_HTML:
```
</body>
</html>`;

app.get('/stats',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/stats',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Stats"
```

---

## Task 7: Refactor PROFITS_PAGE_HTML

**Files:**
- Modify: `index.js` — `PROFITS_PAGE_HTML` constant (~line 2323)

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `PROFITS_PAGE_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
```

Replace with:
```
  ${COMMON_CSS}
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link active">Profits</a>
  <a href="/config" class="nav-link">Config</a>
</header>
<div id="wrap">
```

Replace with:
```
<body>
${sidebarHTML('/profits')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Profits</h1></div>
<div id="wrap">
```

- [ ] **Step 3: Close `.page-content`**

Find end of PROFITS_PAGE_HTML:
```
</body>
</html>`;

app.get('/profits',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/profits',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Profits"
```

---

## Task 8: Refactor NEWS_PAGE_HTML

**Files:**
- Modify: `index.js` — `NEWS_PAGE_HTML` constant (~line 2612)

The news header contains `#dot` and `#lbl` status spans — move to `.page-header`.

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `NEWS_PAGE_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #ed4245; margin-left: auto; }
  #dot.ok { background: #3ba55d; }
  #lbl { font-size: 11px; color: #80848e; }
```

Replace with:
```
  ${COMMON_CSS}
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #ed4245; margin-left: auto; }
  #dot.ok { background: #3ba55d; }
  #lbl { font-size: 11px; color: #80848e; }
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link active">News</a>
  <a href="/config" class="nav-link">Config</a>
  <span id="dot"></span>
  <span id="lbl">Connecting...</span>
</header>
<div id="wrap">
```

Replace with:
```
<body>
${sidebarHTML('/news')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">News</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting...</span>
</div>
<div id="wrap">
```

- [ ] **Step 3: Close `.page-content`**

Find end of NEWS_PAGE_HTML:
```
</body>
</html>`;

app.get('/news',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/news',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on News"
```

---

## Task 9: Refactor LEADERBOARD_HTML

**Files:**
- Modify: `index.js` — `LEADERBOARD_HTML` constant (~line 2762)

The leaderboard has a `#side-panel` (position: fixed slide-in) and an `#overlay` — these follow the header and are not inside it, so no special handling needed.

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in `LEADERBOARD_HTML`'s `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; overflow-x: hidden; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
```

Replace with:
```
  ${COMMON_CSS}
  body { overflow-x: hidden; }
```

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link active">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/news" class="nav-link">News</a>
  <a href="/config" class="nav-link">Config</a>
</header>

<div id="overlay"></div>
```

Replace with:
```
<body>
${sidebarHTML('/leaderboard')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Leaderboard</h1></div>

<div id="overlay"></div>
```

- [ ] **Step 3: Close `.page-content`**

Find end of LEADERBOARD_HTML:
```
</body>
</html>`;

app.get('/leaderboard',
```

Replace with:
```
</div>
</body>
</html>`;

app.get('/leaderboard',
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Leaderboard"
```

---

## Task 10: Refactor configPageHtml (inline route template)

**Files:**
- Modify: `index.js` — inline template inside `app.get('/config', ...)` handler (~line 3076)

This template is a regular template literal inside a JS function, so `${sidebarHTML('/config')}` is called at request time (which is fine).

- [ ] **Step 1: Replace CSS header/nav rules and body rule**

Find in the config route's inline `<style>` block:
```
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  header { background: #2b2d31; border-bottom: 1px solid #3f4147; padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .nav-link { font-size: 13px; color: #80848e; text-decoration: none; padding: 4px 10px; border-radius: 4px; transition: background .15s, color .15s; }
  .nav-link:hover { background: #3f4147; color: #dcddde; }
  .nav-link.active { background: #5865f222; color: #5865f2; }
```

Replace with:
```
  \${COMMON_CSS}
```

Note: Inside a template literal, `${COMMON_CSS}` needs no escaping because `COMMON_CSS` is a JS variable — write it as `${COMMON_CSS}` (no backslash). The `\${}` notation in this plan doc is only to avoid confusion; in the actual file just use `${COMMON_CSS}`.

- [ ] **Step 2: Replace the `<body>` header block**

Find:
```
<body>
<header>
  <h1>&#x1F525; BOOM</h1>
  <a href="/dashboard" class="nav-link">Dashboard</a>
  <a href="/raw-messages" class="nav-link">Messages bruts</a>
  <a href="/image-generator" class="nav-link">Image Generator</a>
  <a href="/proof-generator" class="nav-link">Proof Generator</a>
  <a href="/stats" class="nav-link">Stats</a>
  <a href="/leaderboard" class="nav-link">Leaderboard</a>
  <a href="/profits" class="nav-link">Profits</a>
  <a href="/config" class="nav-link active">Config</a>
</header>
<div id="wrap">
```

Replace with:
```
<body>
${sidebarHTML('/config')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Config</h1></div>
<div id="wrap">
```

- [ ] **Step 3: Close `.page-content`**

Find the closing section of the config template:
```
</div>
</body>
</html>`;
  res.set('Content-Type', 'text/html');
  res.send(configPageHtml);
```

The `</div>` here closes `#wrap`. Add another `</div>` after it to close `.page-content`:
```
</div>
</div>
</body>
</html>`;
  res.set('Content-Type', 'text/html');
  res.send(configPageHtml);
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: sidebar nav on Config"
```

---

## Task 11: Final verification

- [ ] **Step 1: Check syntax**

```bash
node --check index.js
```
Expected: no output (exit 0).

- [ ] **Step 2: Start the server locally and spot-check**

```bash
node index.js &
sleep 2
curl -s http://localhost:3000/health | head -3
```
Expected: JSON response with status info.

Kill the background server after: `kill %1`

- [ ] **Step 3: Final commit if anything was missed**

```bash
git status
```
If clean: nothing to do. If dirty: fix and commit.
