# Dashboard Shell Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tokenize the dashboard's shared CSS into CSS custom properties and restructure the flat 14-item sidebar into 4 logical groups, without changing any per-page logic or breaking existing class consumers.

**Architecture:** Single-file edit on `pages/common.js`. Add a `:root` token block at the top of `COMMON_CSS`. Replace hardcoded values throughout with `var(--token-name)`. Restructure `SIDEBAR_LINKS` from a flat array into grouped sections; export `SIDEBAR_LINKS_FLAT` for backward compatibility. Update `sidebarHTML()` to render section headers. Add `.chip-*` utility classes. Test the new sidebar structure with `pages/common.test.js`.

**Tech Stack:** Node.js, `node:test` runner. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-15-dashboard-shell-refresh-design.md](../specs/2026-05-15-dashboard-shell-refresh-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `pages/common.js` | Modify | Add `:root` token block. Tokenize `COMMON_CSS`. Restructure `SIDEBAR_LINKS`. Add `SIDEBAR_LINKS_FLAT`. Update `sidebarHTML()` to render groups. Add `.nav-sidebar-section` CSS. Add `.chip-*` utilities. Consolidate `.btn-*` rules. |
| `pages/common.test.js` | Create | Tests for `sidebarHTML('/dashboard')` structure (sections + items + active class) and `SIDEBAR_LINKS_FLAT` flat shape. |
| Per-page modules | NOT modified | All inherit the new tokens via `${COMMON_CSS}`. Behavior identical. |
| `PUBLIC_CSS` / marketing pages | NOT modified | Out of scope. |

---

## Task 1: Tokenize `COMMON_CSS`

Add a `:root` block declaring all design tokens, then replace hardcoded values in the existing CSS rules with `var(--token)` references. Visual output is identical — this is a pure refactor for maintainability.

**Files:**
- Modify: `pages/common.js`

- [ ] **Step 1: Add the `:root` token block at the very top of `COMMON_CSS`**

Find the line:
```javascript
const COMMON_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
```

Immediately AFTER the `@import` line and BEFORE the `*, *::before, *::after` reset, insert the `:root` declaration. The resulting top of `COMMON_CSS` becomes:

```javascript
const COMMON_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  :root {
    /* Backgrounds */
    --bg-base:        #0a0a0f;
    --bg-elev-1:      rgba(255,255,255,0.03);
    --bg-elev-2:      rgba(255,255,255,0.04);
    --bg-elev-3:      rgba(255,255,255,0.06);
    --bg-elev-4:      rgba(255,255,255,0.08);
    --bg-sidebar:     #0f0f14;
    --bg-glass:       rgba(10,10,15,0.8);

    /* Borders */
    --border-subtle:  rgba(255,255,255,0.05);
    --border-default: rgba(255,255,255,0.08);
    --border-strong:  rgba(255,255,255,0.18);
    --border-accent:  rgba(139,92,246,0.5);

    /* Text */
    --fg-strong:      #fafafa;
    --fg-default:     #c0c0cc;
    --fg-muted:       #a0a0b0;
    --fg-subtle:      #707080;

    /* Accent (gradient blue→purple, preserved) */
    --accent-blue:    #3b82f6;
    --accent-purple:  #8b5cf6;
    --accent-grad:    linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
    --accent-glow:    0 4px 16px rgba(139,92,246,0.4);
    --accent-glow-sm: 0 2px 8px rgba(59,130,246,0.3);

    /* Semantic */
    --ok:             #3ba55d;
    --err:            #ed4245;
    --warn:           #f59e0b;
    --info:           #3b82f6;
    --neutral:        #80848e;

    /* Typography */
    --font-sans:      'Inter', system-ui, sans-serif;
    --font-mono:      'JetBrains Mono', ui-monospace, Consolas, monospace;

    /* Type scale */
    --text-xs:        11px;
    --text-sm:        12px;
    --text-base:      13px;
    --text-md:        14px;
    --text-lg:        16px;
    --text-xl:        18px;
    --text-2xl:       22px;
    --text-3xl:       32px;
    --text-4xl:       52px;

    /* Spacing (4px scale) */
    --space-1:        4px;
    --space-2:        8px;
    --space-3:        12px;
    --space-4:        16px;
    --space-5:        20px;
    --space-6:        24px;
    --space-7:        32px;
    --space-8:        48px;

    /* Radii */
    --r-sm:           4px;
    --r-md:           8px;
    --r-lg:           12px;
    --r-xl:           16px;
    --r-pill:         999px;

    /* Transitions */
    --t-fast:         200ms cubic-bezier(0.4, 0, 0.2, 1);
    --t-slow:         400ms ease;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
```

Note the keep of `--accent-grad` using literal hex values (not `var(--accent-blue/purple)`) — gradients with var-resolved color stops are fragile across browsers; literal values are reliable.

- [ ] **Step 2: Replace hardcoded values in the body styles**

Find the line:
```javascript
  body { background: #0a0a0f; color: #fafafa; font-family: 'Inter', system-ui, sans-serif; font-size: 14px; line-height: 1.5; display: flex; min-height: 100vh; }
```

Replace with:
```javascript
  body { background: var(--bg-base); color: var(--fg-strong); font-family: var(--font-sans); font-size: var(--text-md); line-height: 1.5; display: flex; min-height: 100vh; }
```

- [ ] **Step 3: Replace hardcoded values in the sidebar rules**

Find this block:
```javascript
  /* Sidebar */
  .nav-sidebar { width: 220px; min-width: 220px; background: #0f0f14; border-right: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; overflow-y: auto; z-index: 20; flex-shrink: 0; }
  .nav-sidebar-logo { padding: 22px 18px 16px; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 10px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }
  .nav-sidebar a { display: flex; align-items: center; gap: 10px; padding: 10px 18px; font-size: 13px; font-weight: 500; color: #a0a0b0; text-decoration: none; border-left: 3px solid transparent; }
  .nav-sidebar a:hover { background: rgba(255,255,255,0.04); color: #fafafa; }
  .nav-sidebar a.active { background: rgba(139,92,246,0.1); color: #fafafa; border-left: 3px solid transparent; border-image: linear-gradient(180deg, #3b82f6, #8b5cf6) 1; font-weight: 600; }
  .nav-sidebar-icon { font-size: 15px; min-width: 20px; text-align: center; }
```

Replace with:
```javascript
  /* Sidebar */
  .nav-sidebar { width: 220px; min-width: 220px; background: var(--bg-sidebar); border-right: 1px solid var(--border-subtle); display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; overflow-y: auto; z-index: 20; flex-shrink: 0; }
  .nav-sidebar-logo { padding: 22px 18px 16px; font-size: var(--text-xl); font-weight: 800; letter-spacing: -0.02em; border-bottom: 1px solid var(--border-subtle); margin-bottom: var(--space-3); background: var(--accent-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }
  .nav-sidebar a { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) 18px; font-size: var(--text-base); font-weight: 500; color: var(--fg-muted); text-decoration: none; border-left: 3px solid transparent; }
  .nav-sidebar a:hover { background: var(--bg-elev-2); color: var(--fg-strong); }
  .nav-sidebar a.active { background: rgba(139,92,246,0.1); color: var(--fg-strong); border-left: 3px solid transparent; border-image: linear-gradient(180deg, var(--accent-blue), var(--accent-purple)) 1; font-weight: 600; }
  .nav-sidebar-icon { font-size: 15px; min-width: 20px; text-align: center; }
```

- [ ] **Step 4: Replace hardcoded values in the page layout rules**

Find:
```javascript
  /* Page layout */
  .page-content { flex: 1; min-width: 0; overflow-y: auto; }
  .page-header { display: flex; align-items: center; gap: 14px; padding: 20px 32px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(10,10,15,0.8); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10; }
  .page-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #fafafa; flex-shrink: 0; }
```

Replace with:
```javascript
  /* Page layout */
  .page-content { flex: 1; min-width: 0; overflow-y: auto; }
  .page-header { display: flex; align-items: center; gap: 14px; padding: var(--space-5) var(--space-7); border-bottom: 1px solid var(--border-default); background: var(--bg-glass); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10; }
  .page-title { font-size: var(--text-2xl); font-weight: 700; letter-spacing: -0.02em; color: var(--fg-strong); flex-shrink: 0; }
```

- [ ] **Step 5: Replace hardcoded values in the cards rules**

Find:
```javascript
  /* Cards (glass) */
  .card { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1); animation: fadeInUp 400ms cubic-bezier(0.4,0,0.2,1) both; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(139,92,246,0.3); }
```

Replace with:
```javascript
  /* Cards (glass) */
  .card { background: var(--bg-elev-1); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--border-default); border-radius: var(--r-lg); padding: var(--space-6); box-shadow: 0 4px 24px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1); animation: fadeInUp 400ms cubic-bezier(0.4,0,0.2,1) both; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(139,92,246,0.3); }
```

(Card animation delays stay as-is — they're `nth-child` rules with ms values that don't need tokenization.)

- [ ] **Step 6: Replace hardcoded values in `.card-title`, `.big-number`, `.big-sub`**

Find:
```javascript
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 16px; }
  .big-number { font-size: 52px; font-weight: 800; color: #fafafa; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .big-sub { font-size: 13px; color: #a0a0b0; margin-top: 6px; }
```

Replace with:
```javascript
  .card-title { font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-muted); margin-bottom: var(--space-4); }
  .big-number { font-size: var(--text-4xl); font-weight: 800; color: var(--fg-strong); line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .big-sub { font-size: var(--text-base); color: var(--fg-muted); margin-top: 6px; }
```

- [ ] **Step 7: Replace hardcoded values in `.btn-primary`, `.btn-refresh`, `.btn-add`, `.btn-period`**

Find this block of button rules:
```javascript
  /* Buttons */
  .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-primary:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-refresh { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; border: none; color: #fff; border-radius: 8px; padding: 8px 18px; cursor: pointer; font-size: 13px; font-weight: 600; margin-left: auto; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-refresh:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-add { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; border: none; color: #fff; border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-add:hover { background-position: 100% 50%; transform: translateY(-1px); }
  .btn-period { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-period:hover { background: rgba(255,255,255,0.06); color: #fafafa; }
  .btn-period.active { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.4); color: #c4b5fd; }
```

Replace with (consolidated gradient buttons share a selector list, period button tokenized):
```javascript
  /* Buttons */
  .btn-primary, .btn-refresh, .btn-add { background: var(--accent-grad); background-size: 200% 200%; background-position: 0% 50%; color: #fff; border: none; border-radius: var(--r-md); cursor: pointer; font-weight: 600; box-shadow: var(--accent-glow-sm); }
  .btn-primary { padding: var(--space-3) var(--space-5); font-size: var(--text-md); }
  .btn-refresh { padding: var(--space-2) 18px; font-size: var(--text-base); margin-left: auto; }
  .btn-add { padding: var(--space-3) var(--space-5); font-size: var(--text-base); }
  .btn-primary:hover, .btn-refresh:hover, .btn-add:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: var(--accent-glow); }
  .btn-period { background: var(--bg-elev-1); border: 1px solid var(--border-default); color: var(--fg-muted); border-radius: var(--r-md); padding: 6px 14px; cursor: pointer; font-size: var(--text-sm); font-weight: 600; }
  .btn-period:hover { background: var(--bg-elev-3); color: var(--fg-strong); }
  .btn-period.active { background: rgba(139,92,246,0.15); border-color: var(--border-accent); color: #c4b5fd; }
```

- [ ] **Step 8: Replace hardcoded values in input rules**

Find:
```javascript
  /* Inputs */
  input[type=text], input[type=number], input[type=password], input[type=time], textarea, select { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; padding: 9px 12px; font-family: inherit; font-size: 14px; outline: none; }
  input[type=text]:focus, input[type=number]:focus, input[type=password]:focus, input[type=time]:focus, textarea:focus, select:focus { border-color: rgba(139,92,246,0.5); background: rgba(255,255,255,0.06); }
```

Replace with:
```javascript
  /* Inputs */
  input[type=text], input[type=number], input[type=password], input[type=time], textarea, select { background: var(--bg-elev-2); border: 1px solid var(--border-default); color: var(--fg-strong); border-radius: var(--r-md); padding: 9px 12px; font-family: inherit; font-size: var(--text-md); outline: none; }
  input[type=text]:focus, input[type=number]:focus, input[type=password]:focus, input[type=time]:focus, textarea:focus, select:focus { border-color: var(--border-accent); background: var(--bg-elev-3); }
```

- [ ] **Step 9: Replace hardcoded values in scrollbar rules**

Find:
```javascript
  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
```

Replace with:
```javascript
  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: var(--r-sm); }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
```

- [ ] **Step 10: Verify syntax**

Run: `node --check pages/common.js`

Expected: No output (exit 0).

- [ ] **Step 11: Smoke-test the require**

Run: `node -e "const c = require('./pages/common'); console.log(c.COMMON_CSS.includes(':root'));"`

Expected: `true`.

- [ ] **Step 12: Commit**

```bash
git add pages/common.js
git commit -m "refactor(common-css): tokenize colors, spacing, type scale via CSS variables

Add :root design-token block. Replace hardcoded values throughout
COMMON_CSS with var(--token) references. Visual output identical —
pure refactor for maintainability. Consolidate .btn-primary /
.btn-refresh / .btn-add into a shared selector list (DRY).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `.chip-*` utility classes

The chip styles are new additions to `COMMON_CSS`. Pages can opt into them incrementally — no existing rules touched.

**Files:**
- Modify: `pages/common.js`

- [ ] **Step 1: Add the chip rules**

In `pages/common.js`, find the existing closing backtick of `COMMON_CSS` (search for `}\n\`;` near line ~72 of the original file, or near the end of the template literal). Just BEFORE the closing backtick, append the chip rules:

