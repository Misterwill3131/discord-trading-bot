# Welcome Message Editor — Design Spec

**Date:** 2026-05-14
**Status:** Approved
**Scope:** Make the welcome message text editable from the dashboard, with a template-and-placeholders model. The 4 env-var IDs (guild, role, welcome channel, start-here channel) remain env-managed — this spec only touches the message body.

---

## 1. Goal

Operator should change the welcome message wording without redeploying the bot. The current hardcoded body lives in `discord/welcome-listener.js`:

```
<@USER_ID> welcome to TOB! Please start with <#START_HERE_CHANNEL_ID> and watch us for a week or so to get familiar with the discord.
```

After this work: the operator opens `/welcome-log` in the dashboard, edits the template in a textarea at the top of the page, saves, and the next welcome the listener sends uses the new wording.

## 2. Template + placeholders

The editable string is a *template*, not raw Discord syntax. Two placeholders:

- `{user}` — substituted at send time with `<@USER_ID>` (clickable user ping)
- `{start_here}` — substituted at send time with `<#START_HERE_CHANNEL_ID>` (clickable channel link)

Why placeholders rather than letting the operator type `<@...>`/`<#...>` directly: simpler mental model, smaller blast radius if they typo, and it lets the dashboard render a faithful preview without needing to know the real IDs.

