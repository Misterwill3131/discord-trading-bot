// ─────────────────────────────────────────────────────────────────────
// routes/db-snapshot.js — Download admin de la DB SQLite (snapshot propre)
// ─────────────────────────────────────────────────────────────────────
//   GET /admin/db-snapshot   — Stream un snapshot consolidé de boom.db
//
// Pourquoi un snapshot ? La DB tourne en mode WAL (Write-Ahead Logging) :
// les écritures vont dans boom.db-wal avant d'être checkpointées dans
// boom.db. Copier boom.db brutalement = on rate les écritures non
// encore checkpointées (potentiellement des heures de data).
//
// Solution : `VACUUM INTO '/tmp/snapshot.db'` qui produit un fichier
// SQLite propre, autonome (pas de WAL séparé), avec TOUTES les données
// committées. Atomique : si la query échoue à mi-chemin, pas de
// fichier corrompu.
//
// Sécurité : derrière requireAuth. Le dump contient TOUTES les data
// (messages, settings, gallery_items binaires) donc accès admin only.
//
// Usage côté client (depuis local) :
//   curl -u admin:<password> https://ton-app.up.railway.app/admin/db-snapshot \
//        -o boom.db
//
// Performance : VACUUM est synchrone et peut bloquer le process Node
// pendant quelques secondes sur grosse DB. Acceptable : route admin
// rare, pas dans le hot path.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, DB_PATH } = require('../db/sqlite');

function registerDbSnapshotRoutes(app, requireAuth) {
  app.get('/admin/db-snapshot', requireAuth, (req, res) => {
    // Génère un path unique pour permettre des téléchargements concurrents
    // (peu probable mais évite race condition).
    const tmpFile = path.join(os.tmpdir(), `boom-snapshot-${Date.now()}.db`);

    try {
      // ── 1. VACUUM INTO : crée un snapshot consolidé, WAL appliqué ──
      // Cette opération est synchrone et bloquante (better-sqlite3) — OK
      // pour une route admin. Sur une DB de quelques MB c'est < 1s, sur
      // 100+ MB c'est quelques secondes mais reste raisonnable.
      const startedAt = Date.now();
      db.prepare(`VACUUM INTO ?`).run(tmpFile);
      const vacuumMs = Date.now() - startedAt;
      const size = fs.statSync(tmpFile).size;
      console.log(`[db-snapshot] VACUUM INTO done in ${vacuumMs}ms, ${(size / 1024 / 1024).toFixed(2)} MB`);

      // ── 2. Stream le fichier en download ──
      const downloadName = `boom-${new Date().toISOString().slice(0, 10)}.db`;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('X-DB-Source', DB_PATH);
      res.setHeader('X-DB-Snapshot-Time-Ms', vacuumMs);

      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);

      // ── 3. Cleanup du temp file après envoi ──
      // 'close' fires après que le client ait fini de download (ou abort).
      // 'error' aussi pour cleanup en cas de coupure. unlink async,
      // non bloquant — la suppression peut échouer silencieusement
      // (Windows peut tenir le fichier ouvert) sans conséquence : tmpdir
      // est nettoyé par l'OS.
      const cleanup = () => {
        fs.unlink(tmpFile, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.warn(`[db-snapshot] cleanup failed: ${err.message}`);
          }
        });
      };
      stream.on('close', cleanup);
      stream.on('error', (err) => {
        console.error(`[db-snapshot] stream error: ${err.message}`);
        cleanup();
      });
      res.on('close', cleanup);  // client aborted
    } catch (err) {
      console.error('[db-snapshot] failed:', err);
      // Cleanup éventuel
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Petit endpoint d'info pour vérifier la taille sans télécharger
  app.get('/admin/db-snapshot/info', requireAuth, (req, res) => {
    try {
      const stat = fs.statSync(DB_PATH);
      const walPath = DB_PATH + '-wal';
      let walSize = 0;
      try { walSize = fs.statSync(walPath).size; } catch { /* no WAL = OK */ }
      res.json({
        dbPath: DB_PATH,
        dbSizeBytes: stat.size,
        dbSizeMB: (stat.size / 1024 / 1024).toFixed(2),
        walSizeBytes: walSize,
        walSizeMB: (walSize / 1024 / 1024).toFixed(2),
        lastModified: stat.mtime.toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerDbSnapshotRoutes };
