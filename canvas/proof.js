// ─────────────────────────────────────────────────────────────────────
// canvas/proof.js — Génération des images Discord "réponse" style
// ─────────────────────────────────────────────────────────────────────
// Deux fonctions principales :
//   • generateImage      — image simple (avatar + en-tête + message)
//   • generateProofImage — image "réponse" (barre de référence en haut
//                          reliée par une flèche courbée au bloc principal)
// + helpers partagés (wrapText, emojis Discord, mentions @user).
//
// Effet de bord : setDiscordClient(c) doit être appelé APRÈS que le
// bot Discord ait connecté `client` (pour résoudre les mentions <@id>).
// Avant l'appel, les mentions restent brutes — pas de crash, juste un
// rendu dégradé.
//
// Exporte :
//   generateImage, drawMessageBlock, generateProofImage
//   setDiscordClient — injection du client Discord pour les @mentions
//   PROOF_LAYOUT     — constantes de layout partagées (tests, debug)
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { CONFIG, FONT, CUSTOM_AVATARS, CUSTOM_ROLES, SPECIAL_MENTIONS, CUSTOM_EMOJIS } = require('./config');
const { getDisplayName } = require('../utils/authors');

// Chemins absolus vers les ressources — remonte d'un niveau depuis canvas/.
const AVATAR_DIR    = path.join(__dirname, '..', 'avatar');
const TAG_BOOM_PATH = path.join(AVATAR_DIR, 'tag_boom.png');
const LOGO_PATH     = path.join(__dirname, '..', 'logo_boom.png');

// ── Client Discord (injecté depuis index.js) ──────────────────────────
// On stocke une référence mutable pour permettre un wire-up après coup
// (le client Discord est créé plus tard dans le lifecycle de l'app).
let _discordClient = null;
function setDiscordClient(client) { _discordClient = client; }

// Lookup couleur+nom d'un rôle Discord par son id.
// Retourne null si non trouvé — le rendu retombe alors sur la chaîne brute.
function getRoleStyle(id) {
  return CUSTOM_ROLES[id] || null;
}

// Convertit un hex "#rrggbb" en string CSS "rgba(r, g, b, alpha)".
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}

// Remplace <@id> / <@!id> par @username via le cache Discord. Si le
// client n'est pas injecté ou l'utilisateur n'est pas en cache, on
// garde la mention brute (pas de crash).
function resolveUserMentions(content) {
  return (content || '').replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = _discordClient && _discordClient.users && _discordClient.users.cache
      ? _discordClient.users.cache.get(userId)
      : null;
    return user ? '@' + (user.globalName || user.username) : match;
  });
}

// ── Helpers text wrapping ────────────────────────────────────────────
function wrapText(ctx, text, maxWidth) {
  const result = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        result.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    result.push(current);
  }
  return result.length ? result : [''];
}

// Segmente un texte en {text}, {emoji}, {roleMention}, {specialMention},
// {link}. L'italique markdown *texte* est représenté par un flag
// `italic: true` sur chaque segment concerné (le contenu interne d'un
// italique est re-parsé pour les liens/emojis/mentions imbriqués).
// Reconnaît :
//   • <:name:id>  ou  <a:name:id>   → emoji custom Discord
//   • <@&id>                         → mention de rôle Discord
//   • @everyone  ou  @here           → mention spéciale (pill blurple)
//   • [label](url)                   → lien markdown (rendu : label en bleu)
//   • *texte*                        → italique markdown (flag sur les sous-segments)
function parseRichSegments(text) {
  const result = [];

  // Parse la couche emoji + role + mention spéciale + lien sur une chaîne
  // en propageant le flag italic à chaque segment produit.
  function parseInner(s, italic) {
    const re = /<(a?):(\w+):(\d+)>|<@&(\d+)>|@(everyone|here)\b|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) {
        const seg = { type: 'text', value: s.slice(last, m.index) };
        if (italic) seg.italic = true;
        result.push(seg);
      }
      let seg;
      if (m[4] !== undefined) {
        seg = { type: 'roleMention', id: m[4] };
      } else if (m[5] !== undefined) {
        seg = { type: 'specialMention', name: m[5] };
      } else if (m[6] !== undefined) {
        seg = { type: 'link', label: m[6], url: m[7] };
      } else {
        seg = { type: 'emoji', animated: m[1] === 'a', name: m[2], id: m[3] };
      }
      if (italic) seg.italic = true;
      result.push(seg);
      last = m.index + m[0].length;
    }
    if (last < s.length) {
      const seg = { type: 'text', value: s.slice(last) };
      if (italic) seg.italic = true;
      result.push(seg);
    }
  }

  // Première passe : italique markdown *texte* (non-greedy, exclut les
  // sauts de ligne et les `*` imbriqués). Le contenu interne est repassé
  // dans parseInner avec italic=true pour gérer les liens imbriqués type
  // `*Replying to ZZ [message](url)*`.
  const italicRe = /\*([^*\n]+)\*/g;
  let last = 0, m;
  while ((m = italicRe.exec(text)) !== null) {
    if (m.index > last) parseInner(text.slice(last, m.index), false);
    parseInner(m[1], true);
    last = m.index + m[0].length;
  }
  if (last < text.length) parseInner(text.slice(last), false);

  return result.length ? result : [{ type: 'text', value: text }];
}

