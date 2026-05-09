// ─────────────────────────────────────────────────────────────────────
// utils/pick-tease.js — Picker contextuel pour le texte du tease vidéo
// ─────────────────────────────────────────────────────────────────────
// Sélectionne un { teaseAction, teaseSubtext } depuis un pool de
// variations défini dans video/messages/contexts.json, en fonction du
// contexte de la vidéo (entry / exit-win-small / exit-win-big).
//
// Picker SEEDÉ (déterministe) : un même seed produit toujours la même
// phrase. Avantages :
//   - Si tu re-render le même item, t'as la même phrase (pas de surprise)
//   - Tests reproductibles
//
// Pour BoomRecap, le tagline + CTA sont gérés ailleurs (parser direct).
// Le 20% floor pour les proofs est appliqué dans le handler/routes
// AVANT d'appeler ce picker — pas la responsabilité d'ici.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, '..', 'video', 'messages', 'contexts.json');

let _pool = null;
function loadPool() {
  if (_pool) return _pool;
  const raw = fs.readFileSync(POOL_PATH, 'utf-8');
  _pool = JSON.parse(raw);
  return _pool;
}

// Extrait un nombre depuis une string PnL ("+30%", "-5%", "+12.5%").
// Retourne null si non parsable.
function parsePnlNumeric(pnl) {
  if (pnl === null || pnl === undefined) return null;
  const m = String(pnl).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Détermine le contexte pour le picker, basé sur le type d'item gallery
// + le PnL extrait. Retourne null si le contexte n'est pas géré ici
// (ex: 'recap' qui a son propre flow).
function pickContext({ type, pnl }) {
  // Signal/entry : pas de PnL pertinent (l'entrée n'a pas encore tourné).
  if (type === 'signal' || type === 'entry') return 'entry';
  // Proof / exit : split par PnL — gros gains gagnent un wording plus spectaculaire.
  if (type === 'proof' || type === 'exit') {
    const num = parsePnlNumeric(pnl);
    return (num !== null && num >= 50) ? 'exit-win-big' : 'exit-win-small';
  }
  // Recap traité ailleurs (parse-recap.js produit le tagline directement).
  return null;
}

// Hash déterministe d'une string seed → entier non-négatif.
// Algorithme : DJB2-like (boucle XOR/shift). Pas crypto — juste pour
// distribuer uniformément les indices dans le pool.
function hashSeed(seed) {
  const s = String(seed || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;  // force 32-bit signed
  }
  return Math.abs(hash);
}

// API publique : retourne { teaseAction, teaseSubtext, context } ou null
// si le contexte n'est pas géré (ex: type=recap).
function pickTease({ type, pnl, seed }) {
  const ctx = pickContext({ type, pnl });
  if (!ctx) return null;
  const pool = loadPool()[ctx];
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const idx = hashSeed(seed) % pool.length;
  const picked = pool[idx];
  return {
    teaseAction:  picked.teaseAction,
    teaseSubtext: picked.teaseSubtext,
    context:      ctx,
  };
}

module.exports = { pickTease, pickContext, parsePnlNumeric, hashSeed };
