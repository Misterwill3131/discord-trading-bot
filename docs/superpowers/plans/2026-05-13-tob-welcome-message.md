# TOB Welcome Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-post a welcome message in a configured Discord channel whenever Whop or Launchpass attribute the subscriber role to a member of the TOB server.

**Architecture:** A new stateless listener module (`discord/welcome-listener.js`) subscribes to `guildMemberUpdate` on the main Discord client. When the configured subscriber role transitions from absent to present on a non-bot member of the configured TOB guild, the listener posts a hardcoded welcome message in the configured welcome channel, referencing the start-here channel with a `<#id>` link.

**Tech Stack:** Node.js + discord.js v14 (already in `package.json`). Test runner: `node --test` (Node's built-in `node:test` + `node:assert`).

**Spec:** [docs/superpowers/specs/2026-05-13-tob-welcome-message-design.md](../specs/2026-05-13-tob-welcome-message-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `discord/welcome-listener.js` | Create | Module: `registerWelcomeListener`, `shouldWelcome`, `formatWelcomeMessage`. No DB, no state. |
| `discord/welcome-listener.test.js` | Create | Unit tests for the two pure functions (`shouldWelcome`, `formatWelcomeMessage`). |
| `index.js` | Modify | Add `GuildMembers` intent (lines 311–317), require + register the listener (after line 363 area). |
| `.env.example` | Modify | Add new section documenting the 4 welcome env vars. |

---

## Task 1: Pure functions — `formatWelcomeMessage` and `shouldWelcome` (TDD)

Implement and test the two pure functions first, in isolation. They contain all the business logic that's worth testing automatically.

**Files:**
- Create: `discord/welcome-listener.js`
- Create: `discord/welcome-listener.test.js`

- [ ] **Step 1: Write failing tests for `formatWelcomeMessage`**

Create `discord/welcome-listener.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { formatWelcomeMessage, shouldWelcome } = require('./welcome-listener');

// ── formatWelcomeMessage ────────────────────────────────────────────

test('formatWelcomeMessage embeds user mention and start-here channel link', () => {
  const out = formatWelcomeMessage('111222333', '444555666');
  assert.strictEqual(
    out,
    '<@111222333> welcome to TOB! Please start with <#444555666> and watch us for a week or so to get familiar with the discord.'
  );
});

test('formatWelcomeMessage works with arbitrary snowflakes', () => {
  const out = formatWelcomeMessage('1', '2');
  assert.ok(out.includes('<@1>'));
  assert.ok(out.includes('<#2>'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/welcome-listener.test.js`

Expected: FAIL with `Cannot find module './welcome-listener'` (module doesn't exist yet).

- [ ] **Step 3: Create minimal `welcome-listener.js` with `formatWelcomeMessage`**

Create `discord/welcome-listener.js`:

```javascript
// ─────────────────────────────────────────────────────────────────────
// discord/welcome-listener.js — Welcome new TOB subscribers
// ─────────────────────────────────────────────────────────────────────
// Whop et Launchpass attribuent le MÊME rôle Discord aux nouveaux
// abonnés. On écoute `guildMemberUpdate` : quand ce rôle transitionne
// d'absent → présent sur un membre non-bot du serveur TOB, on poste
// un message de bienvenue dans le salon configuré.
//
// Stateless : pas de DB, pas de dédupe. Une re-attribution = un nouveau
// welcome (cas rare et bénin).
//
// Spec : docs/superpowers/specs/2026-05-13-tob-welcome-message-design.md
// ─────────────────────────────────────────────────────────────────────

function formatWelcomeMessage(userId, startHereChannelId) {
  return `<@${userId}> welcome to TOB! Please start with <#${startHereChannelId}> and watch us for a week or so to get familiar with the discord.`;
}

module.exports = {
  formatWelcomeMessage,
};
```

- [ ] **Step 4: Run tests to verify `formatWelcomeMessage` tests pass**

Run: `node --test discord/welcome-listener.test.js`

Expected: 2 of the format tests PASS, the rest (shouldWelcome) FAIL with `shouldWelcome is not a function`.

- [ ] **Step 5: Append failing tests for `shouldWelcome` to the test file**

Append to `discord/welcome-listener.test.js`:

```javascript
// ── shouldWelcome ───────────────────────────────────────────────────

// Helper: build a GuildMember-like mock. `roleIds` is the array of role
// IDs the member currently has — only `roles.cache.has()` is used by
// shouldWelcome so we keep the shape minimal.
function mockMember({ guildId = 'tob-guild', isBot = false, roleIds = [] } = {}) {
  return {
    guild: { id: guildId },
    user: { bot: isBot },
    roles: { cache: { has: (id) => roleIds.includes(id) } },
  };
}

const CFG = { roleId: 'sub-role', guildId: 'tob-guild' };

test('shouldWelcome returns true when subscriber role is newly added', () => {
  const oldM = mockMember({ roleIds: [] });
  const newM = mockMember({ roleIds: ['sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), true);
});

test('shouldWelcome returns true when role is added alongside others', () => {
  const oldM = mockMember({ roleIds: ['other-role'] });
  const newM = mockMember({ roleIds: ['other-role', 'sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), true);
});

test('shouldWelcome returns false when role was already present (no transition)', () => {
  const oldM = mockMember({ roleIds: ['sub-role'] });
  const newM = mockMember({ roleIds: ['sub-role', 'other-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false when role was removed (reverse transition)', () => {
  const oldM = mockMember({ roleIds: ['sub-role'] });
  const newM = mockMember({ roleIds: [] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false when role is absent on both sides', () => {
  const oldM = mockMember({ roleIds: ['other-role'] });
  const newM = mockMember({ roleIds: ['other-role', 'another-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false on wrong guild (filter by guildId)', () => {
  const oldM = mockMember({ guildId: 'some-other-guild', roleIds: [] });
  const newM = mockMember({ guildId: 'some-other-guild', roleIds: ['sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});

test('shouldWelcome returns false when member is a bot', () => {
  const oldM = mockMember({ isBot: true, roleIds: [] });
  const newM = mockMember({ isBot: true, roleIds: ['sub-role'] });
  assert.strictEqual(shouldWelcome(oldM, newM, CFG), false);
});
```

- [ ] **Step 6: Run tests to verify shouldWelcome tests fail**

Run: `node --test discord/welcome-listener.test.js`

Expected: FAIL — `shouldWelcome is not a function` for the 7 new tests.

- [ ] **Step 7: Implement `shouldWelcome` in `welcome-listener.js`**

Add to `discord/welcome-listener.js`, before `module.exports`:

```javascript
// True only when the subscriber role just transitioned from absent → present
// on a non-bot member of the configured TOB guild.
function shouldWelcome(oldMember, newMember, { roleId, guildId }) {
  if (newMember.guild.id !== guildId) return false;
  if (newMember.user.bot) return false;
  const hadRole = oldMember.roles.cache.has(roleId);
  const hasRole = newMember.roles.cache.has(roleId);
  return !hadRole && hasRole;
}
```

Update the `module.exports` block:

```javascript
module.exports = {
  formatWelcomeMessage,
  shouldWelcome,
};
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `node --test discord/welcome-listener.test.js`

Expected: All 9 tests PASS (2 format + 7 shouldWelcome).

- [ ] **Step 9: Commit**

```bash
git add discord/welcome-listener.js discord/welcome-listener.test.js
git commit -m "feat(welcome): pure functions for welcome message + role transition detection

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `registerWelcomeListener` — wire the side effects

Add the function that registers the `guildMemberUpdate` event handler on a Discord client. This part is hard to unit-test (it depends on the discord.js event loop), so we only add one test for the config-validation path (log warning + no-op when config is missing).

**Files:**
- Modify: `discord/welcome-listener.js`
- Modify: `discord/welcome-listener.test.js`

- [ ] **Step 1: Write failing test for config validation**

Append to `discord/welcome-listener.test.js`:

```javascript
// ── registerWelcomeListener ─────────────────────────────────────────

const { registerWelcomeListener } = require('./welcome-listener');

// Minimal client mock — captures `on` registrations.
function mockClient() {
  const handlers = {};
  return {
    on: (event, fn) => { handlers[event] = fn; },
    handlers,
  };
}

test('registerWelcomeListener does not subscribe when guildId is missing', () => {
  const c = mockClient();
  registerWelcomeListener(c, { guildId: '', subscriberRoleId: 'r', welcomeChannelId: 'c', startHereChannelId: 's' });
  assert.strictEqual(c.handlers.guildMemberUpdate, undefined);
});

test('registerWelcomeListener does not subscribe when any config is missing', () => {
  for (const missing of ['subscriberRoleId', 'welcomeChannelId', 'startHereChannelId']) {
    const cfg = { guildId: 'g', subscriberRoleId: 'r', welcomeChannelId: 'c', startHereChannelId: 's' };
    cfg[missing] = '';
    const c = mockClient();
    registerWelcomeListener(c, cfg);
    assert.strictEqual(c.handlers.guildMemberUpdate, undefined, `missing ${missing} should disable listener`);
  }
});

test('registerWelcomeListener subscribes when all config is present', () => {
  const c = mockClient();
  registerWelcomeListener(c, {
    guildId: 'g', subscriberRoleId: 'r', welcomeChannelId: 'c', startHereChannelId: 's',
  });
  assert.strictEqual(typeof c.handlers.guildMemberUpdate, 'function');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test discord/welcome-listener.test.js`

Expected: FAIL — `registerWelcomeListener is not a function` on the 3 new tests.

- [ ] **Step 3: Implement `registerWelcomeListener`**

Add to `discord/welcome-listener.js`, before `module.exports`:

```javascript
// Registers a guildMemberUpdate listener on `client`. No-op (with a single
// boot warning) if any config field is empty. The handler is async because
// it fetches the welcome channel from the Discord API.
function registerWelcomeListener(client, {
  guildId,
  subscriberRoleId,
  welcomeChannelId,
  startHereChannelId,
}) {
  if (!guildId || !subscriberRoleId || !welcomeChannelId || !startHereChannelId) {
    console.warn('[welcome] missing config — disabled (need TOB_WELCOME_GUILD_ID, TOB_SUBSCRIBER_ROLE_ID, TOB_WELCOME_CHANNEL_ID, TOB_START_HERE_CHANNEL_ID)');
    return;
  }

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (!shouldWelcome(oldMember, newMember, { roleId: subscriberRoleId, guildId })) return;
    try {
      const ch = await client.channels.fetch(welcomeChannelId);
      if (!ch || !ch.isTextBased || !ch.isTextBased()) {
        console.error('[welcome] welcome channel not text-based or not found:', welcomeChannelId);
        return;
      }
      const msg = formatWelcomeMessage(newMember.user.id, startHereChannelId);
      await ch.send(msg);
    } catch (err) {
      console.error('[welcome] send failed:', err.message);
    }
  });

  console.log('[welcome] listener registered (guild=' + guildId + ', role=' + subscriberRoleId + ')');
}
```

Update `module.exports`:

```javascript
module.exports = {
  formatWelcomeMessage,
  shouldWelcome,
  registerWelcomeListener,
};
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node --test discord/welcome-listener.test.js`

Expected: All 12 tests PASS (2 format + 7 shouldWelcome + 3 registerWelcomeListener).

- [ ] **Step 5: Commit**

```bash
git add discord/welcome-listener.js discord/welcome-listener.test.js
git commit -m "feat(welcome): registerWelcomeListener wires guildMemberUpdate handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire into `index.js` — intent + listener registration

Add the `GuildMembers` privileged intent to the main client and register the welcome listener after the other discord listeners.

**Files:**
- Modify: `index.js` (intents array around line 311–317, register call around line 363)

- [ ] **Step 1: Add `GuildMembers` to the main client's intents**

Open `index.js` and find the main client construction (line ~311):

```javascript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
```

Replace with:

```javascript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});
```

- [ ] **Step 2: Add the require + register call**

Find the line `registerProfitListener(client, { profitsChannelId: PROFITS_CHANNEL_ID });` (around line 363) and add immediately AFTER it:

```javascript
const { registerWelcomeListener } = require('./discord/welcome-listener');
registerWelcomeListener(client, {
  guildId:               process.env.TOB_WELCOME_GUILD_ID,
  subscriberRoleId:      process.env.TOB_SUBSCRIBER_ROLE_ID,
  welcomeChannelId:      process.env.TOB_WELCOME_CHANNEL_ID,
  startHereChannelId:    process.env.TOB_START_HERE_CHANNEL_ID,
});
```

- [ ] **Step 3: Verify the file still parses (syntax check)**

Run: `node --check index.js`

Expected: No output (exit code 0 = syntax OK).

- [ ] **Step 4: Run the full test suite to confirm no regression**

Run: `node --test`

Expected: All tests pass (existing + the 12 new ones from Task 1 & 2).

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(welcome): wire welcome listener into main bot + GuildMembers intent

Privileged intent must be enabled in Discord Developer Portal — see
docs/superpowers/specs/2026-05-13-tob-welcome-message-design.md section 8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Document env vars in `.env.example`

Add the 4 new variables under a clearly labelled section so deployment is unambiguous.

**Files:**
- Modify: `.env.example` (append at end of file)

- [ ] **Step 1: Append the new section**

Open `.env.example`, append at the end:

```bash

# === WELCOME MESSAGE (TOB subscribers) ===============================
# Auto-poste un message de bienvenue dans le salon configuré quand
# Whop ou Launchpass attribuent le rôle d'abonné à un membre du serveur
# TOB. Toutes les vars sont requises — si l'une manque, le listener
# log un warning au boot et reste dormant (pas de crash).
#
# IMPORTANT : nécessite l'activation manuelle du privileged intent
# "Server Members Intent" dans Discord Developer Portal → ton bot principal
# → onglet Bot → toggle on (sinon Discord ne livre pas les events de rôle).
#
# Pour récupérer les IDs : active Discord Developer Mode
# (Settings → Advanced → Developer Mode), puis clic droit → "Copy ID".

# Guild ID du serveur TOB (filtre — évite de welcome si le bot est invité ailleurs).
TOB_WELCOME_GUILD_ID=

# Role ID attribué par Whop ET Launchpass aux nouveaux abonnés (le même rôle).
TOB_SUBSCRIBER_ROLE_ID=

# Channel ID où le message de bienvenue est posté.
TOB_WELCOME_CHANNEL_ID=

# Channel ID référencé dans le corps du message (le <#id> cliquable).
TOB_START_HERE_CHANNEL_ID=
```

- [ ] **Step 2: Verify file is well-formed**

Run: `node -e "console.log(require('fs').readFileSync('.env.example', 'utf8').slice(-500))"`

Expected: output ends with the new section block.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document TOB_WELCOME_* variables for welcome listener

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification + manual-step reminder

Confirm the implementation is complete and call out the manual steps that the user must do before the feature works in production.

- [ ] **Step 1: Run the full test suite one more time**

Run: `node --test`

Expected: All tests pass. No new failures vs. baseline.

- [ ] **Step 2: Confirm `node --check` still passes on the entry point**

Run: `node --check index.js`

Expected: No output.

- [ ] **Step 3: Print a manual-step reminder for the user**

Print to the user (this is a status message, not a code action):

```
✅ Implementation complete. Manual steps required before this works in production:

1. Discord Developer Portal → your main bot application → tab Bot → toggle ON
   "Server Members Intent" (privileged intent). Save.

2. In Discord (with Developer Mode ON: Settings → Advanced → Developer Mode),
   right-click → Copy ID on:
   - The TOB server itself                  → TOB_WELCOME_GUILD_ID
   - The subscriber role (Server Settings → Roles, right-click the role)
                                            → TOB_SUBSCRIBER_ROLE_ID
   - The welcome destination channel        → TOB_WELCOME_CHANNEL_ID
   - The 🚩│start-here channel              → TOB_START_HERE_CHANNEL_ID

3. Railway → project env vars → add the 4 variables above. Redeploy.

Smoke test after redeploy:
- Manually attribute the subscriber role to a test account in TOB.
- The welcome message should appear in the welcome channel within ~1 second.
- Remove the role and re-attribute it → a second welcome posts (no dedupe by design).
```

---

## Out of scope (per spec section 10)

- DM-based welcome
- Per-plan customization
- Configurable wording via dashboard
- Welcome deduplication
- Welcome on `guildMemberAdd`
- Tracking welcome history in DB
