// ─────────────────────────────────────────────────────────────────────
// pages/account/login.js — GET /account/login (form magic-link email)
// ─────────────────────────────────────────────────────────────────────
// Page publique. Form simple : email → POST /account/login → email envoyé
// → redirect /check-email.
// ─────────────────────────────────────────────────────────────────────

const { publicLayoutHTML, escapeHtml } = require('../common');

function renderAccountLogin(opts = {}) {
  const brandName = opts.brandName || 'Trading Signals';
  const error = opts.error ? escapeHtml(opts.error) : null;
  const prefilledEmail = opts.prefilledEmail ? escapeHtml(opts.prefilledEmail) : '';

  const errorBlock = error
    ? `<div style="background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px;">${error}</div>`
    : '';

  const content = `
    <section class="public-section" style="max-width: 440px; margin: 80px auto;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 class="public-h2">Sign in to your account</h1>
        <p style="color: #a0a0b0; margin-top: 8px;">We'll send you a secure sign-in link by email.</p>
      </div>

      <div class="card">
        ${errorBlock}
        <form method="POST" action="/account/login">
          <label style="display: block; font-size: 13px; font-weight: 600; color: #a0a0b0; margin-bottom: 8px;" for="email">
            Your email
          </label>
          <input
            type="email"
            id="email"
            name="email"
            placeholder="you@example.com"
            value="${prefilledEmail}"
            required
            autocomplete="email"
            autofocus
            style="width: 100%; padding: 12px 14px; font-size: 15px;"
          />
          <button
            type="submit"
            class="btn-primary"
            style="width: 100%; margin-top: 16px; padding: 12px; font-size: 15px;"
          >Send sign-in link</button>
        </form>
        <p style="color: #707080; font-size: 12px; margin-top: 18px; text-align: center; line-height: 1.6;">
          Don't have an account yet? <a href="/pricing" style="color: #c4b5fd;">Subscribe to a plan</a> first.
        </p>
      </div>
    </section>
  `;

  return publicLayoutHTML('/account/login', content, {
    title: `Sign in — ${brandName}`,
    brandName,
  });
}

module.exports = { renderAccountLogin };
