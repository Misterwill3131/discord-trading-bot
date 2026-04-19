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
    alpacaKeyId: process.env.ALPACA_KEY_ID || '',
    alpacaSecretKey: process.env.ALPACA_SECRET_KEY || '',
    ibkrHost: process.env.IBKR_HOST || '127.0.0.1',
    ibkrPort: parseInt(process.env.IBKR_PORT || '4002', 10),
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