Default template (used when no override is set in the DB — preserves today's behavior):

```
{user} welcome to TOB! Please start with {start_here} and watch us for a week or so to get familiar with the discord.
```

The default is exported as a named constant from the welcome-listener module so the dashboard can show "Reset to default" and the listener can fall back to it when the setting is absent.

## 3. Architecture

Four units, each with one clear responsibility:

- **`discord/welcome-template.js`** (new) — owns ALL template logic. Exports:
  - `DEFAULT_WELCOME_TEMPLATE` — the hardcoded fallback constant
  - `applyTemplate(template, { userId, startHereId })` — pure substitution function
  - `validateTemplate(text)` → `{ ok, error? }` — server-side validation rules (§5)
  - `getEffectiveTemplate()` → `{ template, isDefault }` — reads `db.getSetting('welcome_message_template')`, falls back to the default if absent/empty
  - `setTemplate(text)` — validates then writes to settings KV. Throws if validation fails.
  - `resetTemplate()` — clears the setting (so `getEffectiveTemplate` falls back to default)

  This module is the single source of truth for the template format, default, and persistence. It has no Discord dependencies (no `discord.js` imports) — pure logic + DB.

- **`discord/welcome-listener.js`** (modify) — at handler runtime, calls `getEffectiveTemplate()` then `applyTemplate(template, { userId, startHereId })` before `ch.send(msg)`. The existing `formatWelcomeMessage(userId, startHereId)` function is rewritten as a thin wrapper: `applyTemplate(DEFAULT_WELCOME_TEMPLATE, { userId, startHereId })`. Both `applyTemplate` and `DEFAULT_WELCOME_TEMPLATE` are imported from `discord/welcome-template.js`. The 12 existing unit tests on `formatWelcomeMessage` and `shouldWelcome` continue to pass because the output for the default template is byte-identical to today.

- **`routes/welcome-log.js`** (modify existing) — adds three JSON endpoints:
  - `GET  /api/welcome-message` → `{ ok, template, default, isDefault }`
  - `PUT  /api/welcome-message` (body: `{ template }`) → `{ ok }` or `{ ok: false, error }`
  - `DELETE /api/welcome-message` → `{ ok }` (resets to default)
  All auth-protected like the existing `GET /welcome-log`.

- **`pages/welcome-log.js`** (modify existing) — adds a "Template" card at the top of the page (above the existing note block) containing:
  - A textarea (initial value: server-rendered current template)
  - A documentation line listing the two placeholders
  - A static preview line (renders the template by replacing `{user}` with `@newuser` and `{start_here}` with `#🚩│start-here`)
  - A "Save" button (POST) and a "Reset to default" button (DELETE)
  - A small status message area for confirmations/errors

  Client-side: a tiny inline `<script>` (no framework) wires the buttons to the API and updates the preview live as the textarea changes. ~30 lines of JS.

## 4. DB storage

Single key in the existing `settings` table:

- Key: `welcome_message_template`
- Value: the raw template string (no JSON wrapping — the existing `getSetting`/`setSetting` already JSON-encodes/decodes scalars)

When the operator clicks "Reset to default", the route calls `db.deleteSetting('welcome_message_template')` (or the equivalent — see Task plan), and `getEffectiveTemplate()` then falls back to the default.

If `deleteSetting` doesn't exist in `db/sqlite.js`, the implementation may use `setSetting(key, null)` and have `getEffectiveTemplate` treat `null`/empty-string the same as "missing".

## 5. Validation

`validateTemplate(text)` runs server-side on every PUT and returns `{ ok, error? }`. Rules:

- `text` must be a non-empty string after trim
- `text.length <= 2000` (Discord's hard limit for a single message)
- `text` MUST contain the literal substring `{user}` — otherwise the new subscriber won't be pinged, which defeats the purpose. Hard-required.
- `{start_here}` is NOT required (operator may decide not to include the link)
- No other placeholder names are validated — unknown `{foo}` substrings are passed through unchanged (Discord renders them as literal text)

UI surfaces validation errors inline next to the Save button.

## 6. Substitution semantics

`applyTemplate(template, { userId, startHereId })`:
- Replace ALL occurrences of `{user}` with `<@${userId}>`
- Replace ALL occurrences of `{start_here}` with `<#${startHereId}>`
- Return the resulting string

Implemented with `.split().join()` rather than regex to avoid escaping concerns. Both placeholders are case-sensitive and exact-match.

## 7. Backward compatibility

Pre-deploy state: production has the hardcoded message and no DB setting. After deploy:
- The first request to `GET /api/welcome-message` returns `{ template: DEFAULT, isDefault: true }`
- The listener calls `getEffectiveTemplate()` which returns the default
- Behavior is identical to today's production until the operator edits the template

No migration step needed. The existing 12 listener tests continue to pass because `formatWelcomeMessage` keeps its signature and produces the same output for the default template.

## 8. Tests

`discord/welcome-template.test.js` (new):
- `validateTemplate` accepts the default template
- `validateTemplate` rejects empty/whitespace-only text
- `validateTemplate` rejects text > 2000 chars
- `validateTemplate` rejects text without `{user}`
- `validateTemplate` accepts text without `{start_here}`
- `applyTemplate` substitutes both placeholders correctly
- `applyTemplate` substitutes multiple occurrences of `{user}`
- `applyTemplate` leaves unknown `{foo}` placeholders unchanged
- `getEffectiveTemplate` returns `{ template: DEFAULT, isDefault: true }` when the setting is absent
- `getEffectiveTemplate` returns `{ template: <override>, isDefault: false }` when the setting is set
- `resetTemplate` followed by `getEffectiveTemplate` returns the default again

`discord/welcome-listener.test.js` (existing 12 tests untouched):
- `formatWelcomeMessage` still produces the original output for the default template — proven by an existing exact-string assertion

`pages/welcome-log.test.js` (extend existing 4):
- New test: the rendered HTML includes the textarea pre-filled with the effective template
- New test: the rendered HTML includes the preview line with `@newuser` and `#🚩│start-here` substitutions

(No browser/JS-level test for the inline script — manual smoke verification suffices for ~30 lines of vanilla JS.)

## 9. Out of scope

- Multiple templates (per-plan, A/B test, scheduled)
- Additional placeholders (`{server}`, `{day}`, custom emoji helpers, etc.)
- Editing the channel/role/guild IDs from the dashboard — these stay env vars on Railway
- Version history of past templates
- WYSIWYG / rich-text editor
- Live preview against a real Discord rendering (Discord-side renders are beyond what a static HTML preview can do — we keep it text-only)
- Approval/review workflow before save (single-operator dashboard, no need)
- Localization of the template (one operator, one Discord, one language)
