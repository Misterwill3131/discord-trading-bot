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

  -- Compteur journalier de profits (1 ligne / jour). milestones_json garde
  -- les paliers déjà annoncés (10/25/50/...) pour ne pas re-notifier.
  CREATE TABLE IF NOT EXISTS profit_counts (
    date            TEXT PRIMARY KEY,       -- YYYY-MM-DD
    count           INTEGER NOT NULL DEFAULT 0,
    milestones_json TEXT    NOT NULL DEFAULT '[]'
  );

  -- Review des messages postés dans #profits (incluant les ignorés).
  -- Permet le feedback learned (blacklist/whitelist) via la page /profits.
  CREATE TABLE IF NOT EXISTS profit_messages (
    id        TEXT PRIMARY KEY,            -- "timestamp-rand" (comme messages)
    ts        TEXT NOT NULL,
    author    TEXT,
    content   TEXT NOT NULL DEFAULT '',
    preview   TEXT NOT NULL DEFAULT '',
    hasImage  INTEGER NOT NULL DEFAULT 0,   -- 0/1
    hasTicker INTEGER NOT NULL DEFAULT 0,   -- 0/1
    textCount INTEGER NOT NULL DEFAULT 0,   -- # de ranges de prix trouvés
    counted   INTEGER NOT NULL DEFAULT 0,   -- 0/1 (a incrémenté le compteur?)
    reason    TEXT,                         -- 'image' | 'ticker' | 'learned-*' | ...
    feedback  TEXT                          -- NULL | 'good' | 'bad'
  );
  CREATE INDEX IF NOT EXISTS idx_profit_messages_ts ON profit_messages(ts);

  -- Filtres learned sur les messages profits (1 ligne par phrase).
  -- Dénormalisé vs un seul blob JSON : queries plus simples, stats faciles.
  CREATE TABLE IF NOT EXISTS profit_filter_phrases (
    phrase TEXT NOT NULL,
    kind   TEXT NOT NULL CHECK (kind IN ('blocked', 'allowed')),
    PRIMARY KEY (phrase, kind)
  );

  -- Table KV générique pour les configs stockées en blob JSON :
  -- custom_filters, config_overrides, etc. Chaque ligne = 1 fichier
  -- JSON. Read/write pattern : on lit l'objet complet, on le mute en
  -- mémoire, on réécrit. Pas de queries par champ → pas besoin de
  -- dénormaliser.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  -- Items de news récents (max 50 en pratique, via cap à l'insertion).
  -- Persiste le fil affiché sur /news et dans !news pour qu'il survive
  -- aux restarts du bot (sinon le dashboard est vide pendant des heures).
  CREATE TABLE IF NOT EXISTS news_items (
    id     TEXT PRIMARY KEY,        -- "timestamp-rand" format
    ts     TEXT NOT NULL,
    title  TEXT NOT NULL,
    emoji  TEXT,
    source TEXT,
    link   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_news_items_ts ON news_items(ts);

  -- Galerie d'images générées (signal proof + promo). Persiste les
  -- buffers PNG pour que /gallery et /gallery/image/:id fonctionnent
  -- après un restart du bot. Cap à 100 items — buffer type ~20 KB,
  -- soit ~2 MB max. better-sqlite3 mappe Buffer <-> BLOB nativement.
  CREATE TABLE IF NOT EXISTS gallery_items (
    id     TEXT PRIMARY KEY,        -- "timestamp-rand"
    ts     TEXT NOT NULL,
    type   TEXT NOT NULL,           -- 'signal' | 'proof'
    ticker TEXT,
    author TEXT,
    buffer BLOB NOT NULL             -- PNG bytes
  );
  CREATE INDEX IF NOT EXISTS idx_gallery_items_ts ON gallery_items(ts);
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

// Purge les messages FILTRÉS (passed=0) qui n'ont ni ticker ni
// entry_price stocké. Ce sont les messages sans valeur analytique :
// questions, réactions, phrases sans données trade parsables.
//
// Les messages passed=1 sont PROTÉGÉS même s'ils n'ont pas de ticker
// (ex: signaux allowed sans ticker détectable — rares mais possible).
//
// Retourne le nombre de lignes supprimées. Helper utile à appeler au
// boot + avant chaque backup nightly pour garder la DB svelte.
const stmtMessagesPurgeFiltered = db.prepare(`
  DELETE FROM messages
  WHERE passed = 0 AND ticker IS NULL AND entry_price IS NULL
`);
function purgeFilteredMessagesWithoutData() {
  return stmtMessagesPurgeFiltered.run().changes;
}

// ═════════════════════════════════════════════════════════════════════
//  Profits — compteur journalier + messages review + filters learned
// ═════════════════════════════════════════════════════════════════════

// ── profit_counts ────────────────────────────────────────────────────

const stmtProfitCountGet = db.prepare(
  'SELECT count, milestones_json FROM profit_counts WHERE date = ?'
);
const stmtProfitCountUpsert = db.prepare(`
  INSERT INTO profit_counts (date, count, milestones_json)
  VALUES (@date, @count, @milestones_json)
  ON CONFLICT(date) DO UPDATE SET
    count = excluded.count,
    milestones_json = excluded.milestones_json
`);
const stmtProfitCountHistory = db.prepare(
  'SELECT date, count FROM profit_counts WHERE date >= ? ORDER BY date ASC'
);

// Retourne { count, milestones } pour un jour donné (0 + [] si absent).
// Shape identique à l'ancien loadProfitData pour backward compat.
function getProfitData(dateKey) {
  const row = stmtProfitCountGet.get(dateKey);
  if (!row) return { count: 0, milestones: [] };
  let milestones = [];
  try { milestones = JSON.parse(row.milestones_json || '[]'); } catch (_) {}
  return { count: row.count, milestones };
}

// UPSERT count+milestones pour un jour. Équivalent de saveProfitData.
function setProfitData(dateKey, data) {
  stmtProfitCountUpsert.run({
    date: dateKey,
    count: data.count | 0,
    milestones_json: JSON.stringify(data.milestones || []),
  });
}

// Historique sur N jours pour le bar chart — renvoie les jours EXISTANTS
// uniquement. Le caller complète avec count:0 pour les jours manquants.
function getProfitHistoryFrom(sinceDateKey) {
  return stmtProfitCountHistory.all(sinceDateKey);
}

// ── profit_messages ─────────────────────────────────────────────────

const stmtProfitMsgInsert = db.prepare(`
  INSERT OR IGNORE INTO profit_messages
    (id, ts, author, content, preview, hasImage, hasTicker, textCount, counted, reason, feedback)
  VALUES
    (@id, @ts, @author, @content, @preview, @hasImage, @hasTicker, @textCount, @counted, @reason, @feedback)
`);
const stmtProfitMsgByDate = db.prepare(
  "SELECT * FROM profit_messages WHERE substr(ts, 1, 10) = ? ORDER BY ts DESC"
);
const stmtProfitMsgSetFeedback = db.prepare(
  'UPDATE profit_messages SET feedback = ? WHERE id = ?'
);

function profitMsgToRow(m) {
  return {
    id:        m.id,
    ts:        m.ts,
    author:    m.author || null,
    content:   m.content || '',
    preview:   m.preview || '',
    hasImage:  m.hasImage ? 1 : 0,
    hasTicker: m.hasTicker ? 1 : 0,
    textCount: m.textCount | 0,
    counted:   m.counted ? 1 : 0,
    reason:    m.reason || null,
    feedback:  m.feedback || null,
  };
}

function profitMsgFromRow(r) {
  return {
    id:        r.id,
    ts:        r.ts,
    author:    r.author,
    content:   r.content,
    preview:   r.preview,
    hasImage:  r.hasImage === 1,
    hasTicker: r.hasTicker === 1,
    textCount: r.textCount,
    counted:   r.counted === 1,
    reason:    r.reason,
    feedback:  r.feedback,
  };
}

function insertProfitMessage(entry) {
  return stmtProfitMsgInsert.run(profitMsgToRow(entry)).changes > 0;
}

function insertProfitMessagesBulk(entries) {
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const r of rows) if (stmtProfitMsgInsert.run(r).changes > 0) n++;
    return n;
  });
  return tx(entries.map(profitMsgToRow));
}

