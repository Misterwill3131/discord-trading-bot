// ─────────────────────────────────────────────────────────────────────
// routes/saas-admin.js — Routes HTTP pour le SaaS relais
// ─────────────────────────────────────────────────────────────────────
//   POST /webhooks/launchpass        — Webhook Launchpass (HMAC-verified, raw body)
//   POST /webhooks/stripe            — Webhook Stripe fallback (raw body)
//   GET  /api/saas/licenses          — Liste licences (auth requise)
//   GET  /api/saas/licenses/:guildId — Détail licence
//   PUT  /api/saas/licenses/:guildId — Crée/met à jour
//   DELETE /api/saas/licenses/:guildId — Supprime
//   POST /api/saas/licenses/:guildId/suspend — Suspend
//   POST /api/saas/licenses/:guildId/resume  — Reprend
//   GET  /api/saas/relay-log/:guildId — Historique relais
//   GET  /api/saas/pending           — Claim codes en attente
//
// Le webhook Launchpass (Phase 2) reçoit un body raw — il faut donc
// `express.raw({ type: 'application/json' })` UNIQUEMENT sur cette route
// pour que `crypto` puisse re-hasher l'octet-pour-octet du payload.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const express = require('express');
const db = require('../db/sqlite');
const licenses = require('../saas/licenses');

