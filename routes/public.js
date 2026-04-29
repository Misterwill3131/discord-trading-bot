// ─────────────────────────────────────────────────────────────────────
// routes/public.js — Routes du site public marketing
// ─────────────────────────────────────────────────────────────────────
// Toutes les routes ici sont SANS auth (publiques). Sert :
//   GET /          → landing
//   GET /pricing   → pricing (lit DB plans dynamiquement)
//   GET /faq       → FAQ
//   GET /terms     → Terms of Service
//   GET /privacy   → Privacy Policy
//   GET /success   → confirmation post-checkout
//   GET /check-email → confirmation envoi magic-link
//   GET /connect-help → tutoriel /connect (cible des emails)
//
// Détection optionnelle de session customer (cookie tob_customer_session)
// pour afficher "My account" au lieu de "Login" dans le header.
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const brand = require('../saas/brand');
const { renderLanding } = require('../pages/public/landing');
const { renderPricing } = require('../pages/public/pricing');
const { renderFaq } = require('../pages/public/faq');
const { renderTerms, renderPrivacy } = require('../pages/public/legal');
const { renderSuccess, renderCheckEmail, renderConnectHelp } = require('../pages/public/funnel');

// Helper : extrait l'état de login customer depuis le cookie. Retourne
// false si pas de session ou session expirée. Ne block jamais — seulement
// utilisé pour adapter le header.
function isCustomerLoggedIn(req) {
  try {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/tob_customer_session=([a-f0-9]+)/);
    if (!match) return false;
    const session = db.customerSessionGet(match[1]);
    return !!session;
  } catch (_) {
    return false;
  }
}

// Helper : URL d'invitation OAuth du bot SaaS. Construite depuis
// SAAS_BOT_CLIENT_ID + permissions Send Messages + Embed Links + slash.
function buildBotInviteUrl() {
  const clientId = process.env.SAAS_BOT_CLIENT_ID || '';
  if (!clientId) return '#';
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=2147485696&scope=bot+applications.commands`;
}

function sendHtml(res, html) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

function registerPublicRoutes(app) {
  // Helper qui pré-remplit les opts communes pour toutes les pages publiques.
  const baseOpts = (req) => ({
    brandName: brand.BRAND_NAME,
    isCustomerLoggedIn: isCustomerLoggedIn(req),
  });

  app.get('/', (req, res) => {
    sendHtml(res, renderLanding(baseOpts(req)));
  });

  app.get('/pricing', (req, res) => {
    sendHtml(res, renderPricing(baseOpts(req)));
  });

  app.get('/faq', (req, res) => {
    sendHtml(res, renderFaq(baseOpts(req)));
  });

  app.get('/terms', (req, res) => {
    sendHtml(res, renderTerms(baseOpts(req)));
  });

  app.get('/privacy', (req, res) => {
    sendHtml(res, renderPrivacy(baseOpts(req)));
  });

  app.get('/success', (req, res) => {
    sendHtml(res, renderSuccess({
      ...baseOpts(req),
      sessionId: typeof req.query.session_id === 'string' ? req.query.session_id : null,
    }));
  });

  app.get('/check-email', (req, res) => {
    sendHtml(res, renderCheckEmail({
      ...baseOpts(req),
      email: typeof req.query.email === 'string' ? req.query.email : null,
    }));
  });

  app.get('/connect-help', (req, res) => {
    sendHtml(res, renderConnectHelp({
      ...baseOpts(req),
      code: typeof req.query.code === 'string' ? req.query.code : null,
      inviteUrl: buildBotInviteUrl(),
    }));
  });
}

module.exports = {
  registerPublicRoutes,
  isCustomerLoggedIn,
  buildBotInviteUrl,
};
