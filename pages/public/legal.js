// ─────────────────────────────────────────────────────────────────────
// pages/public/legal.js — Pages légales (GET /terms et /privacy)
// ─────────────────────────────────────────────────────────────────────
// Templates statiques. À remplacer par les CGV / Politique de confidentialité
// rédigées avec un juriste avant le lancement officiel.
// L'admin pourra les éditer via /admin/marketing → settings KV
//   marketing.terms_html, marketing.privacy_html (HTML brut autorisé).
// Si la KV est absente, on utilise le template ci-dessous (placeholder).
// ─────────────────────────────────────────────────────────────────────

const db = require('../../db/sqlite');
const { publicLayoutHTML, escapeHtml } = require('../common');

const DEFAULT_TERMS = `
<p><strong>⚠️ Placeholder — replace with attorney-reviewed Terms of Service before launch.</strong></p>
<p>By subscribing to %BRAND%, you agree to the following terms:</p>
<h3>1. Service description</h3>
<p>%BRAND% provides real-time relay of curated trading signals to your Discord server. Signals are not financial advice — you trade at your own risk.</p>
<h3>2. Subscription &amp; billing</h3>
<p>Plans are billed monthly or annually as selected at checkout. Subscriptions auto-renew until cancelled. You can cancel anytime from your account dashboard or by contacting support.</p>
<h3>3. Acceptable use</h3>
<p>You agree not to share, redistribute, or resell signals received through the service. Each license is tied to a single Discord server. Sharing licenses violates these terms and may result in immediate termination without refund.</p>
<h3>4. Disclaimer</h3>
<p>Trading involves risk of loss. %BRAND% does not guarantee profits or accuracy of signals. Past performance does not indicate future results. Consult a licensed financial advisor before making investment decisions.</p>
<h3>5. Refund policy</h3>
<p>Within the first 7 days of your initial subscription, you may request a full refund if the service is non-functional. After 7 days, no refunds — but you can cancel future renewals at any time.</p>
<h3>6. Liability</h3>
<p>%BRAND% is provided "as is" without warranty. We are not liable for any losses, missed signals, or service interruptions.</p>
<h3>7. Contact</h3>
<p>For questions about these terms, contact us at the email listed on your invoice.</p>
`;

const DEFAULT_PRIVACY = `
<p><strong>⚠️ Placeholder — replace with attorney-reviewed Privacy Policy before launch.</strong></p>
<h3>1. Data we collect</h3>
<p>When you subscribe, we collect: your email address, your Discord server ID (Guild ID), payment information (handled by our payment processor — Stripe or Launchpass — we never see card details), and basic usage logs (last login, last signal received).</p>
<h3>2. How we use it</h3>
<p>Email: to send you the claim code and login magic-links. Server ID: to deliver signals to your server. Payment info: to process subscriptions. Usage logs: to debug issues and provide support.</p>
<h3>3. Third parties</h3>
<p>Stripe (payment processing), Launchpass (alternative payment), Resend (transactional email). These vendors have their own privacy policies and we only share what's strictly needed for them to function.</p>
<h3>4. Data retention</h3>
<p>Your email and Discord server ID are kept while your subscription is active. Within 30 days of cancellation, you can request deletion via support.</p>
<h3>5. Your rights</h3>
<p>You can request a copy of your data, correction, or deletion at any time. Contact support with your request — we will respond within 14 days.</p>
<h3>6. Cookies</h3>
<p>We use a single session cookie (<code>tob_customer_session</code>) for the customer dashboard. No tracking cookies, no analytics, no advertising.</p>
<h3>7. Contact</h3>
<p>For privacy-related questions, contact us at the email listed on your invoice.</p>
`;

function renderTerms(opts = {}) {
  return renderLegalPage('/terms', 'Terms of Service', 'marketing.terms_html', DEFAULT_TERMS, opts);
}

function renderPrivacy(opts = {}) {
  return renderLegalPage('/privacy', 'Privacy Policy', 'marketing.privacy_html', DEFAULT_PRIVACY, opts);
}

function renderLegalPage(path, title, settingKey, defaultHtml, opts) {
  const brandName = opts.brandName || 'Temple of Boom';
  // Si l'admin a édité, utiliser la version éditée. Sinon le template
  // par défaut. Le HTML est trusted ici (édité par l'admin uniquement).
  const html = (db.getSetting(settingKey, defaultHtml) || defaultHtml)
    .replace(/%BRAND%/g, escapeHtml(brandName));

  const content = `
    <section class="public-section">
      <h1 class="public-h2">${escapeHtml(title)}</h1>
      <p style="color: #707080; font-size: 13px;">Last updated: ${new Date().toISOString().slice(0, 10)}</p>
      <div class="public-prose" style="margin-top: 24px;">
        ${html}
      </div>
    </section>
  `;

  return publicLayoutHTML(path, content, {
    title: `${title} — ${brandName}`,
    brandName,
    isCustomerLoggedIn: opts.isCustomerLoggedIn,
  });
}

module.exports = { renderTerms, renderPrivacy, DEFAULT_TERMS, DEFAULT_PRIVACY };
