const nodeFetch = require('node-fetch');

function stripBold(s) {
  return s.replace(/\*\*/g, '');
}

function createEmailNotifier({ apiKey, to, from, logger = console, fetch = nodeFetch }) {
  return async function sendEmailAlert(message) {
    if (typeof message !== 'string' || !message.startsWith('📥')) return;
    const cleaned = stripBold(message);
    const subject = cleaned.split('\n')[0];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ from, to, subject, text: cleaned }),
    });
  };
}

module.exports = { createEmailNotifier };
