// ─────────────────────────────────────────────────────────────────────
// profit/counter.js — Compteur journalier de profits + rapports Discord
// ─────────────────────────────────────────────────────────────────────
// Regroupe TOUTE la logique liée au compteur de profits (canal #profits) :
//
//   Parsing          countProfitEntries, hasProfitPattern, profitFiltersMatch
//   Persistence      loadProfitData, saveProfitData, loadProfitMessages,
//                    saveProfitMessages, saveProfitFilters
//   Business         addProfitMessage, getProfitRecord, buildProfitSummaryMsg
//   Daily summary    sendDailyProfitSummary (écrit dans #profits à 20:00 EDT)
//   State            profitFilters (mutable), mode silencieux, dernier
//                    message de résumé posté (pour !delete-report)
//
// Dépendances externes injectées via setters :
//   setDiscordClient(client)        — le client discord.js pour envoyer
//   setProfitsChannelId(id)         — l'ID du salon #profits
//
// Pourquoi un gros module : tous ces morceaux mutent/lisent profitFilters,
// partagent les constantes PROFIT_PATTERN/MILESTONES, et leur découpage
// artificiel créerait plus de friction que de clarté. ~320 lignes reste
// lisible d'un coup d'œil.
// ─────────────────────────────────────────────────────────────────────

const { todayKey } = require('../utils/persistence');
const dbMod = require('../db/sqlite');

// ── Constantes partagées ─────────────────────────────────────────────

// Reconnait "0.34-0.55", "1.20 to 4.00", ".97 -- 3.05", "18.60–19.90".
// Les points leading (.97) sont tolérés (notation trader informelle).
const PROFIT_PATTERN = /\.?\d+(?:\.\d+)?\s*(?:[-–]+|to)\s*\.?\d+(?:\.\d+)?/gi;

// Tronque les extraits stockés dans la DB pour éviter d'enregistrer
// des pavés entiers dans la table profit_messages.
const PROFIT_PHRASE_MAX = 120;

// ── Pure parsers ─────────────────────────────────────────────────────

// Strip les motifs numériques qui ressemblent à des ranges mais n'en
// sont pas : heures (14:30-15:45), dates (2026-04-20), numéros de
// téléphone US (1-800-555-1234), ZIP+4 (90210-1234). Sans ça, un post
// comme "trade entre 14:30-15:00" gonfle le compteur de +1 à +2.
function stripNonProfitNumerics(content) {
  return String(content || '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')      // times 14:30, 09:30:00
    .replace(/\b\d{4}-\d{1,2}(?:-\d{1,2})?\b/g, ' ')    // dates 2026-04 ou 2026-04-20
    .replace(/\b\d{1,3}-\d{3}-\d{4}\b/g, ' ')           // phone 1-800-555-1234
    .replace(/\b\d{5}-\d{4}\b/g, ' ');                  // ZIP+4 90210-1234
}

function countProfitEntries(content) {
  if (!content || !content.trim()) return 0;
  const matches = stripNonProfitNumerics(content).match(PROFIT_PATTERN);
  return matches ? matches.length : 0;
}

function hasProfitPattern(content) {
  return PROFIT_PATTERN.test(stripNonProfitNumerics(content));
}

function truncatePhrase(s) {
  const str = String(s || '').trim();
  return str.length > PROFIT_PHRASE_MAX ? str.slice(0, PROFIT_PHRASE_MAX) : str;
}

// Retourne true si `content` contient une des phrases de `list`
// (case-insensitive, substring). Utilisé pour les filtres learned.
function profitFiltersMatch(list, content) {
  if (!content || !list || !list.length) return false;
  const lower = String(content).toLowerCase();
  for (const phrase of list) {
    if (!phrase) continue;
    if (lower.includes(String(phrase).toLowerCase())) return true;
  }
  return false;
}

// ── Persistence (wrappers DB) ────────────────────────────────────────
// API identique à l'ancienne (load/save par dateKey) pour que les
// consommateurs (routes/profits, profit-listener, commands) n'aient
// pas à changer. Sous le capot : SQLite au lieu de JSON files.

function loadProfitData(dateKey)       { return dbMod.getProfitData(dateKey); }
function saveProfitData(dateKey, data) { dbMod.setProfitData(dateKey, data); }

function loadProfitMessages(dateKey)   { return dbMod.getProfitMessagesByDate(dateKey); }

