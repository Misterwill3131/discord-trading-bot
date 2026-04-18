// ─────────────────────────────────────────────────────────────────────
// scripts/migrate-profits.js — Import profits JSON → SQLite
// ─────────────────────────────────────────────────────────────────────
// Migre 3 familles de fichiers :
//
//   profits-YYYY-MM-DD.json         → table profit_counts
//   profit-messages-YYYY-MM-DD.json → table profit_messages
//   profit-filters.json             → table profit_filter_phrases
//
// Idempotent : profit_counts en UPSERT (overwrite), les 2 autres en
// INSERT OR IGNORE (déduplique par id / par (phrase, kind)).
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../utils/persistence');
const {
  setProfitData,
  insertProfitMessagesBulk,
  addProfitFilterPhrase,
  DB_PATH,
} = require('../db/sqlite');

console.log('[migrate-profits] DATA_DIR:', DATA_DIR);
console.log('[migrate-profits] DB path :', DB_PATH);

// ── 1. profits-*.json → profit_counts ────────────────────────────────
let countFiles = [];
try {
  countFiles = fs.readdirSync(DATA_DIR)
    .filter(f => /^profits-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
} catch (e) {
  console.error('[migrate-profits] readdir error:', e.message);
  process.exit(1);
}

let countsMigrated = 0;
for (const file of countFiles) {
  const dateKey = file.replace(/^profits-/, '').replace(/\.json$/, '');
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    setProfitData(dateKey, {
      count: data.count | 0,
      milestones: Array.isArray(data.milestones) ? data.milestones : [],
    });
    countsMigrated++;
    console.log('[migrate-profits] ' + file + ' → count=' + (data.count || 0));
  } catch (e) {
    console.error('[migrate-profits]', file, 'error:', e.message);
  }
}

// ── 2. profit-messages-*.json → profit_messages ──────────────────────
let msgFiles = [];
try {
  msgFiles = fs.readdirSync(DATA_DIR)
    .filter(f => /^profit-messages-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
} catch (e) { /* already reported above if it was an error */ }

let totalMsgsRead = 0;
let totalMsgsInserted = 0;
for (const file of msgFiles) {
  try {
    const msgs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    if (!Array.isArray(msgs)) continue;
    totalMsgsRead += msgs.length;
    const inserted = insertProfitMessagesBulk(msgs);
    totalMsgsInserted += inserted;
    console.log('[migrate-profits] ' + file + ' : ' + msgs.length + ' lus, ' + inserted + ' insérés');
  } catch (e) {
    console.error('[migrate-profits]', file, 'error:', e.message);
  }
}

// ── 3. profit-filters.json → profit_filter_phrases ───────────────────
const filtersPath = path.join(DATA_DIR, 'profit-filters.json');
let filtersMigrated = 0;
if (fs.existsSync(filtersPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(filtersPath, 'utf8'));
    for (const phrase of data.blocked || []) {
      if (addProfitFilterPhrase(phrase, 'blocked')) filtersMigrated++;
    }
    for (const phrase of data.allowed || []) {
      if (addProfitFilterPhrase(phrase, 'allowed')) filtersMigrated++;
    }
    console.log('[migrate-profits] profit-filters.json : ' + filtersMigrated + ' phrases insérées');
  } catch (e) {
    console.error('[migrate-profits] profit-filters.json error:', e.message);
  }
} else {
  console.log('[migrate-profits] profit-filters.json absent — skip');
}

console.log('\n[migrate-profits] Résumé :');
console.log('  profit_counts          : ' + countsMigrated + ' jours');
console.log('  profit_messages        : ' + totalMsgsInserted + ' / ' + totalMsgsRead);
console.log('  profit_filter_phrases  : ' + filtersMigrated + ' phrases');
