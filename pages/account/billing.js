// ─────────────────────────────────────────────────────────────────────
// pages/account/billing.js — Page /account/billing (factures + cancel)
// ─────────────────────────────────────────────────────────────────────
// Affiche les invoices Stripe (si stripe_customer_id défini) + bouton
// "Manage subscription" qui redirige vers Stripe Billing Portal.
// Le portal Stripe gère lui-même cancel, update card, view invoices PDF.
// ─────────────────────────────────────────────────────────────────────

const { publicLayoutHTML, escapeHtml } = require('../common');
const { accountNavHTML, fmtDate } = require('./dashboard');

function fmtAmount(cents, currency) {
  if (cents == null) return '—';
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

function statusLabel(status) {
  const map = {
    paid:        { color: '#86efac', label: 'Paid' },
    open:        { color: '#fcd34d', label: 'Open' },
    void:        { color: '#9ca3af', label: 'Void' },
    uncollectible: { color: '#fca5a5', label: 'Uncollectible' },
    draft:       { color: '#9ca3af', label: 'Draft' },
  };
  const s = map[status] || { color: '#9ca3af', label: status || '—' };
  return `<span style="color: ${s.color}; font-weight: 600;">${escapeHtml(s.label)}</span>`;
}

// invoices = array of Stripe Invoice objects (raw API response).
function renderInvoiceTable(invoices) {
  if (!invoices || invoices.length === 0) {
    return `<div style="padding: 24px; text-align: center; color: #a0a0b0;">No invoices yet.</div>`;
  }
  const rows = invoices.map(inv => `
    <tr style="border-top: 1px solid rgba(255,255,255,0.05);">
      <td style="padding: 12px 14px; color: #c0c0cc;">${escapeHtml(fmtDate(new Date((inv.created || 0) * 1000).toISOString()))}</td>
      <td style="padding: 12px 14px; color: #fafafa; font-weight: 600;">${fmtAmount(inv.amount_paid || inv.amount_due, (inv.currency || 'usd').toUpperCase())}</td>
      <td style="padding: 12px 14px;">${statusLabel(inv.status)}</td>
      <td style="padding: 12px 14px; text-align: right;">
        ${inv.hosted_invoice_url ? `<a href="${escapeHtml(inv.hosted_invoice_url)}" target="_blank" rel="noopener noreferrer" style="color: #c4b5fd; font-size: 13px;">View →</a>` : ''}
      </td>
    </tr>
  `).join('');
  return `
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      <thead>
        <tr style="text-align: left;">
          <th style="padding: 12px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Date</th>
          <th style="padding: 12px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Amount</th>
          <th style="padding: 12px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderAccountBilling(opts = {}) {
  const brandName = opts.brandName || 'Temple of Boom';
  const customer = opts.customer || {};
  const invoices = opts.invoices || [];
  const stripeConfigured = !!opts.stripeConfigured;
  const hasStripeCustomer = !!customer.stripe_customer_id;
  const error = opts.error ? escapeHtml(opts.error) : null;

  const errorBlock = error
    ? `<div style="background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px;">${error}</div>`
    : '';

  let portalSection;
  if (!stripeConfigured) {
    portalSection = `
      <div class="card">
        <h3 class="public-h3">Stripe billing portal</h3>
        <p style="color: #a0a0b0; font-size: 14px; margin-top: 8px; line-height: 1.6;">
          Stripe is not configured on this instance. Use Launchpass to manage your subscription, or contact support.
        </p>
      </div>
    `;
  } else if (!hasStripeCustomer) {
    portalSection = `
      <div class="card">
        <h3 class="public-h3">Stripe billing portal</h3>
        <p style="color: #a0a0b0; font-size: 14px; margin-top: 8px; line-height: 1.6;">
          You don't have a Stripe-managed subscription on this account. If you paid via Launchpass, manage your subscription there directly.
        </p>
      </div>
    `;
  } else {
    portalSection = `
      <div class="card">
        <h3 class="public-h3">Manage your subscription</h3>
        <p style="color: #a0a0b0; font-size: 14px; margin-top: 8px; line-height: 1.6; margin-bottom: 16px;">
          Update payment method, download invoices, or cancel your subscription via the secure Stripe portal.
        </p>
        <form method="POST" action="/account/billing/portal">
          <button type="submit" class="btn-primary" style="padding: 11px 22px;">Open Stripe Portal →</button>
        </form>
      </div>
    `;
  }

  const content = `
    <h1 class="public-h2" style="font-size: 32px; margin-bottom: 8px;">Billing</h1>
    <p style="color: #a0a0b0; margin-bottom: 24px;">Manage your subscription and view invoices.</p>

    ${accountNavHTML('/account/billing')}
    ${errorBlock}

    ${portalSection}

    <div class="card" style="margin-top: 16px; padding: 0; overflow: hidden;">
      <div style="padding: 20px 24px 0;"><h3 class="public-h3">Invoices</h3></div>
      <div style="margin-top: 16px;">
        ${renderInvoiceTable(invoices)}
      </div>
    </div>
  `;

  return publicLayoutHTML('/account/billing', content, {
    title: `Billing — ${brandName}`,
    brandName,
    isCustomerLoggedIn: true,
  });
}

module.exports = { renderAccountBilling };
