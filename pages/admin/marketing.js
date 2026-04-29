// ─────────────────────────────────────────────────────────────────────
// pages/admin/marketing.js — Admin CMS pour copy marketing
// ─────────────────────────────────────────────────────────────────────
//   GET /admin/marketing — édition hero, features, FAQ, terms, privacy
//
// Stocke dans la table settings KV sous des clés `marketing.*`.
// Utilise des textareas (form-friendly) pour text simple, JSON textareas
// pour les arrays.
// ─────────────────────────────────────────────────────────────────────

const db = require('../../db/sqlite');
const { COMMON_CSS, sidebarHTML, escapeHtml } = require('../common');
const { DEFAULT_HERO, DEFAULT_FEATURES, DEFAULT_STEPS } = require('../public/landing');
const { DEFAULT_FAQ } = require('../public/faq');

const MARKETING_CSS = `
  .admin-content { padding: 32px; max-width: 960px; margin: 0 auto; }
  .admin-h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; color: #fafafa; margin-bottom: 8px; }
  .admin-sub { color: #a0a0b0; font-size: 14px; margin-bottom: 32px; }
  .section-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .section-card h2 { font-size: 18px; font-weight: 700; color: #fafafa; margin-bottom: 6px; }
  .section-card .help { color: #a0a0b0; font-size: 13px; margin-bottom: 18px; line-height: 1.6; }
  .section-card label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 6px; margin-top: 14px; }
  .section-card input, .section-card textarea { width: 100%; }
  .section-card textarea.json { font-family: 'Courier New', monospace; font-size: 13px; min-height: 200px; }
  .section-card textarea.html { font-family: 'Courier New', monospace; font-size: 13px; min-height: 240px; }
  .section-actions { display: flex; gap: 10px; margin-top: 18px; }
  .btn-secondary { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-secondary:hover { background: rgba(255,255,255,0.08); }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; box-shadow: 0 8px 32px rgba(0,0,0,0.4); display: none; z-index: 100; }
  .toast.success { background: rgba(59,165,93,0.95); color: #fff; }
  .toast.error { background: rgba(239,68,68,0.95); color: #fff; }
`;

const MARKETING_JS = `
<script>
(function() {
  function showToast(msg, type) {
    const t = document.querySelector('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (type || 'success');
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3500);
  }

  document.querySelectorAll('form.section-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const section = form.dataset.section;
      const fmt = form.dataset.format; // 'object' | 'array' | 'html'
      let value;
      try {
        if (fmt === 'object') {
          value = {};
          for (const el of form.elements) {
            if (!el.name) continue;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              value[el.name] = el.value;
            }
          }
        } else if (fmt === 'array') {
          const ta = form.querySelector('textarea[name="json"]');
          value = JSON.parse(ta.value);
          if (!Array.isArray(value)) throw new Error('Must be a JSON array');
        } else if (fmt === 'html') {
          const ta = form.querySelector('textarea[name="html"]');
          value = ta.value;
        } else {
          throw new Error('Unknown format ' + fmt);
        }
      } catch (err) {
        showToast('Parse error: ' + err.message, 'error');
        return;
      }
      try {
        const r = await fetch('/api/admin/marketing/' + encodeURIComponent(section), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        const data = await r.json();
        if (!data.ok) { showToast(data.error || 'Save failed', 'error'); return; }
        showToast('Saved.');
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  document.querySelectorAll('button.btn-reset').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Reset to default? Your custom version will be lost.')) return;
      const section = btn.dataset.section;
      try {
        const r = await fetch('/api/admin/marketing/' + encodeURIComponent(section), {
          method: 'DELETE',
        });
        const data = await r.json();
        if (!data.ok) { showToast(data.error || 'Reset failed', 'error'); return; }
        showToast('Reset to default. Reloading...');
        setTimeout(() => location.reload(), 800);
      } catch (err) { showToast(err.message, 'error'); }
    });
  });
})();
</script>
`;

