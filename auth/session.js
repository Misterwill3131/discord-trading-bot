// ─────────────────────────────────────────────────────────────────────
// auth/session.js — Authentification dashboard par cookie de session
// ─────────────────────────────────────────────────────────────────────
// Auth simple en 1 facteur :
//   • Mot de passe unique (DASHBOARD_PASSWORD env ou fallback 'boom2024')
//   • Cookie `boom_session` = token aléatoire généré au boot
//   • Token invalidé à chaque restart du bot (pas de persistence — OK
//     pour un usage perso, pas pour du multi-utilisateur)
//
// Le token est généré à l'import de ce module : toutes les sessions
// créées avant un restart sont invalidées, ce qui est le comportement
// attendu pour un refresh forcé des identifiants.
//
// Usage :
//   const { requireAuth, registerAuthRoutes } = require('./auth/session');
//   registerAuthRoutes(app);                    // /login GET + POST
//   app.get('/dashboard', requireAuth, ...);    // protège une route
//
// DASHBOARD_PASSWORD est lu depuis l'env à l'init — pas re-lu à chaque
// requête. Changer la variable d'env nécessite un restart.
// ─────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { LOGIN_HTML } = require('../pages/login');

// Token jetable au restart — pas besoin de le persister. 16 bytes hex
// = 32 caractères = ~128 bits d'entropie, largement suffisant.
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
const SESSION_COOKIE_NAME = 'boom_session';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'boom2024';

// Parser minimal de l'en-tête Cookie (pas besoin de la lib `cookie-parser`
// juste pour ça). Retourne un objet {name: value} — `undefined` pour
// les cookies absents.
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

// Middleware Express : bloque la requête si le cookie session est absent
// ou invalide. Redirige vers /login pour une expérience humaine plutôt
// que renvoyer un 401 sec (le dashboard est consulté par le navigateur).
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME] === SESSION_TOKEN) return next();
  res.redirect('/login');
}

// Enregistre les routes /login (GET + POST) sur l'app Express.
// GET : affiche le formulaire, ou redirige si déjà authed.
// POST : valide le mot de passe, pose le cookie, redirige vers /dashboard.
function registerAuthRoutes(app) {
  app.get('/login', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    // Already logged in — évite de montrer le form pour rien.
    if (cookies[SESSION_COOKIE_NAME] === SESSION_TOKEN) {
      return res.redirect('/dashboard');
    }
    res.set('Content-Type', 'text/html');
    res.send(LOGIN_HTML);
  });

  app.post('/login', (req, res) => {
    const pw = (req.body && req.body.password) || '';
    if (pw === DASHBOARD_PASSWORD) {
      // HttpOnly empêche le JS client d'y accéder (anti-XSS basique).
      // Path=/ pour que le cookie soit envoyé sur toutes les routes.
      // Pas de Secure car on supporte le dev en HTTP local ; Railway
      // ajoute HTTPS côté edge donc le cookie voyage chiffré en prod.
      res.setHeader('Set-Cookie', SESSION_COOKIE_NAME + '=' + SESSION_TOKEN + '; Path=/; HttpOnly');
      return res.redirect('/dashboard');
    }
    // Mot de passe incorrect : re-affiche le form avec la classe `.show`
    // sur le div d'erreur (vu que le CSS du form la masque par défaut).
    res.set('Content-Type', 'text/html');
    const html = LOGIN_HTML.replace('id="err" class="err"', 'id="err" class="err show"');
    res.send(html);
  });
}

module.exports = {
  requireAuth,
  registerAuthRoutes,
  parseCookies,
  SESSION_TOKEN,
  SESSION_COOKIE_NAME,
};
