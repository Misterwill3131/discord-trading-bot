// ─────────────────────────────────────────────────────────────────────
// pages/admin/plans.js — Admin CMS pour les plans tarifaires
// ─────────────────────────────────────────────────────────────────────
//   GET /admin/plans — liste tous les plans (actifs + inactifs)
//
// UI : tableau avec colonnes Name / Price / Status / Actions. Chaque ligne
// expandable en form d'édition. Bouton "+ New plan" en haut.
//
// L'API CRUD (POST/PUT/DELETE) est dans routes/admin-cms.js.
// ─────────────────────────────────────────────────────────────────────

const db = require('../../db/sqlite');
const { COMMON_CSS, sidebarHTML, escapeHtml } = require('../common');

const ADMIN_CSS = `
  .admin-content { padding: 32px; max-width: 1200px; margin: 0 auto; }
  .admin-h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; color: #fafafa; margin-bottom: 8px; }
  .admin-sub { color: #a0a0b0; font-size: 14px; margin-bottom: 32px; }
  .admin-toolbar { display: flex; gap: 12px; margin-bottom: 24px; align-items: center; }
  .plans-table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; overflow: hidden; }
  .plans-table th { text-align: left; padding: 14px 18px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; background: rgba(255,255,255,0.02); border-bottom: 1px solid rgba(255,255,255,0.06); }
  .plans-table td { padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.04); color: #fafafa; font-size: 14px; vertical-align: top; }
  .plans-table tr:last-child td { border-bottom: none; }
  .plan-status { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .plan-status.active { background: rgba(59,165,93,0.15); color: #86efac; }
  .plan-status.inactive { background: rgba(107,114,128,0.15); color: #9ca3af; }
  .plan-edit-row { background: rgba(0,0,0,0.3); }
  .plan-edit-form { padding: 20px 24px; }
  .plan-edit-form label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 6px; margin-top: 12px; }
  .plan-edit-form .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .plan-edit-form input, .plan-edit-form textarea, .plan-edit-form select { width: 100%; }
  .plan-edit-form textarea { min-height: 80px; font-family: 'Courier New', monospace; font-size: 13px; }
  .plan-edit-actions { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); }
  .btn-danger { background: rgba(239,68,68,0.1); color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-danger:hover { background: rgba(239,68,68,0.2); }
  .btn-secondary { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-secondary:hover { background: rgba(255,255,255,0.08); }
  .btn-edit { background: transparent; border: 1px solid rgba(139,92,246,0.3); color: #c4b5fd; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn-edit:hover { background: rgba(139,92,246,0.1); }
  .empty-state { padding: 48px 24px; text-align: center; color: #a0a0b0; }
  .field-help { font-size: 12px; color: #707080; margin-top: 4px; line-height: 1.4; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; box-shadow: 0 8px 32px rgba(0,0,0,0.4); display: none; z-index: 100; }
  .toast.success { background: rgba(59,165,93,0.95); color: #fff; }
  .toast.error { background: rgba(239,68,68,0.95); color: #fff; }
`;

