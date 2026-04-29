// ─────────────────────────────────────────────────────────────────────
// pages/public/landing.js — Landing page marketing publique (GET /)
// ─────────────────────────────────────────────────────────────────────
// Page d'accueil pour les visiteurs anonymes. Pas d'auth.
// Contenu marketing customisable via la table `settings` (KV) sous les clés :
//   marketing.hero       → { title, subtitle, cta_primary, cta_secondary }
//   marketing.features   → [{ icon, title, description }, ...]
//   marketing.steps      → [{ number, title, description }, ...]
//
// Si la clé est absente, on utilise les défauts définis ci-dessous.
// L'admin pourra éditer ces clés via /admin/marketing (Phase B).
// ─────────────────────────────────────────────────────────────────────

const db = require('../../db/sqlite');
const { publicLayoutHTML, escapeHtml } = require('../common');

const DEFAULT_HERO = {
  title: 'Real-time trading signals, delivered to your Discord.',
  subtitle: 'Get curated alerts from professional analysts streamed instantly to your private Discord server. Anonymous, encrypted, and fully managed — your members never know the source.',
  cta_primary: 'See pricing',
  cta_secondary: 'How it works',
};

const DEFAULT_FEATURES = [
  {
    icon: '⚡',
    title: 'Sub-second relay',
    description: 'Messages from our analyst feed reach your Discord server within ~500ms. Your members see signals as they break.',
  },
  {
    icon: '🔒',
    title: 'Source-blind delivery',
    description: 'Embeds are stripped of all source identifiers — no analyst name, no server, no channel ID. Your subscribers can never reverse-engineer the feed.',
  },
  {
    icon: '🎯',
    title: 'Smart signal parsing',
    description: 'Our parser auto-extracts ticker, entry, target, stop, and conditional triggers (break / bounce). Embed layout adapts to each signal type.',
  },
  {
    icon: '🛡️',
    title: 'Paywall enforcement',
    description: 'Your bot auto-leaves any server without an active license. License tied to Discord guild ID — un-shareable.',
  },
  {
    icon: '🔧',
    title: 'Self-service setup',
    description: 'Pay → receive claim code by email → invite bot → run /connect. From checkout to first signal in under 2 minutes.',
  },
  {
    icon: '🎨',
    title: 'Branded embeds',
    description: 'Every relayed signal carries your branding (color, footer, optional logo). Looks native to your server.',
  },
];

const DEFAULT_STEPS = [
  { number: '1', title: 'Pick a plan', description: 'Subscribe via Stripe or Launchpass. Monthly or annual billing.' },
  { number: '2', title: 'Get your code', description: 'Receive a unique claim code by email within seconds.' },
  { number: '3', title: 'Invite the bot', description: 'Click the OAuth link, choose your Discord server, and authorize.' },
  { number: '4', title: 'Start receiving', description: 'Run /connect <code> then /setup #channel — signals flow instantly.' },
];

function getMarketing(key, fallback) {
  return db.getSetting(`marketing.${key}`, fallback);
}

function renderLanding(opts = {}) {
  const hero = getMarketing('hero', DEFAULT_HERO);
  const features = getMarketing('features', DEFAULT_FEATURES);
  const steps = getMarketing('steps', DEFAULT_STEPS);
  const brandName = opts.brandName || 'Trading Signals';

  const featuresHtml = features.map(f => `
    <div class="card">
      <div class="feature-icon">${escapeHtml(f.icon || '✨')}</div>
      <div class="public-h3">${escapeHtml(f.title)}</div>
      <div style="color: #a0a0b0; font-size: 14px; line-height: 1.6;">${escapeHtml(f.description)}</div>
    </div>
  `).join('');

  const stepsHtml = steps.map(s => `
    <div class="card" style="text-align: center;">
      <div style="font-size: 36px; font-weight: 800; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; margin-bottom: 8px;">${escapeHtml(s.number)}</div>
      <div class="public-h3">${escapeHtml(s.title)}</div>
      <div style="color: #a0a0b0; font-size: 14px; line-height: 1.6;">${escapeHtml(s.description)}</div>
    </div>
  `).join('');

  const content = `
    <section class="public-section">
      <h1 class="public-h1">${escapeHtml(hero.title)}</h1>
      <p class="public-lead">${escapeHtml(hero.subtitle)}</p>
      <div class="hero-cta">
        <a href="/pricing" class="primary">${escapeHtml(hero.cta_primary || 'See pricing')}</a>
        <a href="#how-it-works" class="secondary">${escapeHtml(hero.cta_secondary || 'How it works')}</a>
      </div>
    </section>

    <section class="public-section">
      <h2 class="public-h2">Why ${escapeHtml(brandName)}?</h2>
      <p class="public-lead">Built specifically to operate paywalled trading-signal communities on Discord at scale.</p>
      <div class="feature-grid">${featuresHtml}</div>
    </section>

    <section class="public-section" id="how-it-works">
      <h2 class="public-h2">How it works</h2>
      <div class="feature-grid">${stepsHtml}</div>
    </section>

    <section class="public-section" style="text-align: center;">
      <h2 class="public-h2">Ready to start?</h2>
      <p class="public-lead" style="margin: 0 auto 28px;">Pick a plan and start streaming signals to your Discord in under 2 minutes.</p>
      <div class="hero-cta" style="justify-content: center;">
        <a href="/pricing" class="primary">View plans</a>
        <a href="/faq" class="secondary">Read FAQ</a>
      </div>
    </section>
  `;

  return publicLayoutHTML('/', content, {
    title: `${brandName} — Trading signals to your Discord`,
    brandName,
    isCustomerLoggedIn: opts.isCustomerLoggedIn,
  });
}

module.exports = {
  renderLanding,
  DEFAULT_HERO,
  DEFAULT_FEATURES,
  DEFAULT_STEPS,
};