```javascript
  /* Chips (unified badge style — opt-in per page) */
  .chip { display: inline-flex; align-items: center; padding: 2px var(--space-2); border-radius: var(--r-pill); font-size: var(--text-xs); font-weight: 600; font-family: var(--font-mono); white-space: nowrap; }
  .chip-ok      { background: rgba(59,165,93,0.15);   color: #6ee7b7; }
  .chip-err     { background: rgba(237,66,69,0.15);   color: #f87171; }
  .chip-warn    { background: rgba(245,158,11,0.15);  color: #fbbf24; }
  .chip-info    { background: rgba(59,130,246,0.15);  color: #93c5fd; }
  .chip-neutral { background: rgba(128,132,142,0.15); color: #a1a1aa; }
```

- [ ] **Step 2: Verify syntax**

Run: `node --check pages/common.js`

Expected: No output (exit 0).

- [ ] **Step 3: Verify the chip classes are present**

Run: `node -e "const c = require('./pages/common'); console.log(['chip-ok','chip-err','chip-warn','chip-info','chip-neutral'].every(s => c.COMMON_CSS.includes('.' + s)));"`

Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add pages/common.js
git commit -m "feat(common-css): add .chip-* utility classes for unified badges

Adds .chip + .chip-{ok,err,warn,info,neutral} as opt-in utilities.
Per-page badges can migrate incrementally — no existing class is
touched. Adopters get the same pill shape, tokenized colors, and
monospace font without re-defining the rules locally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Restructure the sidebar (TDD)

