# Habs Setup — Stocktwits via Zapier

Steps to enable Habs v0.1 in production. Manual setup is required because
Stocktwits OAuth runs inside Zapier's UI, not in this codebase.

## Prerequisites

- Zapier account (free tier suffices for v0.1, ~30 tasks/month)
- Stocktwits account that will publish the recaps. Use a personal-trader
  handle, NOT an obvious brand handle. Stocktwits restricts the first 50
  posts from any account, so make 3-5 organic manual posts before enabling
  Habs.
- Discord channel ID to receive failure notifications (recommended).

## 1. Configure the Zap

1. In Zapier, create a new Zap.
2. **Trigger:** Webhooks by Zapier → **Catch Hook**. Continue. Zapier
   gives you a webhook URL (`https://hooks.zapier.com/hooks/catch/...`).
   Copy it.
3. **Action:** Stocktwits → **Create Post**.
   - Connect your Stocktwits account when prompted (OAuth flow in
     Zapier's UI).
   - Map the `Post Body` field to the webhook payload's `body` field.
4. Test the Zap with a sample payload.
5. Publish the Zap.

## 2. Environment variables

Add these to Railway (or your hosting env):

```
HABS_ENABLED=true
HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL=<paste the URL from step 1.2>
HABS_ADMIN_CHANNEL_ID=<Discord channel ID for failure notifs>
HABS_WORKER_INTERVAL_MS=5000
```

Optional:

```
HABS_CAPTION_MODEL=claude-haiku-4-5      # default inherits CAPTION_LLM_MODEL
```

## 3. Deploy and verify

1. `git push` and wait for Railway redeploy.
2. Check the bot logs at boot:
   - Expected: `[habs] started` and `[habs:worker] started (tick every 5000ms)`.
   - If you see `[habs] disabled (...)`, env vars are not set correctly.
3. Trigger a real recap: post a P&L screenshot in the recap Discord
   channel as usual.
4. Within 5-15 seconds, the post should appear on the configured
   Stocktwits feed.
5. Check the bot logs and the `social_post_jobs` table:
   ```bash
   sqlite3 <DATA_DIR>/boom.db "SELECT id, status, attempts, last_error FROM social_post_jobs ORDER BY id DESC LIMIT 5;"
   ```
   The latest row should have `status='done'`.

## 4. Failure handling

If Habs hits 3 retries on the same job, it marks the job `failed` and
posts a message to the configured `HABS_ADMIN_CHANNEL_ID`:

> ❌ Habs stocktwits #42 (3 retries exhausted): HTTP 503: Service Unavailable

Common reasons:
- Zapier webhook URL invalid / Zap turned off / Zapier OAuth to
  Stocktwits expired → reconnect in Zapier UI.
- Zapier free tier task limit hit → upgrade or wait until next month.
- Stocktwits account suspended (see compliance below).

To replay a failed job manually (v0.1 has no auto-retry beyond 3):

```bash
sqlite3 <DATA_DIR>/boom.db "UPDATE social_post_jobs SET status='pending', attempts=0, next_attempt_at=NULL WHERE id=<failed-id>;"
```

The worker will pick it up on the next tick.

## 5. Compliance (Stocktwits rules)

Habs v0.1 uses a Stocktwits-rules-compliant caption template (no URLs,
no brand mentions, no "join" CTAs). However, the account itself can still
be flagged if:

- Posts are interpreted as automated marketing for a paid Discord. Vary
  your manual posting pattern alongside Habs (don't make Habs the *only*
  activity from the account).
- Cashtags are used on irrelevant tickers (Habs only cashtags actually
  traded tickers, so this is safe by design).
- The first 50 posts trigger promo flags. Mix manual organic posts with
  Habs output for the first weeks.

Kill switch — set `HABS_ENABLED=false` in env and redeploy. Habs will
log `[habs] disabled` at boot and the Discord recap flow remains intact.

## 6. Cost estimate

- Zapier free tier: 100 tasks/month. Habs uses 1 task per published
  recap. At 1 recap/day, ~30 tasks/month — comfortably within free.
- Anthropic API (optional, if `ANTHROPIC_API_KEY` set): 1 caption
  generation per recap via `claude-haiku-4-5`. ~$0.001/post.
- Falls back to deterministic template if LLM is unavailable.
