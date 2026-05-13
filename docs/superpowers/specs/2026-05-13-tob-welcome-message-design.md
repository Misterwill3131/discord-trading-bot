# TOB Welcome Message — Design Spec

**Date:** 2026-05-13
**Status:** Approved
**Scope:** Auto-welcome new TOB subscribers (Whop + Launchpass) in a dedicated Discord channel.

---

## 1. Goal

When a new person subscribes to TOB via Whop or Launchpass, post a welcome message in a configured Discord channel of the TOB server. The message pings the new user and links the `🚩│start-here` channel:

```
@user welcome to TOB! Please start with #start-here and watch us for a week or so to get familiar with the discord.
```

## 2. Detection mechanism

Whop and Launchpass both grant access to TOB by assigning **the same Discord role** to the new member (via their own bots/integrations on Discord). The role attribution is observable through Discord's `guildMemberUpdate` gateway event.

We listen to `guildMemberUpdate` on the main bot and detect when the subscriber role transitions from "absent on old member" to "present on new member".

Rejected alternatives:
- **Listening to Whop/Launchpass bot messages in the alerts channel.** Fragile — depends on the exact message format of third-party bots which may change without notice.
- **Hooking the Launchpass/Stripe webhooks already received by the SaaS layer.** At webhook time we only know the customer's email, not their Discord user ID. Timing is also unreliable (the user may not have joined the Discord yet when the webhook arrives).

## 3. Module structure

New file: `discord/welcome-listener.js`

Exports:
- `registerWelcomeListener(client, config)` — wires the `guildMemberUpdate` event on `client`. Idempotent: if any config field is missing, logs a warning at boot and the listener stays dormant (no crash).
- `shouldWelcome(oldMember, newMember, { roleId, guildId })` — pure function, returns `true` only when:
  - `newMember.guild.id === guildId`
  - `!newMember.user.bot`
  - `oldMember.roles.cache.has(roleId) === false`
  - `newMember.roles.cache.has(roleId) === true`
- `formatWelcomeMessage(userId, startHereChannelId)` — pure function, returns the formatted string.

No persistent state. No deduplication. If a user leaves and re-subscribes, the role gets re-attributed and they get welcomed again — acceptable behavior.

## 4. Wiring

In `index.js`:
1. Add `GatewayIntentBits.GuildMembers` to the intents array on the main `client` (line 311–317 area).
2. After the existing `registerXxx(client, ...)` calls (around line 363), add:
   ```js
   const { registerWelcomeListener } = require('./discord/welcome-listener');
   registerWelcomeListener(client, {
     guildId:               process.env.TOB_WELCOME_GUILD_ID,
     subscriberRoleId:      process.env.TOB_SUBSCRIBER_ROLE_ID,
     welcomeChannelId:      process.env.TOB_WELCOME_CHANNEL_ID,
     startHereChannelId:    process.env.TOB_START_HERE_CHANNEL_ID,
   });
   ```

The SaaS client (`clientSaas`) is **not** touched — welcomes are TOB-only.

## 5. Message format

Discord native mentions:
- `<@USER_ID>` renders as a clickable user ping
- `<#CHANNEL_ID>` renders as a clickable channel link with its native icon (e.g. `🚩│start-here`)

Final wire format:
```
<@123456789> welcome to TOB! Please start with <#987654321> and watch us for a week or so to get familiar with the discord.
```

The text is hardcoded in `formatWelcomeMessage`. To change wording, edit the source — no dashboard knob.

## 6. Configuration (new env vars)

| Variable | Purpose | Required |
|---|---|---|
| `TOB_WELCOME_GUILD_ID` | Guild ID of the TOB server. Filter — prevents accidental welcomes if the bot joins other servers. | Yes |
| `TOB_SUBSCRIBER_ROLE_ID` | Role ID assigned by both Whop and Launchpass to new subscribers. | Yes |
| `TOB_WELCOME_CHANNEL_ID` | Channel ID where the welcome message is posted. | Yes |
| `TOB_START_HERE_CHANNEL_ID` | Channel ID referenced in the message body (the `<#id>` link). | Yes |

If any are missing, the listener logs `[welcome] missing config — disabled` once at boot and never fires.

Add these to `.env.example` under a new section `=== WELCOME MESSAGE (TOB subscribers) ===`.

## 7. Discord intent

The main `client` currently has:
```js
intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
```

We add `GatewayIntentBits.GuildMembers`. This is a **privileged intent** — must be enabled in the Discord Developer Portal.

## 8. Manual steps required from the user

These cannot be automated by the code and must be done outside the repo:

1. **Discord Developer Portal** → select the main bot application → tab **Bot** → toggle on **Server Members Intent** (under Privileged Gateway Intents). Save.
2. **Discord client, with Developer Mode enabled** (Settings → Advanced → Developer Mode), right-click → "Copy ID" on:
   - The TOB server (server name dropdown → Copy Server ID)
   - The shared subscriber role (Server Settings → Roles → right-click the role)
   - The welcome destination channel
   - The `🚩│start-here` channel
3. **Railway** → project env vars → add the 4 variables above with the IDs from step 2. Redeploy.

Without step 1, Discord will not deliver `guildMemberUpdate` events with role data, and the bot will silently fail to detect role changes.

## 9. Testing

**Unit tests** (`discord/welcome-listener.test.js`):
- `formatWelcomeMessage('123', '456')` returns the exact expected string.
- `shouldWelcome` returns `true` when the role transitions from absent → present on the configured guild.
- `shouldWelcome` returns `false` when:
  - The role was already on the old member (no transition).
  - The role is on a different guild than `guildId`.
  - The member is a bot.
  - The role was *removed* (present on old, absent on new).
  - The role neither was nor is on the member (unrelated update).

**Manual smoke test post-deploy:**
- In the TOB server, manually attribute the subscriber role to a test account.
- Verify the welcome message appears in the configured channel within ~1 second.
- Remove the role, re-attribute it — confirm a second welcome posts (no dedupe by design).

## 10. Out of scope

- DM-based welcome (many users have DMs closed; public message is more reliable).
- Per-plan customization (one welcome template for everyone).
- Configurable wording via the admin dashboard.
- Welcome deduplication (re-subscribers are rare and re-welcoming is benign).
- Welcome on `guildMemberAdd` (join) — Whop/Launchpass assign the role *after* join, so `guildMemberUpdate` captures the right moment. If a future integration ever sets the role at join time, we can add a fallback then.
- Tracking welcome history in the DB.