function getProfitMessagesByDate(dateKey) {
  return stmtProfitMsgByDate.all(dateKey).map(profitMsgFromRow);
}

// Update feedback sur un message existant. Cherche par `id` seul (pas de
// filtre date car l'id contient timestamp → garantit unicité globale).
// Retourne true si la ligne existait et a été modifiée.
function updateProfitMessageFeedback(id, feedback) {
  return stmtProfitMsgSetFeedback.run(feedback, id).changes > 0;
}

// ── profit_filter_phrases ───────────────────────────────────────────

const stmtProfitFilterAdd = db.prepare(
  'INSERT OR IGNORE INTO profit_filter_phrases (phrase, kind) VALUES (?, ?)'
);
const stmtProfitFilterRemove = db.prepare(
  'DELETE FROM profit_filter_phrases WHERE phrase = ? AND kind = ?'
);
const stmtProfitFilterAll = db.prepare(
  'SELECT phrase, kind FROM profit_filter_phrases'
);

// Retourne { blocked: [phrase...], allowed: [phrase...] }. Shape identique
// à l'ancien loadProfitFilters pour backward compat avec le code consommateur.
function getProfitFilters() {
  const out = { blocked: [], allowed: [] };
  for (const row of stmtProfitFilterAll.all()) {
    if (row.kind === 'blocked') out.blocked.push(row.phrase);
    else if (row.kind === 'allowed') out.allowed.push(row.phrase);
  }
  return out;
}

