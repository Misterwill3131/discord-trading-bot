// ─────────────────────────────────────────────────────────────────────
// pages/public/pricing.js — Page de tarification (GET /pricing)
// ─────────────────────────────────────────────────────────────────────
// Lit dynamiquement les plans actifs depuis la table `plans` (DB).
// Tout changement via /admin/plans est immédiatement reflété ici.
//
// Chaque plan a 2 boutons de paiement :
//   - "Pay with Stripe"  → POST /api/checkout/stripe { plan_id, interval }
//   - "Pay with Launchpass" → lien direct vers plan.launchpass_url
//
// Si le plan a UNIQUEMENT un launchpass_url (pas de stripe_price_id), on
// affiche seulement le bouton Launchpass. Idem inverse.
// Si AUCUN moyen de paiement n'est configuré pour un plan, on affiche
// "Coming soon" disabled.
//
// Toggle Monthly/Annual : si price_annual_cents est défini, l'utilisateur
// peut basculer ; sinon on affiche uniquement le prix mensuel.
// ─────────────────────────────────────────────────────────────────────

const db = require('../../db/sqlite');
const { publicLayoutHTML, escapeHtml } = require('../common');

// Format prix en string lisible. cents=12345 → "$123.45"
function formatPrice(cents, currency) {
  if (cents == null) return '—';
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  const v = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  return `${symbol}${v}`;
}

function renderPricing(opts = {}) {
  const plans = db.planList(true); // active only
  const brandName = opts.brandName || 'Trading Signals';

  const cardsHtml = plans.length === 0
    ? `<div class="card" style="grid-column: 1/-1; text-align: center; color: #a0a0b0;">No plans available yet. Check back soon.</div>`
    : plans.map(p => renderPlanCard(p)).join('');

  const content = `
    <section class="public-section" style="text-align: center;">
      <h1 class="public-h1" style="font-size: 44px;">Simple, transparent pricing</h1>
      <p class="public-lead" style="margin: 18px auto 0;">Pick a plan that fits your community. Cancel anytime, no questions asked.</p>
    </section>

    <section class="public-section">
      <div class="pricing-grid">${cardsHtml}</div>
    </section>

    <section class="public-section" style="text-align: center;">
      <h2 class="public-h2" style="font-size: 24px;">Questions before you commit?</h2>
      <p class="public-lead" style="margin: 12px auto 24px;">Our FAQ covers setup, billing, refunds, and the most common gotchas.</p>
      <div class="hero-cta" style="justify-content: center;">
        <a href="/faq" class="secondary">Read FAQ</a>
      </div>
    </section>
  `;

  return publicLayoutHTML('/pricing', content, {
    title: `Pricing — ${brandName}`,
    brandName,
    isCustomerLoggedIn: opts.isCustomerLoggedIn,
  });
}

