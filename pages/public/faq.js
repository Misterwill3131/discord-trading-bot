// ─────────────────────────────────────────────────────────────────────
// pages/public/faq.js — FAQ publique (GET /faq)
// ─────────────────────────────────────────────────────────────────────
// Liste de questions / réponses en accordion. Customisable via la KV
// settings sous la clé `marketing.faq` (array of { q, a }).
// Si la clé est absente, on utilise les défauts ci-dessous.
// ─────────────────────────────────────────────────────────────────────

const db = require('../../db/sqlite');
const { publicLayoutHTML, escapeHtml } = require('../common');

const DEFAULT_FAQ = [
  {
    q: 'How do I get started after I subscribe?',
    a: 'Right after payment, you receive an email with a unique claim code. You then invite our bot to your Discord server (via the link in the email), run /connect <your_code>, and finally /setup #channel to choose where signals are posted. Total setup time: under 2 minutes.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Cancel from your /account/billing page or directly in Stripe / Launchpass. Your access stays active until the end of your current billing period.',
  },
  {
    q: 'What happens to messages already received if I cancel?',
    a: 'Nothing — they stay in your Discord server forever. Cancellation only stops new signals from being delivered.',
  },
  {
    q: 'Can I move my license to a different Discord server?',
    a: 'Yes. From /account/preferences you can switch to a different server. The bot will leave the old server and you re-invite it to the new one.',
  },
  {
    q: 'Do you charge per signal or unlimited?',
    a: 'Unlimited. Pay a flat monthly or annual fee and receive every signal your plan covers, no caps, no per-message billing.',
  },
  {
    q: 'Can my members share the bot with their friends?',
    a: 'No. Licenses are tied to a Discord server ID — if anyone invites the bot to a server without an active license, it auto-leaves within 30 seconds.',
  },
  {
    q: 'What information about the source is exposed?',
    a: 'None. Embeds are reconstructed from extracted data only (ticker, prices, conditions). No analyst name, no source server, no Discord IDs leak through. We strip all metadata before delivery.',
  },
  {
    q: 'What if I need to contact support?',
    a: 'Email us at the address listed on your invoice. We typically respond within 24 hours on business days.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'Yes — if our service is broken or you cannot get it working in your first 7 days, contact us for a full refund. After that, you can cancel future renewals at any time.',
  },
];

function renderFaq(opts = {}) {
  const faq = db.getSetting('marketing.faq', DEFAULT_FAQ);
  const brandName = opts.brandName || 'Trading Signals';

  const itemsHtml = faq.map(item => `
    <details class="faq-item">
      <summary>${escapeHtml(item.q)}</summary>
      <div class="answer">${escapeHtml(item.a)}</div>
    </details>
  `).join('');

  const content = `
    <section class="public-section" style="text-align: center;">
      <h1 class="public-h1" style="font-size: 44px;">Frequently asked questions</h1>
      <p class="public-lead" style="margin: 18px auto 0;">Everything you need to know before subscribing. Still have questions? Reach out.</p>
    </section>

    <section class="public-section" style="max-width: 800px; margin-left: auto; margin-right: auto;">
      ${itemsHtml}
    </section>
  `;

  return publicLayoutHTML('/faq', content, {
    title: `FAQ — ${brandName}`,
    brandName,
    isCustomerLoggedIn: opts.isCustomerLoggedIn,
  });
}

module.exports = { renderFaq, DEFAULT_FAQ };
