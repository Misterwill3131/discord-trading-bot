// ─────────────────────────────────────────────────────────────────────
// routes/checkout.js — Endpoints de paiement (Stripe Checkout)
// ─────────────────────────────────────────────────────────────────────
//   POST /api/checkout/stripe — création d'une session Stripe Checkout
//
// Body JSON attendu : { plan_id, interval ('monthly'|'annual'), email }.
// Réponse : { ok: true, url: 'https://checkout.stripe.com/...' } OU
//           { ok: false, error: '...' }.
//
// Le client redirige ensuite window.location vers `url`. Stripe gère le
// paiement, puis redirige vers /success ou /pricing (cancel) selon issue.
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const stripe = require('../saas/stripe');

function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://templeofboom.up.railway.app');
}

// Validation email basique : présence d'@ + au moins un point dans le domaine.
function isValidEmail(s) {
  if (typeof s !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function registerCheckoutRoutes(app) {
  app.post('/api/checkout/stripe', async (req, res) => {
    try {
      if (!stripe.isConfigured()) {
        return res.status(503).json({
          ok: false,
          error: 'Stripe is not yet configured. Please contact support or use Launchpass.',
        });
      }

      const { plan_id, interval, email } = req.body || {};

      if (!plan_id) {
        return res.status(400).json({ ok: false, error: 'plan_id required' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: 'Valid email required' });
      }
      if (interval !== 'monthly' && interval !== 'annual') {
        return res.status(400).json({ ok: false, error: 'interval must be monthly or annual' });
      }

      const plan = db.planGet(plan_id);
      if (!plan) {
        return res.status(404).json({ ok: false, error: `Unknown plan: ${plan_id}` });
      }
      if (!plan.is_active) {
        return res.status(400).json({ ok: false, error: 'This plan is no longer available.' });
      }

      const priceId = interval === 'annual'
        ? plan.stripe_price_id_annual
        : plan.stripe_price_id_monthly;

      if (!priceId) {
        return res.status(400).json({
          ok: false,
          error: `Stripe price ID not configured for plan "${plan_id}" (${interval}). Please use Launchpass instead, or contact support.`,
        });
      }

      const baseUrl = getPublicBaseUrl();
      const result = await stripe.createCheckoutSession({
        priceId,
        email: email.trim().toLowerCase(),
        successUrl: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/pricing`,
        metadata: {
          plan_id: plan.id,
          interval,
          source: 'web-pricing-page',
        },
      });

      if (!result.ok) {
        console.error('[checkout] Stripe session creation failed:', result.error);
        return res.status(500).json({ ok: false, error: 'Could not create checkout session. Please try again.' });
      }

      // Pre-crée le customer en DB (sera enrichi avec stripe_customer_id
      // lors du webhook checkout.session.completed).
      try { db.customerUpsertByEmail(email); } catch (_) {}

      return res.json({ ok: true, url: result.url, sessionId: result.sessionId });
    } catch (err) {
      console.error('[checkout] unexpected error:', err);
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
  });
}

module.exports = { registerCheckoutRoutes };
