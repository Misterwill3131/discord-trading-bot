// Quick test — generates a proof image with dummy data and saves it
process.env.DISCORD_TOKEN = 'dummy';
process.env.DASHBOARD_PASSWORD = 'dummy';

// Suppress Discord/Express startup
const Module = require('module');
const _load = Module._load;
Module._load = function(req, ...args) {
  if (req === 'discord.js') return { Client: class { on(){}; once(){}; login(){} }, GatewayIntentBits: { Guilds:1, GuildMessages:2, MessageContent:4 } };
  return _load.call(this, req, ...args);
};

// Monkey-patch express listen
const express = require('express');
const _listen = express.application.listen;
express.application.listen = function() { return { on: () => {} }; };

const fs = require('fs');
// We need to isolate generateProofImage — easiest: eval the relevant functions
// Let's use child_process to call the HTTP API instead
// Actually, let's extract the functions via a regex approach...
// Simplest: just run index.js briefly and call the function

// Reset module cache for clean load
delete require.cache[require.resolve('./index.js')];

setTimeout(async () => {
  // The module won't export generateProofImage, so let's build a minimal standalone
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const path = require('path');

  const __dirname2 = __dirname;
  const AV = (f) => path.join(__dirname2, 'avatar', f);
  const CUSTOM_AVATARS = {
    'Z': AV('z-avatar.jpg'),
  };
  const CUSTOM_EMOJIS = { 'greatcall': AV('great_call.png') };
  const FONT = 'gg sans, Segoe UI, Arial, sans-serif';

  function wrapText(ctx, text, maxWidth) {
    const result = [];
    for (const para of String(text || '').split('\n')) {
      const words = para.split(' ');
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (ctx.measureText(test).width > maxWidth && current) { result.push(current); current = word; }
        else current = test;
      }
      result.push(current);
    }
    return result.length ? result : [''];
  }

  function parseRichSegments(text) {
    const segs = [];
    const re = /<(a?):(\w+):(\d+)>/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) segs.push({ type: 'text', value: text.slice(last, m.index) });
      segs.push({ type: 'emoji', animated: m[1] === 'a', name: m[2], id: m[3] });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ type: 'text', value: text.slice(last) });
    return segs.length ? segs : [{ type: 'text', value: text }];
  }

  function measureRichWidth(ctx, text, emojiSize) {
    let w = 0;
    for (const seg of parseRichSegments(text)) w += seg.type === 'text' ? ctx.measureText(seg.value).width : emojiSize + 2;
    return w;
  }

  function wrapRichText(ctx, text, maxWidth, emojiSize) {
    const result = [];
    for (const para of String(text || '').split('\n')) {
      const words = para.split(' ');
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (measureRichWidth(ctx, test, emojiSize) > maxWidth && current) { result.push(current); current = word; }
        else current = test;
      }
      result.push(current);
    }
    return result.length ? result : [''];
  }

  async function drawRichLine(ctx, text, x, y, fontSize) {
    const emojiSize = Math.round(fontSize * 1.15);
    let cx = x;
    for (const seg of parseRichSegments(text)) {
      if (seg.type === 'text') {
        if (seg.value) { ctx.fillText(seg.value, cx, y); cx += ctx.measureText(seg.value).width; }
      } else {
        const localPath = CUSTOM_EMOJIS[seg.name];
        const src = localPath || (seg.animated ? 'https://cdn.discordapp.com/emojis/' + seg.id + '.webp?size=32&animated=true' : 'https://cdn.discordapp.com/emojis/' + seg.id + '.png?size=32');
        try {
          const img = await loadImage(src);
          ctx.drawImage(img, cx, y - emojiSize * 0.82, emojiSize, emojiSize);
          cx += emojiSize + 2;
        } catch (e) {
          ctx.fillText(':' + seg.name + ':', cx, y);
          cx += ctx.measureText(':' + seg.name + ':').width;
        }
      }
    }
  }

  function resolveUserMentions(content) { return content || ''; }

  async function drawMessageBlock(ctx, author, content, timestamp, yStart, W) {
    ctx.save();
    const PADDING_V = 18, PADDING_L = 16, AVATAR_D = 40;
    const AVATAR_X = PADDING_L, CONTENT_X = PADDING_L + AVATAR_D + 16;
    const MAX_TW = W - CONTENT_X - PADDING_L, LINE_H = 22, NAME_H = 20;

    const avatarCX = AVATAR_X + AVATAR_D / 2, avatarCY = yStart + PADDING_V + NAME_H / 2 + 2, avatarR = AVATAR_D / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    const customAvatarUrl = CUSTOM_AVATARS[author];
    if (customAvatarUrl) {
      try {
        const img = await loadImage(customAvatarUrl);
        const size = AVATAR_D, imgRatio = img.width / img.height;
        let drawW = size, drawH = size, drawX = avatarCX - avatarR, drawY = avatarCY - avatarR;
        if (imgRatio > 1) { drawW = size * imgRatio; drawX = avatarCX - drawW / 2; }
        else { drawH = size / imgRatio; drawY = avatarCY - drawH / 2; }
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
      } catch (e) { ctx.fillStyle = '#5865f2'; ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D); }
    } else { ctx.fillStyle = '#5865f2'; ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D); }
    ctx.restore();
    if (!customAvatarUrl) {
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 14px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((author || 'W').slice(0, 2).toUpperCase(), avatarCX, avatarCY);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // Username — bold 16px
    const nameY = yStart + PADDING_V + NAME_H - 3;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 16px ' + FONT;
    const nameW = ctx.measureText(author || 'Z').width;
    if (author === 'Legacy Trading') { ctx.fillStyle = '#e84040'; }
    else {
      const nameGrad = ctx.createLinearGradient(CONTENT_X, 0, CONTENT_X + nameW, 0);
      nameGrad.addColorStop(0, '#ff79f2'); nameGrad.addColorStop(1, '#d649cc'); ctx.fillStyle = nameGrad;
    }
    ctx.fillText(author || 'Z', CONTENT_X, nameY);

    // tag_boom.png
    const TAG_H = 18;
    const badgeX = CONTENT_X + nameW + 6;
    const badgeY = nameY - TAG_H + 2;
    let BADGE_W = 0;
    try {
      const tagImg = await loadImage(path.join(__dirname2, 'avatar', 'tag_boom.png'));
      const tagRatio = tagImg.width / tagImg.height;
      BADGE_W = Math.round(TAG_H * tagRatio);
      ctx.drawImage(tagImg, badgeX, badgeY, BADGE_W, TAG_H);
    } catch(e) {
      ctx.font = 'bold 10px ' + FONT; ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
      ctx.fillText('BOOM', badgeX, badgeY + TAG_H / 2);
      ctx.textBaseline = 'alphabetic'; BADGE_W = 50;
    }

    // Logo BOOM circulaire
    const LOGO_SIZE = 18;
    const logoX = badgeX + BADGE_W + 6;
    const logoCY = badgeY + TAG_H / 2;
    let logoEndX = logoX;
    try {
      const logoImg = await loadImage(path.join(__dirname2, 'logo_boom.png'));
      ctx.save();
      ctx.beginPath(); ctx.arc(logoX + LOGO_SIZE / 2, logoCY, LOGO_SIZE / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
      ctx.drawImage(logoImg, logoX, logoCY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
      ctx.restore();
      logoEndX = logoX + LOGO_SIZE + 6;
    } catch(e) { logoEndX = logoX; }

    // Time — en-US, CONFIG.TIME_COLOR
    const d = timestamp ? new Date(timestamp) : new Date();
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
    ctx.fillStyle = '#80848e'; ctx.font = '12px ' + FONT;
    ctx.fillText(timeStr, logoEndX, nameY - 1);

    // Content — 16px with rich text
    content = resolveUserMentions(content);
    const tmpC = createCanvas(W, 400), tmpCtx = tmpC.getContext('2d');
    tmpCtx.font = '16px ' + FONT;
    const EMOJI_SIZE = 18;
    const lines = wrapRichText(tmpCtx, content, MAX_TW, EMOJI_SIZE);
    ctx.fillStyle = '#dcddde'; ctx.font = '16px ' + FONT;
    let ty = nameY + LINE_H;
    for (const line of lines) { await drawRichLine(ctx, line, CONTENT_X, ty, 16); ty += LINE_H; }
    ctx.restore();
    return PADDING_V + NAME_H + lines.length * LINE_H + PADDING_V;
  }

  async function generateProofImage(alertAuthor, alertContent, alertTimestamp, recapAuthor, recapContent, recapTimestamp) {
    const W = 740;
    const CONTENT_X = 16 + 40 + 16, MAX_TW = W - CONTENT_X - 16;
    const LINE_H = 22, PADDING_V = 18, NAME_H = 20, EMOJI_SIZE = 18;
    const tmpC = createCanvas(W, 1000), tmpCtx = tmpC.getContext('2d');
    tmpCtx.font = '16px ' + FONT;
    const recapLines = wrapRichText(tmpCtx, recapContent, MAX_TW, EMOJI_SIZE);
    const recapH = PADDING_V + NAME_H + recapLines.length * LINE_H + PADDING_V;
    const REPLY_REF_H = 28, HEADER_H = 52, FOOTER_H = 50;
    const BIG_BLOCK_SHIFT = 10;
    const H = HEADER_H + 8 + REPLY_REF_H + recapH + 8 + FOOTER_H - BIG_BLOCK_SHIFT;
    const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1e1f22'; ctx.fillRect(0, 0, W, H);
    const headerGrad = ctx.createLinearGradient(0, 0, W, 0);
    headerGrad.addColorStop(0, '#2a1e3a'); headerGrad.addColorStop(1, '#1a2a3a');
    ctx.fillStyle = headerGrad; ctx.fillRect(0, 0, W, HEADER_H);
    try {
      const logoImg = await loadImage(path.join(__dirname2, 'logo_boom.png'));
      ctx.save(); ctx.beginPath(); ctx.arc(26, HEADER_H/2, 18, 0, Math.PI*2); ctx.closePath(); ctx.clip();
      ctx.drawImage(logoImg, 8, HEADER_H/2-18, 36, 36); ctx.restore();
    } catch(e) {}
    ctx.fillStyle = '#D649CC'; ctx.font = 'bold 20px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('BOOM', 52, HEADER_H/2);
    ctx.fillStyle = '#80848e'; ctx.font = '13px ' + FONT;
    ctx.fillText('Trade Proof  •  discord.gg/templeofboom', 52 + ctx.measureText('BOOM').width + 14, HEADER_H/2);
    ctx.textBaseline = 'alphabetic';

    const refY = HEADER_H + 8, refMidY = refY + REPLY_REF_H/2, REF_AVT_D = 16;
    const refAvtCX = 72 + REF_AVT_D/2, refAvtCY = refMidY;
    const lineY = refAvtCY;
    // Vertical reaches top of big avatar (AVATAR_D=40, avatarCY=yStart+PADDING_V+ROW_H/2+2)
    const bigAvatarTopY = refY + REPLY_REF_H + 18 + 10 + 2 - 20 - BIG_BLOCK_SHIFT;
    const lineStartX = 36;
    ctx.save(); ctx.strokeStyle = '#4f545c'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(lineStartX, bigAvatarTopY + 8); ctx.arcTo(lineStartX, lineY, lineStartX + 8, lineY, 6); ctx.lineTo(refAvtCX, lineY); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(refAvtCX, refAvtCY, REF_AVT_D/2, 0, Math.PI*2); ctx.closePath(); ctx.clip();
    const alertAvtUrl = CUSTOM_AVATARS[alertAuthor];
    if (alertAvtUrl) { try { const img = await loadImage(alertAvtUrl); ctx.drawImage(img, refAvtCX-REF_AVT_D/2, refAvtCY-REF_AVT_D/2, REF_AVT_D, REF_AVT_D); } catch(e) { ctx.fillStyle='#5865f2'; ctx.fillRect(refAvtCX-REF_AVT_D/2, refAvtCY-REF_AVT_D/2, REF_AVT_D, REF_AVT_D); } }
    else { ctx.fillStyle='#5865f2'; ctx.fillRect(refAvtCX-REF_AVT_D/2, refAvtCY-REF_AVT_D/2, REF_AVT_D, REF_AVT_D); }
    ctx.restore();

    const refNameX = 72 + REF_AVT_D + 4;
    ctx.font = 'bold 12px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const refNameW = ctx.measureText(alertAuthor||'?').width;
    const rg = ctx.createLinearGradient(refNameX,0,refNameX+refNameW,0);
    rg.addColorStop(0,'#ff79f2'); rg.addColorStop(1,'#d649cc'); ctx.fillStyle = rg;
    ctx.fillText(alertAuthor||'?', refNameX, refMidY);

    // tag_boom.png + logo_boom.png circulaire (same as bottom block)
    let refBadgeX = refNameX + refNameW + 6;
    const refTagH = 14;
    let refTagW = 0;
    try {
      const tagImg = await loadImage(path.join(__dirname2, 'avatar', 'tag_boom.png'));
      const tagRatio = tagImg.width / tagImg.height;
      refTagW = Math.round(refTagH * tagRatio);
      ctx.drawImage(tagImg, refBadgeX, refMidY - refTagH / 2, refTagW, refTagH);
    } catch (e) {
      ctx.font = 'bold 9px ' + FONT; ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
      ctx.fillText('BOOM', refBadgeX, refMidY); ctx.textBaseline = 'alphabetic';
      refTagW = 35;
    }
    refBadgeX += refTagW + 5;

    const refLogoSize = 14;
    try {
      const logoImg = await loadImage(path.join(__dirname2, 'logo_boom.png'));
      ctx.save();
      ctx.beginPath(); ctx.arc(refBadgeX + refLogoSize / 2, refMidY, refLogoSize / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
      ctx.drawImage(logoImg, refBadgeX, refMidY - refLogoSize / 2, refLogoSize, refLogoSize);
      ctx.restore();
      refBadgeX += refLogoSize + 6;
    } catch (e) {}

    const refContentX = refBadgeX;
    ctx.font = '12px ' + FONT; ctx.fillStyle = '#72767d';
    const truncMaxW = W - refContentX - 16;
    let truncText = (alertContent||'').replace(/\n/g,' ');
    const fullTrunc = truncText;
    while (truncText.length > 0 && ctx.measureText(truncText).width > truncMaxW) truncText = truncText.slice(0,-1);
    if (truncText.length < fullTrunc.length) truncText += '...';
    ctx.fillText(truncText, refContentX, refMidY);
    ctx.textBaseline = 'alphabetic';

    await drawMessageBlock(ctx, recapAuthor, recapContent, recapTimestamp, refY + REPLY_REF_H - BIG_BLOCK_SHIFT, W);

    const footerY = H - FOOTER_H;
    ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, footerY, W, FOOTER_H);
    ctx.fillStyle = '#4f545c'; ctx.font = '13px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('discord.gg/templeofboom', W/2, footerY + FOOTER_H/2);

    return canvas.toBuffer('image/png');
  }

  const buf = await generateProofImage(
    'Z', 'UCAR $1.31 in small', '2026-04-17T14:31:00.000Z',
    'Z', 'UCAR 1.31-1.85', '2026-04-17T16:22:00.000Z'
  );
  require('fs').writeFileSync(path.join(__dirname2, 'test_proof_output.png'), buf);
  console.log('Image saved: test_proof_output.png');
}, 100);