// HMAC SHA-256 timing-safe compare. Tolère un signature header au format
// "sha256=hex" ou juste "hex". Throw jamais — retourne false sur tout
// problème (header absent, longueurs différentes, secret manquant).
function verifyHmacSig(rawBody, headerValue, secret) {
  if (!secret || !headerValue || !rawBody) return false;
  try {
    const provided = String(headerValue).replace(/^sha256=/i, '').trim();
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

// Calcule expires_at depuis un plan + créé_at. Phase 1 simpliste :
// 30 jours. À étendre quand on aura plusieurs paliers tarifaires.
function computeExpiresAt(plan, fromIso) {
  const start = fromIso ? new Date(fromIso) : new Date();
  // TODO Phase 4 : per-plan duration map
  const days = 30;
  const d = new Date(start.getTime() + days * 86400 * 1000);
  return d.toISOString();
}

// ── Launchpass webhook ──────────────────────────────────────────────

function handleLaunchpassEvent(event, body) {
  const type = event.type || event.event || event.action;
  const data = event.data || event.subscription || event;
  const subId = data.subscription_id || data.id || data.sub_id;
  if (!type || !subId) {
    return { ok: false, reason: 'missing-type-or-sub-id' };
  }

  if (type === 'subscription_created' || type === 'subscription.created') {
    // Génère un claim_code et stocke en pending. L'email est envoyé
    // par le caller (notifications/email.js) — voir TODO ci-dessous.
    const code = licenses.registerPendingSub({
      subId,
      email: data.email || data.customer_email || null,
      plan:  data.plan || data.plan_name || 'standard',
      expires_at: computeExpiresAt(data.plan || 'standard', data.created_at),
    });
    db.adminActionInsert({
      admin: 'launchpass-webhook',
      action: 'webhook-event',
      guild_id: null,
      payload: { type, subId, claim_code: code, email: data.email },
    });
    // TODO Phase 2: envoyer l'email avec le claim_code via notifications/email.js
    return { ok: true, action: 'pending-claim-created', claim_code: code };
  }

  if (type === 'subscription_renewed' || type === 'subscription.renewed') {
    const lic = licenses.findByLaunchpassSub(subId);
    if (!lic) return { ok: false, reason: 'sub-not-mapped-to-license' };
    licenses.renew(lic.guild_id, computeExpiresAt(lic.plan, data.renewed_at));
    return { ok: true, action: 'renewed' };
  }

  if (type === 'subscription_cancelled' || type === 'subscription_expired'
      || type === 'subscription.cancelled' || type === 'subscription.expired') {
    const lic = licenses.findByLaunchpassSub(subId);
    if (!lic) return { ok: false, reason: 'sub-not-mapped-to-license' };
    licenses.cancel(lic.guild_id, { admin: 'launchpass-webhook', reason: type });
    return { ok: true, action: 'cancelled' };
  }

  return { ok: false, reason: `unhandled-type-${type}` };
}

// ── Routes ──────────────────────────────────────────────────────────

function registerSaasAdminRoutes(app, requireAuth) {
  // -- Webhook Launchpass : raw body MANDATORY pour HMAC. --
  app.post('/webhooks/launchpass',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      const secret = process.env.LAUNCHPASS_WEBHOOK_SECRET;
      const sig = req.headers['x-launchpass-signature'] || req.headers['x-hub-signature-256'];
      if (!verifyHmacSig(req.body, sig, secret)) {
        return res.status(401).json({ ok: false, error: 'bad-signature' });
      }
      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'invalid-json' });
      }
      const result = handleLaunchpassEvent(payload, req.body);
      const code = result.ok ? 200 : 422;
      return res.status(code).json(result);
    }
  );

  // -- Webhook Stripe (fallback). Garde la même signature pattern : raw body + HMAC. --
  app.post('/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      const sig = req.headers['stripe-signature'];
      if (!secret) return res.status(503).json({ ok: false, error: 'stripe-not-configured' });
      // Stripe utilise un format `t=...,v1=...` — pour la vraie intégration,
      // utiliser `stripe.webhooks.constructEvent(req.body, sig, secret)` (lib `stripe`).
      // Pour l'instant on rejette explicitement avec un TODO pour activer Phase 2 fallback.
      return res.status(501).json({ ok: false, error: 'stripe-not-implemented-yet', sig: !!sig });
    }
  );

  // -- API admin (auth requise) --

  app.get('/api/saas/licenses', requireAuth, (req, res) => {
    const status = req.query.status || null;
    const all = licenses.list(status);
    res.json({ ok: true, count: all.length, licenses: all });
  });

  app.get('/api/saas/licenses/:guildId', requireAuth, (req, res) => {
    const lic = licenses.get(req.params.guildId);
    if (!lic) return res.status(404).json({ ok: false, error: 'not-found' });
    const recent = db.relayLogRecent(req.params.guildId, 20);
    res.json({ ok: true, license: lic, recent_relays: recent });
  });

  app.put('/api/saas/licenses/:guildId', requireAuth, (req, res) => {
    const { plan, expires_at, status, guild_name, notes } = req.body || {};
    try {
      const lic = licenses.addLicense({
        guild_id: req.params.guildId,
        plan, expires_at, status, guild_name, notes,
        admin: req.user || 'http-admin',
      });
      res.json({ ok: true, license: lic });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/saas/licenses/:guildId', requireAuth, (req, res) => {
    db.licenseDelete(req.params.guildId);
    db.adminActionInsert({
      admin: req.user || 'http-admin', action: 'delete', guild_id: req.params.guildId,
    });
    res.json({ ok: true });
  });

  app.post('/api/saas/licenses/:guildId/suspend', requireAuth, (req, res) => {
    licenses.suspend(req.params.guildId, {
      admin: req.user || 'http-admin',
      reason: req.body?.reason || null,
    });
    res.json({ ok: true });
  });

  app.post('/api/saas/licenses/:guildId/resume', requireAuth, (req, res) => {
    licenses.resume(req.params.guildId, { admin: req.user || 'http-admin' });
    res.json({ ok: true });
  });

  app.get('/api/saas/relay-log/:guildId', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const items = db.relayLogRecent(req.params.guildId, limit);
    res.json({ ok: true, count: items.length, items });
  });

  app.get('/api/saas/pending', requireAuth, (req, res) => {
    const map = licenses.listPendingSubs();
    res.json({ ok: true, count: Object.keys(map).length, pending: map });
  });
}

module.exports = {
  registerSaasAdminRoutes,
  // exposé pour tests
  verifyHmacSig,
  handleLaunchpassEvent,
  computeExpiresAt,
};