// Insert direct d'un seul message en DB — O(1), évite de recharger
// toute la liste journalière. À utiliser dans le hot path du listener.
function appendProfitMessage(msg) { return dbMod.insertProfitMessage(msg); }

// saveProfitMessages : l'ancien caller faisait un dump complet de
// l'array modifié. On détecte les nouvelles entrées (celles dont l'id
// n'est pas encore en DB) via INSERT OR IGNORE, et on met à jour le
// feedback des anciennes si changé. Coût O(n) mais n reste petit.
function saveProfitMessages(dateKey, msgs) {
  if (!Array.isArray(msgs)) return;
  const existing = dbMod.getProfitMessagesByDate(dateKey);
  const existingById = {};
  existing.forEach(m => existingById[m.id] = m);

  for (const m of msgs) {
    const prev = existingById[m.id];
    if (!prev) {
      // Nouveau message : insert.
      dbMod.insertProfitMessage(m);
    } else if (prev.feedback !== m.feedback) {
      // Message existant : on n'update que le feedback (le reste est immutable).
      dbMod.updateProfitMessageFeedback(m.id, m.feedback);
    }
  }
}

// saveProfitFilters : écrit l'état courant de l'objet `profitFilters`
// en DB. Stratégie delete-all + re-insert dans une transaction — simple,
// idempotent, et le volume reste trivial (quelques dizaines de phrases).
function saveProfitFilters() {
  const tx = dbMod.db.transaction(() => {
    dbMod.db.prepare('DELETE FROM profit_filter_phrases').run();
    for (const p of profitFilters.blocked || []) dbMod.addProfitFilterPhrase(p, 'blocked');
    for (const p of profitFilters.allowed || []) dbMod.addProfitFilterPhrase(p, 'allowed');
  });
  try {
    tx();
  } catch (e) {
    console.error('[profit-filters] Failed to save:', e.message);
  }
}

// ── État mutable ─────────────────────────────────────────────────────

// Singleton — référence stable, les consommateurs mutent profitFilters.blocked
// / profitFilters.allowed puis appellent saveProfitFilters().
const profitFilters = dbMod.getProfitFilters();

// Mode "bot silencieux" dans #profits : désactive l'envoi automatique du
// daily summary. Utile pour débug ou pendant la config.
let profitsBotSilent = false;

// Dernier résumé journalier posté — permet à la commande !delete-report
// de retrouver le message exact même si d'autres messages sont postés après.
let lastProfitSummaryMessageId = null;
let lastProfitSummaryDate = null;

// Dépendances Discord injectées par index.js au démarrage.
let _client = null;
let _profitsChannelId = null;

// ── Injection des dépendances Discord ───────────────────────────────

function setDiscordClient(client) { _client = client; }
function setProfitsChannelId(id) { _profitsChannelId = id; }

// ── Getters/setters pour les routes ────────────────────────────────

function getBotSilent() { return profitsBotSilent; }
function setBotSilent(val) { profitsBotSilent = !!val; }

function getLastSummaryMessageId() { return lastProfitSummaryMessageId; }
function clearLastSummaryMessageId() { lastProfitSummaryMessageId = null; }

function getLastSummaryDate() { return lastProfitSummaryDate; }
function setLastSummaryDate(d) { lastProfitSummaryDate = d; }

// ── Business logic ───────────────────────────────────────────────────

// Incrémente le compteur du jour en parsant `content` pour y trouver
// des ranges de prix. Retourne le nouveau total. Mutation silencieuse —
// l'appelant décide s'il poste quelque chose sur Discord.
async function addProfitMessage(content, forceCount) {
  const dateKey = todayKey();
  const data = loadProfitData(dateKey);
  const entries = forceCount !== undefined ? forceCount : countProfitEntries(content);
  data.count = (data.count || 0) + entries;
  saveProfitData(dateKey, data);
  console.log('[profits] +' + entries + ' profit(s) — total: ' + data.count);
  return data.count;
}

// Parcourt les 90 derniers jours pour trouver le meilleur total. Valeur
// plancher 109 = record historique avant l'introduction du tracking (on
// ne veut pas afficher un "record" ridicule pendant les premiers jours).
function getProfitRecord() {
  let recordCount = 109;
  let recordDate = null;
  for (let i = 0; i < 90; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    // Fuseau NY pour rester cohérent avec todayKey() / loadProfitData /
    // /api/profits-history / buildProfitSummaryMsg. Sans ça, entre 19h et
    // 23h59 NY (= 00h-04h UTC le lendemain) on lirait une date inexistante.
    const dateKey = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const data = loadProfitData(dateKey);
    if ((data.count || 0) > recordCount) {
      recordCount = data.count;
      recordDate = dateKey;
    }
  }
  return { count: recordCount, date: recordDate };
}

