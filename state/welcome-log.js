// ─────────────────────────────────────────────────────────────────────
// state/welcome-log.js — Ring buffer for welcome listener events
// ─────────────────────────────────────────────────────────────────────
// 100 dernières entries gardées en mémoire, reset au restart du bot.
// Produits par discord/welcome-listener.js, consommés par
// routes/welcome-log.js + pages/welcome-log.js.
//
// Spec : docs/superpowers/specs/2026-05-14-welcome-log-dashboard-design.md
// ─────────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 100;
let buffer = [];

function appendWelcomeLog(entry) {
  buffer.push({ ...entry, ts: entry.ts || new Date().toISOString() });
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
}

function getWelcomeLog() {
  return buffer.slice();
}

// Test-only helper to isolate tests that share the singleton.
function _resetForTests() {
  buffer = [];
}

module.exports = { appendWelcomeLog, getWelcomeLog, MAX_ENTRIES, _resetForTests };
