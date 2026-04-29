// ─────────────────────────────────────────────────────────────────────
// saas/email.js — Emails transactionnels du SaaS (Resend)
// ─────────────────────────────────────────────────────────────────────
// Distinct de notifications/email.js (qui est dédié aux alertes trading
// avec image attachée). Ici : emails post-paiement (welcome + claim_code)
// et login (magic-link).
//
// Lit RESEND_API_KEY + ALERT_EMAIL_FROM (réutilisé) depuis process.env.
// Si l'une manque, les fonctions sont des no-ops silencieux qui retournent
// { ok: false, error: 'not configured' }.
//
// Templates HTML inlinés ici — pas de moteur de template. Les variables
// substituées via simple replace.
// ─────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM);
}

// Envoie un email transactionnel via l'API Resend.
// Returns { ok, error? }.
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM;
  if (!apiKey || !from) {
    return { ok: false, error: 'email not configured (RESEND_API_KEY/ALERT_EMAIL_FROM missing)' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[saas/email] resend non-2xx:', res.status, body);
      return { ok: false, error: `${res.status} ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[saas/email] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Email envoyé après checkout réussi — contient le claim_code et le
// tutoriel /connect.
async function sendWelcomeEmail({ to, brandName, claimCode, inviteUrl, helpUrl, planName }) {
  const subject = `Welcome to ${brandName} — Your access code`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; margin: 0; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.06);">
    <div style="background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); padding: 32px 32px 24px; color: #ffffff;">
      <h1 style="margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.02em;">Welcome to ${escapeHtml(brandName)}!</h1>
      <p style="margin: 8px 0 0; opacity: 0.9; font-size: 15px;">Your subscription is active. ${planName ? `Plan: <strong>${escapeHtml(planName)}</strong>` : ''}</p>
    </div>

    <div style="padding: 32px;">
      <p style="margin: 0 0 20px; color: #1a1a1f; font-size: 15px; line-height: 1.6;">
        Thank you for subscribing. To start receiving signals on your Discord server, follow these 3 steps:
      </p>

      <div style="background: #f0f4ff; border-left: 4px solid #8b5cf6; padding: 16px 20px; margin-bottom: 20px; border-radius: 4px;">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6366f1;">Your access code</div>
        <div style="font-family: 'Courier New', monospace; font-size: 24px; font-weight: 700; color: #1a1a1f; margin-top: 6px; user-select: all;">${escapeHtml(claimCode)}</div>
      </div>

      <ol style="padding-left: 22px; color: #1a1a1f; line-height: 1.8;">
        <li><strong>Invite the bot</strong> to your Discord server: <br>
          <a href="${escapeHtml(inviteUrl)}" style="display: inline-block; margin-top: 6px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">Invite to Discord →</a>
        </li>
        <li style="margin-top: 16px;"><strong>Run this command</strong> on your Discord server (any text channel):
          <div style="background: #1a1a1f; color: #c4b5fd; font-family: 'Courier New', monospace; padding: 10px 14px; border-radius: 6px; margin-top: 6px; font-size: 14px; user-select: all;">/connect code:${escapeHtml(claimCode)}</div>
          <div style="font-size: 12px; color: #707080; margin-top: 4px;">⏱️ You have 30 seconds after inviting the bot.</div>
        </li>
        <li style="margin-top: 16px;"><strong>Choose a channel</strong> for signals:
          <div style="background: #1a1a1f; color: #c4b5fd; font-family: 'Courier New', monospace; padding: 10px 14px; border-radius: 6px; margin-top: 6px; font-size: 14px;">/setup channel:#alerts</div>
        </li>
      </ol>

      <p style="margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #707080; font-size: 13px; line-height: 1.6;">
        Need detailed instructions? <a href="${escapeHtml(helpUrl)}" style="color: #8b5cf6;">View the setup guide</a>.<br>
        Issues? Reply to this email and we'll help.
      </p>
    </div>

    <div style="padding: 16px 32px; background: #fafafa; color: #909090; font-size: 12px; text-align: center;">
      © ${new Date().getFullYear()} ${escapeHtml(brandName)}
    </div>
  </div>
</body>
</html>`;

  const text = `Welcome to ${brandName}!

Your access code: ${claimCode}

Setup instructions:

1. Invite the bot to your Discord server:
   ${inviteUrl}

2. Run this command on your server:
   /connect code:${claimCode}
   (You have 30 seconds after inviting the bot.)

3. Choose a channel for signals:
   /setup channel:#alerts

Detailed help: ${helpUrl}

Reply to this email if you need support.`;

  return sendEmail({ to, subject, html, text });
}

// Email envoyé pour login customer via magic-link.
async function sendMagicLinkEmail({ to, brandName, magicLinkUrl }) {
  const subject = `Sign in to ${brandName}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; margin: 0; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.06);">
    <div style="padding: 32px;">
      <h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 700; color: #1a1a1f;">Sign in to ${escapeHtml(brandName)}</h1>
      <p style="margin: 0 0 24px; color: #4a4a55; font-size: 15px; line-height: 1.6;">
        Click the button below to access your account. The link expires in 15 minutes.
      </p>
      <a href="${escapeHtml(magicLinkUrl)}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; padding: 13px 26px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Sign in to my account</a>
      <p style="margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #909090; font-size: 13px; line-height: 1.6;">
        Or copy this link into your browser:<br>
        <span style="word-break: break-all; color: #6366f1;">${escapeHtml(magicLinkUrl)}</span>
      </p>
      <p style="margin: 16px 0 0; color: #909090; font-size: 12px; line-height: 1.6;">
        Didn't request this? You can safely ignore this email — no one can access your account without this link.
      </p>
    </div>
    <div style="padding: 16px 32px; background: #fafafa; color: #909090; font-size: 12px; text-align: center;">
      © ${new Date().getFullYear()} ${escapeHtml(brandName)}
    </div>
  </div>
</body>
</html>`;

  const text = `Sign in to ${brandName}

Click this link to access your account (expires in 15 minutes):

${magicLinkUrl}

Didn't request this? You can safely ignore this email.`;

  return sendEmail({ to, subject, html, text });
}

module.exports = {
  isConfigured,
  sendEmail,
  sendWelcomeEmail,
  sendMagicLinkEmail,
};
