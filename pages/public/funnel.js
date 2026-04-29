// ─────────────────────────────────────────────────────────────────────
// pages/public/funnel.js — Pages du funnel post-action
// ─────────────────────────────────────────────────────────────────────
//   GET /success?session_id=X         — après checkout Stripe réussi
//   GET /check-email?email=X          — après envoi du magic-link
//   GET /connect-help?code=X          — tutoriel /connect (depuis l'email)
// ─────────────────────────────────────────────────────────────────────

const { publicLayoutHTML, escapeHtml } = require('../common');

function renderSuccess(opts = {}) {
  const brandName = opts.brandName || 'Trading Signals';
  const sessionId = opts.sessionId ? escapeHtml(opts.sessionId) : null;

  const content = `
    <section class="public-section" style="text-align: center; max-width: 640px; margin: 60px auto;">
      <div style="font-size: 64px; margin-bottom: 16px;">🎉</div>
      <h1 class="public-h2">Payment received!</h1>
      <p class="public-lead" style="margin: 18px auto;">
        Thank you for subscribing. We're sending your access code to your email right now.
      </p>
      <div class="card" style="text-align: left; margin-top: 32px;">
        <h3 class="public-h3">What happens next:</h3>
        <ol style="margin-left: 20px; line-height: 2; color: #c0c0cc;">
          <li>Check your inbox for an email from us (subject: "Welcome to ${escapeHtml(brandName)}")</li>
          <li>Follow the 3 simple steps in the email to connect the bot to your Discord server</li>
          <li>Run <code style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">/setup #your-channel</code> on your server</li>
          <li>Start receiving signals immediately</li>
        </ol>
        <p style="color: #a0a0b0; font-size: 13px; margin-top: 18px;">
          Email not arriving? Check your spam folder. If it's still missing after 5 minutes, contact support.
        </p>
      </div>
      ${sessionId ? `<p style="color: #707080; font-size: 12px; margin-top: 24px;">Reference: ${sessionId.slice(0, 32)}...</p>` : ''}
      <div class="hero-cta" style="justify-content: center; margin-top: 32px;">
        <a href="/account/login" class="primary">Access my account</a>
        <a href="/faq" class="secondary">Read FAQ</a>
      </div>
    </section>
  `;

  return publicLayoutHTML('/success', content, {
    title: `Payment confirmed — ${brandName}`,
    brandName,
  });
}

function renderCheckEmail(opts = {}) {
  const brandName = opts.brandName || 'Trading Signals';
  const email = opts.email ? escapeHtml(opts.email) : null;

  const content = `
    <section class="public-section" style="text-align: center; max-width: 600px; margin: 80px auto;">
      <div style="font-size: 64px; margin-bottom: 16px;">📧</div>
      <h1 class="public-h2">Check your email</h1>
      <p class="public-lead" style="margin: 18px auto;">
        ${email ? `We've sent a sign-in link to <strong style="color: #fafafa;">${email}</strong>.` : `We've sent a sign-in link to your inbox.`}
        Click the link in the email to access your account.
      </p>
      <div class="card" style="text-align: left; margin-top: 24px;">
        <p style="color: #a0a0b0; font-size: 14px; line-height: 1.7;">
          The link expires in <strong>15 minutes</strong>. If you don't see it within a couple of minutes, check your spam folder.
        </p>
        <p style="color: #a0a0b0; font-size: 14px; line-height: 1.7; margin-top: 12px;">
          Wrong email? <a href="/account/login" style="color: #c4b5fd;">Try again</a>.
        </p>
      </div>
    </section>
  `;

  return publicLayoutHTML('/account/login', content, {
    title: `Check your email — ${brandName}`,
    brandName,
  });
}

