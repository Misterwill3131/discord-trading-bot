# Proof Generator Discord-Style Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `generateProofImage()` so the output looks like two real Discord messages (avatar + username + role badges + timestamp) instead of colored label blocks.

**Architecture:** Two functions in `index.js` are changed: `drawMessageBlock()` drops the `label`/`labelColor` params and gains Discord badge rendering; `generateProofImage()` updates the height formula and replaces the elaborate divider with a thin line. No other files touched.

**Tech Stack:** Node.js, node-canvas (`createCanvas`, `loadImage`), `CUSTOM_AVATARS` map (local avatar files already present).

---

### Task 1 — Rewrite `drawMessageBlock()` to Discord style

**Files:**
- Modify: `index.js:4075-4178`

**Context:** `drawMessageBlock` is at line 4075. It currently takes `(ctx, author, content, timestamp, yStart, W, label, labelColor)` and draws a colored label badge before the avatar+message. The new version removes `label`/`labelColor`, removes the badge, adds two role badge pills after the username, and changes the timestamp to full date+time.

The function must return the block height so `generateProofImage()` can compute canvas size. New height formula (no label badge):
```
PADDING_V(14) + ROW_H(20) + lines.length * LINE_H(22) + PADDING_V(14)
= 48 + lines.length * 22
```

- [ ] **Step 1: Replace `drawMessageBlock` with the new Discord-style version**

Replace the entire function from line 4075 to 4178 with:

```javascript
async function drawMessageBlock(ctx, author, content, timestamp, yStart, W) {
  const PADDING_V = 14;
  const PADDING_L = 16;
  const AVATAR_D = 40;
  const AVATAR_X = PADDING_L;
  const CONTENT_X = PADDING_L + AVATAR_D + 16;
  const MAX_TW = W - CONTENT_X - PADDING_L;
  const LINE_H = 22;
  const ROW_H = 20;
  const FONT = 'gg sans, Segoe UI, Arial, sans-serif';

  // Avatar
  const avatarCX = AVATAR_X + AVATAR_D / 2;
  const avatarCY = yStart + PADDING_V + ROW_H / 2 + 2;
  const avatarR = AVATAR_D / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const customAvatarUrl = CUSTOM_AVATARS[author];
  if (customAvatarUrl) {
    try {
      const img = await loadImage(customAvatarUrl);
      const size = AVATAR_D;
      const imgRatio = img.width / img.height;
      let drawW = size, drawH = size;
      let drawX = avatarCX - avatarR, drawY = avatarCY - avatarR;
      if (imgRatio > 1) { drawW = size * imgRatio; drawX = avatarCX - drawW / 2; }
      else { drawH = size / imgRatio; drawY = avatarCY - drawH / 2; }
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } catch (e) {
      ctx.fillStyle = '#5865f2';
      ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
    }
  } else {
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
  }
  ctx.restore();
  if (!customAvatarUrl) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((author || '?').slice(0, 2).toUpperCase(), avatarCX, avatarCY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Username
  const nameY = yStart + PADDING_V + ROW_H - 3;
  ctx.font = 'bold 15px ' + FONT;
  const nameW = ctx.measureText(author || '?').width;
  if (author === 'Legacy Trading') {
    ctx.fillStyle = '#e84040';
  } else {
    const nameGrad = ctx.createLinearGradient(CONTENT_X, 0, CONTENT_X + nameW, 0);
    nameGrad.addColorStop(0, '#ff79f2');
    nameGrad.addColorStop(1, '#d649cc');
    ctx.fillStyle = nameGrad;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(author || '?', CONTENT_X, nameY);

  // Role badges
  let badgeX = CONTENT_X + nameW + 8;
  const badgeY = nameY - 14;
  const badgeH = 16;
  ctx.font = 'bold 10px ' + FONT;

  const drawBadge = (text, bgColor, borderColor, textColor) => {
    const tw = ctx.measureText(text).width;
    const bw = tw + 12;
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, bw, badgeH, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(text, badgeX + 6, nameY - 2);
    badgeX += bw + 4;
  };

  drawBadge('\uD83D\uDD25 BOOM', 'rgba(214,73,204,0.15)', 'rgba(214,73,204,0.4)', '#d649cc');
  drawBadge('boom', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.12)', '#a0a0b0');

  // Timestamp
  const d = timestamp ? new Date(timestamp) : new Date();
  const dateStr = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/New_York' });
  const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  ctx.fillStyle = '#72767d';
  ctx.font = '11px ' + FONT;
  ctx.fillText(dateStr + ' \u00B7 ' + timeStr, badgeX + 4, nameY - 2);

  // Message content
  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '15px ' + FONT;
  const lines = wrapText(tmpCtx, content, MAX_TW);
  ctx.fillStyle = '#dcddde';
  ctx.font = '15px ' + FONT;
  let ty = nameY + LINE_H;
  for (const line of lines) {
    ctx.fillText(line, CONTENT_X, ty);
    ty += LINE_H;
  }

  return PADDING_V + ROW_H + lines.length * LINE_H + PADDING_V;
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check index.js && echo OK
```
Expected: `OK`

