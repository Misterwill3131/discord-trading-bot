// ─────────────────────────────────────────────────────────────────────
// auth/trading-session.js — Auth dédiée à la page /trading
// ─────────────────────────────────────────────────────────────────────
// Indépendante de auth/session.js : même si le dashboard principal est
// ouvert, /trading reste protégée par son propre mot de passe. Motivation :
// /trading peut déclencher des ordres réels — niveau de sécurité plus
// élevé que les pages d'analytics.
//
// Config :
//   • TRADING_PASSWORD env var — OBLIGATOIRE pour accéder à /trading.
//     Si absente, le middleware renvoie 503 (trading inaccessible).
//   • Cookie `boom_trading_session` — distinct de `boom_session` (dashboard).
//   • Token jetable au restart (pas de persistence).
//
// Le middleware `requireTradingAuth` redirige vers /trading/login (form HTML)
// pour les navigateurs, ou renvoie 401 JSON pour les requêtes API (header
// Accept: application/json).
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const TRADING_SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
const TRADING_COOKIE_NAME = 'boom_trading_session';
const TRADING_PASSWORD = process.env.TRADING_PASSWORD || '';

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    result[key] = decodeURIComponent(val);
  });
  return result;
}

function wantsJson(req) {
  const a = (req.headers.accept || '').toLowerCase();
  return a.includes('application/json');
}

function requireTradingAuth(req, res, next) {
  if (!TRADING_PASSWORD) {
    // Pas de mot de passe configuré = trading inaccessible (safety).
    if (wantsJson(req)) {
      return res.status(503).json({ error: 'TRADING_PASSWORD env var not set' });
    }
    res.status(503).set('Content-Type', 'text/html').send(
      '<h1>Trading disabled</h1><p>Set the <code>TRADING_PASSWORD</code> environment variable to enable access to /trading.</p>'
    );
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[TRADING_COOKIE_NAME] === TRADING_SESSION_TOKEN) return next();
  if (wantsJson(req)) {
    return res.status(401).json({ error: 'trading auth required' });
  }
  res.redirect('/trading/login');
}

const LOGIN_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Trading — login</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  form { background: #0f1620; border: 1px solid #1f2933; padding: 32px; border-radius: 12px; width: 360px; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { color: #8b9bac; font-size: 13px; margin: 0 0 24px; }
  label { display: block; color: #8b9bac; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
  input { width: 100%; box-sizing: border-box; background: #0b0f14; color: #e6edf3; border: 1px solid #1f2933; padding: 10px 14px; border-radius: 6px; font-size: 14px; }
  button { width: 100%; background: #238636; color: #fff; border: 0; padding: 12px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; margin-top: 16px; font-size: 14px; }
  .err { color: #f85149; font-size: 13px; margin-top: 12px; display: none; }
  .err.show { display: block; }
</style>
</head>
<body>
<form method="POST" action="/trading/login">
  <h1>🔒 Trading</h1>
  <p>Accès protégé — saisir le mot de passe trading.</p>
  <label for="pw">Mot de passe</label>
  <input id="pw" name="password" type="password" autofocus required />
  <button type="submit">Se connecter</button>
  <div id="err" class="err">Mot de passe incorrect.</div>
</form>
</body>
</html>`;

function registerTradingAuthRoutes(app) {
  app.get('/trading/login', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[TRADING_COOKIE_NAME] === TRADING_SESSION_TOKEN) {
      return res.redirect('/trading');
    }
    res.set('Content-Type', 'text/html').send(LOGIN_HTML);
  });

  app.post('/trading/login', (req, res) => {
    if (!TRADING_PASSWORD) {
      return res.status(503).send('TRADING_PASSWORD env var not set');
    }
    const pw = (req.body && req.body.password) || '';
    if (pw === TRADING_PASSWORD) {
      res.setHeader('Set-Cookie', TRADING_COOKIE_NAME + '=' + TRADING_SESSION_TOKEN + '; Path=/; HttpOnly');
      return res.redirect('/trading');
    }
    const html = LOGIN_HTML.replace('id="err" class="err"', 'id="err" class="err show"');
    res.set('Content-Type', 'text/html').send(html);
  });

  // Logout (clears the cookie).
  app.post('/trading/logout', (_req, res) => {
    res.setHeader('Set-Cookie', TRADING_COOKIE_NAME + '=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/trading/login');
  });
}

module.exports = {
  requireTradingAuth,
  registerTradingAuthRoutes,
  TRADING_COOKIE_NAME,
  TRADING_SESSION_TOKEN,
};