function measureRichWidth(ctx, text, emojiSize) {
  let w = 0;
  for (const seg of parseRichSegments(text)) {
    // L'italique change légèrement la métrique — on bascule la police
    // pour la durée de la mesure du segment.
    const prevFont = seg.italic ? ctx.font : null;
    if (seg.italic) ctx.font = 'italic ' + ctx.font;

    if (seg.type === 'text') {
      w += ctx.measureText(seg.value).width;
    } else if (seg.type === 'emoji') {
      w += emojiSize + 2;
    } else if (seg.type === 'roleMention') {
      const style = getRoleStyle(seg.id);
      if (style) {
        // Pill : '@' + name + 6px de padding total (3 de chaque côté).
        w += ctx.measureText('@' + style.name).width + 6;
      } else {
        // Inconnu : on tombe sur le rendu brut <@&id>.
        w += ctx.measureText('<@&' + seg.id + '>').width;
      }
    } else if (seg.type === 'specialMention') {
      const style = SPECIAL_MENTIONS[seg.name];
      // Pill : label + 6px de padding total (idem rôles). Fallback brut
      // si la clé est inconnue (ne devrait pas arriver vu le regex).
      w += style
        ? ctx.measureText(style.label).width + 6
        : ctx.measureText('@' + seg.name).width;
    } else if (seg.type === 'link') {
      // Mesure du label uniquement (l'URL n'est pas rendue).
      w += ctx.measureText(seg.label).width;
    }

    if (prevFont !== null) ctx.font = prevFont;
  }
  return w;
}

function wrapRichText(ctx, text, maxWidth, emojiSize) {
  const result = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (measureRichWidth(ctx, test, emojiSize) > maxWidth && current) {
        result.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    result.push(current);
  }
  return result.length ? result : [''];
}