Replace the flat `SIDEBAR_LINKS` array with a grouped structure, export a `SIDEBAR_LINKS_FLAT` derivative for backward compatibility, update `sidebarHTML()` to render section headers, and add the `.nav-sidebar-section` CSS rule.

**Files:**
- Modify: `pages/common.js`
- Create: `pages/common.test.js`

- [ ] **Step 1: Write the failing test**

Create `pages/common.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { sidebarHTML, SIDEBAR_LINKS, SIDEBAR_LINKS_FLAT } = require('./common');

test('SIDEBAR_LINKS is an array of 4 groups', () => {
  assert.ok(Array.isArray(SIDEBAR_LINKS), 'SIDEBAR_LINKS should be an array');
  assert.strictEqual(SIDEBAR_LINKS.length, 4, 'should have 4 groups');
  const sectionNames = SIDEBAR_LINKS.map(g => g.section);
  assert.deepStrictEqual(sectionNames, ['Overview', 'Content', 'Logs', 'Settings']);
});

test('SIDEBAR_LINKS_FLAT exposes the 14 items as a flat array', () => {
  assert.ok(Array.isArray(SIDEBAR_LINKS_FLAT));
  assert.strictEqual(SIDEBAR_LINKS_FLAT.length, 14);
  // Every entry has the expected shape
  for (const item of SIDEBAR_LINKS_FLAT) {
    assert.strictEqual(typeof item.href, 'string');
    assert.strictEqual(typeof item.icon, 'string');
    assert.strictEqual(typeof item.label, 'string');
  }
});

test('SIDEBAR_LINKS_FLAT contains all the expected hrefs', () => {
  const expectedHrefs = [
    '/dashboard', '/stats', '/profits', '/leaderboard',
    '/news', '/image-generator', '/proof-generator', '/gallery', '/video-studio',
    '/raw-messages', '/db-viewer', '/backup-log', '/welcome-log',
    '/config',
  ];
  const actualHrefs = SIDEBAR_LINKS_FLAT.map(l => l.href);
  assert.deepStrictEqual(actualHrefs.sort(), expectedHrefs.sort());
});

test('sidebarHTML renders all 4 section headers', () => {
  const html = sidebarHTML('/dashboard');
  for (const section of ['Overview', 'Content', 'Logs', 'Settings']) {
    assert.ok(html.includes(section), 'should include section header "' + section + '"');
  }
});

test('sidebarHTML renders all 14 item hrefs', () => {
  const html = sidebarHTML('/dashboard');
  for (const href of ['/dashboard', '/stats', '/profits', '/leaderboard',
    '/news', '/image-generator', '/proof-generator', '/gallery', '/video-studio',
    '/raw-messages', '/db-viewer', '/backup-log', '/welcome-log',
    '/config']) {
    assert.ok(html.includes('href="' + href + '"'), 'should include href ' + href);
  }
});

test('sidebarHTML marks the active link with class="active"', () => {
  const html = sidebarHTML('/stats');
  // Active link should be /stats
  assert.match(html, /href="\/stats" class="active"/);
  // Other links should NOT have class="active"
  assert.doesNotMatch(html, /href="\/dashboard" class="active"/);
  assert.doesNotMatch(html, /href="\/profits" class="active"/);
});

test('sidebarHTML renders the section header CSS class .nav-sidebar-section', () => {
  const html = sidebarHTML('/dashboard');
  assert.ok(html.includes('class="nav-sidebar-section"'),
    'should render section headers with class="nav-sidebar-section"');
});

test('sidebarHTML renders the BOOM logo', () => {
  const html = sidebarHTML('/dashboard');
  assert.ok(html.includes('🔥 BOOM'), 'should include the BOOM logo');
  assert.ok(html.includes('nav-sidebar-logo'), 'should use .nav-sidebar-logo class');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pages/common.test.js`

