// ─────────────────────────────────────────────────────────────────────
// social/habs/worker.js — Habs queue worker (tick + retry backoff)
// ─────────────────────────────────────────────────────────────────────
// Tick : SELECT pending jobs ready → lock → dispatch adapter → mark done
// ou retry/fail selon le résultat. Retry backoff [1s, 5s, 30s] géré
// dans db/sqlite.js (markSocialPostJobRetryOrFailed).
//
// Le worker est pure logic — toutes les dépendances (db, adapters,
// notifyAdmin) sont injectables pour le test.
//
// Cf docs/superpowers/specs/2026-05-18-habs-design.md section 4.
// ─────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

// Effectue un tick. Args :
//   db          : { getPendingSocialPostJobs, markSocialPostJobPosting,
//                   markSocialPostJobDone, markSocialPostJobRetryOrFailed }
//   adapters    : { stocktwits: async ({webhookUrl, payload}) => Result }
//   webhookUrls : { stocktwits: 'https://hooks.zapier.com/...' }
//   notifyAdmin : async (message) => void
async function tickOnce({ db, adapters, webhookUrls, notifyAdmin }) {
  const pending = db.getPendingSocialPostJobs(10);
  for (const job of pending) {
    const locked = db.markSocialPostJobPosting(job.id);
    if (!locked) continue;  // race: another tick grabbed it

    const adapter = adapters[job.platform];
    const webhookUrl = webhookUrls[job.platform];

    if (!adapter) {
      const err = `no adapter for platform '${job.platform}'`;
      db.markSocialPostJobRetryOrFailed(job.id, err, 1);  // force-fail (no retry for unknown platform)
      await safeNotify(notifyAdmin, `❌ Habs ${job.platform} #${job.id}: ${err}`);
      continue;
    }
    if (!webhookUrl) {
      const err = `no webhook URL for platform '${job.platform}'`;
      db.markSocialPostJobRetryOrFailed(job.id, err, 1);
      await safeNotify(notifyAdmin, `❌ Habs ${job.platform} #${job.id}: ${err}`);
      continue;
    }

    // Reconstruct payload from the job row. Defensive parse : cashtags_json
    // should always be valid JSON (we wrote it), but a corrupt DB row
    // shouldn't crash the worker — fall back to empty array.
    let cashtags = [];
    try {
      cashtags = JSON.parse(job.cashtags_json || '[]');
      if (!Array.isArray(cashtags)) cashtags = [];
    } catch (err) {
      console.warn(`[habs:worker] job #${job.id} malformed cashtags_json:`, err.message);
    }
    const payload = {
      body: job.caption,
      source: 'habs-recap',
      job_id: job.id,
      date_label: extractDateLabel(job.caption),
      cashtags,
    };

    let result;
    try {
      result = await adapter({ webhookUrl, payload });
    } catch (err) {
      result = { ok: false, retriable: true, error: String(err && err.message || err) };
    }

    if (result.ok) {
      db.markSocialPostJobDone(job.id, result.postUrl || null);
      continue;
    }

    if (result.retriable) {
      const outcome = db.markSocialPostJobRetryOrFailed(job.id, result.error, MAX_ATTEMPTS);
      if (outcome.status === 'failed') {
        await safeNotify(notifyAdmin, `❌ Habs ${job.platform} #${job.id} (${MAX_ATTEMPTS} retries exhausted): ${result.error}`);
      }
    } else {
      // Permanent failure → force-fail (pass 1 as maxAttempts so attempts >= 1 always fails).
      db.markSocialPostJobRetryOrFailed(job.id, result.error, 1);
      await safeNotify(notifyAdmin, `❌ Habs ${job.platform} #${job.id}: ${result.error}`);
    }
  }
}

// Wrapper qui ne propage jamais : si notifyAdmin throws (caller violated
// the contract), on log et on continue. Évite que la boucle abandonne
// les jobs lockés en `posting` qui n'ont pas encore été traités.
async function safeNotify(notifyAdmin, message) {
  try {
    await notifyAdmin(message);
  } catch (err) {
    console.error('[habs:worker] notifyAdmin threw (ignored):', err && err.message, '|', message);
  }
}

// Lazy extract dateLabel depuis "Trade journal — YYYY-MM-DD" si présent.
function extractDateLabel(caption) {
  const m = /Trade journal — (\d{4}-\d{2}-\d{2})/.exec(String(caption || ''));
  return m ? m[1] : null;
}

// Factory pour le mode production (setInterval). Retourne { start, stop, tick }.
function createWorker({ db, adapters, webhookUrls, notifyAdmin, intervalMs = 5000 }) {
  let handle = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await tickOnce({ db, adapters, webhookUrls, notifyAdmin });
    } catch (err) {
      console.error('[habs:worker] tick error:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (handle) return;
      handle = setInterval(tick, intervalMs);
      console.log(`[habs:worker] started (tick every ${intervalMs}ms)`);
    },
    stop() {
      if (handle) {
        clearInterval(handle);
        handle = null;
        console.log('[habs:worker] stopped');
      }
    },
    tick,
  };
}

module.exports = { tickOnce, createWorker, MAX_ATTEMPTS };
