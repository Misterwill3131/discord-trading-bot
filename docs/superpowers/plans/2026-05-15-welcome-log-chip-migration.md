# Welcome-Log Chip Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete 4 redundant `.chip-*` CSS rules from `pages/welcome-log.js`. The page now inherits the unified `.chip-*` utility classes from `COMMON_CSS`.

**Architecture:** Single-file edit. Remove 4 CSS lines from `pages/welcome-log.js`. No new code, no new tests, no module exports change.

**Tech Stack:** None — pure CSS deletion.

**Spec:** [docs/superpowers/specs/2026-05-15-welcome-log-chip-migration-design.md](../specs/2026-05-15-welcome-log-chip-migration-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `pages/welcome-log.js` | Modify | Delete 4 CSS lines for `.chip`, `.chip-ok`, `.chip-err`, `.chip-warn` (lines ~94-97 in the current file). |

No other files touched.

---

## Task 1: Delete the duplicate chip rules

**Files:**
- Modify: `pages/welcome-log.js`

- [ ] **Step 1: Locate the duplicate block**

Open `pages/welcome-log.js`. Find this 4-line block (around lines 94-97 — they may be nested inside the `<style>` template literal):

```css
  .chip { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
  .chip-ok   { background: rgba(59,165,93,0.15);  color: #6ee7b7; }
  .chip-err  { background: rgba(237,66,69,0.15);  color: #f87171; }
  .chip-warn { background: rgba(250,166,26,0.15); color: #fbbf24; }
```

If the indentation differs slightly (more or fewer leading spaces depending on the file's CSS block), match the exact whitespace in the file.

- [ ] **Step 2: Delete the 4 lines**

Remove all 4 lines from the file. Surrounding CSS (the `td.type { width: 130px; }` rule before, or the `td.user .uid { … }` rule after, depending on exact placement) is preserved unchanged.

After deletion, verify by re-grepping:

Run: `grep -c "^\s*\.chip" pages/welcome-log.js`
Expected: `0` (no remaining local `.chip` declarations).

- [ ] **Step 3: Verify syntax**

Run: `node --check pages/welcome-log.js`
Expected: No output (exit 0).

- [ ] **Step 4: Smoke-test that the page still references the chip classes (in the HTML)**

Run: `node -e "const { renderWelcomeLogPage } = require('./pages/welcome-log'); const html = renderWelcomeLogPage([]); console.log(html.includes('chip-ok') === false || html.includes('chip'));"`

Expected: `true` — at minimum the empty-state HTML mentions `chip` (or none, in which case the test must still complete successfully).

Then a richer smoke: confirm a populated render still works without throwing:

Run: `node -e "const { renderWelcomeLogPage } = require('./pages/welcome-log'); const html = renderWelcomeLogPage([{ts:'2026-01-01T00:00:00Z', type:'sent', userId:'1', username:'test', detail:null}]); console.log(html.includes('chip-ok') && html.includes('sent'));"`

Expected: `true` (the rendered row includes both the chip-ok class — which is the green "sent" indicator — and the literal type label).

- [ ] **Step 5: Run existing welcome-log tests**

Run: `node --test pages/welcome-log.test.js`

Expected: All 10 existing tests PASS. None of them assert on chip CSS styling — only on HTML structure / data shape / escaping.

- [ ] **Step 6: Run full test suite to confirm no regression**

Run: `node --test 2>&1 | tail -10`

Expected: Same pass count as before (no new tests, no broken tests). The 2 known pre-existing failures (`services/llm-classify.test.js` Windows SQLite EBUSY + `video/scripts/test-tts-voice.js` TTS) remain. NO new failures.

- [ ] **Step 7: Commit**

```bash
git add pages/welcome-log.js
git commit -m "refactor(welcome-log): delete duplicate .chip-* CSS rules

These 4 rules are now provided by COMMON_CSS (added in PR #70 Task 2).
The page inherits them automatically via the existing
\${COMMON_CSS} interpolation. Two micro-differences accepted:
square→pill border radius, slightly softer amber tint for chip-warn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Manual smoke verification (instructions only)

No code changes. After Task 1 lands and Railway redeploys, the operator should:

1. Visit `/welcome-log` on the dashboard
2. Confirm:
   - The chips render as **pills (fully rounded)** instead of slightly-rounded boxes
   - The "sent" chip is green (unchanged)
   - The "error-channel" / "error-send" chips are red (unchanged)
   - The "config-missing" chip is amber, slightly softer than before (acceptable per spec)
3. Refresh the page a few times — no console errors, layout unchanged

If anything looks wrong: the rollback is a single commit revert.

---

## Out of scope (per spec)

- Trading page chip migration (Option B from brainstorming)
- Dashboard / raw-messages / ticker `.badge` family migration (Option C — different visual style)
- Gallery / video-studio `.badge-proof/signal` (content type labels)
- Updating `pages/welcome-log.test.js` (no chip assertions exist to update)
