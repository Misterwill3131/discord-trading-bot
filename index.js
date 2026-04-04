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

const app = express();
app.use(express.json());

let lastImageBuffer = null;
let lastImageId = null;

app.get('/image/latest', (req, res) => {
  if (!lastImageBuffer) return res.status(404).json({ error: 'No image available' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-cache');
  res.send(lastImageBuffer);
});

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

app.get('/health', (_req, res) => {
  const makeUrl = MAKE_WEBHOOK_URL || '';
  const railwayUrl = RAILWAY_URL;
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Trading Signal Tester</title>
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
.img-preview img{max-width:100%;border-radius:4px;margin-top:10px;display:none}
</style></head><body>
<div class="container">
<h1>Trading Signal Tester</h1>
<div class="section-title">Presets rapides</div>
<div class="presets">
<button class="preset-btn p-entry" onclick="preset('Will','entry','\$AAPL 150.00-155.00')">AAPL Entry</button>
<button class="preset-btn p-neutral" onclick="preset('Will','neutral','\$TSLA 250.00-260.00 swing')">TSLA Swing</button>
<button class="preset-btn p-entry" onclick="preset('Will','entry','\$AMZN 185.00 scalp rapide')">AMZN Scalp</button>
<button class="preset-btn p-exit" onclick="preset('Will','exit','\$NVDA 875.00 sortie position')">NVDA Exit</button>
<button class="preset-btn p-neutral" onclick="preset('Will','neutral','\$SPY 500.00 niveau cle')">SPY Neutral</button>
</div>
<div class="form-row">
<div><label>Auteur</label><input id="author" value="Will"></div>
<div><label>Signal Type</label>
<select id="signal_type">
<option value="entry">entry</option>
<option value="exit">exit</option>
<option value="neutral">neutral</option>
</select></div></div>
<div style="margin-bottom:12px"><label>Message</label><textarea id="content">\$TSLA 150.00-155.00</textarea></div>
<button class="send-btn" id="sendBtn" onclick="sendSignal()">ENVOYER LE SIGNAL</button>
<div class="status-bar" id="status"></div>
<div class="img-preview"><img id="previewImg" alt="preview"></div>
<div class="section-title" style="margin-top:10px">Log</div>
<div class="log" id="log"></div>
</div>
<script>
var MAKE_URL='${makeUrl}';
var RAILWAY='${railwayUrl}';
function preset(a,t,m){document.getElementById('author').value=a;document.getElementById('signal_type').value=t;document.getElementById('content').value=m;}
function log(msg,cls){cls=cls||'log-info';var d=document.getElementById('log');var t=new Date().toTimeString().slice(0,8);d.innerHTML='<div class="log-entry"><span class="log-time">'+t+'</span><span class="'+cls+'">'+msg+'</span></div>'+d.innerHTML;}
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
var imgRes=await fetch(RAILWAY+'/generate-and-store',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({author:author,content:content,timestamp:new Date().toISOString()})});
if(imgRes.ok){var imgData=await imgRes.json();imageUrl=imgData.image_url;var p=document.getElementById('previewImg');p.src=imageUrl;p.style.display='block';log('Image: '+imageUrl,'log-ok');}
else{log('Image echouee: '+imgRes.status,'log-err');}
}catch(e){log('Erreur image: '+e.message,'log-err');}
document.getElementById('status').innerHTML='<span style="color:#888">Envoi Make.com...</span>';
try{
var r=await fetch(MAKE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:content,author:author,channel:'trading-floor',signal_type:signal_type,timestamp:new Date().toISOString(),image_url:imageUrl})});
document.getElementById('status').innerHTML='<span style="color:#00d4aa">OK '+r.status+' | image: '+(imageUrl?'oui':'null')+'</span>';
log('Make.com '+r.status+' | '+author+' | '+content.substring(0,50),'log-ok');
}catch(e){document.getElementById('status').innerHTML='<span style="color:#ff6b6b">Erreur: '+e.message+'</span>';log('Erreur: '+e.message,'log-err');}
finally{btn.disabled=false;}
}
document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.key==='Enter')sendSignal();});
</script></body></html>`);
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));

// ─────────────────────────────────────────────────────────────
// generateImage  –  screenshot Discord pixel-perfect
//
// Couleurs mesurées sur le vrai Discord dark mode :
//   Fond canal        #1e1f22
//   Fond message      #1e1f22  (pas de hover ici)
//   Nom blanc         #f2f3f5
//   Heure             #80848e
//   Texte message     #dcddde
//   Blurple avatar    #5865f2
//   Séparateur date   #3f4147
// ─────────────────────────────────────────────────────────────
function generateImage(author, content, timestamp) {
  // Dimensions proches d'un screenshot Discord typique
  // Largeur fixe 740px (environ celle d'un canal Discord sur 1080p)
  const W = 740;
  const PADDING_V = 18;   // espace vertical haut/bas autour du message
  const PADDING_L = 16;   // marge gauche du fond
  const AVATAR_D  = 40;   // diamètre avatar
  const AVATAR_X  = PADDING_L;
  const CONTENT_X = PADDING_L + AVATAR_D + 16; // 72px — marge gauche du texte
  const MAX_TW    = W - CONTENT_X - PADDING_L; // largeur max texte

  // ── Calculer la hauteur nécessaire pour le texte ──
  // On crée un canvas temporaire pour mesurer
  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px sans-serif';
  const lines = wrapText(tmpCtx, content, MAX_TW);
  const LINE_H = 22;
  const NAME_H  = 20; // hauteur ligne nom
  // Hauteur totale: padding haut + ligne nom + lignes texte + padding bas
  const H = PADDING_V + NAME_H + (lines.length * LINE_H) + PADDING_V + 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Fond ──
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // ── Avatar: cercle avec initiales ──
  const avatarCX = AVATAR_X + AVATAR_D / 2;
  const avatarCY = PADDING_V + NAME_H / 2 + 2; // centré sur la ligne du nom

  // Couleur avatar: blurple Discord par défaut
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, AVATAR_D / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#5865f2';
  ctx.fill();
  ctx.restore();

  // Initiales dans l'avatar
  const initials = (author || 'W').slice(0, 2).toUpperCase();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, avatarCX, avatarCY);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // ── Nom + heure ──
  const nameY = PADDING_V + NAME_H - 3;

  // Nom en blanc/légèrement gris (membre sans rôle coloré = #f2f3f5)
  ctx.fillStyle = '#D649CC';
  ctx.font = 'bold 16px sans-serif';
// --- USERNAME ---
ctx.fillStyle = '#D649CC';
ctx.font = 'bold 16px sans-serif';
ctx.fillText(author || 'Z', CONTENT_X, nameY);

const nameW = ctx.measureText(author || 'Z').width;

// --- BADGE BOOM ---
const badgeText = '💥 BOOM';
ctx.font = 'bold 11px sans-serif';

const badgePaddingX = 8;
const badgeHeight = 18;

const badgeTextWidth = ctx.measureText(badgeText).width;

// Position badge (juste après le nom)
const badgeX = CONTENT_X + nameW + 8;
const badgeY = nameY - 13;

// fond badge
ctx.fillStyle = '#2b2d31';
roundRect(ctx, badgeX, badgeY, badgeTextWidth + badgePaddingX * 2, badgeHeight, 6);
ctx.fill();

// texte badge
ctx.fillStyle = '#ffffff';
ctx.fillText(badgeText, badgeX + badgePaddingX, badgeY + 13);

// --- HEURE (placée APRÈS le badge) ---
const timeX = badgeX + badgeTextWidth + badgePaddingX * 2 + 8;

const d = timestamp ? new Date(timestamp) : new Date();
const hh = d.getHours().toString().padStart(2, '0');
const mm = d.getMinutes().toString().padStart(2, '0');
const timeStr = hh + ':' + mm;

ctx.fillStyle = '#80848e';
ctx.font = '12px sans-serif';
ctx.fillText(timeStr, timeX, nameY - 1);

  // --- BADGE BOOM ---
const badgeText = '💥 BOOM';

// style du badge
ctx.font = 'bold 11px sans-serif';

// largeur du badge
const badgePaddingX = 8;
const badgePaddingY = 4;
const badgeTextWidth = ctx.measureText(badgeText).width;

// position (à droite du pseudo)
const badgeX = CONTENT_X + nameW + 10;
const badgeY = nameY - 12;

// fond arrondi
ctx.fillStyle = '#2b2d31';
roundRect(ctx, badgeX, badgeY, badgeTextWidth + badgePaddingX * 2, 18, 6);
ctx.fill();

// texte badge
ctx.fillStyle = '#ffffff';
ctx.fillText(badgeText, badgeX + badgePaddingX, badgeY + 13);

  // Heure — format Discord "Aujourd'hui à HH:MM"
  const d = timestamp ? new Date(timestamp) : new Date();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const timeStr = hh + ':' + mm;

  ctx.fillStyle = '#80848e';
  ctx.font = '12px sans-serif';
  ctx.fillText(timeStr, CONTENT_X + nameW + 8, nameY - 1);

  // ── Texte du message ──
  ctx.fillStyle = '#dcddde';
  ctx.font = '16px sans-serif';

  let ty = nameY + LINE_H;
  for (const line of lines) {
    ctx.fillText(line, CONTENT_X, ty);
    ty += LINE_H;
  }

  return canvas.toBuffer('image/png');
}

// Wrap text helper
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// Signal classifier
function classifySignal(content) {
  const lower = content.toLowerCase();
  const blocked = ['news', 'sec', 'ipo', 'offering', 'halted', 'form 8-k', 'reverse stock split'];
  for (const b of blocked) { if (lower.includes(b)) return null; }
  if (lower.includes('entree') || lower.includes('entry') || lower.includes('long') || lower.includes('scalp')) return 'entry';
  if (lower.includes('sortie') || lower.includes('exit') || lower.includes('stop')) return 'exit';
  return 'neutral';
}

// Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
  if (!signalType) { console.log('Filtered out: ' + content.substring(0, 80)); return; }
  console.log('[' + signalType.toUpperCase() + '] ' + content);
  let imageUrl = null;
  try {
    const imgBuf = generateImage(message.author.username, content, message.createdAt.toISOString());
    lastImageBuffer = imgBuf;
    lastImageId = Date.now();
    imageUrl = RAILWAY_URL + '/image/latest?t=' + lastImageId;
    console.log('Image generated, URL: ' + imageUrl);
  } catch (err) { console.error('Image generation error:', err.message); }
  try {
    const result = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, author: message.author.username, channel: channelName, signal_type: signalType, timestamp: message.createdAt.toISOString(), image_url: imageUrl }),
    });
    console.log('Sent to Make, status: ' + result.status);
  } catch (err) { console.error('Error sending to Make:', err.message); }
});
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

client.login(DISCORD_TOKEN);