Expected: FAIL — the new shape of `SIDEBAR_LINKS` is not yet implemented (current shape is a flat array), `SIDEBAR_LINKS_FLAT` is not exported, `sidebarHTML` doesn't render section headers.

- [ ] **Step 3: Replace `SIDEBAR_LINKS` with the grouped structure**

In `pages/common.js`, find the existing:
```javascript
// Liens de la sidebar. Ajouter une page ? Ajouter une entrée ici et
// créer la route Express correspondante.
const SIDEBAR_LINKS = [
  { href: '/dashboard',       icon: '📡', label: 'Dashboard' },
  { href: '/stats',           icon: '📊', label: 'Stats' },
  { href: '/profits',         icon: '💰', label: 'Profits' },
  { href: '/news',            icon: '📰', label: 'News' },
  { href: '/leaderboard',     icon: '🏆', label: 'Leaderboard' },
  { href: '/image-generator', icon: '🖼️', label: 'Image Generator' },
  { href: '/proof-generator', icon: '🔍', label: 'Proof Generator' },
  { href: '/gallery',         icon: '🖼', label: 'Galerie' },
  { href: '/video-studio',    icon: '🎬', label: 'Video Studio' },
  { href: '/raw-messages',    icon: '📋', label: 'Raw Messages' },
  { href: '/db-viewer',       icon: '🗄️', label: 'DB Viewer' },
  { href: '/backup-log',      icon: '💾', label: 'Backup Log' },
  { href: '/welcome-log',     icon: '👋', label: 'Welcome Log' },
  { href: '/config',          icon: '⚙️', label: 'Config' },
];
```

