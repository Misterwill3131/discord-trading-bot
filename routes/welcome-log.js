// ─────────────────────────────────────────────────────────────────────
// routes/welcome-log.js — GET /welcome-log + API /api/welcome-message
// ─────────────────────────────────────────────────────────────────────
//   GET    /welcome-log              — page HTML (auth)
//   GET    /api/welcome-message      — { ok, template, default, isDefault } (auth)
//   PUT    /api/welcome-message      — body { template } → { ok } | { ok:false, error } (auth)
//   DELETE /api/welcome-message      — reset to default → { ok } (auth)
// ─────────────────────────────────────────────────────────────────────

const { renderWelcomeLogPage } = require('../pages/welcome-log');
const { getWelcomeLog } = require('../state/welcome-log');
const {
  DEFAULT_WELCOME_TEMPLATE,
  getEffectiveTemplate,
  setTemplate,
  resetTemplate,
} = require('../discord/welcome-template');

function registerWelcomeLogRoutes(app, requireAuth) {
  // Page HTML.
  app.get('/welcome-log', requireAuth, (_req, res) => {
    const tpl = getEffectiveTemplate();
    res.set('Content-Type', 'text/html');
    res.send(renderWelcomeLogPage(getWelcomeLog(), tpl));
  });

  // Read current template.
  app.get('/api/welcome-message', requireAuth, (_req, res) => {
    const tpl = getEffectiveTemplate();
    res.json({
      ok: true,
      template: tpl.template,
      default: DEFAULT_WELCOME_TEMPLATE,
      isDefault: tpl.isDefault,
    });
  });

  // Write a new template.
  app.put('/api/welcome-message', requireAuth, (req, res) => {
    const text = req.body && req.body.template;
    try {
      setTemplate(text);
      res.json({ ok: true });
    } catch (err) {
      // setTemplate throws Error with .code='INVALID_TEMPLATE' for validation failures.
      const status = err.code === 'INVALID_TEMPLATE' ? 400 : 500;
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // Reset to default.
  app.delete('/api/welcome-message', requireAuth, (_req, res) => {
    resetTemplate();
    res.json({ ok: true });
  });
}

module.exports = { registerWelcomeLogRoutes };
