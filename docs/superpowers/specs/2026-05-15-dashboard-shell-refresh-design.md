# Dashboard Shell Refresh — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Scope:** Visual + structural refresh of the dashboard shell (`pages/common.js`). Tokenize the existing CSS, regroup the 14 sidebar items into 4 logical sections, formalize the typography and spacing scales, unify badge styles. No changes to per-page logic, no changes to `PUBLIC_CSS` (marketing site), no new features, no mobile responsive work.

---

## 1. Goal

Two operator-stated pain points:
- **Visual / aesthetic** — current dashboard works but feels generic. Direction chosen: "Modern SaaS" (Vercel / Stripe / Linear vibe).
- **Sidebar too cluttered** — 14 flat items with no grouping makes scanning harder than it should be.

The current `pages/common.js` already does many things right: Inter font, gradient logo, glass-style cards with hover, gradient buttons, subtle scrollbar, fade-in animations. The starting point is solid — this refresh is a *polish + restructure*, not a rewrite.

After this work:
- Every color, spacing value, font size, and radius is a CSS custom property (`var(--token-name)`). Future tweaks become one-line changes.
- The sidebar groups 14 items into 4 sections (`Overview`, `Content`, `Logs`, `Settings`) with discreet section headers.
- Badge styles (used in dashboard rows, welcome-log, etc.) are unified via reusable `.chip-*` utility classes.
- The existing blue→purple gradient (`#3b82f6 → #8b5cf6`) is preserved — consistent with the public marketing site (`PUBLIC_CSS`).

Net result: visually 80% the same (because users like the current look) but more maintainable and the sidebar is much easier to navigate.

## 2. Files touched

| File | Action | Why |
|---|---|---|
| `pages/common.js` | Modify | `COMMON_CSS` refactored to use CSS variables. `SIDEBAR_LINKS` restructured into groups. `sidebarHTML` updated to render the grouped layout. |
| `pages/common.test.js` | Create (or extend) | Snapshot test on `sidebarHTML('/dashboard')` to verify the grouped HTML structure. Test that `SIDEBAR_LINKS` still exposes a flat `entries` derivative for any consumer expecting an array. |
| Per-page modules (`pages/dashboard.js`, `pages/stats.js`, etc.) | NOT modified | They inherit the new tokens via `${COMMON_CSS}`. Inline `<style>` blocks per page stay untouched (they continue to work with hardcoded values — future per-page passes can migrate to tokens incrementally). |
| `PUBLIC_CSS` (marketing site) | NOT modified | Out of scope. Marketing site keeps current look. |

## 3. CSS variables (design tokens)

All tokens declared on `:root` at the top of `COMMON_CSS`. The current hardcoded values map onto these variables 1:1, so the visual output is identical until someone tweaks a token.

```css
:root {
  /* Backgrounds */
  --bg-base:        #0a0a0f;
  --bg-elev-1:      rgba(255,255,255,0.03);   /* cards */
  --bg-elev-2:      rgba(255,255,255,0.04);   /* inputs, btn-period */
  --bg-elev-3:      rgba(255,255,255,0.06);   /* hover */
  --bg-elev-4:      rgba(255,255,255,0.08);   /* active */
  --bg-sidebar:     #0f0f14;
  --bg-glass:       rgba(10,10,15,0.8);       /* page-header backdrop */

  /* Borders */
  --border-subtle:  rgba(255,255,255,0.05);
  --border-default: rgba(255,255,255,0.08);
  --border-strong:  rgba(255,255,255,0.18);
  --border-accent:  rgba(139,92,246,0.5);     /* focus / hover accent */

  /* Text */
  --fg-strong:      #fafafa;
  --fg-default:     #c0c0cc;
  --fg-muted:       #a0a0b0;
  --fg-subtle:      #707080;

  /* Accent (gradient blue→purple, PRESERVED from current) */
  --accent-blue:    #3b82f6;
  --accent-purple:  #8b5cf6;
  --accent-grad:    linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-purple) 100%);
  --accent-glow:    0 4px 16px rgba(139,92,246,0.4);
  --accent-glow-sm: 0 2px 8px rgba(59,130,246,0.3);

  /* Semantic */
  --ok:             #3ba55d;    /* green — keep current */
  --err:            #ed4245;    /* red */
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
```

Migration strategy: every existing hardcoded value in `COMMON_CSS` is replaced by its token. Visually identical. Example:

```css
/* Before */
.card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; }

/* After */
.card { background: var(--bg-elev-1); border: 1px solid var(--border-default); border-radius: var(--r-lg); padding: var(--space-6); }
```

## 4. Sidebar restructuring

### Current (flat, 14 items)
```
Dashboard, Stats, Profits, News, Leaderboard, Image Generator, Proof Generator,
Galerie, Video Studio, Raw Messages, DB Viewer, Backup Log, Welcome Log, Config
```

### After (4 groups, same 14 items)

```
🔥 BOOM   ← logo unchanged

OVERVIEW
  📡 Dashboard
  📊 Stats
  💰 Profits
  🏆 Leaderboard

CONTENT
  📰 News
  🖼️  Image Generator
  🔍 Proof Generator
  🖼  Galerie
  🎬 Video Studio

LOGS
  📋 Raw Messages
  🗄️  DB Viewer
  💾 Backup Log
  👋 Welcome Log

SETTINGS
  ⚙️  Config
```

