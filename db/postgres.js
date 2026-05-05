// ─────────────────────────────────────────────────────────────────────
// db/postgres.js — Connexion à la DB Postgres partagée avec le site
// ─────────────────────────────────────────────────────────────────────
// Le site temple-of-boom-site (Vercel + Neon Postgres) est la source de
// vérité pour `customers` (incluant claim_code) et `licenses`. Le bot lit
// + écrit ici quand il consume un claim_code via /connect.
//
// Si DATABASE_URL n'est pas set, ce module exporte des stubs no-op qui
// retournent null/false → le bot fall-back sur le flow SQLite legacy.
// ─────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || '';
const isEnabled = !!DATABASE_URL;

let pool = null;

function getPool() {
  if (!isEnabled) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Neon requiert SSL. Le connectionString contient déjà sslmode=require
      // mais on garde ssl: { rejectUnauthorized: false } en fallback safety.
      ssl: DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false,
    });
    pool.on('error', (err) => {
      console.error('[postgres] pool error:', err.message);
    });
  }
  return pool;
}

// ── Helpers utilisés par /connect ─────────────────────────────────────

// Lookup customer par claim_code. Returns row ou null.
async function findCustomerByClaimCode(code) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      'SELECT id, email, plan_id, claim_code, guild_id, stripe_customer_id FROM customers WHERE claim_code = $1 LIMIT 1',
      [code],
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error('[postgres] findCustomerByClaimCode failed:', err.message);
    return null;
  }
}

// Atomique : lie le customer.guild_id, clear claim_code, insère/update license.
// Retourne true si OK, false si erreur.
async function consumeClaimCodeAndCreateLicense({ customerId, guildId, guildName, plan }) {
  const p = getPool();
  if (!p) return false;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE customers SET guild_id = $1, claim_code = NULL WHERE id = $2',
      [guildId, customerId],
    );
    await client.query(
      `INSERT INTO licenses (guild_id, status, plan, guild_name)
       VALUES ($1, 'active', $2, $3)
       ON CONFLICT (guild_id) DO UPDATE
       SET status = 'active', plan = EXCLUDED.plan, guild_name = EXCLUDED.guild_name`,
      [guildId, plan || 'standard', guildName || null],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[postgres] consumeClaimCodeAndCreateLicense failed:', err.message);
    return false;
  } finally {
    client.release();
  }
}

// Pour la vérif relay : status active sur le guild_id ?
async function getLicenseByGuildId(guildId) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      'SELECT guild_id, status, plan, expires_at FROM licenses WHERE guild_id = $1 LIMIT 1',
      [guildId],
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error('[postgres] getLicenseByGuildId failed:', err.message);
    return null;
  }
}

// ── Signal relay log (miroir Postgres du SQLite relay_log) ───────────
// Le site lit ce table pour afficher les stats + recent feed sur le
// dashboard customer (/account → SignalStatsCard + RecentSignalsCard).
// Schema défini côté site (lib/db/schema.ts). Migration 0005 sur Neon.
//
// Insert best-effort : si Postgres down ou table inexistante, on log et
// on continue (le SQLite relay_log local reste l'audit primaire pour le
// bot).
// type values : 'signal' (default), 'passthrough', 'ipo', 'market_alert'.
// Schema migration 0006 a ajouté type + content sur signal_relays.
async function insertSignalRelay({
  guildId,
  type,
  ticker,
  side,
  entryPrice,
  targetPrice,
  stopPrice,
  content,
  sourceMessageId,
  relayedMessageId,
  status,
}) {
  const p = getPool();
  if (!p || !guildId) return;
  try {
    await p.query(
      `INSERT INTO signal_relays
        (guild_id, type, ticker, side, entry_price, target_price, stop_price,
         content, source_message_id, relayed_message_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        guildId,
        type || 'signal',
        ticker || null,
        side || null,
        entryPrice != null ? String(entryPrice) : null,
        targetPrice != null ? String(targetPrice) : null,
        stopPrice != null ? String(stopPrice) : null,
        content || null,
        sourceMessageId || null,
        relayedMessageId || null,
        status || 'ok',
      ],
    );
  } catch (err) {
    console.error('[postgres] insertSignalRelay failed:', err.message);
  }
}

// Permet de fermer proprement la pool au shutdown du bot.
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  isEnabled,
  findCustomerByClaimCode,
  consumeClaimCodeAndCreateLicense,
  getLicenseByGuildId,
  insertSignalRelay,
  close,
};
