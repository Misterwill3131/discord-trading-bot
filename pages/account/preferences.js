// ─────────────────────────────────────────────────────────────────────
// pages/account/preferences.js — Page /account/preferences
// ─────────────────────────────────────────────────────────────────────
// Pour l'instant : info read-only sur le serveur Discord lié + bouton
// "Disconnect bot" (= force-leave) si l'utilisateur veut le retirer.
//
// Phase B+ : changer target_channel via web (au lieu de /setup Discord),
// gérer ticker_whitelist / sides filter / etc.
// ─────────────────────────────────────────────────────────────────────

const { publicLayoutHTML, escapeHtml } = require('../common');
const { accountNavHTML } = require('./dashboard');

function renderAccountPreferences(opts = {}) {
  const brandName = opts.brandName || 'Temple of Boom';
  const customer = opts.customer || {};
  const license = opts.license;
  const success = opts.success ? escapeHtml(opts.success) : null;
  const error = opts.error ? escapeHtml(opts.error) : null;

  const successBlock = success
    ? `<div style="background: rgba(59,165,93,0.1); border: 1px solid rgba(59,165,93,0.3); color: #86efac; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px;">✓ ${success}</div>`
    : '';
  const errorBlock = error
    ? `<div style="background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px;">${error}</div>`
    : '';

  let mainSection;
  if (!license) {
    mainSection = `
      <div class="card">
        <h3 class="public-h3">No active subscription</h3>
        <p style="color: #a0a0b0; font-size: 14px; margin-top: 8px;">
          Subscribe to a plan to access preferences. <a href="/pricing" style="color: #c4b5fd;">View plans →</a>
        </p>
      </div>
    `;
  } else {
    mainSection = `
      <div class="card">
        <h3 class="public-h3">Discord server</h3>
        <p style="color: #a0a0b0; font-size: 14px; margin-top: 8px; line-height: 1.6;">
          Your subscription is currently linked to Discord server ID <code style="background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 4px; color: #fafafa;">${license.guild_id ? escapeHtml(license.guild_id) : '(not yet linked)'}</code>.
        </p>
        ${license.target_channel_id ? `
          <p style="color: #a0a0b0; font-size: 14px; margin-top: 12px; line-height: 1.6;">
            Signals are posted in channel <code style="background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 4px; color: #fafafa;"><#${escapeHtml(license.target_channel_id)}></code>.
          </p>
        ` : `
          <p style="color: #fcd34d; font-size: 14px; margin-top: 12px; line-height: 1.6;">
            ⚠️ Target channel not set. Run <code style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">/setup channel:#alerts</code> on your Discord server.
          </p>
        `}
        <p style="color: #707080; font-size: 13px; margin-top: 16px; line-height: 1.6;">
          To change the channel, run <code style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">/setup channel:#new-channel</code> on your Discord server. To switch to a different server entirely, contact support.
        </p>
      </div>

      <div class="card" style="margin-top: 16px; border-color: rgba(239,68,68,0.2);">
        <h3 class="public-h3" style="color: #fca5a5;">Disconnect bot</h3>
        <p style="color: #a0a0b0; font-size: 14px; margin-top: 8px; line-height: 1.6;">
          This kicks the bot from your Discord server but does NOT cancel your subscription. To cancel billing, go to <a href="/account/billing" style="color: #c4b5fd;">Billing</a>.
        </p>
        <form method="POST" action="/account/preferences/disconnect" style="margin-top: 16px;" onsubmit="return confirm('Disconnect the bot from your Discord server? You can re-invite it later.');">
          <button type="submit" style="background: rgba(239,68,68,0.1); color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;">Disconnect bot</button>
        </form>
      </div>
    `;
  }

  const content = `
    <h1 class="public-h2" style="font-size: 32px; margin-bottom: 8px;">Preferences</h1>
    <p style="color: #a0a0b0; margin-bottom: 24px;">Manage how the bot delivers signals to your server.</p>

    ${accountNavHTML('/account/preferences')}
    ${successBlock}
    ${errorBlock}
    ${mainSection}
  `;

  return publicLayoutHTML('/account/preferences', content, {
    title: `Preferences — ${brandName}`,
    brandName,
    isCustomerLoggedIn: true,
  });
}

module.exports = { renderAccountPreferences };
