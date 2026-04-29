// ─────────────────────────────────────────────────────────────────────
// routes/customer-account.js — Routes /account/* du panel client
// ─────────────────────────────────────────────────────────────────────
//   Public (sans auth) :
//     GET  /account/login          → form magic-link
//     POST /account/login          → envoie magic-link, redirect /check-email
//     GET  /account/verify?token=X → consomme le token, set cookie, redirect /account
//
//   Authentifiées (customerAuth) :
//     GET  /account                → dashboard customer
//     GET  /account/billing        → invoices + Stripe portal button
//     POST /account/billing/portal → crée portal session + redirect
//     GET  /account/preferences    → status DISC + disconnect
//     POST /account/preferences/disconnect → kick bot
//     POST /account/logout         → détruit session, redirect /
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const brand = require('../saas/brand');
const stripe = require('../saas/stripe');
const saasEmail = require('../saas/email');
const customerAuthMod = require('../saas/customer-auth');
const licenses = require('../saas/licenses');
const { renderAccountLogin } = require('../pages/account/login');
const { renderAccountDashboard } = require('../pages/account/dashboard');
const { renderAccountBilling } = require('../pages/account/billing');
const { renderAccountPreferences } = require('../pages/account/preferences');

function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://templeofboom.up.railway.app');
}

function buildBotInviteUrl() {
  const clientId = process.env.SAAS_BOT_CLIENT_ID || '';
  if (!clientId) return '#';
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=2147485696&scope=bot+applications.commands`;
}

function sendHtml(res, html) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// `clientSaas` est passé par index.js — utilisé pour force-leave (disconnect).
// Peut être null si le bot SaaS n'est pas configuré.
function registerCustomerAccountRoutes(app, clientSaasRef) {
  // ── Public : login form ─────────────────────────────────────────────
  app.get('/account/login', (req, res) => {
    sendHtml(res, renderAccountLogin({
      brandName: brand.BRAND_NAME,
      prefilledEmail: typeof req.query.email === 'string' ? req.query.email : '',
      error: typeof req.query.error === 'string' ? req.query.error : null,
    }));
  });

  // ── Public : POST login (envoie magic-link) ─────────────────────────
  app.post('/account/login', async (req, res) => {
    const email = (req.body && req.body.email || '').toString().trim();
    if (!email) {
      return res.redirect('/account/login?error=' + encodeURIComponent('Please enter your email'));
    }
    const baseUrl = getPublicBaseUrl();
    const result = await customerAuthMod.requestMagicLink({
      email,
      baseUrl,
      brandName: brand.BRAND_NAME,
      sendEmailFn: saasEmail.sendMagicLinkEmail,
    });
    if (!result.ok) {
      return res.redirect(`/account/login?email=${encodeURIComponent(email)}&error=${encodeURIComponent(result.error)}`);
    }
    return res.redirect(`/check-email?email=${encodeURIComponent(email)}`);
  });

  // ── Public : verify magic-link → set cookie session → redirect /account
  app.get('/account/verify', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const result = customerAuthMod.verifyMagicLink({
      token,
      userAgent: req.headers['user-agent'],
      ip: req.ip || req.connection?.remoteAddress,
    });
    if (!result.ok) {
      return res.redirect('/account/login?error=' + encodeURIComponent(result.error));
    }
    customerAuthMod.setSessionCookie(res, result.token);
    return res.redirect('/account');
  });

  // ── Authentifiées : à partir d'ici, customerAuth requis ─────────────
  app.get('/account', customerAuthMod.customerAuth, (req, res) => {
    const customer = req.customer;
    // Charge la license liée. Le customer.guild_id est mis à jour quand
    // /connect est exécuté avec le claim_code de cet utilisateur.
    let license = null;
    if (customer.guild_id) {
      license = licenses.get(customer.guild_id);
    }
    sendHtml(res, renderAccountDashboard({
      brandName: brand.BRAND_NAME,
      customer,
      license,
      inviteUrl: buildBotInviteUrl(),
      helpUrl: `${getPublicBaseUrl()}/connect-help`,
    }));
  });

  app.get('/account/billing', customerAuthMod.customerAuth, async (req, res) => {
    const customer = req.customer;
    let invoices = [];
    let invoiceError = null;
    if (customer.stripe_customer_id) {
      const r = await stripe.listInvoices(customer.stripe_customer_id, 20);
      if (r.ok) invoices = r.invoices;
      else invoiceError = r.error;
    }
    sendHtml(res, renderAccountBilling({
      brandName: brand.BRAND_NAME,
      customer,
      invoices,
      stripeConfigured: stripe.isConfigured(),
      error: invoiceError,
    }));
  });

  app.post('/account/billing/portal', customerAuthMod.customerAuth, async (req, res) => {
    const customer = req.customer;
    if (!customer.stripe_customer_id) {
      return res.redirect('/account/billing?error=' + encodeURIComponent('No Stripe subscription on this account.'));
    }
    const baseUrl = getPublicBaseUrl();
    const result = await stripe.createPortalSession({
      stripeCustomerId: customer.stripe_customer_id,
      returnUrl: `${baseUrl}/account/billing`,
    });
    if (!result.ok) {
      return res.redirect('/account/billing?error=' + encodeURIComponent(result.error));
    }
    return res.redirect(result.url);
  });

  app.get('/account/preferences', customerAuthMod.customerAuth, (req, res) => {
    const customer = req.customer;
    let license = null;
    if (customer.guild_id) {
      license = licenses.get(customer.guild_id);
    }
    sendHtml(res, renderAccountPreferences({
      brandName: brand.BRAND_NAME,
      customer,
      license,
      success: typeof req.query.success === 'string' ? req.query.success : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    }));
  });

  app.post('/account/preferences/disconnect', customerAuthMod.customerAuth, async (req, res) => {
    const customer = req.customer;
    if (!customer.guild_id) {
      return res.redirect('/account/preferences?error=' + encodeURIComponent('Bot is not currently connected.'));
    }
    if (!clientSaasRef || !clientSaasRef.current) {
      return res.redirect('/account/preferences?error=' + encodeURIComponent('Bot service unavailable. Try again later.'));
    }
    try {
      const guild = clientSaasRef.current.guilds.cache.get(customer.guild_id);
      if (!guild) {
        return res.redirect('/account/preferences?success=' + encodeURIComponent('Bot was already disconnected.'));
      }
      await guild.leave();
      // Note : on ne change PAS le status de la license — le user a payé,
      // il peut re-inviter le bot quand il veut.
      db.adminActionInsert({
        admin: `customer:${customer.id}`,
        action: 'self-disconnect',
        guild_id: customer.guild_id,
        payload: { reason: 'customer-requested' },
      });
      return res.redirect('/account/preferences?success=' + encodeURIComponent('Bot disconnected. Re-invite anytime to resume.'));
    } catch (err) {
      console.error('[customer-account] disconnect failed:', err.message);
      return res.redirect('/account/preferences?error=' + encodeURIComponent('Could not disconnect: ' + err.message.slice(0, 100)));
    }
  });

  app.post('/account/logout', customerAuthMod.customerAuth, (req, res) => {
    customerAuthMod.logout(req);
    customerAuthMod.clearSessionCookie(res);
    return res.redirect('/');
  });
}

module.exports = { registerCustomerAccountRoutes };
