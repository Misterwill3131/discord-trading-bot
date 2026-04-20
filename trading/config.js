// ─────────────────────────────────────────────────────────────────────
// trading/config.js — Params persistés du moteur de trading
// ─────────────────────────────────────────────────────────────────────
// Stocké dans la table `settings` sous la clé 'trading_config'. Pattern
// identique à utils/config-overrides.js : pas de cache, on relit à
// chaque appel pour que les edits via dashboard soient immédiats.
//
// Les credentials sensibles (Alpaca, IBKR host/port) restent dans
// process.env — jamais en DB.
// ─────────────────────────────────────────────────────────────────────

const { getSetting, setSetting } = require('../db/sqlite');

const SETTINGS_KEY = 'trading_config';

const DEFAULTS = Object.freeze({
  tradingEnabled: false,
  mode: 'paper',
  riskPerTradePct: 1.0,
  tolerancePct: 2.0,
  trailingStopPct: 7.0,
  maxConcurrentPositions: 5,
  limitOrderTimeoutMin: 30,
  authorWhitelist: [],
  tfMinutes: 5,
  // Stratégie de prise de profit :
  //   'trail-only' — pas d'ordre TP fixe. Sortie uniquement via trailing
  //                  stop (qui monte avec le prix) → on laisse courir
  //                  les gains. Défaut.
  //   'fixed'      — ordre limit TP au target_price du signal. Ferme
  //                  dès que le target est atteint, même si le prix
  //                  pourrait continuer à monter.
  takeProfitMode: 'trail-only',
});

function loadTradingConfig() {
  const stored = getSetting(SETTINGS_KEY, {}) || {};
  return Object.assign({}, DEFAULTS, stored);
}

function saveTradingConfig(partial) {
  const current = loadTradingConfig();
  const next = Object.assign({}, current, partial || {});
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = next[k];
  setSetting(SETTINGS_KEY, clean);
  return clean;
}

function getSecrets() {
  return {
    alpacaKeyId: process.env.ALPACA_KEY_ID || '',       // deprecated, kept for back-compat
    alpacaSecretKey: process.env.ALPACA_SECRET_KEY || '', // deprecated
    ibkrHost: process.env.IBKR_HOST || '127.0.0.1',
    // Port par défaut : 4004 (socat) si on tourne derrière l'image
    // gnzsnz/ib-gateway. En connexion directe TWS/IB Gateway locale,
    // utiliser 7497 (TWS paper), 7496 (TWS live), 4002 (IBGW paper),
    // 4001 (IBGW live). Sur Railway avec gnzsnz, c'est 4004 paper.
    ibkrPort: parseInt(process.env.IBKR_PORT || '4004', 10),
    ibkrClientId: parseInt(process.env.IBKR_CLIENT_ID || '1', 10),
  };
}

module.exports = {
  DEFAULTS,
  loadTradingConfig,
  saveTradingConfig,
  getSecrets,
  SETTINGS_KEY,
};