// Ajoute une phrase à blocked OU allowed. Idempotent (INSERT OR IGNORE).
function addProfitFilterPhrase(phrase, kind) {
  return stmtProfitFilterAdd.run(phrase, kind).changes > 0;
}

// Retire une phrase de blocked OU allowed. Silencieux si absente.
function removeProfitFilterPhrase(phrase, kind) {
  return stmtProfitFilterRemove.run(phrase, kind).changes > 0;
}

// ═════════════════════════════════════════════════════════════════════
//  Settings — KV blob générique (1 ligne / namespace)
// ═════════════════════════════════════════════════════════════════════

const stmtSettingGet = db.prepare('SELECT value_json FROM settings WHERE key = ?');
const stmtSettingUpsert = db.prepare(`
  INSERT INTO settings (key, value_json) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
`);

// Retourne la valeur parsée du setting `key`, ou `defaultValue` si absent
// ou si le JSON stocké est corrompu (robustesse > échec dur).
function getSetting(key, defaultValue) {
  const row = stmtSettingGet.get(key);
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.value_json);
  } catch (e) {
    console.error('[settings] Invalid JSON for key', key, ':', e.message);
    return defaultValue;
  }
}

// UPSERT la valeur sérialisée en JSON. Remplace complètement — pas de merge.
function setSetting(key, value) {
  stmtSettingUpsert.run(key, JSON.stringify(value));
}

// ═════════════════════════════════════════════════════════════════════
//  News items — fil récent persisté (dashboard + !news au restart)
// ═════════════════════════════════════════════════════════════════════

const stmtNewsInsert = db.prepare(`
  INSERT OR IGNORE INTO news_items (id, ts, title, emoji, source, link)
  VALUES (@id, @ts, @title, @emoji, @source, @link)
`);
const stmtNewsRecent = db.prepare(
  'SELECT * FROM news_items ORDER BY ts DESC LIMIT ?'
);
const stmtNewsTrim = db.prepare(`
  DELETE FROM news_items
  WHERE id NOT IN (
    SELECT id FROM news_items ORDER BY ts DESC LIMIT ?
  )
`);

// Persist un item. Retourne true si inséré, false si PK déjà connue
// (évite les doublons si le poller retombe sur un GUID déjà stocké).
function insertNewsItem(item) {
  return stmtNewsInsert.run({
    id:     item.id,
    ts:     item.ts,
    title:  item.title || '',
    emoji:  item.emoji || null,
    source: item.source || null,
    link:   item.link || null,
  }).changes > 0;
}

// Les N plus récents — utilisé au boot pour hydrater `recentNews`.
function getRecentNewsItems(limit) {
  return stmtNewsRecent.all(limit);
}

// Conserve uniquement les `keep` plus récents. Appelé après chaque
// insert pour que la table ne grossisse pas indéfiniment.
function trimNewsItems(keep) {
  stmtNewsTrim.run(keep);
}

// Supprime les items plus vieux que `days` jours. La comparaison se
// fait en string ISO (lexicographique = chronologique pour ce format).
// Retourne le nombre de lignes supprimées — utile pour les logs.
const stmtNewsPurge = db.prepare(
  "DELETE FROM news_items WHERE ts < datetime('now', ?)"
);
function purgeNewsOlderThan(days) {
  // SQLite datetime('now', '-7 days') accepte le modifier comme string.
  return stmtNewsPurge.run('-' + (days | 0) + ' days').changes;
}

// ═════════════════════════════════════════════════════════════════════
//  Gallery items — buffers PNG des images générées
// ═════════════════════════════════════════════════════════════════════

