const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas } = require('@napi-rs/canvas');
const express = require('express');

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PORT            = process.env.PORT || 3000;

// Express health/generate server
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/generate', (req, res) => {
  const { username = 'Unknown', content = '', timestamp = new Date().toISOString() } = req.body;
  try {
    const imgBuf = generateImage(username, content, timestamp);
    res.set('Content-Type', 'image/png');
    res.send(imgBuf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Image server running on port ' + PORT));

// Image generator
function generateImage(username, content, timestamp) {
  const W = 600, PADDING = 20, AVATAR = 40;
  const lineH = 22, maxW = W - PADDING * 2 - AVATAR - 12;

  const tmpC = createCanvas(1, 1);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '15px Arial';
  const words = content.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (tmpCtx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  if (!lines.length) lines.push('');

  const H = PADDING * 2 + Math.max(AVATAR, lines.length * lineH + 20) + 10;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#36393f';
  ctx.fillRect(0, 0, W, H);

  const ax = PADDING, ay = PADDING;
  ctx.fillStyle = '#7289da';
  ctx.beginPath();
  ctx.arc(ax + AVATAR / 2, ay + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(username.charAt(0).toUpperCase(), ax + AVATAR / 2, ay + AVATAR / 2);

  const tx = ax + AVATAR + 12;

  ctx.font = 'bold 14px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(username, tx, ay);
  const nameW = ctx.measureText(username).width;
  ctx.fillStyle = '#5865f2';
  ctx.font = 'bold 10px Arial';
  const badgeTxt = 'APP';
  const bW = ctx.measureText(badgeTxt).width + 8;
  ctx.fillRect(tx + nameW + 6, ay + 1, bW, 14);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(badgeTxt, tx + nameW + 10, ay + 2);

  ctx.font = '11px Arial';
  ctx.fillStyle = '#72767d';
  const ts = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  ctx.fillText('Today at ' + ts, tx + nameW + 6 + bW + 6, ay + 2);

  ctx.font = '15px Arial';
  ctx.fillStyle = '#dcddde';
  lines.forEach((line, i) => {
    ctx.fillText(line, tx, ay + 20 + i * lineH);
  });

  return canvas.toBuffer('image/png');
}

// Signal classifier
const BLOCK_KEYWORDS = ['NEWS', 'SEC', 'IPO', 'OFFERING', 'HALTED', 'FORM 8-K', 'REVERSE STOCK SPLIT'];
const TICKER_RE      = /\b[A-Z]{2,5}\b/;
const PRICE_RE       = /\b\d+\.\d{1,4}\b/;
const STRATEGY_RE    = /@(Swing|Momentum|Scalp)/i;

function classifySignal(content) {
  const upper = content.toUpperCase();
  if (BLOCK_KEYWORDS.some(k => upper.includes(k))) return null;
  if (!TICKER_RE.test(content))  return null;
  if (!PRICE_RE.test(content) && !STRATEGY_RE.test(content)) return null;

  if (/@exit|sell|stop|close/i.test(content))   return 'exit';
  if (/@entry|buy|long|@swing|@momentum|@scalp/i.test(content)) return 'entry';
  return 'neutral';
}

// Discord bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelName = message.channel.name || '';
  console.log('Message received - channel: "' + channelName + '", author: ' + message.author.username);

  if (!channelName.includes(TRADING_CHANNEL)) return;

  const content    = message.content;
  const signalType = classifySignal(content);

  if (!signalType) {
    console.log('Filtered out: ' + content.substring(0, 80));
    return;
  }

  console.log('[' + signalType.toUpperCase() + '] ' + content);

  let imageBase64 = null;
  try {
    const imgBuf = generateImage(message.author.username, content, message.createdAt.toISOString());
    imageBase64 = imgBuf.toString('base64');
  } catch (err) {
    console.error('Image generation error:', err.message);
  }

  try {
    const result = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        author:      message.author.username,
        channel:     channelName,
        signal_type: signalType,
        timestamp:   message.createdAt.toISOString(),
        image_base64: imageBase64,
      }),
    });
    console.log('Sent to Make, status: ' + result.status);
  } catch (err) {
    console.error('Error sending to Make:', err.message);
  }
});

client.login(DISCORD_TOKEN);
