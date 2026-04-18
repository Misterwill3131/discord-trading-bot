// ─────────────────────────────────────────────────────────────────────
// routes/pages.js — Routes qui servent un template HTML statique
// ─────────────────────────────────────────────────────────────────────
// Chaque page est un simple GET qui renvoie un template HTML pré-construit
// (imports depuis pages/*.js). Elles ne dépendent d'aucun état runtime :
// tout ce qui est dynamique (stats, SSE, etc.) est chargé ensuite par le
// JS client via les routes /api/*.
//
// Les pages avec logique serveur (cookies /login, génération inline
// /config, /gallery) restent dans index.js pour l'instant.
//
// Usage :
//   const { registerPageRoutes } = require('./routes/pages');
//   registerPageRoutes(app, requireAuth);
// ─────────────────────────────────────────────────────────────────────

const { DASHBOARD_HTML }     = require('../pages/dashboard');
const { STATS_HTML }         = require('../pages/stats');
const { PROFITS_PAGE_HTML }  = require('../pages/profits');
const { NEWS_PAGE_HTML }     = require('../pages/news');
const { LEADERBOARD_HTML }   = require('../pages/leaderboard');
const { TICKER_PAGE_HTML }   = require('../pages/ticker');
const { IMAGE_GEN_HTML }     = require('../pages/image-generator');
const { PROOF_GEN_HTML }     = require('../pages/proof-generator');
const { RAW_MESSAGES_HTML }  = require('../pages/raw-messages');
const { GALLERY_HTML }       = require('../pages/gallery');

// Factory : retourne un handler Express qui sert un HTML statique.
// Centralise le Content-Type pour éviter de l'oublier sur une route.
function sendHtml(html) {
  return (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(html);
  };
}

// Liste déclarative { path → template } — facile à auditer d'un coup d'œil.
// L'ordre n'a pas d'importance (pas de chevauchement de paths).
const PAGES = [
  { path: '/dashboard',       html: DASHBOARD_HTML },
  { path: '/stats',           html: STATS_HTML },
  { path: '/profits',         html: PROFITS_PAGE_HTML },
  { path: '/news',            html: NEWS_PAGE_HTML },
  { path: '/leaderboard',     html: LEADERBOARD_HTML },
  { path: '/ticker/:symbol',  html: TICKER_PAGE_HTML },
  { path: '/image-generator', html: IMAGE_GEN_HTML },
  { path: '/proof-generator', html: PROOF_GEN_HTML },
  { path: '/raw-messages',    html: RAW_MESSAGES_HTML },
  { path: '/gallery',         html: GALLERY_HTML },
];

function registerPageRoutes(app, requireAuth) {
  for (const { path, html } of PAGES) {
    app.get(path, requireAuth, sendHtml(html));
  }
}

module.exports = { registerPageRoutes, PAGES };
