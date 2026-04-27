// ─────────────────────────────────────────────────────────────────────
// saas/licenses.js — API haut niveau pour gérer les licences clients
// ─────────────────────────────────────────────────────────────────────
// Wrap les helpers brutes de db/sqlite.js avec une logique métier :
//   - validation (statut autorisé, expiration cohérente)
//   - audit (chaque action écrit dans admin_actions)
//   - état dérivé (isActive, isExpired)
//   - claim flow Launchpass (KV pending_launchpass_subs → license active)
//
// PAS de dépendance Discord ici — ce module est testable sans bot.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const db = require('../db/sqlite');

const STATUSES = ['pending', 'active', 'suspended', 'expired', 'cancelled'];
const PENDING_KV_KEY = 'pending_launchpass_subs';

// True si la licence est utilisable maintenant (status='active' et non
// expirée). Null/undefined → false. Tolère expires_at NULL (lifetime).
function isActive(license) {
  if (!license) return false;
  if (license.status !== 'active') return false;
  if (!license.expires_at) return true;
  return new Date(license.expires_at).getTime() > Date.now();
}

// True si expires_at est dans le passé (peu importe le status — utile
// pour repérer les licences à passer en 'expired' au tick périodique).
function isExpired(license) {
  if (!license || !license.expires_at) return false;
  return new Date(license.expires_at).getTime() <= Date.now();
}

// ── CRUD haut niveau ────────────────────────────────────────────────

// Crée OU met à jour une licence. Audit l'action si `admin` fourni.
function addLicense({ guild_id, plan, expires_at, status, guild_name, notes, admin }) {
  if (!guild_id) throw new Error('guild_id required');
  if (status && !STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  db.licenseUpsert({
    guild_id, plan, expires_at,
    status: status || 'active',
    guild_name, notes,
  });
  if (admin) {
    db.adminActionInsert({ admin, action: 'add', guild_id, payload: { plan, expires_at, status } });
  }
  return db.licenseGet(guild_id);
}

function suspend(guildId, { admin, reason } = {}) {
  if (!guildId) throw new Error('guildId required');
  db.licenseSetStatus(guildId, 'suspended');
  if (admin) {
    db.adminActionInsert({ admin, action: 'suspend', guild_id: guildId, payload: { reason } });
  }
}

function resume(guildId, { admin } = {}) {
  if (!guildId) throw new Error('guildId required');
  db.licenseSetStatus(guildId, 'active');
  if (admin) {
    db.adminActionInsert({ admin, action: 'resume', guild_id: guildId });
  }
}

// Marque une licence expirée. Pas la même chose que cancel (cancel = action
// volontaire client/admin, expired = passé la date sans renouvellement).
function expire(guildId) {
  db.licenseSetStatus(guildId, 'expired');
  db.adminActionInsert({ admin: 'system', action: 'expire', guild_id: guildId });
}

// Annule (paiement annulé / refund). Conserve la ligne pour audit.
function cancel(guildId, { admin, reason } = {}) {
  db.licenseSetStatus(guildId, 'cancelled');
  db.adminActionInsert({ admin: admin || 'system', action: 'cancel', guild_id: guildId, payload: { reason } });
}

function setTargetChannel(guildId, channelId, { admin } = {}) {
  db.licenseSetTargetChannel(guildId, channelId);
  if (admin) {
    db.adminActionInsert({ admin, action: 'set-target-channel', guild_id: guildId, payload: { channelId } });
  }
}

// Renouvelle une licence (Launchpass renewed event). expiresAtIso ISO string.
function renew(guildId, expiresAtIso) {
  db.licenseSetExpires(guildId, expiresAtIso, 'active');
  db.adminActionInsert({ admin: 'system', action: 'renew', guild_id: guildId, payload: { expires_at: expiresAtIso } });
}

function get(guildId) {
  return db.licenseGet(guildId);
}

function list(status) {
  return db.licenseList(status);
}

// Toutes les licences ACTIVES et NON expirées, avec target_channel_id défini.
// C'est la liste à parcourir pour broadcast un signal.
function listReadyForRelay() {
  return db.licenseList('active').filter(l => l.target_channel_id && !isExpired(l));
}

function findByLaunchpassSub(subId) {
  return db.licenseFindByLaunchpassSub(subId);
}

// ── Claim code flow (Launchpass → license active) ────────────────────

// Génère un code court non-ambigu (8 chars, pas de 0/O/1/I/l).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateClaimCode() {
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

// Lit la map { code: { subId, email, plan, created_at } } depuis settings.
function _readPendingSubs() {
  return db.getSetting(PENDING_KV_KEY, {}) || {};
}
function _writePendingSubs(map) {
  db.setSetting(PENDING_KV_KEY, map);
}

// Stocke un sub Launchpass en attente. Retourne le claim_code généré.
// `subId`, `email`, `plan`, `expires_at_iso` (date à fixer une fois
// la licence claimée — calculée par le caller depuis le plan).
function registerPendingSub({ subId, email, plan, expires_at }) {
  if (!subId) throw new Error('subId required');
  const map = _readPendingSubs();
  // Si subId déjà présent, on retourne le code existant (idempotent).
  for (const [code, entry] of Object.entries(map)) {
    if (entry && entry.subId === subId) return code;
  }
  const code = generateClaimCode();
  map[code] = {
    subId,
    email: email || null,
    plan: plan || 'standard',
    expires_at: expires_at || null,
    created_at: new Date().toISOString(),
  };
  _writePendingSubs(map);
  return code;
}

// Consomme un claim_code et active la licence pour ce guild_id.
// Retourne la licence créée, ou null si code invalide/déjà utilisé.
function claimWithCode(code, { guild_id, guild_name }) {
  if (!code || !guild_id) return null;
  const map = _readPendingSubs();
  const entry = map[code];
  if (!entry) return null;
  // Active la licence
  db.licenseUpsert({
    guild_id,
    status: 'active',
    plan: entry.plan,
    expires_at: entry.expires_at,
    launchpass_subscription_id: entry.subId,
    launchpass_customer_email: entry.email,
    guild_name,
  });
  // Consomme le code (suppression atomique)
  delete map[code];
  _writePendingSubs(map);
  db.adminActionInsert({
    admin: 'system',
    action: 'claim',
    guild_id,
    payload: { code, subId: entry.subId, email: entry.email },
  });
  return db.licenseGet(guild_id);
}

// Liste les claim codes en attente — utile pour debug admin (/saas pending).
function listPendingSubs() {
  return _readPendingSubs();
}

module.exports = {
  // état
  isActive,
  isExpired,
  STATUSES,
  PENDING_KV_KEY,
  // CRUD
  addLicense,
  suspend,
  resume,
  expire,
  cancel,
  setTargetChannel,
  renew,
  get,
  list,
  listReadyForRelay,
  findByLaunchpassSub,
  // claim flow
  generateClaimCode,
  registerPendingSub,
  claimWithCode,
  listPendingSubs,
};
