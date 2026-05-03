// ─────────────────────────────────────────────────────────────────────
// saas/license-sync.js — Sync périodique Postgres → SQLite
// ─────────────────────────────────────────────────────────────────────
// Le site temple-of-boom-site (Vercel + Neon Postgres) écrit la source de
// vérité pour licenses.status (ex: Stripe webhook subscription.deleted →
// licenses.status='cancelled'). Le bot relay consume le mirror SQLite.
//
// Ce module poll Postgres toutes les SYNC_INTERVAL_MS et propage vers
// SQLite. Eventual consistency : ~60s max de lag entre une cancellation
// Stripe et l'arrêt effectif du relay.
//
// No-op si DATABASE_URL absent (pg.isEnabled === false).
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const pg = require('../db/postgres');

const SYNC_INTERVAL_MS = 60 * 1000; // 60s
let intervalHandle = null;

// Effectue 1 sync : pour chaque license SQLite, query Postgres et update
// le status local si différent. Returns { synced, skipped, errors }.
async function syncOnce() {
  if (!pg.isEnabled) return { synced: 0, skipped: 0, errors: 0 };

  const sqliteLicenses = db.licenseList(); // toutes
  let synced = 0, skipped = 0, errors = 0;

  for (const sqlLic of sqliteLicenses) {
    try {
      const pgLic = await pg.getLicenseByGuildId(sqlLic.guild_id);
      if (!pgLic) {
        // Pas en Postgres (ex: license SQLite legacy Launchpass) → skip
        skipped++;
        continue;
      }
      if (pgLic.status !== sqlLic.status) {
        db.licenseSetStatus(sqlLic.guild_id, pgLic.status);
        db.adminActionInsert({
          admin: 'system',
          action: 'license-sync',
          guild_id: sqlLic.guild_id,
          payload: {
            from: sqlLic.status,
            to: pgLic.status,
            source: 'postgres',
          },
        });
        console.log(
          `[license-sync] guild=${sqlLic.guild_id} ${sqlLic.status} → ${pgLic.status}`,
        );
        synced++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(
        `[license-sync] failed for guild=${sqlLic.guild_id}:`,
        err.message,
      );
      errors++;
    }
  }

  return { synced, skipped, errors };
}

function start() {
  if (intervalHandle) return; // idempotent
  if (!pg.isEnabled) {
    console.log('[license-sync] DATABASE_URL not set — sync disabled (legacy SQLite-only mode)');
    return;
  }

  // Initial sync au démarrage
  syncOnce()
    .then((r) => {
      if (r.synced > 0) {
        console.log(
          `[license-sync] initial: synced=${r.synced} skipped=${r.skipped} errors=${r.errors}`,
        );
      }
    })
    .catch((err) => console.error('[license-sync] initial sync failed:', err.message));

  // Tick périodique
  intervalHandle = setInterval(() => {
    syncOnce().catch((err) =>
      console.error('[license-sync] periodic sync failed:', err.message),
    );
  }, SYNC_INTERVAL_MS);

  console.log(`[license-sync] started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  syncOnce,
  start,
  stop,
  SYNC_INTERVAL_MS,
};