function fmtPrice(cents, currency) {
  if (cents == null) return '—';
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${sym}${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

// Form template pour créer/éditer un plan. `plan` = null pour création.
function planEditForm(plan) {
  const isNew = !plan || !plan.id;
  const p = plan || {
    id: '', name: '', description: '', price_monthly_cents: null, price_annual_cents: null,
    currency: 'USD', is_active: true, display_order: 0, features: [],
    highlight_label: '', stripe_price_id_monthly: '', stripe_price_id_annual: '',
    launchpass_url: '',
  };
  const featuresText = (p.features || []).join('\n');

  return `
    <form class="plan-edit-form" data-plan-id="${escapeHtml(p.id || '')}" data-is-new="${isNew ? '1' : '0'}">
      <div class="row">
        <div>
          <label>ID (slug, no spaces)</label>
          <input type="text" name="id" value="${escapeHtml(p.id)}" ${isNew ? 'required' : 'readonly'} pattern="[a-z0-9_-]+" placeholder="starter">
          <div class="field-help">Lowercase letters, numbers, hyphen, underscore. Cannot be changed after creation.</div>
        </div>
        <div>
          <label>Display name</label>
          <input type="text" name="name" value="${escapeHtml(p.name)}" required placeholder="Starter">
        </div>
      </div>
      <label>Description (one-liner shown on pricing card)</label>
      <input type="text" name="description" value="${escapeHtml(p.description || '')}" placeholder="Perfect for solo traders">

      <div class="row">
        <div>
          <label>Monthly price (USD cents)</label>
          <input type="number" name="price_monthly_cents" value="${p.price_monthly_cents != null ? p.price_monthly_cents : ''}" min="0" placeholder="4900">
          <div class="field-help">${p.price_monthly_cents != null ? '= ' + fmtPrice(p.price_monthly_cents, p.currency) + '/mo' : 'Empty = hide monthly option'}</div>
        </div>
        <div>
          <label>Annual price (USD cents)</label>
          <input type="number" name="price_annual_cents" value="${p.price_annual_cents != null ? p.price_annual_cents : ''}" min="0" placeholder="49000">
          <div class="field-help">${p.price_annual_cents != null ? '= ' + fmtPrice(p.price_annual_cents, p.currency) + '/yr' : 'Empty = hide annual option'}</div>
        </div>
      </div>

      <div class="row">
        <div>
          <label>Currency</label>
          <select name="currency">
            <option value="USD"${p.currency === 'USD' ? ' selected' : ''}>USD</option>
            <option value="EUR"${p.currency === 'EUR' ? ' selected' : ''}>EUR</option>
            <option value="GBP"${p.currency === 'GBP' ? ' selected' : ''}>GBP</option>
            <option value="CAD"${p.currency === 'CAD' ? ' selected' : ''}>CAD</option>
          </select>
        </div>
        <div>
          <label>Display order (smaller = left)</label>
          <input type="number" name="display_order" value="${p.display_order || 0}" min="0" max="999">
        </div>
      </div>

      <label>Highlight badge (optional)</label>
      <input type="text" name="highlight_label" value="${escapeHtml(p.highlight_label || '')}" placeholder='Most Popular'>
      <div class="field-help">Adds a coloured pill badge on the pricing card. Empty = no badge.</div>

      <label>Features list (one per line, shown as bullet points)</label>
      <textarea name="features">${escapeHtml(featuresText)}</textarea>

      <label>Stripe Price ID — monthly</label>
      <input type="text" name="stripe_price_id_monthly" value="${escapeHtml(p.stripe_price_id_monthly || '')}" placeholder="price_1AbCdEfGhIjKlMn">
      <div class="field-help">From Stripe Dashboard → Products → your product → Pricing.</div>

      <label>Stripe Price ID — annual</label>
      <input type="text" name="stripe_price_id_annual" value="${escapeHtml(p.stripe_price_id_annual || '')}" placeholder="price_1AbCdEfGhIjKlMn">

      <label>Launchpass URL</label>
      <input type="url" name="launchpass_url" value="${escapeHtml(p.launchpass_url || '')}" placeholder="https://launchpass.com/your-server/your-tier">

      <label style="display: flex; align-items: center; gap: 8px; margin-top: 16px; cursor: pointer;">
        <input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''} style="width: auto;">
        <span style="font-size: 14px; color: #fafafa; text-transform: none; letter-spacing: 0; font-weight: 500;">Active (visible on /pricing)</span>
      </label>

      <div class="plan-edit-actions">
        <button type="submit" class="btn-primary">${isNew ? 'Create plan' : 'Save changes'}</button>
        <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
        ${!isNew ? `<button type="button" class="btn-danger" data-action="delete" data-plan-id="${escapeHtml(p.id)}" style="margin-left: auto;">Delete plan</button>` : ''}
      </div>
    </form>
  `;
}

const ADMIN_CLIENT_JS = `
<script>
(function() {
  const tableBody = document.querySelector('#plans-tbody');
  if (!tableBody) return;

  function showToast(msg, type) {
    const t = document.querySelector('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (type || 'success');
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3500);
  }

  // Click "Edit" → expand row with form
  document.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('button[data-action="edit"]');
    if (editBtn) {
      const planId = editBtn.dataset.planId;
      const tr = editBtn.closest('tr');
      const existing = tr.nextElementSibling;
      if (existing && existing.classList.contains('plan-edit-row')) {
        existing.remove();
        return;
      }
      try {
        const r = await fetch('/api/admin/plans/' + encodeURIComponent(planId));
        const data = await r.json();
        if (!data.ok) { showToast(data.error || 'Failed to load', 'error'); return; }
        const formHtml = data.formHtml;
        const newRow = document.createElement('tr');
        newRow.className = 'plan-edit-row';
        newRow.innerHTML = '<td colspan="6">' + formHtml + '</td>';
        tr.after(newRow);
      } catch (err) { showToast(err.message, 'error'); }
    }

    const cancelBtn = e.target.closest('button[data-action="cancel"]');
    if (cancelBtn) {
      const row = cancelBtn.closest('tr');
      if (row) row.remove();
    }

    const deleteBtn = e.target.closest('button[data-action="delete"]');
    if (deleteBtn) {
      const planId = deleteBtn.dataset.planId;
      if (!confirm('Delete plan "' + planId + '"? This cannot be undone. (Existing licenses are NOT affected.)')) return;
      try {
        const r = await fetch('/api/admin/plans/' + encodeURIComponent(planId), { method: 'DELETE' });
        const data = await r.json();
        if (!data.ok) { showToast(data.error || 'Failed to delete', 'error'); return; }
        showToast('Plan deleted. Reloading...');
        setTimeout(() => location.reload(), 800);
      } catch (err) { showToast(err.message, 'error'); }
    }
  });

  // Submit form
  document.addEventListener('submit', async (e) => {
    if (!e.target.matches('form.plan-edit-form')) return;
    e.preventDefault();
    const form = e.target;
    const isNew = form.dataset.isNew === '1';
    const data = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') {
        data[el.name] = el.checked;
      } else if (el.name === 'features') {
        data.features = el.value.split('\\n').map(s => s.trim()).filter(Boolean);
      } else if (el.type === 'number') {
        data[el.name] = el.value === '' ? null : parseInt(el.value, 10);
      } else {
        data[el.name] = el.value;
      }
    }
    const url = isNew ? '/api/admin/plans' : '/api/admin/plans/' + encodeURIComponent(data.id);
    const method = isNew ? 'POST' : 'PUT';
    try {
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await r.json();
      if (!result.ok) { showToast(result.error || 'Failed to save', 'error'); return; }
      showToast(isNew ? 'Plan created.' : 'Saved.', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (err) { showToast(err.message, 'error'); }
  });

  // New plan button
  const newBtn = document.querySelector('#btn-new-plan');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      const existing = document.querySelector('tr.plan-edit-row[data-new]');
      if (existing) { existing.remove(); return; }
      const newRow = document.createElement('tr');
      newRow.className = 'plan-edit-row';
      newRow.dataset.new = '1';
      newRow.innerHTML = '<td colspan="6">' + window.__newPlanForm + '</td>';
      tableBody.prepend(newRow);
    });
  }
})();
</script>
`;

function renderAdminPlans(opts = {}) {
  const plans = db.planList(false); // include inactive
  const newPlanFormHtml = planEditForm(null);

  let tbody;
  if (plans.length === 0) {
    tbody = `<tr><td colspan="6" class="empty-state">No plans yet. Click "+ New plan" to create one.</td></tr>`;
  } else {
    tbody = plans.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong><br><span style="color: #707080; font-size: 12px; font-family: monospace;">${escapeHtml(p.id)}</span></td>
        <td>${fmtPrice(p.price_monthly_cents, p.currency)}<br><span style="color: #707080; font-size: 12px;">/mo</span></td>
        <td>${fmtPrice(p.price_annual_cents, p.currency)}<br><span style="color: #707080; font-size: 12px;">/yr</span></td>
        <td><span class="plan-status ${p.is_active ? 'active' : 'inactive'}">${p.is_active ? 'Active' : 'Inactive'}</span></td>
        <td style="color: #a0a0b0; font-size: 12px;">${escapeHtml((p.features || []).slice(0, 3).join(' · '))}</td>
        <td style="text-align: right;"><button type="button" class="btn-edit" data-action="edit" data-plan-id="${escapeHtml(p.id)}">Edit</button></td>
      </tr>
    `).join('');
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Plans</title>
<style>${COMMON_CSS}${ADMIN_CSS}</style>
</head>
<body>
${sidebarHTML('/admin/plans')}
<div class="page-content">
  <div class="admin-content">
    <h1 class="admin-h1">Plans</h1>
    <p class="admin-sub">Edit pricing, features, and Stripe/Launchpass IDs. Changes apply to <a href="/pricing" style="color: #c4b5fd;">/pricing</a> instantly.</p>

    <div class="admin-toolbar">
      <a href="/admin/marketing" class="btn-secondary" style="text-decoration: none;">Edit marketing copy →</a>
      <button id="btn-new-plan" class="btn-primary" style="margin-left: auto;">+ New plan</button>
    </div>

    <table class="plans-table">
      <thead>
        <tr>
          <th>Name / ID</th>
          <th>Monthly</th>
          <th>Annual</th>
          <th>Status</th>
          <th>Features</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="plans-tbody">${tbody}</tbody>
    </table>
  </div>
</div>
<div id="toast" class="toast"></div>
<script>window.__newPlanForm = ${JSON.stringify(newPlanFormHtml)};</script>
${ADMIN_CLIENT_JS}
</body>
</html>`;
}

module.exports = { renderAdminPlans, planEditForm };
