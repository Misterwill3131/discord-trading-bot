# Milestone Alerts Channel Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `MILESTONE_ALERTS_CHANNEL_ID` env var that routes milestone alerts to a dedicated channel (post + source link) instead of replying under the source message; preserves the existing reply behavior as a fallback when the env var is absent.

**Architecture:** Single branch in `discord/milestone-checker.js` `tick()` after the mark-then-send insert. When `process.env.MILESTONE_ALERTS_CHANNEL_ID` is set, fetch the dedicated channel and `channel.send(text + sourceLink)`; otherwise, keep the current `sourceMsg.reply(text)` path. The source-message fetch is wrapped in try/catch in dedicated mode so the post still goes through if the source link can't be built.

**Tech Stack:** Node.js · discord.js v14 · better-sqlite3 (no schema change) · node:test + node:assert.

**Spec:** [docs/superpowers/specs/2026-05-15-milestone-alerts-channel-routing-design.md](../specs/2026-05-15-milestone-alerts-channel-routing-design.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `discord/milestone-checker.js` | Modify | Add the channel routing if/else inside `tick`, after `if (!fired) continue;` |
| `discord/milestone-checker.test.js` | Modify | Extend `makeFakeDiscord` to support dual-channel routing + 3 new tests for the branch |
| `.env.example` | Modify | Document `MILESTONE_ALERTS_CHANNEL_ID` in the existing analyst-watchlist section |

The change is fully contained in one logic file + its test file + one doc file. No schema change, no new module, no new dependency. The plan covers it in 2 TDD tasks (logic + tests + docs).

---

## Conventions used in this plan

- **Test runner:** `node --test discord/milestone-checker.test.js`
- **Working directory:** `C:\Users\willi\Documents\GitHub\discord-trading-bot\.claude\worktrees\milestone-channel-routing`
- **Commit per task:** end of each task; messages follow `<type>(<scope>): <short>` convention
- **No schema migration:** the `milestone_alerts.discord_message_id` column added in PR #65 is reused as-is

---

## Task 1: Add channel routing branch with TDD

This task does the whole feature in one TDD cycle: extend the fake Discord client, write 3 new failing tests, implement the routing branch, verify all tests pass, commit.

**Files:**
- Modify: `discord/milestone-checker.test.js` (extend `makeFakeDiscord` + add 3 tests)
- Modify: `discord/milestone-checker.js` (add the routing branch inside `tick`)

### Step 1.1: Extend `makeFakeDiscord` to support dual-channel routing

In `discord/milestone-checker.test.js`, locate the existing `makeFakeDiscord` function (around line 127–148):

```js
function makeFakeDiscord({ replyId = 'reply-1', failFetch = false } = {}) {
  const replies = [];
  const channel = {
    messages: {
      fetch: async (id) => {
        if (failFetch) throw new Error('source message gone');
        return {
          reply: async ({ content }) => {
            replies.push({ messageId: id, content });
            return { id: replyId };
          },
        };
      },
    },
  };
  return {
    channels: { fetch: async () => channel },
    _replies: replies,
  };
}
```

Replace it with the extended version below. The extension adds:
- Optional `dedicatedChannelId` parameter — when `channels.fetch(id)` is called with this ID, returns a channel with `.send(...)` instead of `messages.fetch`
- Optional `sourceGuildId` parameter — included on the message returned by `messages.fetch`, used by `tick` to build the source link in dedicated mode
- New `_sends` array — captures `channel.send` calls (for dedicated channel)
- Optional `dedicatedSendFails` — when true, the dedicated channel's `.send` throws (for testing the "post failed" path)

```js
function makeFakeDiscord({
  replyId = 'reply-1',
  failFetch = false,
  dedicatedChannelId = null,
  sourceGuildId = 'guild-1',
  dedicatedSendFails = false,
} = {}) {
  const replies = [];
  const sends   = [];

  const sourceChannel = {
    messages: {
      fetch: async (id) => {
        if (failFetch) throw new Error('source message gone');
        return {
          guildId: sourceGuildId,
          reply: async ({ content }) => {
            replies.push({ messageId: id, content });
            return { id: replyId };
          },
        };
      },
    },
  };

  const dedicatedChannel = {
    send: async ({ content }) => {
      if (dedicatedSendFails) throw new Error('dedicated send failed');
      sends.push({ content });
      return { id: 'sent-' + replyId };
    },
  };

  return {
    channels: {
      fetch: async (id) => {
        if (dedicatedChannelId && String(id) === String(dedicatedChannelId)) {
          return dedicatedChannel;
        }
        return sourceChannel;
      },
    },
    _replies: replies,
    _sends:   sends,
  };
}
```

The default parameters preserve the existing test behavior — every pre-existing test calls `makeFakeDiscord()` or `makeFakeDiscord({ replyId, failFetch })` and continues to receive the same source-channel-only object.

- [ ] **Step 1.2: Write 3 failing tests for the routing branch**

Append to `discord/milestone-checker.test.js` (after the last existing `tick` test, before any trailing module-level code):

```js
test('tick mode reply : env var empty → behaviour inchangé (sourceMsg.reply)', async () => {
  delete process.env.MILESTONE_ALERTS_CHANNEL_ID;
  const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
  const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
  const fakeClient = makeFakeDiscord({ replyId: 'rep-reply-mode' });
  await tick(fakeClient, 1700001000000, {
    db: fakeDb,
    marketClient: fakeMarket,
    isRTH: () => true,
    milestones: [20, 50],
    cooldownMs: 3600_000,
    ttlMs: 30 * 86400_000,
  });
  assert.strictEqual(fakeClient._replies.length, 1);
  assert.strictEqual(fakeClient._sends.length, 0);
  assert.ok(fakeClient._replies[0].content.includes('+20%'));
  // No source link in reply mode
  assert.ok(!fakeClient._replies[0].content.includes('📎'));
  assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
});

test('tick mode canal dédié : env var set → channel.send + lien source', async () => {
  process.env.MILESTONE_ALERTS_CHANNEL_ID = 'dedicated-chan-id';
  try {
    const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
    const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
    const fakeClient = makeFakeDiscord({
      replyId: 'rep-dedicated',
      dedicatedChannelId: 'dedicated-chan-id',
      sourceGuildId: 'guild-xyz',
    });
    await tick(fakeClient, 1700001000000, {
      db: fakeDb,
      marketClient: fakeMarket,
      isRTH: () => true,
      milestones: [20, 50],
      cooldownMs: 3600_000,
      ttlMs: 30 * 86400_000,
    });
    assert.strictEqual(fakeClient._replies.length, 0);
    assert.strictEqual(fakeClient._sends.length, 1);
    assert.ok(fakeClient._sends[0].content.includes('+20%'));
    // Source link included
    assert.ok(fakeClient._sends[0].content.includes(
      '📎 https://discord.com/channels/guild-xyz/chan-1/src-1'
    ));
    // setMilestoneAlertDiscordId called with the dedicated channel post id
    assert.strictEqual(fakeDb._calls.setMilestoneAlertDiscordId.length, 1);
    assert.strictEqual(
      fakeDb._calls.setMilestoneAlertDiscordId[0].discordMessageId,
      'sent-rep-dedicated'
    );
    // Watchlist still updated
    assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
  } finally {
    delete process.env.MILESTONE_ALERTS_CHANNEL_ID;
  }
});

test('tick mode canal dédié : source message gone → post sans lien (graceful)', async () => {
  process.env.MILESTONE_ALERTS_CHANNEL_ID = 'dedicated-chan-id';
  try {
    const fakeDb = makeFakeDb({ active: [SAMPLE_ENTRY] });
    const fakeMarket = { getQuotesBulk: async () => ({ AAPL: { price: 250, volume: 1 } }) };
    const fakeClient = makeFakeDiscord({
      replyId: 'rep-no-link',
      dedicatedChannelId: 'dedicated-chan-id',
      failFetch: true,  // source message fetch throws
    });
    await tick(fakeClient, 1700001000000, {
      db: fakeDb,
      marketClient: fakeMarket,
      isRTH: () => true,
      milestones: [20, 50],
      cooldownMs: 3600_000,
      ttlMs: 30 * 86400_000,
    });
    // Post still happened in the dedicated channel
    assert.strictEqual(fakeClient._sends.length, 1);
    // But without the source link
    assert.ok(!fakeClient._sends[0].content.includes('📎'));
    assert.ok(fakeClient._sends[0].content.includes('+20%'));
    // Watchlist still updated despite the missing link
    assert.strictEqual(fakeDb._calls.updateWatchlistAfterAlert.length, 1);
  } finally {
    delete process.env.MILESTONE_ALERTS_CHANNEL_ID;
  }
});
```

- [ ] **Step 1.3: Run tests to verify the 3 new ones fail**

```bash
node --test discord/milestone-checker.test.js
```

Expected: 3 new failures. The "mode reply" test may pass coincidentally (it just verifies the unchanged path), but the two "mode dédié" tests will fail because:
- `fakeClient._sends` will be empty (no `channel.send` is ever called by the current `tick`)
- `setMilestoneAlertDiscordId` will be called with the `sourceMsg.reply` id instead of the dedicated send id

Continue once you've confirmed the failure shape.

- [ ] **Step 1.4: Implement the routing branch in `tick`**

In `discord/milestone-checker.js`, locate the block starting at the comment `// Reply Discord. Si fail (msg supprimé, perms), on garde l'insert :` (around line 145). The current block is roughly:

```js
    try {
      const channel = await client.channels.fetch(entry.source_channel_id);
      const sourceMsg = await channel.messages.fetch(entry.source_message_id);
      const text = buildAlertMessage({
        ticker: entry.ticker,
        milestonePct: target,
        initialPrice: entry.initial_price,
        currentPrice: quote.price,
        gainPct,
        mentionedByUsername: entry.mentioned_by_username,
      });
      const reply = await sourceMsg.reply({
        content: text,
        allowedMentions: { parse: [] },
      });
      // Backfill the discord_message_id on the milestone_alerts row we
      // just inserted. Non-blocking : if this update fails, the alert
      // was still posted — we just lose the audit link.
      if (reply && reply.id && typeof db.setMilestoneAlertDiscordId === 'function') {
        try {
          db.setMilestoneAlertDiscordId({
            ticker: entry.ticker,
            milestonePct: target,
            discordMessageId: String(reply.id),
          });
        } catch (err) {
          console.error('[milestone-checker] failed to backfill discord_message_id: '
            + err.message);
        }
      }
      db.updateWatchlistAfterAlert({
        ticker: entry.ticker,
        lastMilestonePct: target,
        lastAlertAt: now,
      });
    } catch (err) {
      console.error('[milestone-checker] reply failed for ' + entry.ticker
        + ': ' + err.message);
    }
```

Replace the entire `try { ... } catch { ... }` block above with this expanded version that supports both modes:

```js
    try {
      const text = buildAlertMessage({
        ticker: entry.ticker,
        milestonePct: target,
        initialPrice: entry.initial_price,
        currentPrice: quote.price,
        gainPct,
        mentionedByUsername: entry.mentioned_by_username,
      });

      const dedicatedChannelId = process.env.MILESTONE_ALERTS_CHANNEL_ID || '';

      let reply;
      if (dedicatedChannelId) {
        // Mode canal dédié : post normal + lien vers le message d'origine
        // si on arrive à récupérer le guildId. Si la source est inaccessible
        // (msg supprimé, perms perdues), on poste sans le lien plutôt que
        // de skip l'alerte entièrement.
        let sourceLink = '';
        try {
          const sourceChannel = await client.channels.fetch(entry.source_channel_id);
          const sourceMsg     = await sourceChannel.messages.fetch(entry.source_message_id);
          const guildId       = sourceMsg.guildId
            || (sourceMsg.guild && sourceMsg.guild.id)
            || '';
          if (guildId) {
            sourceLink = '\n📎 https://discord.com/channels/'
              + guildId + '/' + entry.source_channel_id + '/' + entry.source_message_id;
          }
        } catch (err) {
          console.warn('[milestone-checker] source link unavailable for '
            + entry.ticker + ': ' + err.message);
        }

        const ch = await client.channels.fetch(dedicatedChannelId);
        reply = await ch.send({
          content: text + sourceLink,
          allowedMentions: { parse: [] },
        });
      } else {
        // Mode reply : comportement actuel.
        const channel   = await client.channels.fetch(entry.source_channel_id);
        const sourceMsg = await channel.messages.fetch(entry.source_message_id);
        reply = await sourceMsg.reply({
          content: text,
          allowedMentions: { parse: [] },
        });
      }

      // Backfill the discord_message_id on the milestone_alerts row we
      // just inserted. Non-blocking : if this update fails, the alert
      // was still posted — we just lose the audit link.
      if (reply && reply.id && typeof db.setMilestoneAlertDiscordId === 'function') {
        try {
          db.setMilestoneAlertDiscordId({
            ticker: entry.ticker,
            milestonePct: target,
            discordMessageId: String(reply.id),
          });
        } catch (err) {
          console.error('[milestone-checker] failed to backfill discord_message_id: '
            + err.message);
        }
      }
      db.updateWatchlistAfterAlert({
        ticker: entry.ticker,
        lastMilestonePct: target,
        lastAlertAt: now,
      });
    } catch (err) {
      console.error('[milestone-checker] reply failed for ' + entry.ticker
        + ': ' + err.message);
    }
```

Key invariants preserved:
- `mark-then-send` ordering is untouched — the routing branch runs AFTER the `INSERT OR IGNORE`, so the dedup constraint protects against re-fire if anything fails
- `allowedMentions: { parse: [] }` is set in both modes — no Discord pings
- The outer `try`/`catch` still swallows any error from either mode and keeps the milestone_alerts row inserted (no rollback)
- `setMilestoneAlertDiscordId` and `updateWatchlistAfterAlert` both run regardless of which mode wrote the message

- [ ] **Step 1.5: Run tests to verify all pass**

```bash
node --test discord/milestone-checker.test.js
```

Expected: all tests pass, including the 3 new ones (was 24, now 27). No regression on the existing tick tests.

If a pre-existing test fails because it now needs `_sends` to exist on `fakeClient`, check that the test isn't asserting on the OLD shape — the extended `makeFakeDiscord` is backwards-compatible (default `dedicatedChannelId = null` means no dedicated channel routing).

- [ ] **Step 1.6: Commit**

```bash
git add discord/milestone-checker.js discord/milestone-checker.test.js
git commit -m "feat(milestone-checker): MILESTONE_ALERTS_CHANNEL_ID overrides reply target

When the env var is set, post the milestone alert to that channel via
channel.send() with an appended Discord link to the source message,
instead of reply()ing under the source message in trading-floor.
Source-link fetch is wrapped in try/catch so the post succeeds even
if the source is gone — graceful degradation.

When the env var is empty/absent, the existing reply-in-source-channel
behavior is preserved.

Closes the design at docs/superpowers/specs/2026-05-15-milestone-alerts-channel-routing-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Document the env var in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 2.1: Append the new var to the analyst-watchlist section**

In `.env.example`, locate the existing block starting with `# === ANALYST WATCHLIST + MILESTONE ALERTS =` (added in PR #65). Find the last entry in that block — `MILESTONE_POLL_INTERVAL_MIN=30` — and add the new variable immediately below it (still inside the same section):

```env

# Channel ID Discord (snowflake, 18-20 chiffres) où poster les milestone
# alerts. OPTIONNEL — si vide ou absent, comportement actuel : reply
# sous le message d'origine dans TRADING_CHANNEL (trading-floor).
#
# Utile pour tester la feature dans un canal séparé sans polluer
# trading-floor en prod. Le bot doit avoir la permission "Send Messages"
# dans ce canal. Le post inclura un lien vers le message d'origine.
#
# Pour récupérer l'ID : Discord Developer Mode activé → clic droit sur
# le canal → "Copier l'identifiant".
MILESTONE_ALERTS_CHANNEL_ID=
```

- [ ] **Step 2.2: Verify the `.env.example` still parses (sanity check)**

```bash
node -e "const fs = require('fs'); const env = fs.readFileSync('.env.example', 'utf8'); const lines = env.split('\\n'); for (const l of lines) { if (l.trim() && !l.startsWith('#') && !l.includes('=')) { throw new Error('Malformed line: ' + l); } } console.log('env.example parses ok');"
```

Expected output: `env.example parses ok`.

- [ ] **Step 2.3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document MILESTONE_ALERTS_CHANNEL_ID

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Final verification

- [ ] **Step 3.1: Run the focused test file**

```bash
node --test discord/milestone-checker.test.js
```

Expected: 27 tests pass (24 pre-existing + 3 new).

- [ ] **Step 3.2: Run the full test suite for regression check**

```bash
npm test 2>&1 | tail -10
```

Expected: pre-existing failures only (the 2 well-known pre-existing failures: Windows EBUSY in llm-classify cleanup, ELEVENLABS_API_KEY missing in video). No new failures.

- [ ] **Step 3.3: Smoke check the module loads**

```bash
node -e "require('./discord/milestone-checker'); console.log('milestone-checker ok')"
```

Expected output: `milestone-checker ok`.

- [ ] **Step 3.4: Verify git history**

```bash
git log --oneline -3
```

Expected: 2 new commits (Task 1, Task 2) ahead of `f8b56a2` (current main HEAD).

---

## Manual steps for the operator (call out explicitly in the final report)

1. **Create the test channel** in Discord (ex: `#milestone-test`) — make sure the bot has `Send Messages` permission there.
2. **Get the channel ID**: enable Discord Developer Mode (Settings → Advanced → Developer Mode), right-click the channel → "Copier l'identifiant" — should be a snowflake 18-20 digits.
3. **Set the env var on Railway**: `MILESTONE_ALERTS_CHANNEL_ID=<id>`. Redeploy is automatic.
4. **Verify in logs**: after the next tick (≤ 30 min in RTH 09:30–16:00 ET), look for `[milestone-checker]` lines — no error means the routing is working.
5. **Wait for a milestone trigger**: a watched ticker needs to move +20% from its initial price for the test to actually fire an alert. If no organic trigger comes, you can fake one by editing the `analyst_watchlist` row to lower the `initial_price`.
6. **Verify the post arrives in the test channel** with the `📎` source link.
7. **Switch back to reply mode in prod**: delete the env var on Railway → redeploy. The bot will resume replying under the source message in trading-floor.
