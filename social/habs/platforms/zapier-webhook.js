// ─────────────────────────────────────────────────────────────────────
// social/habs/platforms/zapier-webhook.js — Zapier Catch Hook adapter
// ─────────────────────────────────────────────────────────────────────
// Le seul "platform adapter" v0.1 de Habs. POST un payload JSON vers
// l'URL Zapier Catch Hook configurée. Zapier exécute ensuite le Zap
// configuré côté Zapier UI (typiquement Stocktwits Create Post action).
//
// Retour standard d'un adapter Habs :
//   { ok: true, postUrl?: string }            — succès
//   { ok: false, retriable: boolean, error }  — échec
//
// Cf docs/superpowers/specs/2026-05-18-habs-design.md section 4-5.
// ─────────────────────────────────────────────────────────────────────

const nodeFetch = require('node-fetch');

// 408 = request timeout, 429 = rate limit, 5xx = serveur transient.
// Tout le reste 4xx = client error permanent (mauvais payload, URL invalide).
function isRetriable(status) {
  if (!Number.isFinite(status)) return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

async function publish({ webhookUrl, payload, fetchImpl }) {
  const fetch = fetchImpl || nodeFetch;
  if (!webhookUrl) {
    return { ok: false, retriable: false, error: 'no webhook URL' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      let postUrl = null;
      try {
        const text = await res.text();
        const json = JSON.parse(text);
        if (json && typeof json.id === 'string') postUrl = json.id;
      } catch {
        // Zapier doesn't always return JSON; ignore parse failures.
      }
      return { ok: true, postUrl };
    }
    let body = '';
    try { body = await res.text(); } catch {}
    return {
      ok: false,
      retriable: isRetriable(res.status),
      error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    // Network-level errors (ECONNRESET, DNS, etc.) → retriable
    return { ok: false, retriable: true, error: String(err && err.message || err) };
  }
}

module.exports = { publish, isRetriable };
