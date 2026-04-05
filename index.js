const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const express = require('express');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://discord-trading-bot-production-f159.up.railway.app';

// ─────────────────────────────────────────────────────────────────────
//  SECTION AVATARS — Ajouter ici les avatars personnalisés par Discord username
//  Format : 'NomExact': 'URL_de_l_image'
//  Si un utilisateur n'est pas dans cette liste, ses initiales seront utilisées.
// ─────────────────────────────────────────────────────────────────────
const CUSTOM_AVATARS = {
  'Z': 'https://raw.githubusercontent.com/Misterwill3131/discord-trading-bot/main/z-avatar.jpg',
  // Ajoutez d'autres utilisateurs ici:
  // 'Will': 'https://url-de-l-avatar-de-will.jpg',
  // 'Alex': 'https://url-de-l-avatar-alex.jpg',
};
// ─────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
//  🎨 CUSTOMISATION — Modifie ici l'apparence des images facilement
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // ── Dimensions ──────────────────────────────────────────────────────────
  IMAGE_W:              740,           // Largeur image (px)
  IMAGE_H:              80,            // Hauteur image (px)

  // ── Couleurs fond ────────────────────────────────────────────────────────
  BG_COLOR:             '#1e1f22',     // Fond principal de la carte

  // ── Avatar ───────────────────────────────────────────────────────────────
  AVATAR_SIZE:          44,            // Diamètre du cercle avatar (px)
  AVATAR_COLOR:         '#5865f2',     // Couleur cercle sans photo (blurple)
  AVATAR_TEXT_COLOR:    '#ffffff',     // Couleur initiales

  // ── Badge BOOM ───────────────────────────────────────────────────────────
  BADGE_BG:             '#36393f',     // Fond du badge
  BADGE_BORDER:         '#4f5660',     // Bordure du badge
  BADGE_TEXT:           'BOOM',        // Texte affiché dans le badge
  BADGE_TEXT_COLOR:     '#ffffff',     // Couleur texte badge
  BADGE_FONT_SIZE:      10,            // Taille police badge (px)
  BADGE_HEIGHT:         16,            // Hauteur du badge (px)
  BADGE_RADIUS:         3,             // Arrondi coins badge (px)

  // ── Flamme (badge) ───────────────────────────────────────────────────────
  FLAME_BOTTOM:         '#e65c00',     // Couleur bas flamme (orange foncé)
  FLAME_MID:            '#ff8c00',     // Couleur milieu flamme (orange)
  FLAME_TOP:            '#ffd000',     // Couleur sommet flamme (jaune-or)

  // ── Nom utilisateur ──────────────────────────────────────────────────────
  USERNAME_COLOR:       '#D649CC',     // Couleur du nom (violet/rose)
  USERNAME_FONT_SIZE:   16,            // Taille police nom (px)

  // ── Horodatage ───────────────────────────────────────────────────────────
  TIME_COLOR:           '#80848e',     // Couleur de l'heure
  TIME_FONT_SIZE:       12,            // Taille police heure (px)

  // ── Texte du message ─────────────────────────────────────────────────────
  MESSAGE_COLOR:        '#dcddde',     // Couleur du message
  MESSAGE_FONT_SIZE:    14,            // Taille police message (px)

  // ── Police globale ───────────────────────────────────────────────────────
  FONT:                 'Noto Sans, sans-serif',
};
// ═══════════════════════════════════════════════════════════════════════════
const FONT = CONFIG.FONT; // alias de compatibilité

const app = express();
app.use(express.json());

let lastImageBuffer = null;
let lastImageId = null;

app.get('/preview', async (req, res) => {
  try {
    const author = req.query.author || 'Z';
    const message = req.query.message || '$TSLA 150.00-155.00';
    const buf = await generateImage(author, message, new Date().toISOString());
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
  generateImage(author, content, timestamp).then(imgBuf => {
    lastImageBuffer = imgBuf;
    lastImageId = Date.now();
    const imageUrl = RAILWAY_URL + '/image/latest?t=' + lastImageId;
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ image_url: imageUrl });
  }).catch(err => res.status(500).json({ error: err.message }));
});

app.post('/generate', (req, res) => {
  const { username = 'Unknown', content = '', timestamp = new Date().toISOString() } = req.body;
  generateImage(username, content, timestamp).then(imgBuf => {
    res.set('Content-Type', 'image/png');
    res.send(imgBuf);
  }).catch(err => res.status(500).json({ error: err.message }));
});

