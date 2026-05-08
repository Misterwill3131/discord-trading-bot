// ─────────────────────────────────────────────────────────────────────
// utils/dates.js — Utilitaires de date avec gestion du fuseau horaire
// ─────────────────────────────────────────────────────────────────────
// Toutes les dates business du bot sont normalisées sur America/New_York
// (timezone du marché US). On utilise Intl.DateTimeFormat avec en-CA
// pour avoir le format ISO YYYY-MM-DD natif.
// ─────────────────────────────────────────────────────────────────────

// Retourne YYYY-MM-DD pour une Date donnée, exprimée en TZ America/New_York.
// Utilisé pour les clés journalières (daily_recaps.date, etc.) et pour
// tout matching "même journée trading" indépendamment du fuseau horaire
// du serveur (Railway = UTC).
function formatDateET(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = { formatDateET };