function renderAdminMarketing(opts = {}) {
  const hero = db.getSetting('marketing.hero', DEFAULT_HERO);
  const features = db.getSetting('marketing.features', DEFAULT_FEATURES);
  const steps = db.getSetting('marketing.steps', DEFAULT_STEPS);
  const faq = db.getSetting('marketing.faq', DEFAULT_FAQ);
  const termsHtml = db.getSetting('marketing.terms_html', null);
  const privacyHtml = db.getSetting('marketing.privacy_html', null);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Marketing</title>
<style>${COMMON_CSS}${MARKETING_CSS}</style>
</head>
<body>
${sidebarHTML('/admin/marketing')}
<div class="page-content">
  <div class="admin-content">
    <h1 class="admin-h1">Marketing copy</h1>
    <p class="admin-sub">Edit the public-facing landing copy. Changes apply instantly. <a href="/admin/plans" style="color: #c4b5fd;">← Back to plans</a></p>

    <!-- HERO -->
    <div class="section-card">
      <h2>Hero (top of /)</h2>
      <p class="help">The big headline + subtitle + CTA buttons on the landing page.</p>
      <form class="section-form" data-section="hero" data-format="object">
        <label>Title</label>
        <input type="text" name="title" value="${escapeHtml(hero.title || '')}">

        <label>Subtitle</label>
        <textarea name="subtitle" rows="3">${escapeHtml(hero.subtitle || '')}</textarea>

        <label>Primary CTA text</label>
        <input type="text" name="cta_primary" value="${escapeHtml(hero.cta_primary || '')}">

        <label>Secondary CTA text</label>
        <input type="text" name="cta_secondary" value="${escapeHtml(hero.cta_secondary || '')}">

        <div class="section-actions">
          <button type="submit" class="btn-primary">Save hero</button>
          <button type="button" class="btn-reset btn-secondary" data-section="hero">Reset to default</button>
        </div>
      </form>
    </div>

    <!-- FEATURES -->
    <div class="section-card">
      <h2>Features (cards on landing)</h2>
      <p class="help">JSON array of <code>{ icon, title, description }</code>. Recommended: 3 to 6 features. Icons are emoji.</p>
      <form class="section-form" data-section="features" data-format="array">
        <textarea class="json" name="json">${escapeHtml(JSON.stringify(features, null, 2))}</textarea>
        <div class="section-actions">
          <button type="submit" class="btn-primary">Save features</button>
          <button type="button" class="btn-reset btn-secondary" data-section="features">Reset to default</button>
        </div>
      </form>
    </div>

    <!-- STEPS -->
    <div class="section-card">
      <h2>Steps "How it works"</h2>
      <p class="help">JSON array of <code>{ number, title, description }</code>. Typically 3-5 steps.</p>
      <form class="section-form" data-section="steps" data-format="array">
        <textarea class="json" name="json">${escapeHtml(JSON.stringify(steps, null, 2))}</textarea>
        <div class="section-actions">
          <button type="submit" class="btn-primary">Save steps</button>
          <button type="button" class="btn-reset btn-secondary" data-section="steps">Reset to default</button>
        </div>
      </form>
    </div>

    <!-- FAQ -->
    <div class="section-card">
      <h2>FAQ (/faq page)</h2>
      <p class="help">JSON array of <code>{ q, a }</code>. Question + answer.</p>
      <form class="section-form" data-section="faq" data-format="array">
        <textarea class="json" name="json">${escapeHtml(JSON.stringify(faq, null, 2))}</textarea>
        <div class="section-actions">
          <button type="submit" class="btn-primary">Save FAQ</button>
          <button type="button" class="btn-reset btn-secondary" data-section="faq">Reset to default</button>
        </div>
      </form>
    </div>

    <!-- TERMS -->
    <div class="section-card">
      <h2>Terms of Service (/terms)</h2>
      <p class="help">Raw HTML. Use <code>%BRAND%</code> as placeholder for your brand name. Replace with attorney-reviewed version before launch.</p>
      <form class="section-form" data-section="terms_html" data-format="html">
        <textarea class="html" name="html">${escapeHtml(termsHtml || '')}</textarea>
        <p style="font-size: 12px; color: #707080; margin-top: 6px;">${termsHtml ? 'Custom version active.' : 'Currently using default placeholder.'}</p>
        <div class="section-actions">
          <button type="submit" class="btn-primary">Save terms</button>
          <button type="button" class="btn-reset btn-secondary" data-section="terms_html">Reset to default</button>
        </div>
      </form>
    </div>

    <!-- PRIVACY -->
    <div class="section-card">
      <h2>Privacy Policy (/privacy)</h2>
      <p class="help">Raw HTML. Same rules as terms.</p>
      <form class="section-form" data-section="privacy_html" data-format="html">
        <textarea class="html" name="html">${escapeHtml(privacyHtml || '')}</textarea>
        <p style="font-size: 12px; color: #707080; margin-top: 6px;">${privacyHtml ? 'Custom version active.' : 'Currently using default placeholder.'}</p>
        <div class="section-actions">
          <button type="submit" class="btn-primary">Save privacy</button>
          <button type="button" class="btn-reset btn-secondary" data-section="privacy_html">Reset to default</button>
        </div>
      </form>
    </div>
  </div>
</div>
<div id="toast" class="toast"></div>
${MARKETING_JS}
</body>
</html>`;
}

module.exports = { renderAdminMarketing };
