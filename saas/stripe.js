// ─────────────────────────────────────────────────────────────────────
// saas/stripe.js — Wrapper Stripe SDK pour le SaaS
// ─────────────────────────────────────────────────────────────────────
// Init lazy : on construit l'instance Stripe seulement quand `STRIPE_SECRET_KEY`
// est présent. Sinon les fonctions retournent { ok: false, error: ... }.
//
// Pas de stockage de keys ici — uniquement lus depuis process.env :
//   STRIPE_SECRET_KEY     — sk_test_... ou sk_live_...
//   STRIPE_WEBHOOK_SECRET — whsec_... (pour vérifier les events webhook)
// ─────────────────────────────────────────────────────────────────────

let stripeInstance = null;

function getStripe() {
  if (stripeInstance) return stripeInstance;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require('stripe');
    stripeInstance = new Stripe(key, {
      apiVersion: '2025-07-30.basil', // version stable récente
      typescript: false,
      // Identifiant pour les analytics Stripe — utile en debug.
      appInfo: { name: 'TOB SaaS Bot', version: '1.0.0' },
    });
    return stripeInstance;
  } catch (err) {
    console.error('[saas/stripe] init failed:', err.message);
    return null;
  }
}

// Crée une session Stripe Checkout pour un plan donné.
// `params` = {
//   priceId    — Stripe Price ID (ex: price_1AbCdEf...)
//   email      — email du client (pré-rempli, requis pour matching webhook)
//   successUrl — URL de redirect après paiement OK
//   cancelUrl  — URL de redirect si l'utilisateur annule
//   metadata   — { plan_id, interval } — embarqués dans la session
// }
// Retourne { ok, url, sessionId } OU { ok: false, error }.
async function createCheckoutSession(params) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe not configured (missing STRIPE_SECRET_KEY)' };
  if (!params.priceId) return { ok: false, error: 'priceId required' };
  if (!params.email)   return { ok: false, error: 'email required' };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: params.priceId,
        quantity: 1,
      }],
      customer_email: params.email,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata || {},
      // Allow promotion codes if user has a coupon
      allow_promotion_codes: true,
      // Bill in advance, store payment method
      billing_address_collection: 'auto',
    });
    return { ok: true, url: session.url, sessionId: session.id };
  } catch (err) {
    console.error('[saas/stripe] createCheckoutSession failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Vérifie la signature d'un webhook Stripe et retourne l'event parsé.
// Retourne { ok, event } ou { ok: false, error }.
// `rawBody` doit être un Buffer (express.raw middleware).
function verifyWebhook(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  if (!secret) return { ok: false, error: 'STRIPE_WEBHOOK_SECRET not set' };
  if (!signature) return { ok: false, error: 'missing stripe-signature header' };

  try {
    const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    return { ok: true, event };
  } catch (err) {
    return { ok: false, error: 'signature verification failed: ' + err.message };
  }
}

// Récupère les invoices d'un customer Stripe (pour /account/billing).
// Retourne { ok, invoices: [...] } ou { ok: false, error }.
async function listInvoices(stripeCustomerId, limit = 10) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  if (!stripeCustomerId) return { ok: true, invoices: [] };

  try {
    const result = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: Math.min(limit, 100),
    });
    return { ok: true, invoices: result.data };
  } catch (err) {
    console.error('[saas/stripe] listInvoices failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Crée un Customer Portal session (Stripe-managed billing UI : update card,
// view invoices, cancel subscription). Plus simple que de tout coder.
async function createPortalSession({ stripeCustomerId, returnUrl }) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  if (!stripeCustomerId) return { ok: false, error: 'no stripe customer linked' };

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });
    return { ok: true, url: portal.url };
  } catch (err) {
    console.error('[saas/stripe] createPortalSession failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Annule immédiatement une subscription. Pour les annulations en fin de
// période (souhaitable côté UX), utiliser plutôt `subscriptions.update`
// avec `cancel_at_period_end: true`.
async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  try {
    const sub = await stripe.subscriptions.cancel(subscriptionId);
    return { ok: true, subscription: sub };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Marque une subscription pour annulation à la fin de la période courante.
// Le client garde son accès jusqu'à expires_at.
async function scheduleCancelAtPeriodEnd(subscriptionId) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  try {
    const sub = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
    return { ok: true, subscription: sub };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Détecte si Stripe est configuré (utilisé pour griser les boutons côté UI).
function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

module.exports = {
  getStripe,
  createCheckoutSession,
  verifyWebhook,
  listInvoices,
  createPortalSession,
  cancelSubscription,
  scheduleCancelAtPeriodEnd,
  isConfigured,
};
