const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas } = require('@napi-rs/canvas');
const express = require('express');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://discord-trading-bot-production-f159.up.railway.app';

// Express server
const app = express();
app.use(express.json());

// Image cache
let lastImageBuffer = null;
let lastImageId = null;

// Route GET /image/latest
app.get('/image/latest', (req, res) => {
    if (!lastImageBuffer) {
          return res.status(404).json({ error: 'No image available' });
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(lastImageBuffer);
});

// Route POST /generate-and-store - genere image, stocke, retourne image_url
app.options('/generate-and-store', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
});

app.post('/generate-and-store', (req, res) => {
    const { author = 'Will', content = '', timestamp = new Date().toISOString() } = req.body;
    try {
          const imgBuf = generateImage(author, content, timestamp);
          lastImageBuffer = imgBuf;
          lastImageId = Date.now();
          const imageUrl = RAILWAY_URL + '/image/latest?t=' + lastImageId;
          res.set('Access-Control-Allow-Origin', '*');
          res.json({ image_url: imageUrl });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// Route POST /generate
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

// Trading Signal Tester UI
app.get('/health', (_req, res) => {
    const makeUrl = MAKE_WEBHOOK_URL || '';
    const railwayUrl = RAILWAY_URL;
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
    <html lang="fr">
    <head>
    <meta charset="UTF-8">
    <title>Trading Signal Tester</title>
    <style>
    body{background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;padding:20px}
    .container{width:100%;max-width:500px;margin:0 auto}
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
    .log-entry{margin:2px 0}.log-time{color:#555;margin-right:8px}.log-ok{color:#00d4aa}.log-err{color:#ff6b6b}.log-info{color:#aaa}
    .section-title{font-size:0.75em;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
    .img-preview img{max-width:100%;border-radius:8px;border:1px solid #00d4aa44;margin-top:10px;display:none}
    </style>
    </head>
    <body>
    <div class="container">
    <h1>Trading Signal Tester</h1>
    <div class="section-title">Presets rapides</div>
    <div class="presets">
    <button class="preset-btn p-entry" onclick="preset('Will','entry','AAPL 150.00 entree longue @Momentum')">AAPL Entry</button>
    <button class="preset-btn p-neutral" onclick="preset('Will','neutral','TSLA 250.00 @Swing surveillance')">TSLA Swing</button>
    <button class="preset-btn p-entry" onclick="preset('Will','entry','@scalp AMZN 185.00 scalp rapide')">AMZN Scalp</button>
    <button class="preset-btn p-exit" onclick="preset('Will','exit','NVDA 875.00 sortie position objectif atteint')">NVDA Exit</button>
    <button class="preset-btn p-neutral" onclick="preset('Will','neutral','SPY 500.00 niveau cle surveiller')">SPY Neutral</button>
    </div>
    <div class="form-row">
    <div><label>Auteur</label><input id="author" value="Will"></div>
    <div><label>Signal Type</label>
    <select id="signal_type">
    <option value="entry">entry</option>
    <option value="exit">exit</option>
    <option value="neutral">neutral</option>
    </select>
    </div>
    </div>
    <div style="margin-bottom:12px"><label>Message</label><textarea id="content">AAPL 150.00 entree longue @Momentum</textarea></div>
    <button class="send-btn" id="sendBtn" onclick="sendSignal()">ENVOYER LE SIGNAL</button>
    <div class="status-bar" id="status"></div>
    <div class="img-preview"><img id="previewImg" alt="Signal image preview"></div>
    <div class="section-title" style="margin-top:10px">Log</div>
    <div class="log" id="log"></div>
    </div>
    <script>
    var MAKE_URL='${makeUrl}';
    var RAILWAY='${railwayUrl}';
    function preset(author,type,msg){
      document.getElementById('author').value=author;
        document.getElementById('signal_type').value=type;
          document.getElementById('content').value=msg;
          }
          function log(msg,cls){
            cls=cls||'log-info';
              var d=document.getElementById('log');
                var t=new Date().toTimeString().slice(0,8);
                  d.innerHTML='<div class="log-entry"><span class="log-time">'+t+'</span><span class="'+cls+'">'+msg+'</span></div>'+d.innerHTML;
                  }
                  async function sendSignal(){
                    var author=document.getElementById('author').value.trim();
                      var signal_type=document.getElementById('signal_type').value;
                        var content=document.getElementById('content').value.trim();
                          if(!content)return;
                            var btn=document.getElementById('sendBtn');
                              btn.disabled=true;
                                document.getElementById('status').innerHTML='<span style="color:#888">Generation image...</span>';
                                  var imageUrl=null;
                                    try{
                                        var imgRes=await fetch(RAILWAY+'/generate-and-store',{
                                              method:'POST',
                                                    headers:{'Content-Type':'application/json'},
                                                          body:JSON.stringify({author:author,content:content,timestamp:new Date().toISOString()})
                                                              });
                                                                  if(imgRes.ok){
                                                                        var imgData=await imgRes.json();
                                                                              imageUrl=imgData.image_url;
                                                                                    var previewImg=document.getElementById('previewImg');
                                                                                          previewImg.src=imageUrl;
                                                                                                previewImg.style.display='block';
                                                                                                      log('Image: '+imageUrl,'log-ok');
                                                                                                          }else{
                                                                                                                log('Image echouee: '+imgRes.status,'log-err');
                                                                                                                    }
                                                                                                                      }catch(e){
                                                                                                                          log('Erreur image: '+e.message,'log-err');
                                                                                                                            }
                                                                                                                              document.getElementById('status').innerHTML='<span style="color:#888">Envoi Make.com...</span>';
                                                                                                                                try{
                                                                                                                                    var r=await fetch(MAKE_URL,{
                                                                                                                                          method:'POST',
                                                                                                                                                headers:{'Content-Type':'application/json'},
                                                                                                                                                      body:JSON.stringify({content:content,author:author,channel:'trading-floor',signal_type:signal_type,timestamp:new Date().toISOString(),image_url:imageUrl})
                                                                                                                                                          });
                                                                                                                                                              document.getElementById('status').innerHTML='<span style="color:#00d4aa">OK '+r.status+' | image: '+(imageUrl?'oui':'null')+'</span>';
                                                                                                                                                                  log('Make.com '+r.status+' | '+author+' | '+content.substring(0,50),'log-ok');
                                                                                                                                                                    }catch(e){
                                                                                                                                                                        document.getElementById('status').innerHTML='<span style="color:#ff6b6b">Erreur: '+e.message+'</span>';
                                                                                                                                                                            log('Erreur: '+e.message,'log-err');
                                                                                                                                                                              }finally{
                                                                                                                                                                                  btn.disabled=false;
                                                                                                                                                                                    }
                                                                                                                                                                                    }
                                                                                                                                                                                    document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.key==='Enter')sendSignal();});
                                                                                                                                                                                    </script>
                                                                                                                                                                                    </body>
                                                                                                                                                                                    </html>`);
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));

// Image generation function
function generateImage(author, content, timestamp) {
    const width = 800;
    const height = 450;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#0a0a1a');
    bg.addColorStop(1, '#16213e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, width - 8, height - 8);

  const headerGrad = ctx.createLinearGradient(0, 0, width, 0);
    headerGrad.addColorStop(0, '#00d4aa33');
    headerGrad.addColorStop(1, '#0099cc33');
    ctx.fillStyle = headerGrad;
    ctx.fillRect(4, 4, width - 8, 60);

  ctx.fillStyle = '#00d4aa';
    ctx.font = 'bold 22px Arial';
    ctx.fillText('TRADING SIGNAL', 30, 42);

  ctx.fillStyle = '#888888';
    ctx.font = '14px Arial';
    const ts = timestamp ? new Date(timestamp).toLocaleString('fr-CA') : new Date().toLocaleString('fr-CA');
    ctx.fillText('@' + author + ' - ' + ts, 30, 90);

  const lower = content.toLowerCase();
    let signalColor = '#ffd700';
    let signalLabel = 'NEUTRE';
    if (lower.includes('entree') || lower.includes('entry') || lower.includes('long') || lower.includes('scalp')) {
          signalColor = '#00d4aa';
          signalLabel = 'ENTREE';
    } else if (lower.includes('sortie') || lower.includes('exit') || lower.includes('stop')) {
          signalColor = '#ff6b6b';
          signalLabel = 'SORTIE';
    }

  ctx.fillStyle = signalColor + '33';
    ctx.fillRect(30, 110, 160, 36);
    ctx.fillStyle = signalColor;
    ctx.font = 'bold 18px Arial';
    ctx.fillText(signalLabel, 45, 133);

  ctx.fillStyle = '#e0e0e0';
    ctx.font = '20px Arial';
    const words = content.split(' ');
    let line = '';
    let y = 185;
    for (const word of words) {
          const test = line + word + ' ';
          if (ctx.measureText(test).width > width - 60 && line) {
                  ctx.fillText(line.trim(), 30, y);
                  line = word + ' ';
                  y += 32;
          } else {
                  line = test;
          }
    }
    if (line) ctx.fillText(line.trim(), 30, y);

  ctx.fillStyle = '#ffffff11';
    ctx.fillRect(4, height - 50, width - 8, 46);
    ctx.fillStyle = '#00d4aa';
    ctx.font = 'bold 14px Arial';
    ctx.fillText('MrWill_l Trading Signals', 30, height - 20);
    ctx.fillStyle = '#555555';
    ctx.font = '12px Arial';
    ctx.fillText('Not financial advice', width - 160, height - 20);

  return canvas.toBuffer('image/png');
}

// Signal classifier
function classifySignal(content) {
    const lower = content.toLowerCase();
    const blocked = ['news', 'sec', 'ipo', 'offering', 'halted', 'form 8-k', 'reverse stock split'];
    for (const b of blocked) {
          if (lower.includes(b)) return null;
    }
    if (lower.includes('entree') || lower.includes('entry') || lower.includes('long') || lower.includes('scalp')) return 'entry';
    if (lower.includes('sortie') || lower.includes('exit') || lower.includes('stop')) return 'exit';
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

            let imageUrl = null;
    try {
          const imgBuf = generateImage(message.author.username, content, message.createdAt.toISOString());
          lastImageBuffer = imgBuf;
          lastImageId = Date.now();
          imageUrl = RAILWAY_URL + '/image/latest?t=' + lastImageId;
          console.log('Image generated, URL: ' + imageUrl);
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
                                    image_url: imageUrl,
                          }),
                  });
                  console.log('Sent to Make, status: ' + result.status);
            } catch (err) {
                  console.error('Error sending to Make:', err.message);
            }
});

client.login(DISCORD_TOKEN);
