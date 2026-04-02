const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');
const http = require('http');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';

if (!DISCORD_TOKEN) {
  console.error('ERROR: DISCORD_TOKEN is not set');
  process.exit(1);
}

if (!MAKE_WEBHOOK_URL) {
  console.error('ERROR: MAKE_WEBHOOK_URL is not set');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------------- FILTER CONFIG ----------------

// ❌ Seulement le vrai bruit
const BLOCKED_KEYWORDS = [
  'NEWS',
  'SEC',
  'IPO',
  'FORM 8-K',
  'OFFERING',
  'HALTED',
  'REVERSE STOCK SPLIT'
];

// Regex permissifs
const TICKER_REGEX = /\$?[A-Z]{2,5}\b/;
const PRICE_REGEX = /\d+/; // volontairement permissif (n'importe quel chiffre)

// Options (SPY etc.)
const OPTIONS_REGEX = /\b(SPY|QQQ)\s+[CP]\s+\d+\b/i;

// Mots clés
const ENTRY_KEYWORDS = [
  'adding',
  'add',
  'entry',
  'buy',
  '@swing',
  '@momentum',
  '@scalp',
  'starter',
  'starting'
];

const EXIT_KEYWORDS = [
  'sold',
  'trim',
  'out',
  'exit',
  'took profit',
  'profit',
  'closing'
];

// ---------------- CLASSIFIER ----------------

function classifySignal(content) {
  const upper = content.toUpperCase();
  const lower = content.toLowerCase();

  // ❌ Bloquer bruit
  for (const kw of BLOCKED_KEYWORDS) {
    if (upper.includes(kw)) {
      return null;
    }
  }

  // ✅ Cas options
  if (OPTIONS_REGEX.test(content)) {
    return 'entry';
  }

  // ✅ Doit contenir ticker
  const hasTicker = TICKER_REGEX.test(content);
  if (!hasTicker) return null;

  // (permissif) → chiffre OU mot clé suffit
  const hasPrice = PRICE_REGEX.test(content);
  const hasEntryKeyword = ENTRY_KEYWORDS.some(kw => lower.includes(kw));
  const hasExitKeyword = EXIT_KEYWORDS.some(kw => lower.includes(kw));

  if (hasEntryKeyword) return 'entry';
  if (hasExitKeyword) return 'exit';

  if (hasPrice) return 'neutral';

  return null;
}

// ---------------- SEND TO MAKE ----------------

function sendToMake(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(MAKE_WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------- DISCORD ----------------

client.once('ready', () => {
  console.log(`Bot connected as ${client.user.tag}`);
  console.log(`Listening for channels containing: ${TRADING_CHANNEL}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelName = message.channel.name || '';
  if (!channelName.includes(TRADING_CHANNEL)) return;

  const content = message.content;

  const signalType = classifySignal(content);

  if (!signalType) {
    console.log(`Filtered out: ${content.substring(0, 80)}`);
    return;
  }

  console.log(`[${signalType.toUpperCase()}] ${content}`);

  try {
    const payload = {
      content: content,
      type: signalType, // entry / exit / neutral
      author: message.author.username,
      author_id: message.author.id,
      channel: channelName,
      timestamp: message.createdAt.toISOString(),
      message_id: message.id,
    };

    const result = await sendToMake(payload);
    console.log(`Sent to Make, status: ${result.status}`);
  } catch (err) {
    console.error('Error sending to Make:', err.message);
  }
});

client.login(DISCORD_TOKEN);