async function drawRichLine(ctx, text, x, y, fontSize) {
  const emojiSize = Math.round(fontSize * 1.15);
  let cx = x;
  for (const seg of parseRichSegments(text)) {
    // L'italique se traduit en bascule de police pour la durée du segment.
    // Les emojis ne sont pas affectés (les SVG/PNG ne s'inclinent pas).
    const prevFont = seg.italic ? ctx.font : null;
    if (seg.italic) ctx.font = 'italic ' + ctx.font;

    if (seg.type === 'text') {
      if (seg.value) {
        ctx.fillText(seg.value, cx, y);
        cx += ctx.measureText(seg.value).width;
      }
    } else if (seg.type === 'emoji') {
      // Préférence aux fichiers locaux pour les emojis custom du bot ; sinon CDN Discord.
      const localPath = CUSTOM_EMOJIS[seg.name];
      const src = localPath || (seg.animated
        ? 'https://cdn.discordapp.com/emojis/' + seg.id + '.webp?size=32&animated=true'
        : 'https://cdn.discordapp.com/emojis/' + seg.id + '.png?size=32');
      try {
        const img = await loadImage(src);
        ctx.drawImage(img, cx, y - emojiSize * 0.82, emojiSize, emojiSize);
        cx += emojiSize + 2;
      } catch (e) {
        // Fallback : afficher le nom entre deux colonnes.
        ctx.fillText(':' + seg.name + ':', cx, y);
        cx += ctx.measureText(':' + seg.name + ':').width;
      }
    } else if (seg.type === 'roleMention') {
      const style = getRoleStyle(seg.id);
      if (style) {
        const label = '@' + style.name;
        const labelW = ctx.measureText(label).width;
        const pillH = fontSize + 4;
        const pillY = y - fontSize * 0.85;
        const prevFill = ctx.fillStyle;
        // Fond pill (couleur du rôle à 18% d'opacity).
        ctx.fillStyle = hexToRgba(style.color, 0.18);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(cx, pillY, labelW + 6, pillH, 3);
        } else {
          // Fallback si roundRect n'est pas dispo dans la version de canvas.
          ctx.rect(cx, pillY, labelW + 6, pillH);
        }
        ctx.fill();
        // Texte du label par-dessus.
        ctx.fillStyle = style.color;
        ctx.fillText(label, cx + 3, y);
        // Restaurer la couleur précédente pour le texte qui suit.
        ctx.fillStyle = prevFill;
        cx += labelW + 6;
      } else {
        const raw = '<@&' + seg.id + '>';
        ctx.fillText(raw, cx, y);
        cx += ctx.measureText(raw).width;
      }
    } else if (seg.type === 'specialMention') {
      const style = SPECIAL_MENTIONS[seg.name];
      if (style) {
        const label = style.label;
        const labelW = ctx.measureText(label).width;
        const pillH = fontSize + 4;
        const pillY = y - fontSize * 0.85;
        const prevFill = ctx.fillStyle;
        ctx.fillStyle = hexToRgba(style.color, 0.18);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(cx, pillY, labelW + 6, pillH, 3);
        } else {
          ctx.rect(cx, pillY, labelW + 6, pillH);
        }
        ctx.fill();
        ctx.fillStyle = style.color;
        ctx.fillText(label, cx + 3, y);
        ctx.fillStyle = prevFill;
        cx += labelW + 6;
      } else {
        const raw = '@' + seg.name;
        ctx.fillText(raw, cx, y);
        cx += ctx.measureText(raw).width;
      }
    } else if (seg.type === 'link') {
      // Lien markdown : on n'affiche que le label, en couleur lien (l'URL
      // n'est pas exploitable dans une image fixe). Pas de soulignement —
      // Discord lui-même ne souligne qu'au survol.
      const prevFill = ctx.fillStyle;
      ctx.fillStyle = CONFIG.LINK_COLOR;
      ctx.fillText(seg.label, cx, y);
      cx += ctx.measureText(seg.label).width;
      ctx.fillStyle = prevFill;
    }

    if (prevFont !== null) ctx.font = prevFont;
  }
}

