# UI Refresh — SaaS Modern Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a modern SaaS visual refresh (Linear/Notion/Vercel style) to the existing web UI by rewriting `COMMON_CSS` and cleaning up per-page duplicate rules.

**Architecture:** `COMMON_CSS` (in `index.js`, around line 245) becomes the single source of truth for card/button/typography/animation styles. Each page's `<style>` block is cleaned up to remove duplicates (which currently override COMMON_CSS with the old look) and keep only page-specific additions. Gradient `#3b82f6 → #8b5cf6` is the visual signature used on logo, active nav link, primary buttons, and progress bars.

**Tech Stack:** Plain CSS via template literals in `index.js`. No new dependencies. Inter font already loaded.

---

## File Map

All changes in `index.js`:

| Section                        | Change                                                              |
|--------------------------------|---------------------------------------------------------------------|
| `const COMMON_CSS` (~line 245) | Rewrite completely with new design system                           |
| `DASHBOARD_HTML` (~line 278)   | Update `.badge` radius, `#authors-panel`/`#filters-panel` glass look |
| `STATS_HTML` (~line 1684)      | Remove duplicate `.card`/`.card-title`/`.big-number`/`.big-sub`/`.btn-period`/`.btn-refresh` rules |
| `PROFITS_PAGE_HTML` (~line 2293) | Remove duplicate `.card`/`.card-title`/`.btn-period`/`.btn-add`; update `.stat-box` |
| `NEWS_PAGE_HTML` (~line 2569)  | Update `.news-card` to glass look                                   |
| `LEADERBOARD_HTML` (~line 2707)| Remove duplicate `.card`/`.card-title`; update `#side-panel`/`.signal-card` |
| `IMAGE_GEN_HTML` (~line 902)   | Remove duplicate `.btn-primary`; update `.preview-box`/`.avatar-item` |
| `PROOF_GEN_HTML` (~line 1499)  | Update `.panel` and `.btn` to glass/gradient look                   |
| `RAW_MESSAGES_HTML` (~line 1232) | Update `.msg-card` to glass; bump `.badge` radius                 |
| `configPageHtml` (inline, ~line 3021) | Remove duplicate `.card`/`.card-title`                      |

Line numbers are approximate — search by content.

---

## Task 1: Rewrite COMMON_CSS

**Files:**
- Modify: `index.js` — the entire `COMMON_CSS` constant (starts at `const COMMON_CSS = \``)

- [ ] **Step 1: Replace the entire `COMMON_CSS` constant**

