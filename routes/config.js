// ─────────────────────────────────────────────────────────────────────
// routes/config.js — GET /config (page read-only de configuration)
// ─────────────────────────────────────────────────────────────────────
// Snapshot à chaque requête :
//   • Aliases = AUTHOR_ALIASES hardcodé + config-overrides.json.authorAliases
//   • customFilters courants (mutent à chaque feedback)
//   • Canaux additionnels (config-overrides.json.allowedChannels)
//
// Volontairement read-only : toute modification passe soit par le
// dashboard (phrases/auteurs via feedback), soit par édition directe
// du fichier config-overrides.json (aliases/canaux). Évite une surface
// d'attaque supplémentaire sur une auth à 1 facteur.
// ─────────────────────────────────────────────────────────────────────

const { AUTHOR_ALIASES } = require('../utils/authors');
const { loadConfigOverrides } = require('../utils/config-overrides');
const { customFilters } = require('../state/custom-filters');
const { renderConfigPage } = require('../pages/config');

function registerConfigRoutes(app, requireAuth) {
  app.get('/config', requireAuth, (req, res) => {
    // Reload à chaque hit : si l'opérateur édite config-overrides.json à
    // chaud, le rafraîchissement de page suffit à voir le changement
    // (pas besoin de restart du bot).
    const overrides = loadConfigOverrides();
    const aliases = Object.assign({}, AUTHOR_ALIASES, overrides.authorAliases || {});
    const channelOverrides = overrides.allowedChannels || [];

    // Clone défensif : le template itère sur `.length`, des champs
    // manquants casseraient l'affichage. On force la présence.
    const safeFilters = {
      blocked:         customFilters.blocked         || [],
      allowed:         customFilters.allowed         || [],
      blockedAuthors:  customFilters.blockedAuthors  || [],
      allowedAuthors:  customFilters.allowedAuthors  || [],
      allowedChannels: customFilters.allowedChannels || [],
    };

    res.set('Content-Type', 'text/html');
    res.send(renderConfigPage({ aliases, safeFilters, channelOverrides }));
  });
}

module.exports = { registerConfigRoutes };
