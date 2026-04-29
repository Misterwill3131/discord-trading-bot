// ─────────────────────────────────────────────────────────────────────
// routes/admin-cms.js — API CRUD pour le CMS admin
// ─────────────────────────────────────────────────────────────────────
//   Pages (HTML, requireAuth) :
//     GET /admin/plans              → liste/édition plans
//     GET /admin/marketing          → édition copy
//
//   API JSON (requireAuth) :
//     GET    /api/admin/plans       → liste tous (incluant inactive)
//     GET    /api/admin/plans/:id   → détail + form HTML pour expand
//     POST   /api/admin/plans       → créer
//     PUT    /api/admin/plans/:id   → mettre à jour
//     DELETE /api/admin/plans/:id   → supprimer
//
//     GET    /api/admin/marketing/:section → lit depuis settings KV
//     PUT    /api/admin/marketing/:section → écrit dans settings KV
//     DELETE /api/admin/marketing/:section → reset (efface l'override)
// ─────────────────────────────────────────────────────────────────────

const db = require('../db/sqlite');
const { renderAdminPlans, planEditForm } = require('../pages/admin/plans');
const { renderAdminMarketing } = require('../pages/admin/marketing');

// Sections marketing valides + format autorisé. Empêche d'écrire des clés
// arbitraires dans settings via l'API admin.
const MARKETING_SECTIONS = {
  hero:         { format: 'object' },
  features:     { format: 'array' },
  steps:        { format: 'array' },
  faq:          { format: 'array' },
  terms_html:   { format: 'string' },
  privacy_html: { format: 'string' },
};

function sendHtml(res, html) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// Validation stricte du payload plan. Retourne { ok, error?, sanitized? }.
function validatePlanInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Body required' };
  if (!input.id || typeof input.id !== 'string') return { ok: false, error: 'id required' };
  if (!/^[a-z0-9_-]+$/.test(input.id)) return { ok: false, error: 'id must be lowercase letters/digits/-/_' };
  if (input.id.length > 32) return { ok: false, error: 'id too long (max 32 chars)' };
  if (!input.name || typeof input.name !== 'string') return { ok: false, error: 'name required' };
  if (input.name.length > 100) return { ok: false, error: 'name too long (max 100)' };

  if (input.price_monthly_cents != null && (typeof input.price_monthly_cents !== 'number' || input.price_monthly_cents < 0)) {
    return { ok: false, error: 'price_monthly_cents must be ≥ 0' };
  }
  if (input.price_annual_cents != null && (typeof input.price_annual_cents !== 'number' || input.price_annual_cents < 0)) {
    return { ok: false, error: 'price_annual_cents must be ≥ 0' };
  }
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) {
    return { ok: false, error: 'currency must be 3-letter ISO code' };
  }
  if (!Array.isArray(input.features) && input.features != null) {
    return { ok: false, error: 'features must be an array' };
  }
  return { ok: true, sanitized: input };
}

function registerAdminCmsRoutes(app, requireAuth) {
  // ── Pages HTML ────────────────────────────────────────────────────
  app.get('/admin/plans', requireAuth, (_req, res) => {
    sendHtml(res, renderAdminPlans());
  });
  app.get('/admin/marketing', requireAuth, (_req, res) => {
    sendHtml(res, renderAdminMarketing());
  });

  // ── API plans ─────────────────────────────────────────────────────
  app.get('/api/admin/plans', requireAuth, (_req, res) => {
    res.json({ ok: true, plans: db.planList(false) });
  });

  app.get('/api/admin/plans/:id', requireAuth, (req, res) => {
    const plan = db.planGet(req.params.id);
    if (!plan) return res.status(404).json({ ok: false, error: 'Plan not found' });
    res.json({ ok: true, plan, formHtml: planEditForm(plan) });
  });

  app.post('/api/admin/plans', requireAuth, (req, res) => {
    const v = validatePlanInput(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const existing = db.planGet(v.sanitized.id);
    if (existing) return res.status(409).json({ ok: false, error: 'Plan with this id already exists' });
    db.planUpsert(v.sanitized);
    db.adminActionInsert({
      admin: req.user || 'admin',
      action: 'plan-create',
      payload: { id: v.sanitized.id },
    });
    res.json({ ok: true, plan: db.planGet(v.sanitized.id) });
  });

  app.put('/api/admin/plans/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    const body = { ...(req.body || {}), id };
    const v = validatePlanInput(body);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const existing = db.planGet(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Plan not found' });
    db.planUpsert(v.sanitized);
    db.adminActionInsert({
      admin: req.user || 'admin',
      action: 'plan-update',
      payload: { id, fields: Object.keys(req.body || {}) },
    });
    res.json({ ok: true, plan: db.planGet(id) });
  });

  app.delete('/api/admin/plans/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    if (!db.planGet(id)) return res.status(404).json({ ok: false, error: 'Plan not found' });
    db.planDelete(id);
    db.adminActionInsert({
      admin: req.user || 'admin',
      action: 'plan-delete',
      payload: { id },
    });
    res.json({ ok: true });
  });

  // ── API marketing ─────────────────────────────────────────────────
  app.get('/api/admin/marketing/:section', requireAuth, (req, res) => {
    const section = req.params.section;
    if (!MARKETING_SECTIONS[section]) return res.status(404).json({ ok: false, error: 'Unknown section' });
    const value = db.getSetting('marketing.' + section, null);
    res.json({ ok: true, section, value });
  });

  app.put('/api/admin/marketing/:section', requireAuth, (req, res) => {
    const section = req.params.section;
    const meta = MARKETING_SECTIONS[section];
    if (!meta) return res.status(404).json({ ok: false, error: 'Unknown section' });
    if (!req.body || !('value' in req.body)) return res.status(400).json({ ok: false, error: 'Body { value } required' });
    const value = req.body.value;

    if (meta.format === 'array' && !Array.isArray(value)) {
      return res.status(400).json({ ok: false, error: 'Value must be an array' });
    }
    if (meta.format === 'object' && (typeof value !== 'object' || Array.isArray(value) || value === null)) {
      return res.status(400).json({ ok: false, error: 'Value must be an object' });
    }
    if (meta.format === 'string' && typeof value !== 'string') {
      return res.status(400).json({ ok: false, error: 'Value must be a string' });
    }

    db.setSetting('marketing.' + section, value);
    db.adminActionInsert({
      admin: req.user || 'admin',
      action: 'marketing-update',
      payload: { section },
    });
    res.json({ ok: true });
  });

  app.delete('/api/admin/marketing/:section', requireAuth, (req, res) => {
    const section = req.params.section;
    if (!MARKETING_SECTIONS[section]) return res.status(404).json({ ok: false, error: 'Unknown section' });
    db.setSetting('marketing.' + section, null);
    db.adminActionInsert({
      admin: req.user || 'admin',
      action: 'marketing-reset',
      payload: { section },
    });
    res.json({ ok: true });
  });
}

module.exports = { registerAdminCmsRoutes };