const stmtGalleryInsert = db.prepare(`
  INSERT OR IGNORE INTO gallery_items (id, ts, type, ticker, author, buffer)
  VALUES (@id, @ts, @type, @ticker, @author, @buffer)
`);
const stmtGalleryRecent = db.prepare(
  'SELECT id, ts, type, ticker, author, buffer FROM gallery_items ORDER BY ts DESC LIMIT ?'
);
const stmtGalleryTrim = db.prepare(`
  DELETE FROM gallery_items
  WHERE id NOT IN (
    SELECT id FROM gallery_items ORDER BY ts DESC LIMIT ?
  )
`);

// Persist un item (buffer doit être un Buffer Node — mappé en BLOB).
function insertGalleryItem(item) {
  return stmtGalleryInsert.run({
    id:     item.id,
    ts:     item.ts,
    type:   item.type,
    ticker: item.ticker || null,
    author: item.author || null,
    buffer: item.buffer,
  }).changes > 0;
}

// Les N plus récents — hydrate imageState.imageGallery au boot.
// better-sqlite3 retourne les BLOB sous forme de Buffer natif : pas de
// conversion nécessaire côté caller.
function getRecentGalleryItems(limit) {
  return stmtGalleryRecent.all(limit);
}

function trimGalleryItems(keep) {
  stmtGalleryTrim.run(keep);
}

// ═════════════════════════════════════════════════════════════════════
//  Stats — diagnostic global (taille fichier, count + range par table)
// ═════════════════════════════════════════════════════════════════════

// Colonne temporelle utilisée pour MIN/MAX par table. `null` = pas de
// range affichable (table KV ou sans timestamp).
const TIME_COLUMNS = {
  messages:              'ts',
  profit_counts:         'date',
  profit_messages:       'ts',
  news_items:            'ts',
  gallery_items:         'ts',
  profit_filter_phrases: null,
  settings:              null,
};

// Retourne un résumé structuré pour la page /db-viewer :
//   { dbPath, fileSize, pageSize, pageCount, tables: [{name, rowCount, oldest, newest}] }
//
// Erreurs tolérées sur un range individuel (table absente / vide) → on
// renvoie oldest/newest à null plutôt que crasher le diagnostic global.
function getDbStats() {
  const fs = require('fs');
  let fileSize = 0;
  try { fileSize = fs.statSync(DB_PATH).size; } catch (_) {}

  // SQLite pragmas pour la structure interne (pages = taille réelle
  // incluant le WAL si actif).
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });

  const tables = Object.keys(TIME_COLUMNS).map(name => {
    let rowCount = 0;
    let oldest = null;
    let newest = null;
    try {
      rowCount = db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n;
      const col = TIME_COLUMNS[name];
      if (col && rowCount > 0) {
        const row = db.prepare(
          'SELECT MIN(' + col + ') AS a, MAX(' + col + ') AS b FROM ' + name
        ).get();
        oldest = row.a;
        newest = row.b;
      }
    } catch (e) {
      // Table absente ou autre erreur : on la signale via rowCount = -1.
      rowCount = -1;
    }
    return { name, rowCount, oldest, newest };
  });

  return {
    dbPath: DB_PATH,
    fileSize,
    pageSize,
    pageCount,
    tables,
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Backup snapshot — pour la commit git quotidienne
// ═════════════════════════════════════════════════════════════════════

// Crée un snapshot binaire cohérent de la DB à `destPath`. Utilise
// l'API native SQLite qui gère la concurrence : safe même si des INSERT
// arrivent pendant la copie (contrairement à un simple fs.copyFile qui
// pourrait attraper un état intermédiaire en mode WAL).
//
// Retourne une Promise. Le fichier résultat est une base SQLite
// autonome — ouvrable directement, sans fichiers .wal/.shm annexes.
function backupDb(destPath) {
  return db.backup(destPath);
}

module.exports = {
  db,
  DB_PATH,

  // messages
  insertMessage,
  insertMessagesBulk,
  getRecentMessages,
  getMessagesByDateKey,
  getMessagesByTsRange,
  getMessagesByTicker,
  countMessages,
  purgeFilteredMessagesWithoutData,

  // profits
  getProfitData,
  setProfitData,
  getProfitHistoryFrom,
  insertProfitMessage,
  insertProfitMessagesBulk,
  getProfitMessagesByDate,
  updateProfitMessageFeedback,
  getProfitFilters,
  addProfitFilterPhrase,
  removeProfitFilterPhrase,

  // settings (KV blob)
  getSetting,
  setSetting,

  // news items
  insertNewsItem,
  getRecentNewsItems,
  trimNewsItems,
  purgeNewsOlderThan,

  // gallery items
  insertGalleryItem,
  getRecentGalleryItems,
  trimGalleryItems,

  // backup
  backupDb,

  // diagnostic
  getDbStats,
};
