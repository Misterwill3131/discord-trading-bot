const express = require('express');
const { createCanvas, loadImage } = require('canvas');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.post('/generate', async (req, res) => {
    try {
          const {
                  username = 'Z',
                  avatar_url = '',
                  content = '',
                  timestamp = new Date().toISOString()
          } = req.body;

      const width = 600;
          const lineHeight = 24;
          const padding = 20;
          const avatarSize = 44;
          const contentLines = wrapText(content, 50);
          const height = padding * 2 + avatarSize + contentLines.length * lineHeight + 20;

      const canvas = createCanvas(width, height);
          const ctx = canvas.getContext('2d');

      // Discord dark background
      ctx.fillStyle = '#313338';
          ctx.fillRect(0, 0, width, height);

      // Avatar circle
      ctx.fillStyle = '#5865F2';
          ctx.beginPath();
          ctx.arc(padding + avatarSize / 2, padding + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
          ctx.fill();

      // Avatar letter
      ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 20px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(username.charAt(0).toUpperCase(), padding + avatarSize / 2, padding + avatarSize / 2);

      // Username
      ctx.textAlign = 'left';
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 16px Arial';
          const nameX = padding + avatarSize + 12;
          ctx.fillText(username, nameX, padding + 16);

      // APP badge
      ctx.fillStyle = '#5865F2';
          const badgeX = nameX + ctx.measureText(username).width + 8;
          roundRect(ctx, badgeX, padding + 5, 35, 18, 3);
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 10px Arial';
          ctx.fillText('APP', badgeX + 6, padding + 17);

      // Timestamp
      const time = new Date(timestamp);
          const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          ctx.fillStyle = '#949BA4';
          ctx.font = '12px Arial';
          ctx.fillText(timeStr, badgeX + 45, padding + 17);

      // Message content
      ctx.fillStyle = '#DBDEE1';
          ctx.font = '16px Arial';
          let y = padding + avatarSize + 10;
          for (const line of contentLines) {
                  ctx.fillText(line, nameX, y);
                  y += lineHeight;
          }

      const buffer = canvas.toBuffer('image/png');
          res.set('Content-Type', 'image/png');
          res.send(buffer);

    } catch (error) {
          console.error('Error generating image:', error);
          res.status(500).json({ error: error.message });
    }
});

function wrapText(text, maxChars) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
          if ((current + ' ' + word).trim().length > maxChars) {
                  if (current) lines.push(current);
                  current = word;
          } else {
                  current = (current + ' ' + word).trim();
          }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

app.listen(PORT, () => {
    console.log(`Image generator running on port ${PORT}`);
});