// Variante single-line de drawRichLine qui tronque avec "..." si la
// largeur dépasse maxWidth. Utilisée pour la barre de référence du
// generateProofImage. Prérequis : ctx.font et ctx.textBaseline = 'middle'
// déjà configurés par l'appelant.
async function drawRichLineTruncated(ctx, text, x, y, fontSize, maxWidth) {
  const segs = parseRichSegments(text);
  const emojiSize = Math.round(fontSize * 1.15);
  const ellipsisW = ctx.measureText('...').width;
  const xMax = x + maxWidth;
  let cx = x;

  // Mesure d'un segment pour le test "fits". Bascule en italique si le
  // segment porte le flag — la métrique italique diffère légèrement.
  function segWidth(seg) {
    const prevFont = seg.italic ? ctx.font : null;
    if (seg.italic) ctx.font = 'italic ' + ctx.font;
    let w = 0;
    if (seg.type === 'text') {
      w = ctx.measureText(seg.value).width;
    } else if (seg.type === 'emoji') {
      w = emojiSize + 2;
    } else if (seg.type === 'roleMention') {
      const st = getRoleStyle(seg.id);
      w = st ? ctx.measureText('@' + st.name).width + 6
             : ctx.measureText('<@&' + seg.id + '>').width;
    } else if (seg.type === 'specialMention') {
      const st = SPECIAL_MENTIONS[seg.name];
      w = st ? ctx.measureText(st.label).width + 6
             : ctx.measureText('@' + seg.name).width;
    } else if (seg.type === 'link') {
      w = ctx.measureText(seg.label).width;
    }
    if (prevFont !== null) ctx.font = prevFont;
    return w;
  }

  // Tronque char par char le texte d'un segment pour qu'il rentre dans
  // l'espace restant (en réservant la place pour "...") puis dessine.
  function truncateAndDraw(value, drawColor) {
    let tx = value;
    while (tx.length > 0 && cx + ctx.measureText(tx).width + ellipsisW > xMax) {
      tx = tx.slice(0, -1);
    }
    if (tx.length > 0) {
      const prevFill = ctx.fillStyle;
      if (drawColor) ctx.fillStyle = drawColor;
      ctx.fillText(tx, cx, y);
      if (drawColor) ctx.fillStyle = prevFill;
      cx += ctx.measureText(tx).width;
    }
    ctx.fillText('...', cx, y);
  }

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    const w = segWidth(seg);
    const reserved = isLast ? 0 : ellipsisW;
    const fits = cx + w + reserved <= xMax;

    // Bascule italique pour la durée du segment (mesure ET render utilisent
    // déjà la police italique via segWidth/blocs ci-dessous).
    const prevFont = seg.italic ? ctx.font : null;
    if (seg.italic) ctx.font = 'italic ' + ctx.font;

    if (!fits) {
      // Tronque les segments à contenu textuel ; pour les autres, on
      // pose juste l'ellipsis et on arrête.
      if (seg.type === 'text')        truncateAndDraw(seg.value);
      else if (seg.type === 'link')   truncateAndDraw(seg.label, CONFIG.LINK_COLOR);
      else                            ctx.fillText('...', cx, y);
      if (prevFont !== null) ctx.font = prevFont;
      return;
    }

    // Le segment tient en entier — render normal.
    if (seg.type === 'text') {
      ctx.fillText(seg.value, cx, y);
      cx += w;
    } else if (seg.type === 'emoji') {
      const localPath = CUSTOM_EMOJIS[seg.name];
      const src = localPath || (seg.animated
        ? 'https://cdn.discordapp.com/emojis/' + seg.id + '.webp?size=32&animated=true'
        : 'https://cdn.discordapp.com/emojis/' + seg.id + '.png?size=32');
      try {
        const img = await loadImage(src);
        ctx.drawImage(img, cx, y - emojiSize / 2, emojiSize, emojiSize);
        cx += emojiSize + 2;
      } catch (e) {
        const fb = ':' + seg.name + ':';
        ctx.fillText(fb, cx, y);
        cx += ctx.measureText(fb).width;
      }
    } else if (seg.type === 'roleMention') {
      const st = getRoleStyle(seg.id);
      if (st) {
        const label = '@' + st.name;
        const lblW = ctx.measureText(label).width;
        const pillH = fontSize + 4;
        const pillY = y - pillH / 2;
        const prevFill = ctx.fillStyle;
        ctx.fillStyle = hexToRgba(st.color, 0.18);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(cx, pillY, lblW + 6, pillH, 3);
        else                                      ctx.rect(cx, pillY, lblW + 6, pillH);
        ctx.fill();
        ctx.fillStyle = st.color;
        ctx.fillText(label, cx + 3, y);
        ctx.fillStyle = prevFill;
        cx += lblW + 6;
      } else {
        const raw = '<@&' + seg.id + '>';
        ctx.fillText(raw, cx, y);
        cx += ctx.measureText(raw).width;
      }
    } else if (seg.type === 'specialMention') {
      const st = SPECIAL_MENTIONS[seg.name];
      if (st) {
        const label = st.label;
        const lblW = ctx.measureText(label).width;
        const pillH = fontSize + 4;
        const pillY = y - pillH / 2;
        const prevFill = ctx.fillStyle;
        ctx.fillStyle = hexToRgba(st.color, 0.18);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(cx, pillY, lblW + 6, pillH, 3);
        else                                      ctx.rect(cx, pillY, lblW + 6, pillH);
        ctx.fill();
        ctx.fillStyle = st.color;
        ctx.fillText(label, cx + 3, y);
        ctx.fillStyle = prevFill;
        cx += lblW + 6;
      } else {
        const raw = '@' + seg.name;
        ctx.fillText(raw, cx, y);
        cx += ctx.measureText(raw).width;
      }
    } else if (seg.type === 'link') {
      const prevFill = ctx.fillStyle;
      ctx.fillStyle = CONFIG.LINK_COLOR;
      ctx.fillText(seg.label, cx, y);
      ctx.fillStyle = prevFill;
      cx += w;
    }

    if (prevFont !== null) ctx.font = prevFont;
  }
}

