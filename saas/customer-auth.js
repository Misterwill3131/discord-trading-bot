// ─────────────────────────────────────────────────────────────────────
// saas/customer-auth.js — Auth customer (magic-link + cookie session)
// ─────────────────────────────────────────────────────────────────────
// Auth distincte du dashboard admin (cookie 'boom_session' / DASHBOARD_PASSWORD).
// Cookie : tob_customer_session=TOKEN, HttpOnly, SameSite=Lax, Path=/, Max-Age=30j.
//
// Flow login :
//   1. POST /account/login { email } → magicLinkCreate, sendMagicLinkEmail,
//      redirect /check-email?email=X
//   2. GET /account/verify?token=X → magicLinkConsume, customerSessionCreate,
//      Set-Cookie, redirect /account
//
// Middleware customerAuth :
//   - Lit cookie tob_customer_session
//   - Charge la session DB → injecte req.customer = { id, email, guild_id, ... }
//   - Si invalide/absent → redirect /account/login
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');

const COOKIE_NAME = 'tob_customer_session';
const SESSION_TTL_DAYS = 30;
const MAGIC_LINK_TTL_MINUTES = 15;
const MAGIC_LINK_RATE_LIMIT = 5; // max par heure par email

// Parse le cookie et retourne la valeur du token, ou null.
function parseSessionCookie(req) {
  const cookieHeader = req.headers && req.headers.cookie;
  if (!cookieHeader) return null;
  const re = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]+)`);
  const m = cookieHeader.match(re);
  return m ? m[1] : null;
}

// Construit la valeur Set-Cookie pour la session.
function setSessionCookie(res, token, ttlDays) {
  const days = ttlDays || SESSION_TTL_DAYS;
  const maxAge = days * 86400;
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_PUBLIC_DOMAIN;
  const flags = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isProd) flags.push('Secure');
  res.set('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res) {
  res.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Middleware Express. Si pas de session valide :
//   - JSON request (Accept: application/json) → 401 JSON
//   - Sinon → redirect /account/login
function customerAuth(req, res, next) {
  const token = parseSessionCookie(req);
  if (token) {
    const session = db.customerSessionGet(token);
    if (session) {
      req.customer = {
        id: session.customer_id,
        email: session.email,
        guild_id: session.guild_id,
        stripe_customer_id: session.stripe_customer_id,
        launchpass_customer_id: session.launchpass_customer_id,
      };
      req.customerSessionToken = token;
      return next();
    }
  }
  // Pas de session valide
  const wantsJson = (req.headers.accept || '').includes('application/json')
    || (req.headers['content-type'] || '').includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ ok: false, error: 'Not authenticated. Please log in.' });
  }
  return res.redirect('/account/login');
}

// Crée un magic-link pour `email` et l'envoie par email. Rate-limited.
// Returns { ok, error? }.
async function requestMagicLink({ email, baseUrl, brandName, sendEmailFn }) {
  const norm = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
    return { ok: false, error: 'Invalid email format' };
  }

  // Rate limit : max 5 magic-links par heure par email
  const recentCount = db.magicLinkCountRecent(norm, 60);
  if (recentCount >= MAGIC_LINK_RATE_LIMIT) {
    return { ok: false, error: 'Too many requests. Please wait an hour and try again.' };
  }

  // S'assure qu'un customer existe pour cet email (création silencieuse si nouveau)
  db.customerUpsertByEmail(norm);

  // Génère le token avec TTL 15 min
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();
  const token = db.magicLinkCreate({ email: norm, expires_at: expiresAt });
  const magicLinkUrl = `${baseUrl}/account/verify?token=${encodeURIComponent(token)}`;

  // Envoie l'email (peut être mocké via sendEmailFn pour tests)
  const result = await sendEmailFn({
    to: norm,
    brandName,
    magicLinkUrl,
  });

  if (!result.ok) {
    // En prod, on ne révèle pas l'erreur exacte (peut leak email service status)
    console.error('[customer-auth] sendMagicLinkEmail failed:', result.error);
    return { ok: false, error: 'Could not send email. Please try again or contact support.' };
  }

  return { ok: true };
}

// Consomme le token et crée une session. Returns { ok, token } ou { ok: false, error }.
function verifyMagicLink({ token, userAgent, ip }) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Invalid link' };
  }
  const link = db.magicLinkConsume(token);
  if (!link) {
    return { ok: false, error: 'Link is invalid, expired, or already used' };
  }
  // Trouve ou crée le customer
  const customer = db.customerUpsertByEmail(link.email);
  db.customerTouchLogin(customer.id);

  // Crée une session 30 jours
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000).toISOString();
  const sessionToken = db.customerSessionCreate({
    customer_id: customer.id,
    expires_at: expiresAt,
    user_agent: userAgent ? userAgent.slice(0, 200) : null,
    ip: ip ? String(ip).slice(0, 64) : null,
  });

  return { ok: true, token: sessionToken, customer };
}

function logout(req) {
  const token = req.customerSessionToken || parseSessionCookie(req);
  if (token) db.customerSessionDelete(token);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_DAYS,
  MAGIC_LINK_TTL_MINUTES,
  parseSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  customerAuth,
  requestMagicLink,
  verifyMagicLink,
  logout,
};
