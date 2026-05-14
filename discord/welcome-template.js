// ─────────────────────────────────────────────────────────────────────
// discord/welcome-template.js — Template du message de bienvenue
// ─────────────────────────────────────────────────────────────────────
// Single source of truth pour le template welcome :
//   - DEFAULT_WELCOME_TEMPLATE : valeur par défaut (fallback DB-absent)
//   - applyTemplate(text, vars) : substitution {user}/{start_here}
//   - validateTemplate(text)    : règles serveur-side avant set
//   - getEffectiveTemplate()    : lit la setting, fallback default
//   - setTemplate(text)         : valide puis écrit
//   - resetTemplate()           : efface l'override (retour au default)
//
// Aucune dépendance discord.js — le listener importe d'ici, pas
// l'inverse. La DB est touchée seulement par les 3 fonctions du bas.
//
// Spec : docs/superpowers/specs/2026-05-14-welcome-message-editor-design.md
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_WELCOME_TEMPLATE =
  '{user} welcome to TOB! Please start with {start_here} and watch us for a week or so to get familiar with the discord.';

// Pure: substitute all occurrences of {user} and {start_here}. Unknown
// placeholders pass through verbatim (Discord will render them as text).
function applyTemplate(template, { userId, startHereId }) {
  return String(template == null ? '' : template)
    .split('{user}').join('<@' + userId + '>')
    .split('{start_here}').join('<#' + startHereId + '>');
}

// Server-side validation. Returns { ok: true } or { ok: false, error }.
function validateTemplate(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Le template doit être une chaîne de caractères.' };
  if (!text.trim()) return { ok: false, error: 'Le template ne peut pas être vide.' };
  if (text.length > 2000) return { ok: false, error: 'Le template dépasse la limite Discord de 2000 caractères.' };
  if (!text.includes('{user}')) return { ok: false, error: 'Le template doit contenir {user} pour ping le nouveau membre.' };
  return { ok: true };
}

module.exports = {
  DEFAULT_WELCOME_TEMPLATE,
  applyTemplate,
  validateTemplate,
};
