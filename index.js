const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas } = require('@napi-rs/canvas');
const express = require('express');

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL  = process.env.TRADING_CHANNEL || 'trading-floor';
const PORT             = process.env.PORT || 3000;

// Express server
const app = express();
app.use(express.json());

// Trading Signal Tester UI
app.get('/health', (_req, res) => {
    const makeUrl = MAKE_WEBHOOK_URL || '';
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
    <html lang="fr">
    <head>
    <meta charset="UTF-8">
    <title>Trading Signal Tester</title>
    <style>
      body{background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;display:flex;justify-content:center;padding:20px}
        .container{width:100%;max-width:500px}
          h1{color:#00d4aa;text-align:center;font-size:1.4em;margin-bottom:20px}
            .presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
              .preset-btn{padding:6px 12px;border-radius:20px;border:none;cursor:pointer;font-size:0.85em;font-weight:600}
                .p-entry{background:#00d4aa22;color:#00d4aa;border:1px solid #00d4aa55}
                  .p-exit{background:#ff6b6b22;color:#ff6b6b;border:1px solid #ff6b6b55}
                    .p-neutral{background:#ffd70022;color:#ffd700;border:1px solid #ffd70055}
                      .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
                        label{font-size:0.8em;color:#888;margin-bottom:4px;display:block}
                          input,textarea,select{width:100%;background:#16213e;border:1px solid #0f3460;color:#e0e0e0;padding:8px;border-radius:6px;font-size:0.9em;box-sizing:border-box}
                            textarea{height:80px;resize:vertical}
                              .send-btn{width:100%;padding:14px;background:linear-gradient(135deg,#00d4aa,#0099cc);border:none;border-radius:8px;color:#fff;font-size:1.1em;font-weight:700;cursor:pointer;margin-top:8px}
                                .send-btn:hover{opacity:0.9}
                                  .status-bar{text-align:center;margin:10px 0;font-size:0.9em;min-height:20px}
                                    .log{background:#0a0a1a;border-radius:6px;padding:10px;height:160px;overflow-y:auto;font-size:0.78em;font-family:monospace}
                                      .log-entry{margin:2px 0}.log-time{color:#555;margin-right:8px}.log-ok{color:#00d4aa}.log-err{color:#ff6b6b}
                                        .section-title{font-size:0.75em;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
                                        </style>
                                        </head>
                                        <body>
                                        <div class="container">
                                          <h1>⚡ Trading Signal Tester</h1>
                                            <div class="section-title">⚡ Presets rapides</div>
                                              <div class="presets">
                                                  <button class="preset-btn p-entry" onclick="preset('Will','entry','AAPL 150.00 entree longue @Momentum')">📈 AAPL Entry</button>
                                                      <button class="preset-btn p-neutral" onclick="preset('Will','neutral','TSLA 250.00 @Swing surveillance')">📊 TSLA Swing</button>
                                                          <button class="preset-btn p-entry" onclick="preset('Will','entry','@Scalp AMZN 185.00 scalp rapide')">⚡ AMZN Scalp</button>
                                                              <button class="preset-btn p-exit" onclick="preset('Will','exit','NVDA 875.00 sortie position objectif atteint')">🔴 NVDA Exit</button>
                                                                  <button class="preset-btn p-neutral" onclick="preset('Will','neutral','SPY 500.00 niveau cle surveiller')">🔵 SPY Neutral</button>
                                                                    </div>
                                                                      <div class="form-row">
                                                                          <div><label>👤 Auteur</label><input id="author" value="Will"></div>
                                                                              <div><label>📊 Signal Type</label>
                                                                                    <select id="signal_type">
                                                                                            <option value="entry">entry</option>
                                                                                                    <option value="exit">exit</option>
                                                                                                            <option value="neutral">neutral</option>
                                                                                                                  </select>
                                                                                                                      </div>
                                                                                                                        </div>
                                                                                                                          <div style="margin-bottom:12px"><label>💬 Message</label><textarea id="content">AAPL 150.00 entree longue @Momentum</textarea></div>
                                                                                                                            <div class="form-row">
                                                                                                                                <div><label>📢 Channel</label><input id="channel" value="trading-floor"></div>
                                                                                                                                    <div><label>🔗 Destination</label>
                                                                                                                                          <select id="target">
                                                                                                                                                  <option value="make">Make.com Webhook</option>
                                                                                                                                                          <option value="railway">Railway /generate</option>
                                                                                                                                                                </select>
                                                                                                                                                                    </div>
                                                                                                                                                                      </div>
                                                                                                                                                                        <button class="send-btn" id="sendBtn" onclick="sendSignal()">⚡ ENVOYER LE SIGNAL</button>
                                                                                                                                                                          <div class="status-bar" id="status"></div>
                                                                                                                                                                            <div class="log" id="log"></div>
                                                                                                                                                                              <div style="text-align:center;font-size:0.7em;color:#333;margin-top:8px">💡 Ctrl+Enter pour envoyer rapidement</div>
                                                                                                                                                                              </div>
                                                                                                                                                                              <script>
                                                                                                                                                                              const MAKE_URL = '${makeUrl}';
                                                                                                                                                                              const RAILWAY_URL = '/generate';
                                                                                                                                                                              
                                                                                                                                                                              function preset(author, type, msg) {
                                                                                                                                                                                document.getElementById('author').value = author;
                                                                                                                                                                                  document.getElementById('signal_type').value = type;
                                                                                                                                                                                    document.getElementById('content').value = msg;
                                                                                                                                                                                    }
                                                                                                                                                                                    
                                                                                                                                                                                    function log(msg, ok) {
                                                                                                                                                                                      const d = document.getElementById('log');
                                                                                                                                                                                        const t = new Date().toTimeString().slice(0,8);
                                                                                                                                                                                          d.innerHTML = '<div class="log-entry"><span class="log-time">' + t + '</span><span class="' + (ok ? 'log-ok' : 'log-err') + '">' + msg + '</span></div>' + d.innerHTML;
                                                                                                                                                                                          }
                                                                                                                                                                                          
                                                                                                                                                                                          async function sendSignal() {
                                                                                                                                                                                            const author = document.getElementById('author').value.trim();
                                                                                                                                                                                              const signal_type = document.getElementById('signal_type').value;
                                                                                                                                                                                                const content = document.getElementById('content').value.trim();
                                                                                                                                                                                                  const channel = document.getElementById('channel').value.trim();
                                                                                                                                                                                                    const target = document.getElementById('target').value;
                                                                                                                                                                                                    
                                                                                                                                                                                                      if (!content) return;
                                                                                                                                                                                                      
                                                                                                                                                                                                        const btn = document.getElementById('sendBtn');
                                                                                                                                                                                                          btn.disabled = true;
                                                                                                                                                                                                            document.getElementById('status').innerHTML = '<span style="color:#888">⏳ Envoi...</span>';
                                                                                                                                                                                                            
                                                                                                                                                                                                              try {
                                                                                                                                                                                                                  let url, body, opts;
                                                                                                                                                                                                                  
                                                                                                                                                                                                                      if (target === 'make') {
                                                                                                                                                                                                                            url = MAKE_URL;
                                                                                                                                                                                                                                  body = JSON.stringify({
                                                                                                                                                                                                                                          content, author, channel, signal_type,
                                                                                                                                                                                                                                                  timestamp: new Date().toISOString(),
                                                                                                                                                                                                                                                          image_base64: null
                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                      opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
                                                                                                                                                                                                                                                                          } else {
                                                                                                                                                                                                                                                                                url = RAILWAY_URL;
                                                                                                                                                                                                                                                                                      body = JSON.stringify({ username: author, content, timestamp: new Date().toISOString() });
                                                                                                                                                                                                                                                                                            opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                    const r = await fetch(url, opts);
                                                                                                                                                                                                                                                                                                        const txt = await r.text();
                                                                                                                                                                                                                                                                                                            const preview = txt.startsWith('{') ? txt.substring(0,60) : ('PNG image (' + txt.length + ' bytes)');
                                                                                                                                                                                                                                                                                                                document.getElementById('status').innerHTML = '<span style="color:#00d4aa">✅ ' + r.status + ' — ' + preview + '</span>';
                                                                                                                                                                                                                                                                                                                    log((target === 'make' ? '→ Make.com' : '→ Railway') + ' | ' + author + ' | ' + content.substring(0,60), true);
                                                                                                                                                                                                                                                                                                                      } catch(e) {
                                                                                                                                                                                                                                                                                                                          document.getElementById('status').innerHTML = '<span style="color:#ff6b6b">❌ ' + e.message + '</span>';
                                                                                                                                                                                                                                                                                                                              log('ERROR: ' + e.message, false);
                                                                                                                                                                                                                                                                                                                                } finally {
                                                                                                                                                                                                                                                                                                                                    btn.disabled = false;
                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                      document.addEventListener('keydown', e => {
                                                                                                                                                                                                                                                                                                                                        if (e.ctrlKey && e.key === 'Enter') sendSignal();
                                                                                                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                                                                                                        </script>
                                                                                                                                                                                                                                                                                                                                        </body>
                                                                                                                                                                                                                                                                                                                                        </html>`);
});

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

// GET /image endpoint for Make.com Buffer integration
app.get('/image', (req, res) => {
    const { username = 'Signal', content = '', timestamp = new Date().toISOString() } = req.query;
    try {
          const imgBuf = generateImage(username, decodeURIComponent(content), decodeURIComponent(timestamp));
          res.set('Content-Type', 'image/png');
          res.set('Cache-Control', 'no-cache');
          res.send(imgBuf);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

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
const TICKER_RE = /\b[A-Z]{2,5}\b/;
const PRICE_RE = /\b\d+\.\d{1,4}\b/;
const STRATEGY_RE = /@(Swing|Momentum|Scalp)/i;

function classifySignal(content) {
    const upper = content.toUpperCase();
    if (BLOCK_KEYWORDS.some(k => upper.includes(k))) return null;
    if (!TICKER_RE.test(content)) return null;
    if (!PRICE_RE.test(content) && !STRATEGY_RE.test(content)) return null;

  if (/@exit|sell|stop|close/i.test(content)) return 'exit';
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

            const content = message.content;
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
                                    author: message.author.username,
                                    channel: channelName,
                                    signal_type: signalType,
                                    timestamp: message.createdAt.toISOString(),
                                    image_base64: imageBase64,
                          }),
                  });
                  console.log('Sent to Make, status: ' + result.status);
            } catch (err) {
                  console.error('Error sending to Make:', err.message);
            }
});

client.login(DISCORD_TOKEN);