// ═════════════════════════════════════════════════════════════════════
//  generateImage — image simple avec un seul bloc message
// ═════════════════════════════════════════════════════════════════════
async function generateImage(author, content, timestamp /*, parentAuthor, parentContent */) {
  author = getDisplayName(author);

  const W = 740;
  const PADDING_V = 18;
  const PADDING_L = 16;
  const AVATAR_D  = 40;
  const AVATAR_X  = PADDING_L;
  const CONTENT_X = PADDING_L + AVATAR_D + 16;
  const MAX_TW    = W - CONTENT_X - PADDING_L;

  // Pré-calcul du nombre de lignes pour dimensionner le canvas final.
  // wrapRichText (et plus tard drawRichLine) rend les emojis Discord et
  // les mentions de rôle <@&id> ; sans ça, generateImage afficherait
  // les balises brutes dans l'image.
  const MSG_FONT_SIZE = 16;
  const MSG_EMOJI_SIZE = Math.round(MSG_FONT_SIZE * 1.15);
  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = MSG_FONT_SIZE + 'px ' + FONT;
  const lines = wrapRichText(tmpCtx, content, MAX_TW, MSG_EMOJI_SIZE);

  const LINE_H = 22;
  const NAME_H = 20;
  const H = PADDING_V + NAME_H + (lines.length * LINE_H) + PADDING_V + 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = CONFIG.BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  // ── Avatar rond ──
  const avatarCX = AVATAR_X + AVATAR_D / 2;
  const avatarCY = PADDING_V + NAME_H / 2 + 2;
  const avatarR  = AVATAR_D / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const customAvatarUrl = CUSTOM_AVATARS[author];
  if (customAvatarUrl) {
    try {
      const img = await loadImage(customAvatarUrl);
      // Cover : remplit le cercle en conservant le ratio de l'image.
      const size = AVATAR_D;
      const imgRatio = img.width / img.height;
      let drawW = size, drawH = size;
      let drawX = avatarCX - avatarR, drawY = avatarCY - avatarR;
      if (imgRatio > 1) { drawW = size * imgRatio; drawX = avatarCX - drawW / 2; }
      else              { drawH = size / imgRatio; drawY = avatarCY - drawH / 2; }
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } catch (e) {
      ctx.fillStyle = CONFIG.AVATAR_COLOR;
      ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
    }
  } else {
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
  }
  ctx.restore();

  // Initiales (uniquement si pas d'avatar custom).
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

  // Username — rouge pour Legacy Trading, dégradé rose pour les autres.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '16px ' + FONT;
  const nameW = ctx.measureText(author || 'Z').width;
  if (author === 'Legacy Trading') {
    ctx.fillStyle = '#e84040';
  } else {
    const nameGrad = ctx.createLinearGradient(CONTENT_X, 0, CONTENT_X + nameW, 0);
    nameGrad.addColorStop(0, '#ff79f2');
    nameGrad.addColorStop(1, '#d649cc');
    ctx.fillStyle = nameGrad;
  }
  ctx.fillText(author || 'Z', CONTENT_X, nameY);

  // Badge tag_boom.png
  const TAG_H = 18;
  const badgeX = CONTENT_X + nameW + 6;
  const badgeY = nameY - TAG_H + 2;
  let BADGE_W = 0;
  try {
    const tagImg = await loadImage(TAG_BOOM_PATH);
    const tagRatio = tagImg.width / tagImg.height;
    BADGE_W = Math.round(TAG_H * tagRatio);
    ctx.drawImage(tagImg, badgeX, badgeY, BADGE_W, TAG_H);
  } catch (e) {
    ctx.font = 'bold 10px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOOM', badgeX, badgeY + TAG_H / 2);
    ctx.textBaseline = 'alphabetic';
    BADGE_W = 50;
  }

  // Logo BOOM circulaire
  const LOGO_SIZE = 18;
  const logoX = badgeX + BADGE_W + 6;
  const logoCY = badgeY + TAG_H / 2;
  let logoEndX = logoX;
  try {
    const logoImg = await loadImage(LOGO_PATH);
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, logoCY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, logoX, logoCY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();
    logoEndX = logoX + LOGO_SIZE + 6;
  } catch (e) {
    logoEndX = logoX;
  }

  // Heure fuseau NY (24h).
  const d = timestamp ? new Date(timestamp) : new Date();
  const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  ctx.fillStyle = CONFIG.TIME_COLOR;
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, logoEndX, nameY - 1);

  // Corps du message — rendu rich-text (emojis Discord, mentions de rôle).
  ctx.fillStyle = CONFIG.MESSAGE_COLOR;
  ctx.font = MSG_FONT_SIZE + 'px ' + FONT;
  let ty = nameY + LINE_H;
  for (const line of lines) {
    await drawRichLine(ctx, line, CONTENT_X, ty, MSG_FONT_SIZE);
    ty += LINE_H;
  }

  return canvas.toBuffer('image/png');
}