// Construit le texte Markdown du rapport journalier : total du jour +
// comparaison hier + chart ASCII des 7 derniers jours ouvrés + record all-time.
function buildProfitSummaryMsg() {
  const dateKey = todayKey();
  const data = loadProfitData(dateKey);
  const todayCount = data.count || 0;
  const record = getProfitRecord();

  // Chart 7 jours ouvrés (skip samedi/dimanche — marchés fermés).
  const days7 = [];
  const cursor = new Date();
  while (days7.length < 7) {
    const dk = cursor.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const [y, m, day] = dk.split('-').map(Number);
    const dow = new Date(y, m - 1, day).getDay(); // 0=dimanche, 6=samedi
    if (dow !== 0 && dow !== 6) {
      days7.unshift({ date: dk, count: loadProfitData(dk).count || 0 });
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  const max7 = Math.max.apply(null, days7.map(d => d.count)) || 1;
  const chart = days7.map(d => {
    const bars = Math.round((d.count / max7) * 8);
    const bar = '█'.repeat(bars) + '░'.repeat(8 - bars);
    const label = d.date.slice(5); // MM-DD
    const isToday = d.date === dateKey;
    return (isToday ? '**' : '') + '`' + label + '` ' + bar + ' ' + d.count + (isToday ? ' ← today**' : '');
  }).join('\n');

  const isNewRecord = todayCount > 0 && todayCount >= record.count && dateKey === record.date;
  const recordLine = isNewRecord
    ? '\n\n🏆 **NEW ALL-TIME RECORD! ' + todayCount + ' profits!** 🏆'
    : '\n\n📊 All-time record: **' + record.count + '** profits (' + record.date + ')';

  // Comparaison hier (cumule toutes les dates ouvrées, incluant si hier = weekend
  // alors on lit le count du samedi/dimanche — en pratique généralement 0).
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayCount = loadProfitData(yesterday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })).count || 0;
  let comparison = '';
  if (yesterdayCount > 0) {
    const diff = todayCount - yesterdayCount;
    if (diff > 0) comparison = ' (📈 +' + diff + ' vs yesterday)';
    else if (diff < 0) comparison = ' (📉 ' + diff + ' vs yesterday)';
    else comparison = ' (➡️ same as yesterday)';
  }

  return '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
    + '📊 **Daily Profit Report**\n'
    + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
    + '🔥 **' + todayCount + '** profits posted today' + comparison + '\n\n'
    + '**Last 7 days:**\n' + chart
    + recordLine + '\n\n'
    + '-# Keep posting your wins! Every profit counts 💪';
}

// Envoie le rapport journalier dans #profits. No-op si :
//   - PROFITS_CHANNEL_ID n'est pas configuré
//   - Le client Discord n'est pas injecté
//   - Le mode silencieux est activé (toggle via l'API)
async function sendDailyProfitSummary() {
  if (!_profitsChannelId || !_client || profitsBotSilent) return;
  try {
    const ch = _client.channels.cache.get(_profitsChannelId);
    if (!ch || !ch.send) return;
    const sent = await ch.send(buildProfitSummaryMsg());
    lastProfitSummaryMessageId = sent.id;
    console.log('[profits] Daily summary posted');
  } catch (e) {
    console.error('[profits] Summary error:', e.message);
  }
}

module.exports = {
  // Constantes
  PROFIT_PATTERN,
  PROFIT_PHRASE_MAX,

  // Parsers
  countProfitEntries,
  hasProfitPattern,
  truncatePhrase,
  profitFiltersMatch,

  // Persistence
  loadProfitData,
  saveProfitData,
  loadProfitMessages,
  appendProfitMessage,
  saveProfitMessages,
  saveProfitFilters,

  // State (mutable reference)
  profitFilters,

  // Business logic
  addProfitMessage,
  getProfitRecord,
  buildProfitSummaryMsg,
  sendDailyProfitSummary,

  // Discord injection
  setDiscordClient,
  setProfitsChannelId,

  // Accessors
  getBotSilent,
  setBotSilent,
  getLastSummaryMessageId,
  clearLastSummaryMessageId,
  getLastSummaryDate,
  setLastSummaryDate,
};