### `SIDEBAR_LINKS` data structure change

Before (flat array):
```js
const SIDEBAR_LINKS = [
  { href: '/dashboard', icon: '📡', label: 'Dashboard' },
  ...
];
```

After (grouped):
```js
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
```

### Backward compatibility for tests/consumers

Some existing test (or future consumer) may expect `SIDEBAR_LINKS` to be a flat array of items. To maintain compatibility, also export `SIDEBAR_LINKS_FLAT`:

```js
const SIDEBAR_LINKS_FLAT = SIDEBAR_LINKS.flatMap(g => g.items);
```

`module.exports` keeps both: `SIDEBAR_LINKS` (new grouped shape — preferred), `SIDEBAR_LINKS_FLAT` (flat, for any consumer that iterates).

### `sidebarHTML(active)` updated

```js
function sidebarHTML(active) {
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${SIDEBAR_LINKS.map(group => `
    <div class="nav-sidebar-section">${group.section}</div>
    ${group.items.map(l =>
      `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}>
        <span class="nav-sidebar-icon">${l.icon}</span>${l.label}
      </a>`
    ).join('\n    ')}
  `).join('\n  ')}
</nav>`;
}
```

### Sidebar CSS additions

```css
.nav-sidebar-section {
  padding: var(--space-5) var(--space-4) var(--space-2);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-subtle);
}
.nav-sidebar-section:first-of-type {
  padding-top: var(--space-3);
}
```

Section headers are intentionally muted (`var(--fg-subtle)` = `#707080`) so they structure the eye without competing with item labels.

## 5. Component refresh

### `.card` (unchanged visually, tokenized)

The current card style is preserved 1:1 — only the values are tokenized. Hover animation (`translateY(-2px)` + accent glow) stays.

### `.btn-*` family

Existing `btn-primary`, `btn-refresh`, `btn-add`, `btn-period` get tokenized. The 3 primary variants are visually identical — they share `var(--accent-grad)` and `var(--accent-glow)`. Consolidation pass: ALL three become aliases of a single `.btn-primary` style. The old class names stay (for backward compat — pages use them) but they share the same rules. Less CSS, same visual.

### `.chip-*` utilities (new, unified badges)

The dashboard, welcome-log, and stats pages each have their own badge implementations. Unify into the shared CSS:

```css
.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border-radius: var(--r-pill);
  font-size: var(--text-xs);
  font-weight: 600;
  font-family: var(--font-mono);
  white-space: nowrap;
}
.chip-ok   { background: rgba(59,165,93,0.15);   color: #6ee7b7; }
.chip-err  { background: rgba(237,66,69,0.15);   color: #f87171; }
.chip-warn { background: rgba(245,158,11,0.15);  color: #fbbf24; }
.chip-info { background: rgba(59,130,246,0.15);  color: #93c5fd; }
.chip-neutral { background: rgba(128,132,142,0.15); color: #a1a1aa; }
```

Per-page modules that use their own badge style (e.g., `pages/dashboard.js`'s "FILTERED — BLOCKED KEYWORD" pills) can adopt `.chip-warn` in a follow-up — out of scope for THIS spec. The new classes are *additive*: they don't break existing styles.

### Page header pattern (preserved)

The `.page-header` (sticky top, glass blur) and `.page-title` (22px, weight 700) keep their current size and feel. Tokenized only.

## 6. Backward compatibility

- All existing classes preserved (no rename). Pages that hardcode class names like `.btn-primary` keep working.
- Per-page inline `<style>` blocks (dashboard, stats, profits, etc.) keep their hardcoded values. They continue to render correctly because the OUTER CSS context (body color, font, etc.) remains the same.
- The flat `SIDEBAR_LINKS_FLAT` export covers any consumer that previously expected an array.
- No DB changes, no JS logic changes.

## 7. Testing strategy

Visual changes are hard to unit-test reliably. The approach:

`pages/common.test.js` (new or extend existing) tests three things:
1. `sidebarHTML('/dashboard')` returns a string containing exactly the expected section headers (`Overview`, `Content`, `Logs`, `Settings`) and all 14 hrefs.
2. The currently-active link gets the `class="active"` attribute and others don't.
3. `SIDEBAR_LINKS_FLAT` is a flat array of 14 items in deterministic order — useful for any iterator that expects flat.

Manual visual regression: after deploy, the operator visits each page (Dashboard, Stats, Profits, …, Config) and confirms the layout looks correct. No screenshot diff tooling needed for a 1-time tokenization + sidebar grouping change.

## 8. Out of scope (deferred to follow-ups)

- Per-page content / layout changes (KPI cards on Dashboard, filters, etc.)
- Mobile responsive (currently broken below ~768px — separate concern)
- `PUBLIC_CSS` / marketing site refresh
- New features or pages
- Rebranding "BOOM" name or logo
- Icon migration (emoji → SVG via Lucide or similar)
- Light mode
- Sidebar collapse / drawer behavior
- Animation / micro-interactions beyond what already exists
- Per-page migration to chip-* utilities (each page can adopt incrementally)
