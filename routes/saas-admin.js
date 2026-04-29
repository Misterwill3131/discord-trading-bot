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
const saasEmail = require('../saas/email');
const brand = require('../saas/brand');

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

// ── Stripe webhook event handler ────────────────────────────────────

// Construit l'URL d'invitation OAuth du bot SaaS. Identique à
// routes/public.js mais on n'importe pas pour éviter les cycles.
function buildBotInviteUrl() {
  const clientId = process.env.SAAS_BOT_CLIENT_ID || '';
  if (!clientId) return '#';
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=2147485696&scope=bot+applications.commands`;
}

// Construit la base URL publique pour les liens dans les emails.
function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://templeofboom.up.railway.app');
}

async function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const subscriptionId = session.subscription;
    const stripeCustomerId = session.customer;
    const planId = session.metadata?.plan_id || 'standard';
    const interval = session.metadata?.interval || 'monthly';

    if (!email) return { action: 'skipped', reason: 'no-email-on-session' };
    if (!subscriptionId) return { action: 'skipped', reason: 'no-subscription' };

    // Calcule l'expiration depuis l'intervalle.
    const expiresAt = (() => {
      const days = interval === 'annual' ? 365 : 30;
      return new Date(Date.now() + days * 86400 * 1000).toISOString();
    })();

    // Génère un claim_code lié à cette subscription.
    const code = licenses.registerPendingSub({
      subId: subscriptionId,
      email,
      plan: planId,
      expires_at: expiresAt,
    });

    // Lie le customer Stripe (utile plus tard pour /account/billing).
    const customer = db.customerUpsertByEmail(email);
    if (stripeCustomerId) {
      db.customerSetStripeId(customer.id, stripeCustomerId);
    }

    // Envoie l'email de bienvenue avec le claim_code.
    const baseUrl = getPublicBaseUrl();
    const helpUrl = `${baseUrl}/connect-help?code=${encodeURIComponent(code)}`;
    const inviteUrl = buildBotInviteUrl();
    const planName = planId.charAt(0).toUpperCase() + planId.slice(1);

    const emailResult = await saasEmail.sendWelcomeEmail({
      to: email,
      brandName: brand.BRAND_NAME,
      claimCode: code,
      inviteUrl,
      helpUrl,
      planName,
    });

    db.adminActionInsert({
      admin: 'stripe-webhook',
      action: 'subscription-created',
      guild_id: null,
      payload: {
        event_id: event.id,
        subId: subscriptionId,
        email,
        plan: planId,
        interval,
        claim_code: code,
        email_sent: emailResult.ok,
        email_error: emailResult.error || null,
      },
    });

    return { action: 'pending-claim-created', claim_code: code, email_sent: emailResult.ok };
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const lic = licenses.findByLaunchpassSub(sub.id);
    // Note: notre champ est launchpass_subscription_id mais on l'utilise pour
    // les 2 providers (Stripe et Launchpass). Le subId Stripe sera unique
    // de toute façon (ne collide pas avec Launchpass).
    if (!lic) return { action: 'skipped', reason: 'sub-not-mapped-to-license' };
    licenses.cancel(lic.guild_id, { admin: 'stripe-webhook', reason: 'subscription-deleted' });
    return { action: 'cancelled' };
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const subId = invoice.subscription;
    if (!subId) return { action: 'skipped', reason: 'no-subscription' };
    const lic = licenses.findByLaunchpassSub(subId);
    if (!lic) {
      // Premier invoice (= post-checkout). La license sera créée par
      // checkout.session.completed déjà. Skip silencieusement.
      return { action: 'skipped', reason: 'license-not-yet-created' };
    }
    // Étend l'expiration. Pour l'instant, hardcoded 30 jours par renewal.
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    licenses.renew(lic.guild_id, expiresAt);
    return { action: 'renewed', new_expires_at: expiresAt };
  }

  // Tous les autres events sont silencieusement ignorés (pas d'erreur).
  return { action: 'unhandled', type: event.type };
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
    async (req, res) => {
      const stripe = require('../saas/stripe');
      const sig = req.headers['stripe-signature'];
      const verify = stripe.verifyWebhook(req.body, sig);
      if (!verify.ok) {
        return res.status(401).json({ ok: false, error: verify.error });
      }
      const event = verify.event;

      // Idempotence : skip si on a déjà traité cet event_id.
      const claimed = db.webhookEventClaim({
        provider: 'stripe',
        event_id: event.id,
        event_type: event.type,
      });
      if (!claimed) {
        return res.json({ ok: true, action: 'duplicate-skipped', event_id: event.id });
      }

      try {
        const result = await handleStripeEvent(event);
        db.webhookEventMarkProcessed({ provider: 'stripe', event_id: event.id });
        return res.json({ ok: true, ...result });
      } catch (err) {
        console.error('[saas/stripe-webhook]', event.type, 'failed:', err.message);
        // Renvoie 500 pour que Stripe retry plus tard. Mais l'event reste
        // claimed dans la DB — on ne le retraitera pas, à debug manuellement.
        return res.status(500).json({ ok: false, error: err.message });
      }
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