app.get('/health', async (req, res) => {
  // Envoie un signal test à Make automatiquement (sauf si ?send=0)
  const autoSend = req.query.send !== '0';

  let makeStatus = null;
  let imageUrl = null;
  let makeError = null;

  if (autoSend && MAKE_WEBHOOK_URL) {
    try {
      const testAuthor  = req.query.author  || 'Will';
      const testContent = req.query.message || '$TSLA 150.00-155.00';
      const testSignal  = req.query.signal  || 'entry';
      const buf = await generateImage(testAuthor, testContent, new Date().toISOString());
      lastImageBuffer = buf;
      lastImageId = Date.now();
      imageUrl = RAILWAY_URL + '/image/latest?id=' + lastImageId;

      const makeRes = await fetch(MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content:     testContent,
          author:      testAuthor,
          channel:     'trading-floor',
          signal_type: testSignal,
          timestamp:   new Date().toISOString(),
          image_url:   imageUrl,
          ...extractPrices(testContent)
        }),
      });
      makeStatus = makeRes.status;
      console.log('[/health] Signal envoye a Make, status:', makeStatus);
    } catch (err) {
      makeError = err.message;
      console.error('[/health] Erreur Make:', err.message);
    }
  }

  res.json({
    status:      'online',
    make_sent:   autoSend && !!MAKE_WEBHOOK_URL,
    make_status: makeStatus,
    make_error:  makeError,
    image_url:   imageUrl,
    timestamp:   new Date().toISOString(),
    tip:         'Params optionnels: ?author=Z&message=$AAPL+180&signal=entry | ?send=0 pour desactiver'
  });
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));

