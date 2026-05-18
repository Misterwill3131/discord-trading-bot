# Habs Platform Adapter Interface

Every file in `social/habs/platforms/*.js` (except this doc) is a platform
adapter. Adapters MUST export a `publish` function with this signature:

```js
async function publish({ webhookUrl, payload, fetchImpl }) → Result
```

`Result` shape:
- `{ ok: true, postUrl?: string }` — success. `postUrl` is the public URL
  of the resulting post if the platform returns one (else null/omitted).
- `{ ok: false, retriable: boolean, error: string }` — failure.
  - `retriable: true` → worker will schedule a retry per backoff policy.
  - `retriable: false` → worker marks the job `failed` immediately (no retry).

The worker dispatches by reading `job.platform` and requiring
`./platforms/${platform}.js`. Currently supported platforms:

| platform value | adapter file |
|---|---|
| `stocktwits` (via Zapier) | `zapier-webhook.js` |

To add a new platform:
1. Create `social/habs/platforms/<name>.js` exporting `publish`.
2. Wire dispatcher in `social/habs/worker.js` (switch by platform string).
3. Document credentials/env vars needed in `docs/habs-setup.md`.
