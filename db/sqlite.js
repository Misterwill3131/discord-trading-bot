// ─────────────────────────────────────────────────────────────────────
// db/sqlite.js — Base SQLite embarquée (fichier `boom.db` dans DATA_DIR)
// ─────────────────────────────────────────────────────────────────────
// Stocke les messages Discord traités (source de vérité). Remplace les
// fichiers journaliers messages-YYYY-MM-DD.json qui restent en backup
// mais ne sont plus lus par l'app.
//
// Choix techniques :
//   • better-sqlite3 : API synchrone, plus simple que le modèle async de
//     node-sqlite3. Bloque l'event loop sur chaque query mais les
//     volumes restent faibles (quelques milliers de messages/jour) et
//     le bot est single-process donc pas de contention.
//   • WAL mode : autorise les lectures concurrentes pendant les writes,
//     réduit les verrous. Recommandé pour un read-heavy workload.
//   • `ts` en TEXT ISO : inexable, triable lexicographiquement. Pas de
//     DATETIME car SQLite n'a pas de type date natif de toute façon.
//   • `passed` / `isReply` en INTEGER : 0/1. SQLite n'a pas de BOOLEAN.
//
// IDs au format "timestamp-rand" hérités de logEvent() — on garde le
// format exact pour que la migration JSON → DB soit idempotente (on
// réinsère tel quel, et INSERT OR IGNORE sur la PK déduplique).
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../utils/persistence');

const DB_PATH = path.join(DATA_DIR, 'boom.db');

// Singleton : une seule connexion pour tout le process. `verbose` peut
// être ajouté pour logger chaque query pendant le debug.
const db = new Database(DB_PATH);

// WAL = Write-Ahead Logging : lectures concurrentes aux writes, plus
// performant pour un pattern write-write-read-read que le rollback journal.
db.pragma('journal_mode = WAL');
// FK constraints off par défaut dans SQLite — on n'en a pas ici, mais
// activation future facile.
db.pragma('foreign_keys = ON');

// Schema creation — idempotent. Appelé à l'import, crée les tables
// absentes sans toucher aux existantes.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    ts            TEXT NOT NULL,
    author        TEXT,
    channel       TEXT,
    content       TEXT NOT NULL DEFAULT '',
    preview       TEXT NOT NULL DEFAULT '',
    passed        INTEGER NOT NULL,            -- 0 ou 1
    type          TEXT,                         -- 'entry' | 'exit' | 'neutral' | NULL
    reason        TEXT,
    confidence    INTEGER,
    ticker        TEXT,
    entry_price   REAL,
    isReply       INTEGER NOT NULL DEFAULT 0,
    parentPreview TEXT,
    parentAuthor  TEXT
  );

  -- Index pour les queries les plus fréquentes du dashboard :
  CREATE INDEX IF NOT EXISTS idx_messages_ts            ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_ticker        ON messages(ticker);
  CREATE INDEX IF NOT EXISTS idx_messages_author        ON messages(author);
  CREATE INDEX IF NOT EXISTS idx_messages_passed_ts     ON messages(passed, ts);
  CREATE INDEX IF NOT EXISTS idx_messages_ticker_passed ON messages(ticker, passed);
`);

// ── Prepared statements (réutilisables, plus rapides) ────────────────

// INSERT OR IGNORE : si un id existe déjà, on saute sans erreur. Utile
// pour la migration (re-import sans doublons) et pour les éventuels
// retries côté Discord.
const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, ts, author, channel, content, preview, passed, type, reason,
     confidence, ticker, entry_price, isReply, parentPreview, parentAuthor)
  VALUES
    (@id, @ts, @author, @channel, @content, @preview, @passed, @type, @reason,
     @confidence, @ticker, @entry_price, @isReply, @parentPreview, @parentAuthor)
`);

const stmtRecent = db.prepare(`
  SELECT * FROM messages
  ORDER BY ts DESC
  LIMIT ?
`);