async function generateImage(author, content, timestamp) {
  const W = 740;
  const PADDING_V = 18;
  const PADDING_L = 16;
  const AVATAR_D = 40;
  const AVATAR_X = PADDING_L;
  const CONTENT_X = PADDING_L + AVATAR_D + 16;
  const MAX_TW = W - CONTENT_X - PADDING_L;

  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px ' + FONT;
  const lines = wrapText(tmpCtx, content, MAX_TW);

  const LINE_H = 22;
  const NAME_H = 20;
  const H = PADDING_V + NAME_H + (lines.length * LINE_H) + PADDING_V + 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = CONFIG.BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  // ── Avatar ──
  const avatarCX = AVATAR_X + AVATAR_D / 2;
  const avatarCY = PADDING_V + NAME_H / 2 + 2;
  const avatarR = AVATAR_D / 2;

  // Clip circulaire pour l'avatar
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const customAvatarUrl = CUSTOM_AVATARS[author];
  if (customAvatarUrl) {
    // Charger et dessiner la photo de profil personnalisée
    try {
      const img = await loadImage(customAvatarUrl);
      // Dessiner l'image dans le cercle en gardant le ratio (cover)
      const size = AVATAR_D;
      const imgRatio = img.width / img.height;
      let drawW = size, drawH = size;
      let drawX = avatarCX - avatarR, drawY = avatarCY - avatarR;
      if (imgRatio > 1) {
        drawW = size * imgRatio;
        drawX = avatarCX - drawW / 2;
      } else {
        drawH = size / imgRatio;
        drawY = avatarCY - drawH / 2;
      }
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } catch (e) {
      // Fallback: cercle blurple avec initiales
      ctx.fillStyle = CONFIG.AVATAR_COLOR;
      ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
    }
  } else {
    // Avatar par défaut: cercle blurple avec initiales
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
  }
  ctx.restore();

  // Initiales (uniquement si pas d'avatar personnalisé)
  if (!customAvatarUrl) {
    const initials = (author || 'W').slice(0, 2).toUpperCase();
    ctx.fillStyle = CONFIG.AVATAR_TEXT_COLOR;
    ctx.font = 'bold 14px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, avatarCX, avatarCY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  const nameY = PADDING_V + NAME_H - 3;

  // Username
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = CONFIG.USERNAME_COLOR;
  ctx.font = 'bold 16px ' + FONT;
  ctx.fillText(author || 'Z', CONTENT_X, nameY);
  const nameW = ctx.measureText(author || 'Z').width;

  // BOOM badge
  const BADGE_H = 16;
  const BADGE_PAD_X = 5;
  const BADGE_RADIUS = 3;
  const BADGE_LABEL = 'BOOM';
  const FLAME_W = 9;
  const BADGE_GAP = 3;

  ctx.font = 'bold 10px ' + FONT;
  const labelW = ctx.measureText(BADGE_LABEL).width;

  const BADGE_W = BADGE_PAD_X + FLAME_W + BADGE_GAP + labelW + BADGE_PAD_X;
  const badgeX = CONTENT_X + nameW + 6;
  const badgeY = nameY - BADGE_H + 2;

  ctx.fillStyle = CONFIG.BADGE_BG;
  roundRect(ctx, badgeX, badgeY, BADGE_W, BADGE_H, BADGE_RADIUS);
  ctx.fill();

  ctx.strokeStyle = CONFIG.BADGE_BORDER;
  ctx.lineWidth = 0.5;
  roundRect(ctx, badgeX, badgeY, BADGE_W, BADGE_H, BADGE_RADIUS);
  ctx.stroke();

  // Flamme Canvas — fidele au logo de reference (base large, pointe fine)
  const flameX = badgeX + BADGE_PAD_X;
  const flameY = badgeY + 0.5;
  const fw = FLAME_W;
  const fh = BADGE_H - 1;
  ctx.save();
  const flameGrad = ctx.createLinearGradient(flameX + fw/2, flameY + fh, flameX + fw/2, flameY);
  flameGrad.addColorStop(0,    CONFIG.FLAME_BOTTOM);
  flameGrad.addColorStop(0.45, CONFIG.FLAME_MID);
  flameGrad.addColorStop(1,    CONFIG.FLAME_TOP);
  ctx.fillStyle = flameGrad;
  ctx.beginPath();
  ctx.moveTo(flameX + fw * 0.50, flameY);
  ctx.bezierCurveTo(
    flameX + fw * 0.75, flameY + fh * 0.18,
    flameX + fw * 1.00, flameY + fh * 0.42,
    flameX + fw * 0.92, flameY + fh * 0.70
  );
  ctx.bezierCurveTo(
    flameX + fw * 0.88, flameY + fh * 0.85,
    flameX + fw * 0.80, flameY + fh * 0.95,
    flameX + fw * 0.50, flameY + fh * 1.00
  );
  ctx.bezierCurveTo(
    flameX + fw * 0.20, flameY + fh * 0.95,
    flameX + fw * 0.12, flameY + fh * 0.85,
    flameX + fw * 0.08, flameY + fh * 0.70
  );
  ctx.bezierCurveTo(
    flameX + fw * 0.00, flameY + fh * 0.42,
    flameX + fw * 0.25, flameY + fh * 0.18,
    flameX + fw * 0.50, flameY
  );
  ctx.closePath();
  ctx.fill();
  const innerGrad = ctx.createLinearGradient(flameX + fw/2, flameY + fh * 0.9, flameX + fw/2, flameY + fh * 0.35);
  innerGrad.addColorStop(0, 'rgba(255,255,180,0.55)');
  innerGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.moveTo(flameX + fw * 0.50, flameY + fh * 0.38);
  ctx.bezierCurveTo(flameX + fw * 0.65, flameY + fh * 0.52, flameX + fw * 0.70, flameY + fh * 0.72, flameX + fw * 0.50, flameY + fh * 0.90);
  ctx.bezierCurveTo(flameX + fw * 0.30, flameY + fh * 0.72, flameX + fw * 0.35, flameY + fh * 0.52, flameX + fw * 0.50, flameY + fh * 0.38);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.font = 'bold 10px ' + FONT;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(BADGE_LABEL, badgeX + BADGE_PAD_X + FLAME_W + BADGE_GAP, badgeY + BADGE_H / 2);
  ctx.textBaseline = 'alphabetic';

  // Time
  const d = timestamp ? new Date(timestamp) : new Date();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const timeStr = 'Today at ' + hh + ':' + mm;
  const timeX = badgeX + BADGE_W + 6;
  ctx.fillStyle = CONFIG.TIME_COLOR;
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, timeX, nameY - 1);

  // Gain % badge (si entree ET sortie detectees)
  const priceData = extractPrices(content);
  if (priceData.gain_pct !== null) {
    const gainStr = (priceData.gain_pct >= 0 ? '+' : '') + priceData.gain_pct + '%';
    const gainColor = priceData.gain_pct >= 0 ? '#23d18b' : '#f04747';
    const gainBg    = priceData.gain_pct >= 0 ? 'rgba(35,209,139,0.15)' : 'rgba(240,71,71,0.15)';
    ctx.font = 'bold 11px ' + FONT;
    const gainTW = ctx.measureText(gainStr).width;
    const gainW  = gainTW + 14;
    const gainX  = W - PADDING_H - gainW;
    const gainY  = PADDING_V;
    ctx.fillStyle = gainBg;
    roundRect(ctx, gainX, gainY, gainW, 16, 3);
    ctx.fill();
    ctx.strokeStyle = gainColor;
    ctx.lineWidth = 0.8;
    roundRect(ctx, gainX, gainY, gainW, 16, 3);
    ctx.stroke();
    ctx.fillStyle = gainColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(gainStr, gainX + gainW / 2, gainY + 8);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Message text
  ctx.fillStyle = CONFIG.MESSAGE_COLOR;
  ctx.font = '16px ' + FONT;
  let ty = nameY + LINE_H;
  for (const line of lines) {
    ctx.fillText(line, CONTENT_X, ty);
    ty += LINE_H;
  }

  return canvas.toBuffer('image/png');
}

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

// ─────────────────────────────────────────────────────────────────────
// extractPrices — Detecte prix d'entree ET de sortie dans un message
// ─────────────────────────────────────────────────────────────────────
function extractPrices(content) {
  if (!content) return { entry_price: null, exit_price: null, gain_pct: null };
  const c = content.replace(/,/g, '.');
  let entry = null;
  let exit  = null;

  // Priorite 1: TICKER PRIX-PRIX (ex: $TSLA 150.00-155.00 ou NCT 2.60-4.06)
  const rangeM = c.match(/(?:\$?[A-Z]{1,6}\s+)(\d+(?:\.\d+)?)\s*[-\u2013]\s*(\d+(?:\.\d+)?)/i);
  if (rangeM) {
    const a = parseFloat(rangeM[1]), b = parseFloat(rangeM[2]);
    entry = Math.min(a, b);
    exit  = Math.max(a, b);
  }

  // Priorite 2: "in at PRIX" / "entry PRIX" / "long PRIX"
  if (!entry) {
    const em = c.match(/(?:in\s+at|entry|bought?|long at|achat|entree)\s+\$?(\d+(?:\.\d+)?)/i);
    if (em) entry = parseFloat(em[1]);
  }

  // Priorite 3: "out at PRIX" / "exit PRIX" / "target PRIX" / "tp PRIX"
  if (!exit) {
    const xm = c.match(/(?:out\s+at|exit\s+at|sold?\s+at|target|tp|sortie|objectif)\s+\$?(\d+(?:\.\d+)?)/i);
    if (xm) exit = parseFloat(xm[1]);
  }

  // Priorite 4: Niveaux separes par ... ou to (ex: 2.50...3.50)
  if (!entry || !exit) {
    const lm = c.match(/\$?(\d+(?:\.\d+)?)\s*(?:\.{2,}|\bto\b)\s*\$?(\d+(?:\.\d+)?)/i);
    if (lm) {
      const a = parseFloat(lm[1]), b = parseFloat(lm[2]);
      if (!entry) entry = Math.min(a, b);
      if (!exit)  exit  = Math.max(a, b);
    }
  }

  let gain_pct = null;
  if (entry !== null && exit !== null && entry > 0) {
    gain_pct = parseFloat((((exit - entry) / entry) * 100).toFixed(2));
  }

  return { entry_price: entry, exit_price: exit, gain_pct };
}
// ─────────────────────────────────────────────────────────────────────

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
  if (!signalType) {
    console.log('Filtered out: ' + content.substring(0, 80));
    return;
  }
  console.log('[' + signalType.toUpperCase() + '] ' + content);

  let imageUrl = null;
  try {
    const imgBuf = await generateImage(message.author.username, content, message.createdAt.toISOString());
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
        ...extractPrices(content)
      }),
    });
    console.log('Sent to Make, status: ' + result.status);
  } catch (err) {
    console.error('Error sending to Make:', err.message);
  }
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
