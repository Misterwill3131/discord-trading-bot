const nodeFetch = require('node-fetch');

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Construit le payload Resend. Si imageBuffer est fourni, l'email est envoyé
// en HTML avec l'image en pièce jointe inline (cid:alert-image), et le texte
// brut du message sert de fallback pour les clients sans HTML.
function buildPayload({ from, to, subject, text, imageBuffer, imageMimeType }) {
  const base = { from, to, subject, text };
  if (!imageBuffer) return base;

  const cid = 'alert-image';
  const mimeType = imageMimeType || 'image/png';
  const ext = mimeType.split('/')[1] || 'png';

  return {
    ...base,
    html: '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif">'
      + '<img src="cid:' + cid + '" alt="' + escapeHtml(subject) + '" '
      + 'style="max-width:100%;height:auto;display:block" />'
      + '</div>',
    attachments: [{
      filename: 'alert.' + ext,
      content: imageBuffer.toString('base64'),
      content_id: cid,
      content_type: mimeType,
    }],
  };
}

function createEmailNotifier({ apiKey, to, from, logger = console, fetch = nodeFetch }) {
  if (!apiKey || !to || !from) {
    return async () => {};
  }
  return async function sendEmailAlert(message, options) {
    if (typeof message !== 'string' || !message.startsWith('📥')) return;
    const cleaned = stripBold(message);
    const subject = cleaned.split('\n')[0];
    const imageBuffer = options && options.imageBuffer;
    const imageMimeType = options && options.imageMimeType;

    const payload = buildPayload({
      from, to, subject, text: cleaned, imageBuffer, imageMimeType,
    });

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.error('[email] resend non-2xx:', res.status, body);
      }
    } catch (err) {
      logger.error('[email] send failed:', err.message);
    }
  };
}

module.exports = { createEmailNotifier };
