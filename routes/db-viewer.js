// ─────────────────────────────────────────────────────────────────────
// routes/db-viewer.js — DB viewer SQL read-only
// ─────────────────────────────────────────────────────────────────────
//   GET  /db-viewer      — page HTML (textarea + result table)
//   POST /api/db-query   — exécute la query SELECT, renvoie les rows
//
// Sécurité : derrière requireAuth (comme tout le dashboard) + whitelist
// stricte des verbes SQL autorisés. Même si un attaquant a les creds
// dashboard, il ne peut pas muter la DB via cette route.
//
// Restrictions appliquées :
//   1. Premier mot doit être SELECT ou WITH (CTE) — sinon rejet
//   2. Pas de `;` (multi-statements interdits même si better-sqlite3
//      n'en compile qu'un, on veut un message d'erreur explicite)
//   3. Cap dur à MAX_ROWS lignes dans la réponse
//   4. Timeout implicite : better-sqlite3 est synchrone donc une query
//      longue bloque le process — on compte sur nos données de taille
//      modeste pour que ça reste instantané
// ─────────────────────────────────────────────────────────────────────

const { db, getDbStats } = require('../db/sqlite');
const { DB_VIEWER_HTML } = require('../pages/db-viewer');

// Cap sur le nombre de lignes renvoyées. Protège à la fois :
//   - La mémoire serveur (pas de result set monstrueux)
//   - Le rendu côté client (innerHTML de 10k lignes = freeze)
const MAX_ROWS = 1000;

// Whitelist des verbes SQL en tête de query. `WITH` permet les CTE
// (`WITH x AS (...) SELECT ...`). Tout le reste est rejeté.
const ALLOWED_VERBS = new Set(['select', 'with']);

// Valide qu'une query est "safe" à exécuter. Retourne null si OK, ou
// un message d'erreur humain-lisible sinon.
function validateSql(sql) {
  const trimmed = String(sql || '').trim();
  if (!trimmed) return 'Query vide.';

  // Premier mot — case-insensitive, sans commentaires éventuels au début.
  // On strip les commentaires -- ... et /* ... */ en début de query.
  const cleaned = trimmed
    .replace(/^\/\*[\s\S]*?\*\//, '')
    .replace(/^--[^\n]*\n/, '')
    .trim();
  const firstWord = cleaned.split(/\s+/, 1)[0].toLowerCase();
  if (!ALLOWED_VERBS.has(firstWord)) {
    return 'Seules les queries SELECT / WITH sont autorisées (reçu: ' + firstWord + ').';
  }

  // Rejet des multi-statements. On autorise un `;` final (pratique copier-coller
  // depuis un éditeur SQL) mais pas au milieu.
  const woFinal = trimmed.replace(/;\s*$/, '');
  if (woFinal.includes(';')) {
    return 'Multi-statements interdits (un seul SELECT par query).';
  }

  return null;
}

function registerDbViewerRoutes(app, requireAuth) {
  app.get('/db-viewer', requireAuth, (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(DB_VIEWER_HTML);
  });

  // Diagnostic global : taille fichier + count/range par table. Appelé
  // au chargement de /db-viewer pour afficher un résumé en haut de page.
  app.get('/api/db-stats', requireAuth, (_req, res) => {
    try {
      res.json(getDbStats());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/db-query', requireAuth, (req, res) => {
    const sql = (req.body && req.body.sql) || '';
    const err = validateSql(sql);
    if (err) return res.status(400).json({ error: err });

    try {
      const stmt = db.prepare(sql);
      // `.all()` retourne toutes les rows — on cappe après coup car
      // better-sqlite3 n'a pas d'option `maxRows` en prepare().
      const rows = stmt.all();
      const capped = rows.length > MAX_ROWS;
      res.json({
        rows: capped ? rows.slice(0, MAX_ROWS) : rows,
        totalRows: rows.length,
        capped,
      });
    } catch (e) {
      // Expose le message SQLite tel quel — utile pour debugger la query.
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { registerDbViewerRoutes, validateSql };