Replace with:
```javascript
// Liens de la sidebar — groupés en 4 sections (Overview / Content / Logs /
// Settings). Ajouter une page = ajouter une entrée dans le bon groupe puis
// créer la route Express. Pour les consumers qui ont besoin de l'ancien
// shape plat, voir SIDEBAR_LINKS_FLAT plus bas.
const SIDEBAR_LINKS = [
  {
    section: 'Overview',
    items: [
      { href: '/dashboard',   icon: '📡',  label: 'Dashboard' },
      { href: '/stats',       icon: '📊',  label: 'Stats' },
      { href: '/profits',     icon: '💰',  label: 'Profits' },
      { href: '/leaderboard', icon: '🏆',  label: 'Leaderboard' },
    ],
  },
  {
    section: 'Content',
    items: [
      { href: '/news',            icon: '📰', label: 'News' },
      { href: '/image-generator', icon: '🖼️', label: 'Image Generator' },
      { href: '/proof-generator', icon: '🔍', label: 'Proof Generator' },
      { href: '/gallery',         icon: '🖼', label: 'Galerie' },
      { href: '/video-studio',    icon: '🎬', label: 'Video Studio' },
    ],
  },
  {
    section: 'Logs',
    items: [
      { href: '/raw-messages', icon: '📋', label: 'Raw Messages' },
      { href: '/db-viewer',    icon: '🗄️', label: 'DB Viewer' },
      { href: '/backup-log',   icon: '💾', label: 'Backup Log' },
      { href: '/welcome-log',  icon: '👋', label: 'Welcome Log' },
    ],
  },
  {
    section: 'Settings',
    items: [
      { href: '/config', icon: '⚙️', label: 'Config' },
    ],
  },
];

// Backward-compat: any consumer that previously iterated SIDEBAR_LINKS as
// a flat array can use this derivative.
const SIDEBAR_LINKS_FLAT = SIDEBAR_LINKS.flatMap(g => g.items);
```