Find this block in `index.js` (the whole `const COMMON_CSS = \`…\`;` declaration):

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
```

Replace with:

```javascript
const COMMON_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #fafafa; font-family: 'Inter', system-ui, sans-serif; font-size: 14px; line-height: 1.5; display: flex; min-height: 100vh; }
  a, button, .card, .btn, .btn-primary, .btn-period, .btn-refresh, .btn-add, .nav-sidebar a, input, select, textarea { transition: background-color 200ms cubic-bezier(0.4,0,0.2,1), border-color 200ms cubic-bezier(0.4,0,0.2,1), color 200ms cubic-bezier(0.4,0,0.2,1), transform 200ms cubic-bezier(0.4,0,0.2,1), box-shadow 200ms cubic-bezier(0.4,0,0.2,1), background-position 400ms ease; }

  /* Sidebar */
  .nav-sidebar { width: 220px; min-width: 220px; background: #0f0f14; border-right: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; overflow-y: auto; z-index: 20; flex-shrink: 0; }
  .nav-sidebar-logo { padding: 22px 18px 16px; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 10px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }
  .nav-sidebar a { display: flex; align-items: center; gap: 10px; padding: 10px 18px; font-size: 13px; font-weight: 500; color: #a0a0b0; text-decoration: none; border-left: 3px solid transparent; }
  .nav-sidebar a:hover { background: rgba(255,255,255,0.04); color: #fafafa; }
  .nav-sidebar a.active { background: rgba(139,92,246,0.1); color: #fafafa; border-left: 3px solid transparent; border-image: linear-gradient(180deg, #3b82f6, #8b5cf6) 1; font-weight: 600; }
  .nav-sidebar-icon { font-size: 15px; min-width: 20px; text-align: center; }

  /* Page layout */
  .page-content { flex: 1; min-width: 0; overflow-y: auto; }
  .page-header { display: flex; align-items: center; gap: 14px; padding: 20px 32px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(10,10,15,0.8); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10; }
  .page-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #fafafa; flex-shrink: 0; }

  /* Cards (glass) */
  .card { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1); animation: fadeInUp 400ms cubic-bezier(0.4,0,0.2,1) both; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(139,92,246,0.3); }
  .card:nth-child(2) { animation-delay: 50ms; }
  .card:nth-child(3) { animation-delay: 100ms; }
  .card:nth-child(4) { animation-delay: 150ms; }
  .card:nth-child(5) { animation-delay: 200ms; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 16px; }
  .big-number { font-size: 52px; font-weight: 800; color: #fafafa; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .big-sub { font-size: 13px; color: #a0a0b0; margin-top: 6px; }

  /* Buttons */
  .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-primary:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-refresh { background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.3); color: #a78bfa; border-radius: 8px; padding: 8px 18px; cursor: pointer; font-size: 13px; font-weight: 600; margin-left: auto; }
  .btn-refresh:hover { background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.5); color: #c4b5fd; }
  .btn-add { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; border: none; color: #fff; border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-add:hover { background-position: 100% 50%; transform: translateY(-1px); }
  .btn-period { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-period:hover { background: rgba(255,255,255,0.06); color: #fafafa; }
  .btn-period.active { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.4); color: #c4b5fd; }

  /* Inputs */
  input[type=text], input[type=number], input[type=password], input[type=time], textarea, select { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; padding: 9px 12px; font-family: inherit; font-size: 14px; outline: none; }
  input[type=text]:focus, input[type=number]:focus, input[type=password]:focus, input[type=time]:focus, textarea:focus, select:focus { border-color: rgba(139,92,246,0.5); background: rgba(255,255,255,0.06); }

  /* Animations */
  @keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
  .shimmer { background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent); background-size: 200% 100%; animation: shimmer 1.5s infinite; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
`;
```

- [ ] **Step 2: Verify syntax**

Run: `node --check index.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(ui): rewrite COMMON_CSS with SaaS modern design system"
```

---

## Task 2: Update DASHBOARD_HTML

**Files:**
- Modify: `index.js` — `DASHBOARD_HTML` constant

The dashboard has no `.card` rule to remove, but its `#authors-panel` and `#filters-panel` use the old dark background colors. Its `.badge` rule needs a radius bump.

- [ ] **Step 1: Bump `.badge` border-radius and update background tints**

Find in `DASHBOARD_HTML`'s `<style>` block:
```
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
```
Replace with:
```
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
```

- [ ] **Step 2: Update `#authors-panel` and `#filters-panel` to glass look**

Find:
```
  #filters-panel { margin-top:24px; border:1px solid #3f4147; border-radius:6px; overflow:hidden; }
  #filters-toggle { width:100%; background:#2b2d31; border:none; color:#dcddde; padding:10px 16px; text-align:left; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; align-items:center; }
  #filters-toggle:hover { background:#32353b; }
  #filters-body { display:none; padding:12px 16px; background:#1e1f22; }
```
Replace with:
```
  #filters-panel { margin-top:24px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; }
  #filters-toggle { width:100%; background:transparent; border:none; color:#fafafa; padding:14px 20px; text-align:left; cursor:pointer; font-size:13px; font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  #filters-toggle:hover { background:rgba(255,255,255,0.03); }
  #filters-body { display:none; padding:16px 20px; background:rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
```

- [ ] **Step 3: Update `.filter-tag` background**

Find:
```
  .filter-tag { display:inline-flex; align-items:center; gap:6px; background:#2b2d31; border:1px solid #3f4147; border-radius:4px; padding:3px 8px; font-size:12px; margin:3px; max-width:420px; word-break:break-all; }
```
Replace with:
```
  .filter-tag { display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:3px 8px; font-size:12px; margin:3px; max-width:420px; word-break:break-all; }
```

- [ ] **Step 4: Update `#authors-panel` section**

Find:
```
  #authors-panel { margin:0 24px 16px; border:1px solid #3f4147; border-radius:6px; overflow:hidden; }
  #authors-toggle { width:100%; background:#2b2d31; border:none; color:#dcddde; padding:10px 16px; text-align:left; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; align-items:center; }
  #authors-toggle:hover { background:#32353b; }
  #authors-body { display:none; padding:12px 16px; background:#1e1f22; }
```
Replace with:
```
  #authors-panel { margin:0 24px 16px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; }
  #authors-toggle { width:100%; background:transparent; border:none; color:#fafafa; padding:14px 20px; text-align:left; cursor:pointer; font-size:13px; font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  #authors-toggle:hover { background:rgba(255,255,255,0.03); }
  #authors-body { display:none; padding:16px 20px; background:rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
```

- [ ] **Step 5: Update `.author-row` background**

Find:
```
  .author-row { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:4px; margin-bottom:4px; background:#2b2d31; }
  .author-row:hover { background:#32353b; }
```
Replace with:
```
  .author-row { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:6px; margin-bottom:4px; background:rgba(255,255,255,0.03); }
  .author-row:hover { background:rgba(255,255,255,0.06); }
```

- [ ] **Step 6: Update table hover and borders**

Find:
```
  thead th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 10px 10px; border-bottom: 1px solid #3f4147; white-space: nowrap; }
  tbody tr { border-bottom: 1px solid #2b2d31; transition: background .15s; }
  tbody tr:hover { background: #2b2d31; }
```
Replace with:
```
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background .15s; }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
```

- [ ] **Step 7: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass treatment on Dashboard panels and table"
```

---

## Task 3: Update STATS_HTML — remove duplicates

**Files:**
- Modify: `index.js` — `STATS_HTML` constant

The stats page redefines `.card`, `.card-title`, `.big-number`, `.big-sub`, `.btn-refresh`, `.btn-period` — all now in COMMON_CSS. Remove them so COMMON_CSS takes over.

- [ ] **Step 1: Remove duplicate rules**

Find in `STATS_HTML`'s `<style>` block:
```
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-full { grid-column: 1 / -1; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 16px; }
  .big-number { font-size: 52px; font-weight: 800; color: #fff; line-height: 1; }
  .big-sub { font-size: 13px; color: #80848e; margin-top: 6px; }
  .progress-bar { height: 10px; border-radius: 5px; background: #3f4147; margin-top: 14px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 5px; transition: width .4s; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-label { width: 80px; font-size: 12px; color: #b5bac1; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { flex: 1; height: 14px; background: #3f4147; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width .4s; }
  .bar-val { width: 30px; font-size: 12px; color: #80848e; text-align: left; }
```
Replace with:
```
  .card-full { grid-column: 1 / -1; }
  .progress-bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,0.06); margin-top: 14px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 5px; transition: width .4s; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-label { width: 80px; font-size: 12px; color: #a0a0b0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { flex: 1; height: 14px; background: rgba(255,255,255,0.06); border-radius: 6px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; transition: width .4s; }
  .bar-val { width: 30px; font-size: 12px; color: #a0a0b0; text-align: left; }
```

Note: `.progress-fill` and `.bar-fill` have no `background` property — the JS sets inline `style="background:#3ba55d"` with semantic colors per signal type, which should remain unchanged.

- [ ] **Step 2: Remove duplicate button rules**

Find:
```
  .btn-refresh { background: #5865f222; border: 1px solid #5865f244; color: #5865f2; border-radius: 4px; padding: 6px 16px; cursor: pointer; font-size: 13px; font-weight: 600; margin-left: auto; }
  .btn-refresh:hover { background: #5865f244; }
  .period-btns { display: flex; gap: 6px; margin-left: 16px; }
  .btn-period { background: #2b2d31; border: 1px solid #3f4147; color: #80848e; border-radius: 4px; padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 600; transition: background .15s, color .15s; }
  .btn-period:hover { background: #3f4147; color: #dcddde; }
  .btn-period.active { background: #5865f244; border-color: #5865f2; color: #5865f2; }
```
Replace with:
```
  .period-btns { display: flex; gap: 6px; margin-left: 16px; }
```

(`.btn-refresh` and `.btn-period` are now in COMMON_CSS; only `.period-btns` layout stays.)

- [ ] **Step 3: Update stat-badge colors**

Find:
```
  .stat-badge { display: flex; flex-direction: column; align-items: center; padding: 14px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; min-width: 80px; }
```
Replace with:
```
  .stat-badge { display: flex; flex-direction: column; align-items: center; padding: 14px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; min-width: 80px; }
```

- [ ] **Step 4: Update perf-table colors**

Find:
```
  .perf-table th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 8px 8px; border-bottom: 1px solid #3f4147; }
  .perf-table td { padding: 7px 8px; border-bottom: 1px solid #2b2d31; font-size: 12px; vertical-align: middle; }
```
Replace with:
```
  .perf-table th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .perf-table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; vertical-align: middle; }
```

- [ ] **Step 5: Update `.perf-bar-wrap` background**

Find:
```
  .perf-bar-wrap { width: 80px; height: 8px; background: #3f4147; border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
```
Replace with:
```
  .perf-bar-wrap { width: 80px; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
```

- [ ] **Step 6: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass cards + gradient accents on Stats"
```

---

## Task 4: Update PROFITS_PAGE_HTML — remove duplicates + update stat-box

**Files:**
- Modify: `index.js` — `PROFITS_PAGE_HTML` constant

- [ ] **Step 1: Remove duplicate rules**

Find in `PROFITS_PAGE_HTML`'s `<style>` block:
```
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
  .period-btns { display: flex; gap: 6px; }
  .btn-period { background: #1e1f22; border: 1px solid #3f4147; color: #80848e; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-period:hover { background: #3f4147; color: #dcddde; }
  .btn-period.active { background: #5865f244; border-color: #5865f2; color: #5865f2; }
```
Replace with:
```
  .card-title { display: flex; align-items: center; justify-content: space-between; }
  .period-btns { display: flex; gap: 6px; }
```

(This keeps profits-specific `.card-title` additions — `display: flex; justify-content: space-between` — which extend COMMON_CSS's base `.card-title`. `.card` and `.btn-period` now come from COMMON_CSS.)

Wait — COMMON_CSS already defines `.card-title { font-size: 11px; font-weight: 700; ... margin-bottom: 16px; }` (no `display:flex`). We want profits' `.card-title` to ALSO have `display:flex; align-items:center; justify-content:space-between` because the profits card title has period buttons inside it. So the page-level override adds only those three properties.

- [ ] **Step 2: Update `.stat-box` to glass**

Find:
```
  .stat-box { background: #1e1f22; border: 1px solid #3f4147; border-radius: 6px; padding: 14px 20px; flex: 1; min-width: 120px; }
  .stat-box .num { font-size: 30px; font-weight: 800; color: #3ba55d; }
  .stat-box .lbl { font-size: 12px; color: #80848e; margin-top: 4px; }
```
Replace with:
```
  .stat-box { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 120px; }
  .stat-box .num { font-size: 30px; font-weight: 800; color: #fafafa; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .stat-box .lbl { font-size: 11px; color: #a0a0b0; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
```

- [ ] **Step 3: Remove `.btn-add` duplicate**

Find:
```
  .btn-add { background: #3ba55d; border: none; color: #fff; border-radius: 4px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-add:hover { background: #2d8049; }
```
Replace with: *(remove both lines entirely — `.btn-add` is now in COMMON_CSS with gradient)*

- [ ] **Step 4: Update chart colors**

Find:
```
  .bar-chart .bar { fill: #3ba55d; transition: opacity .15s; cursor: default; }
  .bar-chart .bar:hover { opacity: 0.75; }
  .bar-chart .axis-label { fill: #80848e; font-size: 11px; font-family: 'Segoe UI', system-ui, sans-serif; }
  .bar-chart .value-label { fill: #dcddde; font-size: 10px; font-family: 'Segoe UI', system-ui, sans-serif; text-anchor: middle; }
```
Replace with:
```
  .bar-chart .bar { fill: url(#profit-gradient); transition: opacity .15s; cursor: default; }
  .bar-chart .bar:hover { opacity: 0.8; }
  .bar-chart .axis-label { fill: #a0a0b0; font-size: 11px; font-family: 'Inter', system-ui, sans-serif; }
  .bar-chart .value-label { fill: #fafafa; font-size: 10px; font-family: 'Inter', system-ui, sans-serif; text-anchor: middle; }
```

Note: `fill: url(#profit-gradient)` references an SVG `<defs>` gradient we need to add. Do this in step 5.

- [ ] **Step 5: Add SVG gradient defs for bar chart**

Find the SVG element:
```
      <svg class="bar-chart" id="profit-chart" viewBox="0 0 800 200" preserveAspectRatio="none"></svg>
```
Replace with:
```
      <svg class="bar-chart" id="profit-chart" viewBox="0 0 800 200" preserveAspectRatio="none">
        <defs>
          <linearGradient id="profit-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#8b5cf6" />
            <stop offset="100%" stop-color="#3b82f6" />
          </linearGradient>
        </defs>
      </svg>
```

- [ ] **Step 6: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass cards + gradient bars on Profits"
```

---

## Task 5: Update NEWS_PAGE_HTML — glass news cards

**Files:**
- Modify: `index.js` — `NEWS_PAGE_HTML` constant

- [ ] **Step 1: Update `.news-card` to glass**

Find in `NEWS_PAGE_HTML`'s `<style>` block:
```
  .news-card {
    background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px;
    padding: 10px 14px; margin-bottom: 10px; transition: background .2s;
    animation: fadeIn .4s ease;
  }
  .news-card:hover { background: #32353b; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
```
Replace with:
```
  .news-card {
    background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
    padding: 14px 18px; margin-bottom: 10px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
    animation: fadeInUp 400ms cubic-bezier(0.4,0,0.2,1) both;
  }
  .news-card:hover { background: rgba(255,255,255,0.05); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(139,92,246,0.15); }
```

(`fadeInUp` is now provided by COMMON_CSS; remove the old `fadeIn` keyframe.)

- [ ] **Step 2: Update secondary elements**

Find:
```
  .news-title { font-weight: 600; color: #fff; font-size: 14px; }
  .news-meta { display: flex; gap: 10px; margin-top: 6px; font-size: 11px; color: #80848e; }
  .news-source { background: #1e1f22; padding: 1px 8px; border-radius: 3px; font-weight: 600; }
  .news-empty { text-align: center; padding: 60px; color: #80848e; }
  .count-badge { font-size: 11px; color: #80848e; margin-left: 8px; }
```
Replace with:
```
  .news-title { font-weight: 600; color: #fafafa; font-size: 14px; letter-spacing: -0.01em; }
  .news-meta { display: flex; gap: 10px; margin-top: 8px; font-size: 11px; color: #a0a0b0; }
  .news-source { background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 4px; font-weight: 600; color: #fafafa; }
  .news-empty { text-align: center; padding: 80px; color: #a0a0b0; }
  .count-badge { font-size: 11px; color: #a0a0b0; margin-left: 8px; }
```

- [ ] **Step 3: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass news cards"
```

---

## Task 6: Update LEADERBOARD_HTML — remove duplicates + glass side panel

**Files:**
- Modify: `index.js` — `LEADERBOARD_HTML` constant

- [ ] **Step 1: Remove duplicate `.card` rules**

Find in `LEADERBOARD_HTML`'s `<style>` block:
```
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 16px; }
```
Replace with: *(remove both lines — they're now in COMMON_CSS)*

- [ ] **Step 2: Update table rows**

Find:
```
  thead th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 10px 10px; border-bottom: 1px solid #3f4147; }
  tbody tr { border-bottom: 1px solid #2b2d31; transition: background .15s; cursor: pointer; }
  tbody tr:hover { background: #32353b; }
  tbody tr.active-row { background: #2a1e3f; border-left: 3px solid #D649CC; }
```
Replace with:
```
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background .15s; cursor: pointer; }
  tbody tr:hover { background: rgba(255,255,255,0.04); }
  tbody tr.active-row { background: rgba(139,92,246,0.1); border-left: 3px solid #8b5cf6; }
```

- [ ] **Step 3: Update `.bar-wrap` and `.bar-fill` in leaderboard**

Find:
```
  .bar-wrap { width: 120px; height: 8px; background: #3f4147; border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
  .bar-fill { height: 100%; border-radius: 4px; background: #3ba55d; }
```
Replace with:
```
  .bar-wrap { width: 120px; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
  .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); }
```

- [ ] **Step 4: Update `#side-panel` glass**

Find:
```
  #side-panel {
    position: fixed; top: 0; right: -480px; width: 460px; height: 100vh;
    background: #2b2d31; border-left: 1px solid #3f4147;
    display: flex; flex-direction: column;
    transition: right .3s ease; z-index: 100; overflow: hidden;
  }
  #side-panel.open { right: 0; }
  #panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid #3f4147; flex-shrink: 0;
  }
```
Replace with:
```
  #side-panel {
    position: fixed; top: 0; right: -480px; width: 460px; height: 100vh;
    background: rgba(15,15,20,0.95); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
    border-left: 1px solid rgba(255,255,255,0.08);
    box-shadow: -8px 0 32px rgba(0,0,0,0.4);
    display: flex; flex-direction: column;
    transition: right .3s ease; z-index: 100; overflow: hidden;
  }
  #side-panel.open { right: 0; }
  #panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
  }
```

- [ ] **Step 5: Update `.signal-card` glass**

Find:
```
  .signal-card {
    background: #1e1f22; border: 1px solid #3f4147; border-radius: 6px;
    padding: 12px 14px; margin-bottom: 10px;
  }
```
Replace with:
```
  .signal-card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 10px;
  }
```

- [ ] **Step 6: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass cards + side panel on Leaderboard"
```

---

## Task 7: Update IMAGE_GEN_HTML — update buttons and panels

**Files:**
- Modify: `index.js` — `IMAGE_GEN_HTML` constant

This page has its own `.sidebar` (the image generator's parameter panel — NOT the nav sidebar) and `.btn`, `.btn-primary`, etc.

- [ ] **Step 1: Update `.sidebar` (param panel) to glass**

Find in `IMAGE_GEN_HTML`'s `<style>` block:
```
  .sidebar { background: #2b2d31; border-right: 1px solid #3f4147; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
```
Replace with:
```
  .sidebar { background: rgba(255,255,255,0.02); border-right: 1px solid rgba(255,255,255,0.06); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
```

- [ ] **Step 2: Update `.btn` and button variants**

Find:
```
  .btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; transition: filter .15s; }
  .btn:hover { filter: brightness(1.1); }
  .btn:active { filter: brightness(0.9); }
  .btn-primary { background: #5865f2; color: #fff; width: 100%; justify-content: center; }
  .btn-success { background: #3ba55d; color: #fff; }
  .btn-secondary { background: #4f5660; color: #fff; }
```
Replace with:
```
  .btn { display: inline-flex; align-items: center; gap: 7px; padding: 10px 18px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn:active { transform: translateY(0); filter: brightness(0.9); }
  .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; width: 100%; justify-content: center; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-primary:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-success { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; }
  .btn-success:hover { transform: translateY(-1px); }
  .btn-secondary { background: rgba(255,255,255,0.06); color: #fafafa; border: 1px solid rgba(255,255,255,0.08); }
  .btn-secondary:hover { background: rgba(255,255,255,0.1); transform: translateY(-1px); }
```

- [ ] **Step 3: Update `.preview-box` and `.history-item`**

Find:
```
  .preview-box { background: #111214; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 140px; justify-content: center; }
```
Replace with:
```
  .preview-box { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 140px; justify-content: center; }
```

Find:
```
  .history-item { background: #111214; border: 1px solid #3f4147; border-radius: 6px; overflow: hidden; }
```
Replace with:
```
  .history-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; transition: border-color 200ms, transform 200ms; }
  .history-item:hover { border-color: rgba(139,92,246,0.3); transform: translateY(-1px); }
```

- [ ] **Step 4: Update `.avatar-item`**

Find:
```
  .avatar-item { display: flex; align-items: center; gap: 10px; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 8px 10px; }
  .avatar-circle { width: 32px; height: 32px; border-radius: 50%; background: #5865f2; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; overflow: hidden; }
```
Replace with:
```
  .avatar-item { display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; }
  .avatar-circle { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; overflow: hidden; }
```

- [ ] **Step 5: Update `.status-bar` variants**

Find:
```
  .status-bar.ok { background: #1e3a2f; border: 1px solid #3ba55d44; color: #3ba55d; display: block; }
  .status-bar.err { background: #3a1e1e; border: 1px solid #ed424544; color: #ed4245; display: block; }
```
Replace with:
```
  .status-bar.ok { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; display: block; border-radius: 8px; }
  .status-bar.err { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #f87171; display: block; border-radius: 8px; }
```

- [ ] **Step 6: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass panels + gradient buttons on Image Generator"
```

---

## Task 8: Update PROOF_GEN_HTML — glass panels + gradient button

**Files:**
- Modify: `index.js` — `PROOF_GEN_HTML` constant

- [ ] **Step 1: Update `.panel` to glass**

Find in `PROOF_GEN_HTML`'s `<style>` block:
```
  .panel { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; flex: 1; min-width: 320px; }
  .panel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 14px; }
```
Replace with:
```
  .panel { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; flex: 1; min-width: 320px; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
  .panel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 16px; }
```

- [ ] **Step 2: Update `.btn` and `.btn-sm`**

Find:
```
  .btn { background: #5865f2; color: #fff; border: none; border-radius: 4px; padding: 10px 20px; cursor: pointer; font-size: 13px; font-weight: 600; width: 100%; margin-top: 16px; }
  .btn:hover { background: #4752c4; }
  .btn-sm { background: #3ba55d22; border: 1px solid #3ba55d44; color: #3ba55d; border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 12px; font-weight: 600; width: auto; margin-top: 0; }
  .btn-sm:hover { background: #3ba55d44; }
```
Replace with:
```
  .btn { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; border: none; border-radius: 8px; padding: 11px 20px; cursor: pointer; font-size: 13px; font-weight: 600; width: 100%; margin-top: 16px; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-sm { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; width: auto; margin-top: 0; }
  .btn-sm:hover { background: rgba(16,185,129,0.2); }
```

- [ ] **Step 3: Update `.alert-item` and `#preview-wrap`**

Find:
```
  .alert-item { background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 8px 10px; cursor: pointer; transition: border-color .15s; }
  .alert-item:hover { border-color: #5865f2; }
  .alert-item.selected { border-color: #3ba55d; background: #1a3a2a; }
```
Replace with:
```
  .alert-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 200ms; }
  .alert-item:hover { border-color: rgba(139,92,246,0.4); background: rgba(255,255,255,0.05); }
  .alert-item.selected { border-color: rgba(16,185,129,0.5); background: rgba(16,185,129,0.1); }
```

Find:
```
  #preview-wrap { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; flex: 0 0 100%; }
```
Replace with:
```
  #preview-wrap { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; flex: 0 0 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
```

- [ ] **Step 4: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass panels + gradient buttons on Proof Generator"
```

---

## Task 9: Update RAW_MESSAGES_HTML — glass message cards

**Files:**
- Modify: `index.js` — `RAW_MESSAGES_HTML` constant

- [ ] **Step 1: Update `.msg-card` to glass**

Find in `RAW_MESSAGES_HTML`'s `<style>` block:
```
  .msg-card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
  .msg-card.new { animation: flash .8s ease-out; }
```
Replace with:
```
  .msg-card { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px 18px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; transition: background 200ms, border-color 200ms; }
  .msg-card:hover { background: rgba(255,255,255,0.05); border-color: rgba(139,92,246,0.3); }
  .msg-card.new { animation: flash .8s ease-out; }
```

- [ ] **Step 2: Update `flash` keyframe to match new palette**

Find:
```
  @keyframes flash { from { background: #2a3040; } to { background: #2b2d31; } }
```
Replace with:
```
  @keyframes flash { from { background: rgba(139,92,246,0.15); } to { background: rgba(255,255,255,0.03); } }
```

- [ ] **Step 3: Update search bar inputs**

Find:
```
  #search-input { flex: 1; background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 7px 12px; font-size: 13px; outline: none; }
  #search-input:focus { border-color: #5865f2; }
  #search-input::placeholder { color: #80848e; }
  #filter-author { background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 7px 10px; font-size: 13px; outline: none; cursor: pointer; }
  #filter-author:focus { border-color: #5865f2; }
```
Replace with:
```
  #search-input { flex: 1; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #fafafa; padding: 9px 14px; font-size: 13px; outline: none; }
  #search-input:focus { border-color: rgba(139,92,246,0.5); background: rgba(255,255,255,0.06); }
  #search-input::placeholder { color: #a0a0b0; }
  #filter-author { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; color: #fafafa; padding: 9px 12px; font-size: 13px; outline: none; cursor: pointer; }
  #filter-author:focus { border-color: rgba(139,92,246,0.5); }
```

- [ ] **Step 4: Bump badge radius**

Find:
```
  .badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
```
Replace with:
```
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
```

- [ ] **Step 5: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass message cards on Raw Messages"
```

---

## Task 10: Update configPageHtml — remove duplicates

**Files:**
- Modify: `index.js` — inline template in `app.get('/config', ...)` handler

- [ ] **Step 1: Remove duplicate rules**

Find in the config route's inline `<style>` block:
```
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 14px; }
```
Replace with: *(remove both lines — they're now in COMMON_CSS)*

- [ ] **Step 2: Update `.tag` variants**

Find:
```
  .tag { display: inline-block; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 2px 8px; font-size: 12px; margin: 3px; }
```
Replace with:
```
  .tag { display: inline-block; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 10px; font-size: 12px; margin: 3px; }
```

- [ ] **Step 3: Update env-val**

Find:
```
  .env-val { font-size: 12px; color: #dcddde; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 4px 10px; flex: 1; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```
Replace with:
```
  .env-val { font-size: 12px; color: #fafafa; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 12px; flex: 1; font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Update table styling**

Find:
```
  thead th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 8px 8px; border-bottom: 1px solid #3f4147; }
  tbody tr { border-bottom: 1px solid #2b2d31; }
  tbody tr:hover { background: #32353b; }
```
Replace with:
```
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
```

- [ ] **Step 5: Verify and commit**

```bash
node --check index.js
git add index.js
git commit -m "feat(ui): glass cards on Config"
```

---

## Task 11: Final verification

- [ ] **Step 1: Syntax check**

```bash
node --check index.js
```
Expected: exit 0, no output.

- [ ] **Step 2: Grep for old palette leaks**

```bash
grep -n "#2b2d31\|#3f4147\|#1e1f22" index.js | grep -v "LOGIN_HTML\|login" | head -20
```
Expected: few or no matches in authenticated page templates (LOGIN_HTML is out of scope and may still contain old colors).

- [ ] **Step 3: Start server and quick smoke test** (optional)

```bash
node index.js &
sleep 3
curl -s http://localhost:3000/health
kill %1
```
Expected: JSON health response. Kill server after.

- [ ] **Step 4: Final commit if anything was missed**

```bash
git status
git log --oneline -12
```