const stmtByTsRange = db.prepare(`
  SELECT * FROM messages
  WHERE ts >= ? AND ts <= ?
  ORDER BY ts DESC
`);

const stmtByDateKey = db.prepare(`
  SELECT * FROM messages
  WHERE substr(ts, 1, 10) = ?
  ORDER BY ts DESC
`);

const stmtByTicker = db.prepare(`
  SELECT * FROM messages
  WHERE ticker = ? AND ts >= ?
  ORDER BY ts DESC
`);

const stmtCount = db.prepare('SELECT COUNT(*) as n FROM messages');

// ── Helpers typés ────────────────────────────────────────────────────

// Convertit une entry JS (format logEvent) en row SQLite (booleans → 0/1).
function toRow(entry) {
  return {
    id:            entry.id,
    ts:            entry.ts,
    author:        entry.author || null,
    channel:       entry.channel || null,
    content:       entry.content || '',
    preview:       entry.preview || '',
    passed:        entry.passed ? 1 : 0,
    type:          entry.type || null,
    reason:        entry.reason || null,
    confidence:    entry.confidence != null ? entry.confidence : null,
    ticker:        entry.ticker || null,
    entry_price:   entry.entry_price != null ? entry.entry_price : null,
    isReply:       entry.isReply ? 1 : 0,
    parentPreview: entry.parentPreview || null,
    parentAuthor:  entry.parentAuthor || null,
  };
}

// Convertit une row SQLite en entry JS (0/1 → boolean). Reproduit le
// format exact attendu par les consommateurs (messageLog.filter, etc.).
function fromRow(row) {
  return {
    id:            row.id,
    ts:            row.ts,
    author:        row.author,
    channel:       row.channel,
    content:       row.content,
    preview:       row.preview,
    passed:        row.passed === 1,
    type:          row.type,
    reason:        row.reason,
    confidence:    row.confidence,
    ticker:        row.ticker,
    entry_price:   row.entry_price,
    isReply:       row.isReply === 1,
    parentPreview: row.parentPreview,
    parentAuthor:  row.parentAuthor,
  };
}

// ── API publique ─────────────────────────────────────────────────────

// Insert un message. Retourne true si inséré, false si doublon ignoré.
function insertMessage(entry) {
  const result = stmtInsert.run(toRow(entry));
  return result.changes > 0;
}

// Bulk insert — utilisé par la migration. Wrappé dans une transaction
// pour ~100× perf vs N inserts isolés.
function insertMessagesBulk(entries) {
  const tx = db.transaction((rows) => {
    let inserted = 0;
    for (const r of rows) {
      const res = stmtInsert.run(r);
      if (res.changes > 0) inserted++;
    }
    return inserted;
  });
  return tx(entries.map(toRow));
}

// Les N messages les plus récents (pour peupler le cache messageLog au boot).
function getRecentMessages(limit) {
  return stmtRecent.all(limit).map(fromRow);
}

// Messages d'une journée précise (date key YYYY-MM-DD). Remplace
// loadDailyFile(dateKey).
function getMessagesByDateKey(dateKey) {
  return stmtByDateKey.all(dateKey).map(fromRow);
}

// Messages dans un range de ts ISO (inclusive). Utile pour
// /api/messages?from=...&to=... et les aggregations analytics.
function getMessagesByTsRange(fromIso, toIso) {
  return stmtByTsRange.all(fromIso, toIso).map(fromRow);
}

// Tous les messages d'un ticker depuis un ts minimum.
function getMessagesByTicker(ticker, sinceIso) {
  return stmtByTicker.all(ticker, sinceIso).map(fromRow);
}

// Diagnostic : total de messages en base.
function countMessages() {
  return stmtCount.get().n;
}

module.exports = {
  db,
  DB_PATH,
  insertMessage,
  insertMessagesBulk,
  getRecentMessages,
  getMessagesByDateKey,
  getMessagesByTsRange,
  getMessagesByTicker,
  countMessages,
};