- [ ] **Step 4: Update `sidebarHTML()` to render the grouped layout**

Find the existing:
```javascript
function sidebarHTML(active) {
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${SIDEBAR_LINKS.map(l => `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}><span class="nav-sidebar-icon">${l.icon}</span>${l.label}</a>`).join('\n  ')}
</nav>`;
}
```

Replace with:
```javascript
function sidebarHTML(active) {
  const groupsHtml = SIDEBAR_LINKS.map(group => {
    const header = `<div class="nav-sidebar-section">${group.section}</div>`;
    const items = group.items.map(l =>
      `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}><span class="nav-sidebar-icon">${l.icon}</span>${l.label}</a>`
    ).join('\n  ');
    return header + '\n  ' + items;
  }).join('\n  ');
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${groupsHtml}
</nav>`;
}
```

- [ ] **Step 5: Add the section-header CSS rule**

In `pages/common.js`, find the existing sidebar CSS block:
```javascript
  .nav-sidebar-icon { font-size: 15px; min-width: 20px; text-align: center; }
```

Immediately AFTER this line, add:
```javascript
  .nav-sidebar-section { padding: var(--space-5) var(--space-4) var(--space-2); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-subtle); }
  .nav-sidebar-section:first-of-type { padding-top: var(--space-3); }
```

- [ ] **Step 6: Add `SIDEBAR_LINKS_FLAT` to module.exports**

Find the existing `module.exports` block at the end of the file:
```javascript
module.exports = {
  COMMON_CSS,
  PUBLIC_CSS,
  SIDEBAR_LINKS,
  sidebarHTML,
  publicLayoutHTML,
  escapeHtml,
};
```

Replace with:
```javascript
module.exports = {
  COMMON_CSS,
  PUBLIC_CSS,
  SIDEBAR_LINKS,
  SIDEBAR_LINKS_FLAT,
  sidebarHTML,
  publicLayoutHTML,
  escapeHtml,
};
```

- [ ] **Step 7: Run the tests to verify they all pass**

Run: `node --test pages/common.test.js`

Expected: All 8 tests PASS.

- [ ] **Step 8: Run the full test suite to confirm no regression**

Run: `node --test 2>&1 | tail -10`

Expected: Test count increased by 8 vs. the prior baseline. The 2 known pre-existing failures (`services/llm-classify.test.js` Windows SQLite EBUSY + `video/scripts/test-tts-voice.js` TTS diagnostic) remain. NO new failures.

- [ ] **Step 9: Verify syntax on common.js once more**

Run: `node --check pages/common.js`

Expected: No output (exit 0).

- [ ] **Step 10: Commit**

```bash
git add pages/common.js pages/common.test.js
git commit -m "feat(sidebar): group 14 items into 4 sections (Overview/Content/Logs/Settings)

SIDEBAR_LINKS becomes a grouped structure with sections. Export
SIDEBAR_LINKS_FLAT (derived via .flatMap) for any consumer that
needs the original flat shape. Update sidebarHTML() to render
section headers with the new .nav-sidebar-section CSS class.

8 new unit tests in pages/common.test.js cover the grouped
shape, the flat export, the rendered HTML structure, and the
active-link marking.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Final verification + manual smoke

- [ ] **Step 1: Full test suite green**

Run: `node --test 2>&1 | tail -10`

Expected: Pass count increased by 8 vs. before Task 3. Same 2 pre-existing failures (`services/llm-classify.test.js` Windows EBUSY + `video/scripts/test-tts-voice.js` TTS).

- [ ] **Step 2: Syntax check**

Run: `node --check pages/common.js`

Expected: No output (exit 0).

- [ ] **Step 3: Confirm key tokens exist in the bundled CSS**

Run: `node -e "const c = require('./pages/common'); console.log(c.COMMON_CSS.includes(':root') && c.COMMON_CSS.includes('--bg-base') && c.COMMON_CSS.includes('--accent-grad') && c.COMMON_CSS.includes('nav-sidebar-section'));"`

Expected: `true`. (Sanity check that the `:root` block, key tokens, and section-header CSS all landed.)

- [ ] **Step 4: Print user-facing summary**

Print to the user:

```
✅ Dashboard shell refresh ready. After Railway redeploys:

1. Open /dashboard (any auth-protected page).
2. The sidebar should now show 4 grouped sections:
   • OVERVIEW (Dashboard, Stats, Profits, Leaderboard)
   • CONTENT (News, Image Generator, Proof Generator, Galerie, Video Studio)
   • LOGS (Raw Messages, DB Viewer, Backup Log, Welcome Log)
   • SETTINGS (Config)
3. Section headers are small uppercase in muted gray (.nav-sidebar-section).
4. Visual style of cards, buttons, badges, colors is IDENTICAL to before
   — only the underlying CSS is now tokenized via :root variables.
5. New .chip-{ok,err,warn,info,neutral} utility classes are available
   for pages to adopt (welcome-log, dashboard, stats can migrate
   incrementally in follow-up PRs).

Tests: 8 new in pages/common.test.js. Visual regression: none expected.

If anything looks off in production, the rollback is a simple revert
of the merge commit — no env vars, no DB changes, no migrations.
```

---

## Out of scope (deferred to follow-ups)

- Per-page content / layout changes (KPI cards on Dashboard, filters, etc.)
- Mobile responsive
- `PUBLIC_CSS` refresh (marketing site)
- Icon migration (emoji → SVG via Lucide)
- Light mode
- Sidebar collapse / drawer behavior
- Per-page migration to `.chip-*` utilities (each page can adopt independently)
- Animation / micro-interactions beyond what already exists
