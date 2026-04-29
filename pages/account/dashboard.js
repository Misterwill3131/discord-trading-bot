// ─────────────────────────────────────────────────────────────────────
// pages/account/dashboard.js — Page /account (panel client principal)
// ─────────────────────────────────────────────────────────────────────
// Affiche le statut de l'abonnement courant, le serveur Discord lié,
// l'expiration, et liens vers billing/preferences/logout.
// ─────────────────────────────────────────────────────────────────────

const { publicLayoutHTML, escapeHtml } = require('../common');

// Sub-nav de l'espace client (tabs en haut du contenu).
function accountNavHTML(activePath) {
  const links = [
    { href: '/account', label: 'Overview' },
    { href: '/account/billing', label: 'Billing' },
    { href: '/account/preferences', label: 'Preferences' },
  ];
  const linksHtml = links.map(l => {
    const active = l.href === activePath;
    return `<a href="${l.href}" style="padding: 10px 16px; font-size: 14px; font-weight: 600; color: ${active ? '#fafafa' : '#a0a0b0'}; text-decoration: none; border-bottom: 2px solid ${active ? '#8b5cf6' : 'transparent'};">${l.label}</a>`;
  }).join('');
  return `
    <div style="display: flex; gap: 4px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 32px;">
      ${linksHtml}
      <form method="POST" action="/account/logout" style="margin-left: auto; align-self: center;">
        <button type="submit" style="background: transparent; border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;">Sign out</button>
      </form>
    </div>
  `;
}

function statusBadge(status) {
  const styles = {
    active:    { bg: 'rgba(59,165,93,0.15)',  fg: '#86efac', label: 'Active' },
    pending:   { bg: 'rgba(251,191,36,0.15)', fg: '#fcd34d', label: 'Pending setup' },
    suspended: { bg: 'rgba(239,68,68,0.15)',  fg: '#fca5a5', label: 'Suspended' },
    expired:   { bg: 'rgba(107,114,128,0.15)', fg: '#9ca3af', label: 'Expired' },
    cancelled: { bg: 'rgba(107,114,128,0.15)', fg: '#9ca3af', label: 'Cancelled' },
  };
  const s = styles[status] || styles.pending;
  return `<span style="background: ${s.bg}; color: ${s.fg}; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;">${s.label}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

// dto = {
//   customer: { email, guild_id },
//   license: { status, plan, expires_at, target_channel_id, last_relay_at, ... } OR null,
//   inviteUrl, helpUrl,
// }
function renderAccountDashboard(opts = {}) {
  const brandName = opts.brandName || 'Temple of Boom';
  const customer = opts.customer || {};
  const license = opts.license;
  const inviteUrl = opts.inviteUrl || '#';
  const helpUrl = opts.helpUrl || '#';

  const noLicense = !license;
  const guildLinked = !!(license && license.guild_id);
  const channelSet = !!(license && license.target_channel_id);

  // Section principale : status card
  let statusCard;
  if (noLicense) {
    statusCard = `
      <div class="card">
        <h3 class="public-h3" style="margin-bottom: 8px;">No active subscription</h3>
        <p style="color: #a0a0b0; font-size: 14px; line-height: 1.6;">
          Your account exists, but you don't have an active license yet. Either complete your initial setup with a claim code, or subscribe to a plan.
        </p>
        <div class="hero-cta" style="margin-top: 20px;">
          <a href="/pricing" class="primary">View plans</a>
          <a href="${escapeHtml(helpUrl)}" class="secondary">I have a code</a>
        </div>
      </div>
    `;
  } else {
    const planLabel = license.plan ? license.plan.charAt(0).toUpperCase() + license.plan.slice(1) : '—';
    statusCard = `
      <div class="card">
        <div style="display: flex; align-items: start; justify-content: space-between; gap: 16px; flex-wrap: wrap;">
          <div>
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Subscription</div>
            <div style="font-size: 24px; font-weight: 700; color: #fafafa; margin-top: 4px;">${escapeHtml(planLabel)}</div>
          </div>
          ${statusBadge(license.status)}
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-top: 24px;">
          <div>
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Expires</div>
            <div style="font-size: 16px; color: #fafafa; margin-top: 4px;">${escapeHtml(fmtDate(license.expires_at))}</div>
          </div>
          <div>
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Last signal received</div>
            <div style="font-size: 16px; color: #fafafa; margin-top: 4px;">${escapeHtml(fmtDate(license.last_relay_at))}</div>
          </div>
          <div>
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0;">Target channel</div>
            <div style="font-size: 16px; color: #fafafa; margin-top: 4px;">${license.target_channel_id ? '#' + escapeHtml(license.target_channel_id.slice(-8)) : 'Not set'}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Onboarding helper si setup pas fini
  let onboardingCard = '';
  if (license && (!guildLinked || !channelSet)) {
    onboardingCard = `
      <div class="card" style="margin-top: 16px; background: rgba(59,130,246,0.05); border-color: rgba(59,130,246,0.3);">
        <h3 class="public-h3" style="margin-bottom: 12px;">⚙️ Finish setup</h3>
        ${!guildLinked ? `
          <p style="color: #c0c0cc; font-size: 14px; line-height: 1.6; margin-bottom: 12px;">
            Your subscription is active but not yet linked to a Discord server. Follow the setup guide:
          </p>
          <a href="${escapeHtml(helpUrl)}" class="hero-cta primary" style="display: inline-block; padding: 10px 20px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600;">View setup guide</a>
        ` : `
          <p style="color: #c0c0cc; font-size: 14px; line-height: 1.6;">
            Bot is connected to your Discord server. Run <code style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">/setup channel:#alerts</code> on your server to choose where signals are posted.
          </p>
        `}
      </div>
    `;
  }

  const content = `
    <h1 class="public-h2" style="font-size: 32px; margin-bottom: 8px;">My account</h1>
    <p style="color: #a0a0b0; margin-bottom: 24px;">Signed in as <strong style="color: #fafafa;">${escapeHtml(customer.email || '')}</strong></p>

    ${accountNavHTML('/account')}

    ${statusCard}
    ${onboardingCard}

    <div class="card" style="margin-top: 16px;">
      <h3 class="public-h3" style="margin-bottom: 12px;">Quick actions</h3>
      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <a href="/account/billing" class="hero-cta secondary" style="padding: 10px 18px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Manage billing</a>
        <a href="/account/preferences" class="hero-cta secondary" style="padding: 10px 18px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Preferences</a>
        <a href="/faq" class="hero-cta secondary" style="padding: 10px 18px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">FAQ</a>
      </div>
    </div>
  `;

  return publicLayoutHTML('/account', content, {
    title: `My account — ${brandName}`,
    brandName,
    isCustomerLoggedIn: true,
  });
}

module.exports = { renderAccountDashboard, accountNavHTML, statusBadge, fmtDate };