// ═════════════════════════════════════════════════════════════════════
//  drawMessageBlock — Dessine UN bloc message complet à yStart
//                     (utilisé seul ou comme partie basse de generateProofImage)
// ═════════════════════════════════════════════════════════════════════

// Layout partagé entre drawMessageBlock et generateProofImage — centralisé
// pour éviter la dérive entre les deux fonctions.
const PROOF_LAYOUT = {
  PADDING_L:      16,   // padding horizontal (gauche/droite)
  PADDING_V:      18,   // padding vertical (haut/bas du bloc principal)
  AVATAR_D:       40,   // diamètre du gros avatar
  NAME_H:         20,   // hauteur de la ligne d'en-tête (nom + badges)
  LINE_H:         22,   // hauteur d'une ligne de contenu
  EMOJI_SIZE:     18,   // taille des emojis dans le contenu
  TAG_H:          18,   // hauteur du badge tag_boom.png
  LOGO_SIZE:      18,   // diamètre du logo BOOM circulaire
  // Remonte la ligne d'en-tête (nom + tag + logo + heure) de 6px pour
  // compacter la "zone titre" au plus près de la barre de référence.
  NAME_ROW_LIFT:  6,
};

async function drawMessageBlock(ctx, author, content, timestamp, yStart, W) {
  ctx.save();

  const { PADDING_L, PADDING_V, AVATAR_D, NAME_H, LINE_H, EMOJI_SIZE,
          TAG_H, LOGO_SIZE, NAME_ROW_LIFT } = PROOF_LAYOUT;
  const CONTENT_X = PADDING_L + AVATAR_D + PADDING_L;
  const MAX_TW    = W - CONTENT_X - PADDING_L;

  // ─── Gros avatar ───
  const avatarR  = AVATAR_D / 2;
  const avatarCX = PADDING_L + avatarR;
  // +2 compense une légère asymétrie de la police pour rester aligné
  // avec la baseline du nom (comme le fait le client Discord).
  const avatarCY = yStart + PADDING_V + NAME_H / 2 + 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const customAvatarUrl = CUSTOM_AVATARS[author];
  if (customAvatarUrl) {
    try {
      const img = await loadImage(customAvatarUrl);
      const imgRatio = img.width / img.height;
      let drawW = AVATAR_D, drawH = AVATAR_D;
      let drawX = avatarCX - avatarR, drawY = avatarCY - avatarR;
      if (imgRatio > 1) { drawW = AVATAR_D * imgRatio; drawX = avatarCX - drawW / 2; }
      else              { drawH = AVATAR_D / imgRatio; drawY = avatarCY - drawH / 2; }
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } catch (e) {
      ctx.fillStyle = CONFIG.AVATAR_COLOR;
      ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
    }
  } else {
    ctx.fillStyle = CONFIG.AVATAR_COLOR;
    ctx.fillRect(avatarCX - avatarR, avatarCY - avatarR, AVATAR_D, AVATAR_D);
  }
  ctx.restore();

  if (!customAvatarUrl) {
    ctx.fillStyle = CONFIG.AVATAR_TEXT_COLOR;
    ctx.font = 'bold 14px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((author || 'W').slice(0, 2).toUpperCase(), avatarCX, avatarCY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ─── Ligne d'en-tête (nom + tag + logo + heure) ───
  const nameY = yStart + PADDING_V + NAME_H - 3 - NAME_ROW_LIFT;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '16px ' + FONT;
  const nameW = ctx.measureText(author || 'Z').width;

  if (author === 'Legacy Trading') {
    ctx.fillStyle = '#e84040';
  } else {
    const nameGrad = ctx.createLinearGradient(CONTENT_X, 0, CONTENT_X + nameW, 0);
    nameGrad.addColorStop(0, '#ff79f2');
    nameGrad.addColorStop(1, '#d649cc');
    ctx.fillStyle = nameGrad;
  }
  ctx.fillText(author || 'Z', CONTENT_X, nameY);

  // Badge tag_boom.png
  const badgeX = CONTENT_X + nameW + 6;
  const badgeY = nameY - TAG_H + 2;
  let BADGE_W = 0;
  try {
    const tagImg = await loadImage(TAG_BOOM_PATH);
    const tagRatio = tagImg.width / tagImg.height;
    BADGE_W = Math.round(TAG_H * tagRatio);
    ctx.drawImage(tagImg, badgeX, badgeY, BADGE_W, TAG_H);
  } catch (e) {
    ctx.font = 'bold 10px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOOM', badgeX, badgeY + TAG_H / 2);
    ctx.textBaseline = 'alphabetic';
    BADGE_W = 50;
  }

  // Logo BOOM circulaire
  const logoX   = badgeX + BADGE_W + 6;
  const logoCY  = badgeY + TAG_H / 2;
  let   logoEndX = logoX;
  try {
    const logoImg = await loadImage(LOGO_PATH);
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, logoCY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, logoX, logoCY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();
    logoEndX = logoX + LOGO_SIZE + 6;
  } catch (e) {}

  // Heure — fuseau NY (marché US).
  const d = timestamp ? new Date(timestamp) : new Date();
  const timeStr = d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/New_York',
  });
  ctx.fillStyle = CONFIG.TIME_COLOR;
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, logoEndX, nameY - 1);

  // Contenu (résolution des mentions + wrapping riche).
  content = resolveUserMentions(content);
  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px ' + FONT;
  const lines = wrapRichText(tmpCtx, content, MAX_TW, EMOJI_SIZE);

  ctx.fillStyle = CONFIG.MESSAGE_COLOR;
  ctx.font = '16px ' + FONT;
  let ty = nameY + LINE_H;
  for (const line of lines) {
    await drawRichLine(ctx, line, CONTENT_X, ty, 16);
    ty += LINE_H;
  }

  ctx.restore();
  return PADDING_V + NAME_H + lines.length * LINE_H + PADDING_V;
}

