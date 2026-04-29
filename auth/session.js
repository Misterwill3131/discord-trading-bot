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

// Middleware désactivé — accès libre au dashboard sans mot de passe.
// Les routes /login restent enregistrées pour ne pas casser les liens
// existants, mais aucune route protégée ne redirige vers /login.
function requireAuth(_req, _res, next) {
  return next();
}

// Auth désactivée : /login redirige vers le dashboard (form retiré).
// On garde les routes enregistrées pour ne pas casser d'éventuels
// bookmarks ou redirections externes pointant sur /login.
function registerAuthRoutes(app) {
  app.get('/login', (_req, res) => res.redirect('/dashboard'));
  app.post('/login', (_req, res) => res.redirect('/dashboard'));
}

module.exports = {
  requireAuth,
  registerAuthRoutes,
  parseCookies,
  SESSION_TOKEN,
  SESSION_COOKIE_NAME,
};