---

### Task 2 — Update `generateProofImage()` height calc, divider, and call sites

**Files:**
- Modify: `index.js:4183-4281`

**Context:** `generateProofImage()` pre-computes canvas height using a `blockH` formula that must match `drawMessageBlock`'s return value. Old formula: `LABEL_H(32) + PADDING_V(14) + NAME_H(20) + lines*LINE_H(22) + PADDING_V(14) = 80 + lines*22`. New formula (no label badge): `PADDING_V(14) + ROW_H(20) + lines*LINE_H(22) + PADDING_V(14) = 48 + lines*22`. `DIVIDER_H` drops from 44 to 20. Call sites remove `label`/`labelColor` args. Font size in `wrapText` measurement changes from `16px` to `15px` (matching new content font).

- [ ] **Step 1: Replace the height-computation block and divider in `generateProofImage()`**

Find and replace the block from `const W = 740;` through `ctx.textBaseline = 'alphabetic';` (lines ~4184–4242) with:

```javascript
  const W = 740;
  const FONT = 'gg sans, Segoe UI, Arial, sans-serif';

  const tmpC = createCanvas(W, 1000);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '15px ' + FONT;
  const CONTENT_X = 16 + 40 + 16;
  const MAX_TW = W - CONTENT_X - 16;
  const LINE_H = 22;
  const PADDING_V = 14;
  const ROW_H = 20;

  const alertLines = wrapText(tmpCtx, alertContent, MAX_TW);
  const recapLines = wrapText(tmpCtx, recapContent, MAX_TW);

  const blockH = (lines) => PADDING_V + ROW_H + lines.length * LINE_H + PADDING_V;
  const alertH = blockH(alertLines);
  const recapH = blockH(recapLines);
  const DIVIDER_H = 20;
  const HEADER_H = 52;
  const FOOTER_H = 50;

  const H = HEADER_H + 8 + alertH + DIVIDER_H + recapH + 8 + FOOTER_H;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // Header gradient
  const headerGrad = ctx.createLinearGradient(0, 0, W, 0);
  headerGrad.addColorStop(0, '#2a1e3a');
  headerGrad.addColorStop(1, '#1a2a3a');
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Header: BOOM branding
  try {
    const logoImg = await loadImage(path.join(__dirname, 'logo_boom.png'));
    ctx.save();
    ctx.beginPath();
    ctx.arc(26, HEADER_H / 2, 18, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, 8, HEADER_H / 2 - 18, 36, 36);
    ctx.restore();
  } catch (e) {}
  ctx.fillStyle = '#D649CC';
  ctx.font = 'bold 20px ' + FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('BOOM', 52, HEADER_H / 2);
  ctx.fillStyle = '#80848e';
  ctx.font = '13px ' + FONT;
  ctx.fillText('Trade Proof  \u2022  discord.gg/templeofboom', 52 + ctx.measureText('BOOM').width + 14, HEADER_H / 2);
  ctx.textBaseline = 'alphabetic';
```

- [ ] **Step 2: Replace the alert block call, divider, and recap block call**

Find and replace from `// Alert block` through `await drawMessageBlock(ctx, recapAuthor...` (lines ~4244–4268) with:

```javascript
  // Alert block
  let y = HEADER_H + 8;
  await drawMessageBlock(ctx, alertAuthor, alertContent, alertTimestamp, y, W);

  // Thin divider
  y += alertH;
  ctx.strokeStyle = '#3f4147';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(40, y + DIVIDER_H / 2);
  ctx.lineTo(W - 40, y + DIVIDER_H / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Recap block
  y += DIVIDER_H;
  await drawMessageBlock(ctx, recapAuthor, recapContent, recapTimestamp, y, W);
```

- [ ] **Step 3: Verify syntax**

```bash
node --check index.js && echo OK
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd /c/Users/willi/Documents/GitHub/discord-trading-bot
git add index.js
git commit -m "Redesign proof image to Discord-style messages with role badges"
git push
```

Expected: push succeeds, Railway redeploys.

- [ ] **Step 5: Visual test**

Navigate to `/proof-generator`, search a ticker, select an alert, fill the recap, click "Générer". Verify the image shows:
- Two Discord-style messages (avatar circle, username in pink gradient, `🔥 BOOM` badge, `boom` badge, date+time timestamp)
- Thin horizontal separator between the two messages
- BOOM header and footer unchanged
