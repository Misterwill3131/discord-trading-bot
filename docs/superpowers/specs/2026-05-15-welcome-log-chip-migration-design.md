# Welcome-Log Chip Migration — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Scope:** Delete 4 redundant `.chip-*` CSS rules from `pages/welcome-log.js`. The page inherits the unified `.chip-*` utility classes from `COMMON_CSS` (added in PR #70 Task 2). Accept the small visual change (square→pill, warn amber tint shift) as the unified design system.

---

## 1. Goal

The PR #70 shell refresh introduced `.chip` + `.chip-ok/err/warn/info/neutral` utility classes in `COMMON_CSS` (`pages/common.js`). These were intended for opt-in adoption by per-page modules.

`pages/welcome-log.js` already has its own local `.chip-*` definitions (lines 94-97). Those rules predate PR #70 and are now redundant — almost. There are two micro-differences:

| Property | welcome-log (local) | COMMON_CSS (new) |
|---|---|---|
| `.chip` display | `inline-block` | `inline-flex; align-items: center` |
| `.chip` border-radius | `6px` (slightly rounded) | `var(--r-pill)` = `999px` (fully rounded) |
| `.chip-warn` background | `rgba(250,166,26,0.15)` (orange-y amber) | `rgba(245,158,11,0.15)` (slightly softer amber) |
| All other rules | Match byte-for-byte | Match byte-for-byte |

Operator has accepted these differences — the unified rendering wins.

## 2. Change

In `pages/welcome-log.js`, find this block (lines ~94-97):

```css
  .chip { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .chip-ok   { background: rgba(59,165,93,0.15);  color: #6ee7b7; }
  .chip-err  { background: rgba(237,66,69,0.15);  color: #f87171; }
  .chip-warn { background: rgba(250,166,26,0.15); color: #fbbf24; }
```

Delete it. The page's `<style>` block already inlines `${COMMON_CSS}` first, so the global `.chip-*` rules from `COMMON_CSS` apply automatically.

## 3. Files touched

| File | Action |
|---|---|
| `pages/welcome-log.js` | Delete 4 CSS lines |

No other file modified. No new file. No new test.

## 4. Tests

The 9 existing tests in `pages/welcome-log.test.js` do not assert on chip styling — they assert on HTML structure (textarea, table cells, content presence). All 9 continue to pass without modification.

Manual smoke after deploy: visit `/welcome-log` and confirm:
- Chips render as pills (fully rounded), not square-ish boxes
- `error-channel` / `error-send` use the red chip (unchanged)
- `config-missing` uses the amber chip (slightly softer tint than before)
- `sent` uses the green chip (unchanged)

## 5. Backward compatibility

`pages/welcome-log.js` HTML continues to reference `class="chip chip-ok"` etc. The class names are identical between the deleted local rules and the global rules in COMMON_CSS — no template change needed.

## 6. Out of scope

- Trading page chip migration (different scope — see Option B)
- Dashboard / raw-messages / ticker `.badge` family migration (different visual style — Option C)
- Gallery / video-studio `.badge-proof/signal` (content type labels — different concept)