// Render une carte de plan. Plan = { id, name, description, price_monthly_cents,
// price_annual_cents, currency, features, highlight_label, stripe_price_id_*,
// launchpass_url }.
function renderPlanCard(plan) {
  const monthly = plan.price_monthly_cents;
  const annual = plan.price_annual_cents;
  const currency = plan.currency || 'USD';
  const featuresHtml = (plan.features || []).map(f => `<li>${escapeHtml(f)}</li>`).join('');

  const hasStripeMonthly = !!plan.stripe_price_id_monthly;
  const hasStripeAnnual = !!plan.stripe_price_id_annual;
  const hasLaunchpass = !!plan.launchpass_url;

  // Bouton Stripe (mensuel par défaut, JS toggle pour annuel)
  let stripeBtn = '';
  if (hasStripeMonthly || hasStripeAnnual) {
    stripeBtn = `<button class="stripe" data-action="stripe" data-plan-id="${escapeHtml(plan.id)}" data-interval="monthly">
      Pay with Stripe
    </button>`;
  }

  // Bouton Launchpass
  let lpBtn = '';
  if (hasLaunchpass) {
    lpBtn = `<a class="launchpass" href="${escapeHtml(plan.launchpass_url)}" target="_blank" rel="noopener noreferrer">Pay with Launchpass</a>`;
  }

  const noPayment = !hasStripeMonthly && !hasStripeAnnual && !hasLaunchpass;
  const payButtons = noPayment
    ? `<button class="launchpass" disabled style="opacity: 0.5; cursor: not-allowed;">Coming soon</button>`
    : `${stripeBtn}${lpBtn}`;

  // Toggle annual/monthly si les 2 prix sont dispos
  let priceBlock;
  if (monthly != null && annual != null) {
    priceBlock = `
      <div class="price" data-monthly="${monthly}" data-annual="${annual}">
        <span class="price-amount">${formatPrice(monthly, currency)}</span>
        <span class="price-suffix"> /mo</span>
      </div>
      <div style="margin: 12px 0; display: inline-flex; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 4px;">
        <button class="toggle-btn active" data-period="monthly" style="background: rgba(139,92,246,0.2); color: #c4b5fd; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">Monthly</button>
        <button class="toggle-btn" data-period="annual" style="background: transparent; color: #a0a0b0; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">Annual</button>
      </div>
    `;
  } else if (monthly != null) {
    priceBlock = `<div class="price">${formatPrice(monthly, currency)}<span class="price-suffix"> /mo</span></div>`;
  } else if (annual != null) {
    priceBlock = `<div class="price">${formatPrice(annual, currency)}<span class="price-suffix"> /yr</span></div>`;
  } else {
    priceBlock = `<div class="price">—</div>`;
  }

  const highlightBadge = plan.highlight_label
    ? `<div class="badge">${escapeHtml(plan.highlight_label)}</div>` : '';
  const cardClass = plan.highlight_label ? 'pricing-card highlight' : 'pricing-card';

  return `
    <div class="${cardClass}" data-plan-id="${escapeHtml(plan.id)}">
      ${highlightBadge}
      <div class="name">${escapeHtml(plan.name || plan.id)}</div>
      ${priceBlock}
      <div class="desc">${escapeHtml(plan.description || '')}</div>
      <ul>${featuresHtml}</ul>
      <div class="pay-buttons">
        ${payButtons}
      </div>
    </div>
  `;
}

// Script JS injecté côté client : gère le toggle monthly/annual + redirige
// vers le checkout Stripe quand on clique le bouton.
const PRICING_CLIENT_JS = `
<script>
(function() {
  // Toggle monthly/annual sur chaque carte
  document.querySelectorAll('.pricing-card').forEach(card => {
    const priceEl = card.querySelector('.price[data-monthly]');
    if (!priceEl) return;
    const monthlyCents = parseInt(priceEl.dataset.monthly, 10);
    const annualCents = parseInt(priceEl.dataset.annual, 10);
    const stripeBtn = card.querySelector('button.stripe');
    const amountEl = priceEl.querySelector('.price-amount');
    const suffixEl = priceEl.querySelector('.price-suffix');

    card.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const period = btn.dataset.period;
        // Update active state
        card.querySelectorAll('.toggle-btn').forEach(b => {
          if (b === btn) {
            b.classList.add('active');
            b.style.background = 'rgba(139,92,246,0.2)';
            b.style.color = '#c4b5fd';
          } else {
            b.classList.remove('active');
            b.style.background = 'transparent';
            b.style.color = '#a0a0b0';
          }
        });
        // Update price
        const cents = period === 'annual' ? annualCents : monthlyCents;
        const dollars = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
        amountEl.textContent = '$' + dollars;
        suffixEl.textContent = period === 'annual' ? ' /yr' : ' /mo';
        // Update Stripe interval data
        if (stripeBtn) stripeBtn.dataset.interval = period;
      });
    });
  });

  // Stripe checkout
  document.querySelectorAll('button[data-action="stripe"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const planId = btn.dataset.planId;
      const interval = btn.dataset.interval || 'monthly';
      const email = prompt('Enter your email to receive your access code after payment:');
      if (!email) return;
      btn.disabled = true; btn.textContent = 'Processing...';
      try {
        const res = await fetch('/api/checkout/stripe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_id: planId, interval, email }),
        });
        const data = await res.json();
        if (data.ok && data.url) {
          window.location = data.url;
        } else {
          alert('Checkout error: ' + (data.error || 'Unknown error'));
          btn.disabled = false; btn.textContent = 'Pay with Stripe';
        }
      } catch (e) {
        alert('Network error: ' + e.message);
        btn.disabled = false; btn.textContent = 'Pay with Stripe';
      }
    });
  });
})();
</script>
`;

// Combine la page + le script. Le layout HTML de base se termine par
// </body></html>, donc on injecte le script juste avant cette fermeture.
function renderPricingWithJs(opts) {
  const html = renderPricing(opts);
  return html.replace('</body>', `${PRICING_CLIENT_JS}</body>`);
}

module.exports = {
  renderPricing: renderPricingWithJs,
  formatPrice,
};