// ═════════════════════════════════════════════════════════════════════
//  generateProofImage — Barre de référence + bloc message (style reply)
// ═════════════════════════════════════════════════════════════════════
async function generateProofImage(alertAuthor, alertContent, alertTimestamp, recapAuthor, recapContent, recapTimestamp) {
  alertAuthor  = getDisplayName(alertAuthor);
  recapAuthor  = getDisplayName(recapAuthor);
  alertContent = resolveUserMentions(alertContent);
  recapContent = resolveUserMentions(recapContent);

  const { PADDING_L, PADDING_V, AVATAR_D, NAME_H, LINE_H, EMOJI_SIZE } = PROOF_LAYOUT;
  const W              = 740;
  const CONTENT_X      = PADDING_L + AVATAR_D + PADDING_L; // doit matcher drawMessageBlock
  const MAX_TW         = W - CONTENT_X - PADDING_L;
  const REPLY_REF_H    = 28;   // hauteur barre de référence
  const REF_AVT_D      = 16;   // diamètre petit avatar
  const TOP_MARGIN     = 8;    // marge au-dessus de la barre
  // Remonte le bloc principal pour raccourcir la flèche à ~14px.
  const BIG_BLOCK_SHIFT = 10;

  // Pré-wrap pour dimensionner le canvas.
  const tmpC = createCanvas(W, 1000);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px ' + FONT;
  const recapLines = wrapRichText(tmpCtx, recapContent, MAX_TW, EMOJI_SIZE);
  const recapH = PADDING_V + NAME_H + recapLines.length * LINE_H + PADDING_V;
  const H = TOP_MARGIN + REPLY_REF_H + recapH - BIG_BLOCK_SHIFT;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // ─── Barre de référence (message d'origine, en haut) ───
  const refY     = TOP_MARGIN;
  const refMidY  = refY + REPLY_REF_H / 2;
  const refAvtCX = CONTENT_X + REF_AVT_D / 2;
  const refAvtCY = refMidY;

  // Flèche courbée : départ au-dessus du gros avatar, arrivée avant le petit.
  // On laisse 2px de gap visible (offset=3, round cap de 1px).
  const mainAvatarTopY = refY + REPLY_REF_H + PADDING_V + NAME_H / 2 + 2
                         - AVATAR_D / 2 - BIG_BLOCK_SHIFT;
  const arrowX       = PADDING_L + AVATAR_D / 2;
  const arrowCornerR = 6;

  ctx.save();
  ctx.strokeStyle = '#4f545c';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(arrowX, mainAvatarTopY - 3);
  ctx.arcTo(arrowX, refAvtCY, arrowX + 8, refAvtCY, arrowCornerR);
  ctx.lineTo(refAvtCX - REF_AVT_D / 2 - 3, refAvtCY);
  ctx.stroke();
  ctx.restore();

  // Petit avatar (auteur alerte d'origine).
  ctx.save();
  ctx.beginPath();
  ctx.arc(refAvtCX, refAvtCY, REF_AVT_D / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const alertAvtUrl = CUSTOM_AVATARS[alertAuthor];
  if (alertAvtUrl) {
    try {
      const img = await loadImage(alertAvtUrl);
      ctx.drawImage(img, refAvtCX - REF_AVT_D / 2, refAvtCY - REF_AVT_D / 2, REF_AVT_D, REF_AVT_D);
    } catch (e) {
      ctx.fillStyle = '#5865f2';
      ctx.fillRect(refAvtCX - REF_AVT_D / 2, refAvtCY - REF_AVT_D / 2, REF_AVT_D, REF_AVT_D);
    }
  } else {
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(refAvtCX - REF_AVT_D / 2, refAvtCY - REF_AVT_D / 2, REF_AVT_D, REF_AVT_D);
  }
  ctx.restore();

  // Nom de l'auteur de l'alerte.
  const refNameX = CONTENT_X + REF_AVT_D + 4;
  ctx.font = '12px ' + FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const refNameW = ctx.measureText(alertAuthor || '?').width;

  if (alertAuthor === 'Legacy Trading') {
    ctx.fillStyle = '#e84040';
  } else {
    const rg = ctx.createLinearGradient(refNameX, 0, refNameX + refNameW, 0);
    rg.addColorStop(0, '#ff79f2');
    rg.addColorStop(1, '#d649cc');
    ctx.fillStyle = rg;
  }
  ctx.fillText(alertAuthor || '?', refNameX, refMidY);

  // Badge + logo dans la barre de référence.
  let   refBadgeX = refNameX + refNameW + 6;
  const refTagH   = 14;
  let   refTagW   = 0;
  try {
    const tagImg = await loadImage(TAG_BOOM_PATH);
    const tagRatio = tagImg.width / tagImg.height;
    refTagW = Math.round(refTagH * tagRatio);
    ctx.drawImage(tagImg, refBadgeX, refMidY - refTagH / 2, refTagW, refTagH);
  } catch (e) {
    ctx.font = 'bold 9px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOOM', refBadgeX, refMidY);
    ctx.textBaseline = 'alphabetic';
    refTagW = 35;
  }
  refBadgeX += refTagW + 5;

  const refLogoSize = 14;
  try {
    const logoImg = await loadImage(LOGO_PATH);
    ctx.save();
    ctx.beginPath();
    ctx.arc(refBadgeX + refLogoSize / 2, refMidY, refLogoSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, refBadgeX, refMidY - refLogoSize / 2, refLogoSize, refLogoSize);
    ctx.restore();
    refBadgeX += refLogoSize + 6;
  } catch (e) {}

  // Contenu tronqué de l'alerte d'origine — pipeline rich segments
  // (markdown link [label](url), italique *texte*, emoji, mentions).
  // Strip des markers de blockquote `> ` car la barre est elle-même la
  // mise en forme du quote — le marker brut serait redondant.
  const refContentX = refBadgeX;
  ctx.font = '11px ' + FONT;
  ctx.fillStyle = '#ffffff';
  const truncMaxW = W - refContentX - PADDING_L;
  const refRaw = (alertContent || '')
    .replace(/^>\s+/, '')
    .replace(/\n>\s*/g, ' ')
    .replace(/\n/g, ' ');
  await drawRichLineTruncated(ctx, refRaw, refContentX, refMidY, 11, truncMaxW);
  ctx.textBaseline = 'alphabetic';

  // ─── Bloc principal (message complet, en bas) ───
  await drawMessageBlock(
    ctx, recapAuthor, recapContent, recapTimestamp,
    refY + REPLY_REF_H - BIG_BLOCK_SHIFT, W
  );

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateImage,
  drawMessageBlock,
  generateProofImage,
  setDiscordClient,
  parseRichSegments,
  getRoleStyle,
  hexToRgba,
  PROOF_LAYOUT,
};
