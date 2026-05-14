// ─────────────────────────────────────────────────────────────────────
// discord/analyst-watchlist.js — Listener event-driven
// ─────────────────────────────────────────────────────────────────────
// Écoute le canal TRADING_CHANNEL et :
//  1. Stocke TOUS les messages (analystes + bots) dans tracked_messages
//     pour audit.
//  2. Si non-bot ET ticker détecté → seed analyst_watchlist avec le prix
//     mentionné dans le message (ou le prix marché FMP en fallback).
//
// La 1ère mention d'un ticker gagne (INSERT OR IGNORE sur PK ticker).
// Le module milestone-checker.js consomme cette table via le cron 30 min.
// ─────────────────────────────────────────────────────────────────────

// Regex prix : $XX, $XX.XX, $X,XXX.XX (avec virgules de milliers).
// Prend le PREMIER match — convention "prix d'entrée" si plage donnée.
const PRICE_REGEX = /\$\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,4})?)(?!\d)/;

function extractPrice(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = text.match(PRICE_REGEX);
  if (!m) return null;
  const price = parseFloat(m[1].replace(/,/g, ''));
  // Sanity range : 0.01 < prix < 100,000.
  // Filtre les faux positifs (codes ZIP, années en $, prix BTC pris pour stock).
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000) return null;
  return price;
}

module.exports = {
  extractPrice,
};
