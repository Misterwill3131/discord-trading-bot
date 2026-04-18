// ─────────────────────────────────────────────────────────────────────
// routes/filters.js — Endpoints pour les filtres custom persistés
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/custom-filters  — snapshot des règles courantes
//   POST /api/feedback        — action sur une phrase (block/allow/...)
//   POST /api/author-filter   — action sur un username Discord
//
// Tous mutent `state/custom-filters`. Les règles sont persistées en JSON
// à chaque action (small file — pas de batching nécessaire).
//
// Auto-blacklist intelligente : sur "false-positive" on compte les mots
// significatifs (>3 lettres, hors stopwords). Si un mot revient 3 fois
// dans des false-positives distincts, on le blacklist automatiquement —
// c'est l'apprentissage par rétroaction, pas un filtre hardcodé.
// ─────────────────────────────────────────────────────────────────────

const { customFilters, saveCustomFilters } = require('../state/custom-filters');

// Mots courants trop génériques pour servir de signal de false-positive.
// Si on les autorisait, le moindre message long en triggerait trois.
const FP_STOPWORDS = new Set([
  'the','and','for','that','this','with','from','have','will','your',
  'are','was','not','but','can','its','our','you','they','all','been',
  'one','had','her','his','him','she','let','get','got','has','how',
  'did','who','why','when','what','than','into','over','just','like',
  'more','also','some','then','them','their','there','would','could','should',
]);

const FEEDBACK_ACTIONS = ['block', 'allow', 'unblock-blocked', 'unblock-allowed', 'false-positive'];
const AUTHOR_ACTIONS   = ['block', 'allow', 'remove-blocked', 'remove-allowed'];

// Seuil d'auto-blacklist : un mot revenu 3 fois dans des false-positives
// est considéré comme un marqueur fiable de bruit.
const FP_AUTO_BLOCK_THRESHOLD = 3;

function registerFilterRoutes(app, requireAuth) {
  app.get('/api/custom-filters', requireAuth, (req, res) => {
    res.json(customFilters);
  });

  // /api/feedback gère 5 actions sur une PHRASE (texte libre) :
  //   block / false-positive  → ajout à la blacklist (FP incrémente les counts)
  //   allow                   → ajout à la whitelist
  //   unblock-blocked         → retrait de la blacklist
  //   unblock-allowed         → retrait de la whitelist
  app.post('/api/feedback', requireAuth, (req, res) => {
    const { content, action } = req.body || {};
    if (!content || !FEEDBACK_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }
    const phrase = content.trim();
    const autoBlocked = [];

    if (action === 'block' || action === 'false-positive') {
      if (!customFilters.blocked.includes(phrase)) customFilters.blocked.push(phrase);

      // Auto-blacklist : on ne compte que pour les "false-positive" (pas
      // les "block" manuels purs) — un bloc manuel ne révèle pas un motif
      // récurrent, juste une décision ponctuelle.
      if (action === 'false-positive') {
        if (!customFilters.falsePositiveCounts) customFilters.falsePositiveCounts = {};
        const words = phrase.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !FP_STOPWORDS.has(w));
        words.forEach(word => {
          customFilters.falsePositiveCounts[word] = (customFilters.falsePositiveCounts[word] || 0) + 1;
          if (customFilters.falsePositiveCounts[word] >= FP_AUTO_BLOCK_THRESHOLD
              && !customFilters.blocked.includes(word)) {
            customFilters.blocked.push(word);
            autoBlocked.push(word);
            console.log('[feedback] Auto-blocked keyword after ' + FP_AUTO_BLOCK_THRESHOLD + ' false positives: ' + word);
          }
        });
      }
    } else if (action === 'allow') {
      if (!customFilters.allowed.includes(phrase)) customFilters.allowed.push(phrase);
    } else if (action === 'unblock-blocked') {
      customFilters.blocked = customFilters.blocked.filter(p => p !== phrase);
    } else if (action === 'unblock-allowed') {
      customFilters.allowed = customFilters.allowed.filter(p => p !== phrase);
    }

    saveCustomFilters();
    console.log('[feedback] action=' + action + ' phrase=' + phrase.substring(0, 60));
    res.json({ ok: true, customFilters, autoBlocked });
  });

  // /api/author-filter gère 4 actions sur un USERNAME Discord :
  //   block / allow           → ajout à la liste correspondante (retire de l'autre)
  //   remove-blocked          → retrait de blockedAuthors
  //   remove-allowed          → retrait de allowedAuthors
  app.post('/api/author-filter', requireAuth, (req, res) => {
    const { username, action } = req.body || {};
    if (!username || !AUTHOR_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }
    // Init paresseuse au cas où le JSON n'a pas encore ces champs.
    if (!customFilters.blockedAuthors)  customFilters.blockedAuthors  = [];
    if (!customFilters.allowedAuthors) customFilters.allowedAuthors = [];

    const u = username.trim();

    if (action === 'block') {
      // Block force le retrait de allowedAuthors : les listes sont exclusives.
      customFilters.allowedAuthors = customFilters.allowedAuthors.filter(a => a !== u);
      if (!customFilters.blockedAuthors.includes(u)) customFilters.blockedAuthors.push(u);
    } else if (action === 'allow') {
      customFilters.blockedAuthors = customFilters.blockedAuthors.filter(a => a !== u);
      if (!customFilters.allowedAuthors.includes(u)) customFilters.allowedAuthors.push(u);
    } else if (action === 'remove-blocked') {
      customFilters.blockedAuthors = customFilters.blockedAuthors.filter(a => a !== u);
    } else if (action === 'remove-allowed') {
      customFilters.allowedAuthors = customFilters.allowedAuthors.filter(a => a !== u);
    }

    saveCustomFilters();
    console.log('[author-filter] action=' + action + ' user=' + u);
    res.json({ ok: true, customFilters });
  });
}

module.exports = { registerFilterRoutes };