function renderConnectHelp(opts = {}) {
  const brandName = opts.brandName || 'Trading Signals';
  const code = opts.code ? escapeHtml(opts.code) : null;
  const inviteUrl = opts.inviteUrl ? escapeHtml(opts.inviteUrl) : '#';

  const content = `
    <section class="public-section" style="max-width: 720px; margin: 40px auto;">
      <h1 class="public-h2" style="text-align: center;">Connect the bot to your server</h1>
      <p class="public-lead" style="margin: 18px auto; text-align: center;">
        Just 3 steps and you're done. Follow them in order.
      </p>

      <div class="card" style="margin-top: 32px;">
        <h3 class="public-h3"><span style="color: #8b5cf6;">Step 1.</span> Invite the bot to your Discord server</h3>
        <p style="color: #c0c0cc; line-height: 1.7; margin-top: 8px;">
          Click the button below. You'll be asked which Discord server to add the bot to. Pick the server where you want signals delivered. You need <strong>Manage Server</strong> permission on that server.
        </p>
        <div style="margin-top: 16px;">
          <a href="${inviteUrl}" target="_blank" rel="noopener noreferrer" class="hero-cta primary" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600;">Invite bot to Discord</a>
        </div>
      </div>

      <div class="card" style="margin-top: 16px;">
        <h3 class="public-h3"><span style="color: #8b5cf6;">Step 2.</span> Connect your subscription</h3>
        <p style="color: #c0c0cc; line-height: 1.7; margin-top: 8px;">
          Once the bot is in your server, run this command in any text channel:
        </p>
        ${code ? `
          <div style="background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); padding: 14px 18px; border-radius: 8px; margin-top: 14px; font-family: 'Courier New', monospace; color: #c4b5fd; font-size: 16px; user-select: all;">
            /connect code:${code}
          </div>
          <p style="color: #707080; font-size: 12px; margin-top: 8px;">Click to select, then copy with Ctrl+C / Cmd+C.</p>
        ` : `
          <div style="background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); padding: 14px 18px; border-radius: 8px; margin-top: 14px; font-family: 'Courier New', monospace; color: #c4b5fd; font-size: 16px;">
            /connect code:&lt;your_code_from_email&gt;
          </div>
        `}
        <p style="color: #a0a0b0; font-size: 13px; margin-top: 12px; line-height: 1.6;">
          ⚠️ You have 30 seconds after inviting the bot to run this. If the timer expires, just re-invite the bot and try again.
        </p>
      </div>

      <div class="card" style="margin-top: 16px;">
        <h3 class="public-h3"><span style="color: #8b5cf6;">Step 3.</span> Choose where signals are posted</h3>
        <p style="color: #c0c0cc; line-height: 1.7; margin-top: 8px;">
          Pick a channel where the bot will post signals (create one if needed, ex: <code>#alerts</code>):
        </p>
        <div style="background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); padding: 14px 18px; border-radius: 8px; margin-top: 14px; font-family: 'Courier New', monospace; color: #c4b5fd; font-size: 16px;">
          /setup channel:#alerts
        </div>
        <p style="color: #a0a0b0; font-size: 13px; margin-top: 12px; line-height: 1.6;">
          The bot needs <strong>Send Messages</strong> + <strong>Embed Links</strong> permissions in this channel.
        </p>
      </div>

      <div style="margin-top: 32px; text-align: center; padding: 24px; background: rgba(59,130,246,0.05); border: 1px solid rgba(59,130,246,0.2); border-radius: 12px;">
        <p style="color: #fafafa; margin-bottom: 8px;">✅ <strong>That's it!</strong> You'll receive signals in <code>#alerts</code> as soon as analysts post them.</p>
        <p style="color: #a0a0b0; font-size: 13px;">
          Anytime: run <code style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px;">/status</code> to check your subscription.
        </p>
      </div>
    </section>
  `;

  return publicLayoutHTML('/connect-help', content, {
    title: `Connect the bot — ${brandName}`,
    brandName,
  });
}

module.exports = { renderSuccess, renderCheckEmail, renderConnectHelp };
