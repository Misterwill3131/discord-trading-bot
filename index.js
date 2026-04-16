const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const TRADING_CHANNEL = process.env.TRADING_CHANNEL || 'trading-floor';
const PROFITS_CHANNEL_ID = process.env.PROFITS_CHANNEL_ID || '';
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID || '';
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://discord-trading-bot-production-f159.up.railway.app';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'boom2024';
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

// ─────────────────────────────────────────────────────────────────────
//  DATA_DIR — /data on Railway, __dirname locally
// ─────────────────────────────────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;

// ─────────────────────────────────────────────────────────────────────
//  AUTHOR_ALIASES — canonical display names mapped from Discord usernames
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
//  ALIAS D'AUTEURS — Tag Discord → Nom affiché
// ─────────────────────────────────────────────────────────────────────
const AUTHOR_ALIASES = {
  'sanibel2026':       'AR',
  'therealbora':       'Bora',
  'traderzz1m':        'Z',
  'viking9496':        'Viking',
  'legacytrading506':  'Legacy Trading',
  'rf0496_76497':      'RF',
  'wulftrader':        'L',
  'beppels':           'beppels',
  'gnew123_83101':     'Gaz',
  'capital__gains':    'CapitalGains',
  'gblivin141414':     'Michael',
  'protraderjs':       'ProTrader',
  'disciplined04':     'THE REVERSAL',
  'k.str.l':           'kestrel',
  'the1albatross':     'the1albatross',
  'thedutchess1':      'thedutchess1',
};
function getDisplayName(username) {
  return AUTHOR_ALIASES[username] || username;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadDailyFile(dateKey) {
  try {
    const filePath = path.join(DATA_DIR, 'messages-' + dateKey + '.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('[daily] Failed to load messages-' + dateKey + '.json:', e.message);
  }
  return [];
}

function saveDailyFile(dateKey, messages) {
  try {
    const filePath = path.join(DATA_DIR, 'messages-' + dateKey + '.json');
    fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  } catch (e) {
    console.error('[daily] Failed to save messages-' + dateKey + '.json:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Profit counter — profits-YYYY-MM-DD.json
// ─────────────────────────────────────────────────────────────────────
const PROFIT_MILESTONES = [10, 25, 50, 100, 150, 200];

function loadProfitData(dateKey) {
  try {
    const filePath = path.join(DATA_DIR, 'profits-' + dateKey + '.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('[profits] Failed to load profits-' + dateKey + '.json:', e.message);
  }
  return { count: 0, milestones: [] };
}

function saveProfitData(dateKey, data) {
  try {
    const filePath = path.join(DATA_DIR, 'profits-' + dateKey + '.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[profits] Failed to save profits-' + dateKey + '.json:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  countProfitEntries — compte le nombre de profits dans un message
//  Reconnait: .34-.55, 1.20 to 4.00, .97 -- 3.05, 18.60–19.90
//  Sépare par ligne OU par point+espace (multi-profits sur une ligne)
// ─────────────────────────────────────────────────────────────────────
const PROFIT_PATTERN = /\.?\d+(?:\.\d+)?\s*(?:[-–]+|to)\s*\.?\d+(?:\.\d+)?/gi;

function countProfitEntries(content) {
  if (!content || !content.trim()) return 0;
  const matches = content.match(PROFIT_PATTERN);
  return matches ? matches.length : 0;
}

function hasProfitPattern(content) {
  return PROFIT_PATTERN.test(content);
}

// Last generated promo image
let lastPromoImageBuffer = null;

// ─────────────────────────────────────────────────────────────────────
//  Persistence JSON journalière
// ─────────────────────────────────────────────────────────────────────
function saveTodayMessages(msgs) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'messages-' + todayKey() + '.json'), JSON.stringify(msgs, null, 2), 'utf8');
  } catch(e) { console.error('[daily] save error:', e.message); }
}

function loadInitialMessages() {
  try {
    const today = loadDailyFile(todayKey());
    return today.slice(0, MAX_LOG);
  } catch(e) {}
  return [];
}
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  Filtre adaptatif — chargement / sauvegarde des règles apprises
// ─────────────────────────────────────────────────────────────────────
const FILTERS_PATH = path.join(__dirname, 'custom-filters.json');

function loadCustomFilters() {
  try {
    if (fs.existsSync(FILTERS_PATH)) {
      return JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[filters] Failed to load custom-filters.json:', e.message);
  }
  return { blocked: [], allowed: [], blockedAuthors: [], allowedAuthors: [], falsePositiveCounts: {} };
}

function saveCustomFilters() {
  try {
    fs.writeFileSync(FILTERS_PATH, JSON.stringify(customFilters, null, 2), 'utf8');
  } catch (e) {
    console.error('[filters] Failed to save custom-filters.json:', e.message);
  }
}

let customFilters = loadCustomFilters();
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  SECTION AVATARS — Ajouter ici les avatars personnalisés par Discord username
//  Format : 'NomExact': 'URL_de_l_image'
//  Si un utilisateur n'est pas dans cette liste, ses initiales seront utilisées.
// ─────────────────────────────────────────────────────────────────────
const AV = (f) => path.join(__dirname, 'avatar', f);
const CUSTOM_AVATARS = {
  'Z':              AV('z-avatar.jpg'),
  'AR':             AV('AR_AVATAR.png'),
  'beppels':        AV('beppels_avatar.png'),
  'L':              AV('L_avatar.png'),
  'RF':             AV('RF_AVATAR.png'),
  'Viking':         AV('Viking_avatar.png'),
  'ProTrader':      AV('ProTrader_avatar.png'),
  'Gaz':            AV('Gaz_avatar.png'),
  'CapitalGains':   AV('CapitalGains_avatar.png'),
  'THE REVERSAL':   AV('THE REVERSAL_avatar.png'),
  'kestrel':        AV('kestrel_avatar.png'),
  'the1albatross':  AV('the1albatross_avatar.png'),
  'Bora':           AV('Bora_avatar.png'),
  'Michael':        AV('Michael_avatar.png'),
  'thedutchess1':   AV('thedutchess1_avatar.png'),
  'Legacy Trading': AV('Legacy Trading_avatar.png'),
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

const COMMON_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #fafafa; font-family: 'Inter', system-ui, sans-serif; font-size: 14px; line-height: 1.5; display: flex; min-height: 100vh; }
  a, button, .card, .btn, .btn-primary, .btn-period, .btn-refresh, .btn-add, .nav-sidebar a, input, select, textarea { transition: background-color 200ms cubic-bezier(0.4,0,0.2,1), border-color 200ms cubic-bezier(0.4,0,0.2,1), color 200ms cubic-bezier(0.4,0,0.2,1), transform 200ms cubic-bezier(0.4,0,0.2,1), box-shadow 200ms cubic-bezier(0.4,0,0.2,1), background-position 400ms ease; }

  /* Sidebar */
  .nav-sidebar { width: 220px; min-width: 220px; background: #0f0f14; border-right: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0; overflow-y: auto; z-index: 20; flex-shrink: 0; }
  .nav-sidebar-logo { padding: 22px 18px 16px; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 10px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }
  .nav-sidebar a { display: flex; align-items: center; gap: 10px; padding: 10px 18px; font-size: 13px; font-weight: 500; color: #a0a0b0; text-decoration: none; border-left: 3px solid transparent; }
  .nav-sidebar a:hover { background: rgba(255,255,255,0.04); color: #fafafa; }
  .nav-sidebar a.active { background: rgba(139,92,246,0.1); color: #fafafa; border-left: 3px solid transparent; border-image: linear-gradient(180deg, #3b82f6, #8b5cf6) 1; font-weight: 600; }
  .nav-sidebar-icon { font-size: 15px; min-width: 20px; text-align: center; }

  /* Page layout */
  .page-content { flex: 1; min-width: 0; overflow-y: auto; }
  .page-header { display: flex; align-items: center; gap: 14px; padding: 20px 32px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(10,10,15,0.8); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10; }
  .page-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #fafafa; flex-shrink: 0; }

  /* Cards (glass) */
  .card { background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1); animation: fadeInUp 400ms cubic-bezier(0.4,0,0.2,1) both; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(139,92,246,0.3); }
  .card:nth-child(2) { animation-delay: 50ms; }
  .card:nth-child(3) { animation-delay: 100ms; }
  .card:nth-child(4) { animation-delay: 150ms; }
  .card:nth-child(5) { animation-delay: 200ms; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 16px; }
  .big-number { font-size: 52px; font-weight: 800; color: #fafafa; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .big-sub { font-size: 13px; color: #a0a0b0; margin-top: 6px; }

  /* Buttons */
  .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-primary:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-refresh { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; border: none; color: #fff; border-radius: 8px; padding: 8px 18px; cursor: pointer; font-size: 13px; font-weight: 600; margin-left: auto; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-refresh:hover { background-position: 100% 50%; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .btn-add { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); background-size: 200% 200%; background-position: 0% 50%; border: none; color: #fff; border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .btn-add:hover { background-position: 100% 50%; transform: translateY(-1px); }
  .btn-period { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); color: #a0a0b0; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-period:hover { background: rgba(255,255,255,0.06); color: #fafafa; }
  .btn-period.active { background: rgba(139,92,246,0.15); border-color: rgba(139,92,246,0.4); color: #c4b5fd; }

  /* Inputs */
  input[type=text], input[type=number], input[type=password], input[type=time], textarea, select { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; border-radius: 8px; padding: 9px 12px; font-family: inherit; font-size: 14px; outline: none; }
  input[type=text]:focus, input[type=number]:focus, input[type=password]:focus, input[type=time]:focus, textarea:focus, select:focus { border-color: rgba(139,92,246,0.5); background: rgba(255,255,255,0.06); }

  /* Animations */
  @keyframes fadeInUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
  .shimmer { background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent); background-size: 200% 100%; animation: shimmer 1.5s infinite; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
`;

function sidebarHTML(active) {
  const links = [
    { href: '/dashboard',       icon: '📡', label: 'Dashboard' },
    { href: '/stats',           icon: '📊', label: 'Stats' },
    { href: '/profits',         icon: '💰', label: 'Profits' },
    { href: '/news',            icon: '📰', label: 'News' },
    { href: '/leaderboard',     icon: '🏆', label: 'Leaderboard' },
    { href: '/image-generator', icon: '🖼️', label: 'Image Generator' },
    { href: '/proof-generator', icon: '🔍', label: 'Proof Generator' },
    { href: '/raw-messages',    icon: '📋', label: 'Raw Messages' },
    { href: '/config',          icon: '⚙️', label: 'Config' },
  ];
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${links.map(l => `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}><span class="nav-sidebar-icon">${l.icon}</span>${l.label}</a>`).join('\n  ')}
</nav>`;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Signal Monitor</title>
<style>
  ${COMMON_CSS}
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on  { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
  #wrap { padding: 16px 24px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background .15s; }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
  td { padding: 9px 10px; vertical-align: middle; line-height: 1.45; }
  .ts   { color: #80848e; font-size: 12px; white-space: nowrap; }
  .auth { font-weight: 600; color: #D649CC; white-space: nowrap; }
  .chan { color: #80848e; white-space: nowrap; }
  .prev { max-width: 380px; word-break: break-word; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit    { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter  { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .b-convo   { background: #2e2e2e; color: #80848e; border: 1px solid #80848e44; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dg { background: #3ba55d; } .dr { background: #ed4245; } .do { background: #faa61a; } .dz { background: #80848e; }
  #empty { padding: 60px 24px; text-align: center; color: #80848e; }
  @keyframes flash { from { background: #2a3040; } to { background: transparent; } }
  tr.new { animation: flash .8s ease-out; }
  tr.learned { opacity: 0.45; }
  tr.unblocked { opacity: 0.45; }
  .btn-fp { background:none; border:1px solid #ed424588; color:#ed4245; border-radius:4px; font-size:11px; padding:1px 6px; cursor:pointer; margin-left:6px; line-height:1.6; }
  .btn-fp:hover { background:#ed424522; }
  .btn-fn { background:none; border:1px solid #3ba55d88; color:#3ba55d; border-radius:4px; font-size:11px; padding:1px 6px; cursor:pointer; margin-left:6px; line-height:1.6; }
  .btn-fn:hover { background:#3ba55d22; }
  #filters-panel { margin-top:24px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; }
  #filters-toggle { width:100%; background:transparent; border:none; color:#fafafa; padding:14px 20px; text-align:left; cursor:pointer; font-size:13px; font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  #filters-toggle:hover { background:rgba(255,255,255,0.03); }
  #filters-body { display:none; padding:16px 20px; background:rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
  #filters-body.open { display:block; }
  .filter-section { margin-bottom:12px; }
  .filter-section h3 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#80848e; margin-bottom:8px; }
  .filter-tag { display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:3px 8px; font-size:12px; margin:3px; max-width:420px; word-break:break-all; }
  .filter-tag button { background:none; border:none; color:#80848e; cursor:pointer; font-size:14px; line-height:1; padding:0; }
  .filter-tag button:hover { color:#ed4245; }
  .reply-badge { display:inline-block; font-size:10px; background:#2b2d31; border:1px solid #3f4147; color:#80848e; border-radius:3px; padding:1px 5px; margin-right:5px; vertical-align:middle; white-space:nowrap; }
  .reply-badge span { color:#D649CC; font-weight:600; }
  .reply-parent { display:block; font-size:11px; color:#80848e; margin-top:2px; font-style:italic; border-left:2px solid #3f4147; padding-left:6px; }
  #authors-panel { margin:0 24px 16px; background: rgba(255,255,255,0.03); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; }
  #authors-toggle { width:100%; background:transparent; border:none; color:#fafafa; padding:14px 20px; text-align:left; cursor:pointer; font-size:13px; font-weight: 600; display:flex; justify-content:space-between; align-items:center; }
  #authors-toggle:hover { background:rgba(255,255,255,0.03); }
  #authors-body { display:none; padding:16px 20px; background:rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.06); }
  #authors-body.open { display:block; }
  .author-row { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-radius:6px; margin-bottom:4px; background:rgba(255,255,255,0.03); }
  .author-row:hover { background:rgba(255,255,255,0.06); }
  .author-name { font-weight:600; color:#D649CC; font-size:13px; flex:1; }
  .author-status { font-size:11px; color:#80848e; margin:0 10px; white-space:nowrap; }
  .author-status.blocked  { color:#ed4245; }
  .author-status.allowed  { color:#3ba55d; }
  .author-actions { display:flex; gap:5px; }
  .btn-allow-author { background:none; border:1px solid #3ba55d88; color:#3ba55d; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-allow-author:hover { background:#3ba55d22; }
  .btn-block-author { background:none; border:1px solid #ed424588; color:#ed4245; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-block-author:hover { background:#ed424522; }
  .btn-reset-author { background:none; border:1px solid #80848e55; color:#80848e; border-radius:4px; font-size:11px; padding:2px 8px; cursor:pointer; }
  .btn-reset-author:hover { background:#80848e22; }
</style>
</head>
<body>
${sidebarHTML('/dashboard')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Dashboard</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</div>
<div id="wrap">
  <table>
    <thead><tr><th>Time</th><th>Author</th><th>Channel</th><th>Preview</th><th>Result</th></tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div id="empty">No messages yet — waiting for activity on #trading-floor…</div>
</div>

<div id="authors-panel">
  <button id="authors-toggle">
    <span>Gestion des auteurs</span>
    <span id="authors-arrow">▶</span>
  </button>
  <div id="authors-body">
    <div id="authors-list"><span style="color:#80848e;font-size:12px;font-style:italic">Aucun auteur vu pour l&#39;instant</span></div>
  </div>
</div>

<div id="filters-panel" style="margin:0 24px 24px">
  <button id="filters-toggle">
    <span>Règles apprises : <span id="rule-count">0</span></span>
    <span id="filters-arrow">▶</span>
  </button>
  <div id="filters-body">
    <div class="filter-section">
      <h3>Phrases bloquées (faux-positifs corrigés) ❌</h3>
      <div id="blocked-tags"><span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l&#39;instant</span></div>
    </div>
    <div class="filter-section">
      <h3>Phrases autorisées (faux-négatifs corrigés) ✅</h3>
      <div id="allowed-tags"><span style="color:#80848e;font-size:12px;font-style:italic">Aucune règle pour l&#39;instant</span></div>
    </div>
  </div>
</div>
<script>
(function(){
  var tb=document.getElementById('tb'),cnt=document.getElementById('cnt'),
      dot=document.getElementById('dot'),lbl=document.getElementById('lbl'),
      empty=document.getElementById('empty'),total=0;

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmt(iso){ var d=new Date(iso); return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

  function badge(e){
    var btn='';
    if(e.passed){
      var cls=e.type==='entry'?'b-entry':e.type==='exit'?'b-exit':'b-neutral';
      var dc =e.type==='entry'?'dg':e.type==='exit'?'dr':'dg';
      btn='<button class="btn-fp" data-id="'+esc(e.id)+'" data-content="'+esc(e.content||e.preview)+'" title="Faux-positif: bloquer ce message">❌</button>';
      return '<span class="badge '+cls+'"><span class="dot '+dc+'"></span>'+e.type.toUpperCase()+'</span>'+btn;
    }
    var bc=(e.reason==='Conversational'||e.reason==='No content')?'b-convo':'b-filter';
    var dd=(e.reason==='Conversational'||e.reason==='No content')?'dz':'do';
    btn='<button class="btn-fn" data-id="'+esc(e.id)+'" data-content="'+esc(e.content||e.preview)+'" title="Faux-negatif: autoriser ce message">✅</button>';
    return '<span class="badge '+bc+'"><span class="dot '+dd+'"></span>FILTERED — '+esc(e.reason)+'</span>'+btn;
  }

  function makeRow(e,isNew){
    var tr=document.createElement('tr');
    if(isNew) tr.className='new';
    var previewHtml='';
    if(e.isReply){
      var who=e.parentAuthor?'<span>'+esc(e.parentAuthor)+'</span>':'';
      previewHtml+='<span class="reply-badge">↩ réponse à '+who+'</span>';
    }
    previewHtml+=esc(e.preview);
    if(e.isReply && e.parentPreview){
      previewHtml+='<span class="reply-parent">'+esc(e.parentPreview)+'</span>';
    }
    tr.innerHTML='<td class="ts">'+fmt(e.ts)+'</td><td class="auth">'+esc(e.author)+'</td>'
      +'<td class="chan">#'+esc(e.channel)+'</td><td class="prev">'+previewHtml+'</td>'
      +'<td>'+badge(e)+'</td>';
    return tr;
  }

  function upd(){ cnt.textContent=total+' message'+(total===1?'':'s'); }

  // Délégation d'événements sur le tableau pour les boutons feedback
  tb.addEventListener('click', function(ev){
    var btn=ev.target.closest('.btn-fp,.btn-fn');
    if(!btn) return;
    var id=btn.getAttribute('data-id');
    var content=btn.getAttribute('data-content');
    var action=btn.classList.contains('btn-fp')?'block':'allow';
    btn.disabled=true; btn.textContent='…';
    fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,content:content,action:action})})
      .then(function(r){return r.json();})
      .then(function(data){
        if(data.ok){
          var tr=btn.closest('tr');
          var badgeEl=tr.querySelector('.badge');
          if(action==='block'){
            tr.classList.add('learned');
            if(badgeEl) badgeEl.outerHTML='<span class="badge b-filter"><span class="dot do"></span>APPRIS: Bloqué</span>';
          } else {
            tr.classList.add('unblocked');
            if(badgeEl) badgeEl.outerHTML='<span class="badge b-entry"><span class="dot dg"></span>DÉBLOQUÉ</span>';
          }
          btn.remove();
          renderFilters(data.customFilters);
        } else { btn.disabled=false; btn.textContent=action==='block'?'❌':'✅'; }
      })
      .catch(function(){ btn.disabled=false; btn.textContent=action==='block'?'❌':'✅'; });
  });

  // Panneau des règles apprises
  function renderFilters(cf){
    var blocked=cf.blocked||[], allowed=cf.allowed||[];
    document.getElementById('rule-count').textContent=blocked.length+allowed.length;
    var bt=document.getElementById('blocked-tags');
    var at=document.getElementById('allowed-tags');
    bt.innerHTML=blocked.length?'':'<span style="color:#80848e;font-size:12px;font-style:italic">Aucune regle</span>';
    at.innerHTML=allowed.length?'':'<span style="color:#80848e;font-size:12px;font-style:italic">Aucune regle</span>';
    blocked.forEach(function(phrase){
      var tag=document.createElement('span'); tag.className='filter-tag';
      tag.innerHTML=esc(phrase)+'<button data-phrase="'+esc(phrase)+'" data-list="blocked" title="Supprimer">✕</button>';
      bt.appendChild(tag);
    });
    allowed.forEach(function(phrase){
      var tag=document.createElement('span'); tag.className='filter-tag';
      tag.innerHTML=esc(phrase)+'<button data-phrase="'+esc(phrase)+'" data-list="allowed" title="Supprimer">✕</button>';
      at.appendChild(tag);
    });
  }

  // Suppression d'une règle apprise
  document.getElementById('filters-body').addEventListener('click', function(ev){
    var btn=ev.target.closest('button[data-phrase]');
    if(!btn) return;
    var phrase=btn.getAttribute('data-phrase');
    var list=btn.getAttribute('data-list');
    fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:phrase,action:'unblock-'+list})})
      .then(function(r){return r.json();}).then(function(data){ if(data.ok) renderFilters(data.customFilters); });
  });

  // Accordéon du panneau
  document.getElementById('filters-toggle').addEventListener('click', function(){
    var body=document.getElementById('filters-body');
    var arrow=document.getElementById('filters-arrow');
    body.classList.toggle('open');
    arrow.textContent=body.classList.contains('open')?'▼':'▶';
  });

  fetch('/api/messages').then(function(r){return r.json();}).then(function(ms){
    ms.forEach(function(e){ tb.appendChild(makeRow(e,false)); total++; });
    upd(); if(total>0) empty.style.display='none';
  }).catch(function(){});

  fetch('/api/custom-filters').then(function(r){return r.json();}).then(function(cf){
    renderFilters(cf);
    renderAuthors(cf);
  }).catch(function(){});

  // ── Gestion des auteurs ───────────────────────────────────────────────────
  function getAuthorsFromLog(){
    var seen={};
    var rows=tb.querySelectorAll('tr');
    rows.forEach(function(tr){
      var a=tr.querySelector('.auth');
      if(a) seen[a.textContent.trim()]=true;
    });
    return Object.keys(seen);
  }

  function renderAuthors(cf){
    var blocked=cf.blockedAuthors||[], allowed=cf.allowedAuthors||[];
    var authors=getAuthorsFromLog();
    // Ajouter les auteurs déjà dans les listes même s'ils ne sont pas dans le log visible
    blocked.forEach(function(a){ if(!authors.includes(a)) authors.push(a); });
    allowed.forEach(function(a){ if(!authors.includes(a)) authors.push(a); });
    var list=document.getElementById('authors-list');
    if(!authors.length){ list.innerHTML='<span style="color:#80848e;font-size:12px;font-style:italic">Aucun auteur vu</span>'; return; }
    list.innerHTML='';
    authors.sort().forEach(function(name){
      var isBlocked=blocked.includes(name), isAllowed=allowed.includes(name);
      var statusCls=isBlocked?'blocked':isAllowed?'allowed':'';
      var statusTxt=isBlocked?'⛔ Bloqué':isAllowed?'✅ Autorisé':'— Neutre';
      var row=document.createElement('div'); row.className='author-row';
      row.innerHTML='<span class="author-name">'+esc(name)+'</span>'
        +'<span class="author-status '+statusCls+'">'+statusTxt+'</span>'
        +'<span class="author-actions">'
        +(isAllowed?'':'<button class="btn-allow-author" data-user="'+esc(name)+'">✅ Autoriser</button>')
        +(isBlocked?'':'<button class="btn-block-author" data-user="'+esc(name)+'">⛔ Bloquer</button>')
        +((isBlocked||isAllowed)?'<button class="btn-reset-author" data-user="'+esc(name)+'" data-list="'+(isBlocked?'blocked':'allowed')+'">✕ Réinitialiser</button>':'')
        +'</span>';
      list.appendChild(row);
    });
  }

  document.getElementById('authors-body').addEventListener('click', function(ev){
    var btn=ev.target.closest('button[data-user]');
    if(!btn) return;
    var username=btn.getAttribute('data-user');
    var action;
    if(btn.classList.contains('btn-allow-author'))  action='allow';
    else if(btn.classList.contains('btn-block-author')) action='block';
    else { var list=btn.getAttribute('data-list'); action='remove-'+list; }
    fetch('/api/author-filter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username,action:action})})
      .then(function(r){return r.json();}).then(function(data){ if(data.ok) renderAuthors(data.customFilters); });
  });

  document.getElementById('authors-toggle').addEventListener('click', function(){
    var body=document.getElementById('authors-body');
    var arrow=document.getElementById('authors-arrow');
    body.classList.toggle('open');
    arrow.textContent=body.classList.contains('open')?'▼':'▶';
  });

  (function connect(){
    var es=new EventSource('/api/events');
    es.onopen=function(){ dot.className='on'; lbl.textContent='Live'; };
    es.onmessage=function(ev){
      var e; try{ e=JSON.parse(ev.data); }catch(_){ return; }
      tb.insertBefore(makeRow(e,true),tb.firstChild);
      total++; upd(); empty.style.display='none';
      // Rafraîchir la liste des auteurs si nouveau auteur
      fetch('/api/custom-filters').then(function(r){return r.json();}).then(renderAuthors).catch(function(){});
    };
    es.onerror=function(){ dot.className='off'; lbl.textContent='Reconnecting…'; };
  })();
})();
</script>
</div>
</body>
</html>`;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(cookieHeader) {
  var result = {};
  if (!cookieHeader) return result;
  cookieHeader.split(';').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    var key = pair.slice(0, idx).trim();
    var val = pair.slice(idx + 1).trim();
    result[key] = decodeURIComponent(val);
  });
  return result;
}

function requireAuth(req, res, next) {
  var cookies = parseCookies(req.headers.cookie);
  if (cookies['boom_session'] === SESSION_TOKEN) return next();
  res.redirect('/login');
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1f22; color: #dcddde; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 36px 40px; width: 340px; }
  h1 { font-size: 22px; font-weight: 700; color: #fff; text-align: center; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #80848e; text-align: center; margin-bottom: 28px; }
  label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #b5bac1; margin-bottom: 6px; }
  input[type=password] { width: 100%; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 10px 12px; font-size: 14px; outline: none; margin-bottom: 20px; }
  input[type=password]:focus { border-color: #5865f2; }
  button { width: 100%; background: #5865f2; border: none; border-radius: 4px; color: #fff; font-size: 15px; font-weight: 600; padding: 11px; cursor: pointer; }
  button:hover { background: #4752c4; }
  .err { background: #3a1e1e; border: 1px solid #ed424544; color: #ed4245; border-radius: 4px; padding: 8px 12px; font-size: 13px; margin-bottom: 16px; display: none; }
  .err.show { display: block; }
</style>
</head>
<body>
<div class="card">
  <h1>&#x1F525; BOOM</h1>
  <p class="sub">Signal Monitor Dashboard</p>
  <form method="POST" action="/login">
    <div id="err" class="err">Mot de passe incorrect</div>
    <label for="pw">Mot de passe</label>
    <input type="password" id="pw" name="password" autofocus placeholder="••••••••">
    <button type="submit">Se connecter</button>
  </form>
</div>
</body>
</html>`;

app.get('/login', (req, res) => {
  var cookies = parseCookies(req.headers.cookie);
  if (cookies['boom_session'] === SESSION_TOKEN) return res.redirect('/dashboard');
  res.set('Content-Type', 'text/html');
  res.send(LOGIN_HTML);
});

app.post('/login', (req, res) => {
  var pw = (req.body && req.body.password) || '';
  if (pw === DASHBOARD_PASSWORD) {
    res.setHeader('Set-Cookie', 'boom_session=' + SESSION_TOKEN + '; Path=/; HttpOnly');
    return res.redirect('/dashboard');
  }
  res.set('Content-Type', 'text/html');
  var html = LOGIN_HTML.replace('id="err" class="err"', 'id="err" class="err show"');
  res.send(html);
});

let lastImageBuffer = null;
let lastImageId = null;

const MAX_LOG = 200;
const messageLog = loadInitialMessages();
const sseClients = [];

function logEvent(author, channel, content, signalType, reason, extra) {
  const entry = {
    id:      Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ts:      new Date().toISOString(),
    author,
    channel,
    content: content || '',
    preview: content && content.length > 120 ? content.slice(0, 120) + '…' : (content || ''),
    passed:  signalType !== null,
    type:    signalType,
    reason,
    confidence:  extra?.confidence  != null ? extra.confidence  : null,
    ticker:      extra?.ticker      != null ? extra.ticker      : null,
    entry_price: extra?.entry_price != null ? extra.entry_price : null,
    isReply:       extra?.isReply || false,
    parentPreview: extra?.parentPreview || null,
    parentAuthor:  extra?.parentAuthor || null,
  };
  messageLog.unshift(entry);
  if (messageLog.length > MAX_LOG) messageLog.pop();
  saveTodayMessages(messageLog);
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].res.write(payload); } catch (_) { sseClients.splice(i, 1); }
  }
}


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
          content:     enrichContent(testContent),
          author:      testAuthor,
          channel:     'trading-floor',
          signal_type: testSignal,
          timestamp:   new Date().toISOString(),
          image_url:   imageUrl,
                        ticker: extractTicker(testContent),
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

app.get('/api/messages', requireAuth, (req, res) => {
  var msgs = messageLog;
  if (req.query.from) {
    var from = new Date(req.query.from).getTime();
    if (!isNaN(from)) msgs = msgs.filter(function(m) { return new Date(m.ts).getTime() >= from; });
  }
  if (req.query.to) {
    var to = new Date(req.query.to).getTime();
    if (!isNaN(to)) msgs = msgs.filter(function(m) { return new Date(m.ts).getTime() <= to; });
  }
  res.json(msgs);
});

app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const client = { res };
  sseClients.push(client);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    const i = sseClients.indexOf(client);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

app.get('/api/custom-filters', requireAuth, (req, res) => {
  res.json(customFilters);
});

const FP_STOPWORDS = new Set(['the','and','for','that','this','with','from','have','will','your','are','was','not','but','can','its','our','you','they','all','been','one','had','her','his','him','she','him','let','get','got','has','how','did','who','why','when','what','than','into','over','just','like','more','also','some','then','them','their','there','would','could','should']);

app.post('/api/feedback', requireAuth, (req, res) => {
  const { id, content, action } = req.body || {};
  const validActions = ['block', 'allow', 'unblock-blocked', 'unblock-allowed', 'false-positive'];
  if (!content || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }
  const phrase = content.trim();
  const autoBlocked = [];

  if (action === 'block' || action === 'false-positive') {
    if (!customFilters.blocked.includes(phrase)) customFilters.blocked.push(phrase);
    // Auto-blacklist: count significant keywords from this false-positive
    if (!customFilters.falsePositiveCounts) customFilters.falsePositiveCounts = {};
    const words = phrase.toLowerCase().split(/\W+/).filter(function(w) {
      return w.length > 3 && !FP_STOPWORDS.has(w);
    });
    words.forEach(function(word) {
      customFilters.falsePositiveCounts[word] = (customFilters.falsePositiveCounts[word] || 0) + 1;
      if (customFilters.falsePositiveCounts[word] >= 3 && !customFilters.blocked.includes(word)) {
        customFilters.blocked.push(word);
        autoBlocked.push(word);
        console.log('[feedback] Auto-blocked keyword after 3 false positives: ' + word);
      }
    });
  } else if (action === 'allow') {
    if (!customFilters.allowed.includes(phrase)) customFilters.allowed.push(phrase);
  } else if (action === 'unblock-blocked') {
    customFilters.blocked = customFilters.blocked.filter(p => p !== phrase);
  } else if (action === 'unblock-allowed') {
    customFilters.allowed = customFilters.allowed.filter(p => p !== phrase);
  }
  saveCustomFilters();
  console.log('[feedback] action=' + action + ' phrase=' + phrase.substring(0, 60));
  res.json({ ok: true, customFilters, autoBlocked });
});

app.post('/api/author-filter', requireAuth, (req, res) => {
  const { username, action } = req.body || {};
  const validActions = ['block', 'allow', 'remove-blocked', 'remove-allowed'];
  if (!username || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }
  if (!customFilters.blockedAuthors)  customFilters.blockedAuthors  = [];
  if (!customFilters.allowedAuthors) customFilters.allowedAuthors = [];
  const u = username.trim();
  if (action === 'block') {
    customFilters.allowedAuthors  = customFilters.allowedAuthors.filter(a => a !== u);
    if (!customFilters.blockedAuthors.includes(u)) customFilters.blockedAuthors.push(u);
  } else if (action === 'allow') {
    customFilters.blockedAuthors = customFilters.blockedAuthors.filter(a => a !== u);
    if (!customFilters.allowedAuthors.includes(u)) customFilters.allowedAuthors.push(u);
  } else if (action === 'remove-blocked') {
    customFilters.blockedAuthors = customFilters.blockedAuthors.filter(a => a !== u);
  } else if (action === 'remove-allowed') {
    customFilters.allowedAuthors = customFilters.allowedAuthors.filter(a => a !== u);
  }
  saveCustomFilters();
  console.log('[author-filter] action=' + action + ' user=' + u);
  res.json({ ok: true, customFilters });
});

app.get('/api/export-csv', requireAuth, (req, res) => {
  function csvField(val) {
    var s = String(val == null ? '' : val);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  var msgs = messageLog;
  if (req.query.from) {
    var from = new Date(req.query.from).getTime();
    if (!isNaN(from)) msgs = msgs.filter(function(m) { return new Date(m.ts).getTime() >= from; });
  }
  if (req.query.to) {
    var to = new Date(req.query.to).getTime();
    if (!isNaN(to)) msgs = msgs.filter(function(m) { return new Date(m.ts).getTime() <= to; });
  }
  var dateStr = new Date().toISOString().slice(0, 10);
  var rows = ['timestamp,author,channel,ticker,type,reason,confidence,preview'];
  msgs.forEach(function(m) {
    rows.push([
      csvField(m.ts),
      csvField(m.author),
      csvField(m.channel),
      csvField(m.ticker || ''),
      csvField(m.type || 'filtered'),
      csvField(m.reason),
      csvField(m.confidence != null ? m.confidence : ''),
      csvField(m.preview)
    ].join(','));
  });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="boom-signals-' + dateStr + '.csv"');
  res.send(rows.join('\n'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(DASHBOARD_HTML);
});

// ─────────────────────────────────────────────────────────────────────
//  Interface Generateur d'Images
// ─────────────────────────────────────────────────────────────────────
const IMAGE_GEN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Image Generator</title>
<style>
  ${COMMON_CSS}
  .page-content { overflow: hidden; }
  .main { display: grid; grid-template-columns: 360px 1fr; gap: 0; height: 100vh; }
  .sidebar { background: #2b2d31; border-right: 1px solid #3f4147; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
  .content { padding: 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 10px; }
  label { display: block; font-size: 13px; color: #b5bac1; margin-bottom: 6px; }
  input[type=text], textarea, input[type=time] {
    width: 100%; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px;
    color: #dcddde; padding: 8px 10px; font-size: 14px; font-family: inherit;
    outline: none; transition: border-color .15s;
  }
  input[type=text]:focus, textarea:focus, input[type=time]:focus { border-color: #5865f2; }
  textarea { resize: vertical; min-height: 90px; }
  .field { margin-bottom: 14px; }
  .row { display: flex; gap: 10px; }
  .row .field { flex: 1; }
  .hint { font-size: 11px; color: #80848e; margin-top: 4px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; font-weight: 600; transition: filter .15s; }
  .btn:hover { filter: brightness(1.1); }
  .btn:active { filter: brightness(0.9); }
  .btn-primary { background: #5865f2; color: #fff; width: 100%; justify-content: center; }
  .btn-success { background: #3ba55d; color: #fff; }
  .btn-secondary { background: #4f5660; color: #fff; }
  .preview-box { background: #111214; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 140px; justify-content: center; }
  .preview-box img { max-width: 100%; border-radius: 6px; display: block; box-shadow: 0 4px 24px rgba(0,0,0,0.6); image-rendering: crisp-edges; }
  .preview-placeholder { color: #80848e; font-size: 13px; width: 100%; text-align: center; padding: 30px 0; }
  #preview-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .history-grid { display: flex; flex-direction: column; gap: 10px; }
  .history-item { background: #111214; border: 1px solid #3f4147; border-radius: 6px; overflow: hidden; }
  .history-item img { width: 100%; display: block; }
  .history-meta { padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; }
  .history-meta span { font-size: 11px; color: #80848e; }
  .history-meta button { background: none; border: 1px solid #3f4147; color: #80848e; border-radius: 3px; font-size: 11px; padding: 2px 8px; cursor: pointer; }
  .history-meta button:hover { background: #2b2d31; color: #dcddde; }
  .avatar-list { display: flex; flex-direction: column; gap: 8px; }
  .avatar-item { display: flex; align-items: center; gap: 10px; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 8px 10px; }
  .avatar-circle { width: 32px; height: 32px; border-radius: 50%; background: #5865f2; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; overflow: hidden; }
  .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-name { flex: 1; font-size: 13px; font-weight: 600; color: #D649CC; }
  .avatar-url { font-size: 11px; color: #80848e; word-break: break-all; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #ffffff44; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-bar { padding: 8px 12px; border-radius: 4px; font-size: 13px; display: none; }
  .status-bar.ok { background: #1e3a2f; border: 1px solid #3ba55d44; color: #3ba55d; display: block; }
  .status-bar.err { background: #3a1e1e; border: 1px solid #ed424544; color: #ed4245; display: block; }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #3f4147; border-radius: 3px; }
</style>
</head>
<body>
${sidebarHTML('/image-generator')}
<div class="page-content">
<div class="main">
  <!-- Panneau gauche : formulaire -->
  <div class="sidebar">
    <div>
      <div class="section-title">Parametres de l'image</div>

      <div class="field">
        <label for="inp-author">Auteur</label>
        <input type="text" id="inp-author" placeholder="ex: Z" value="Z" autocomplete="off">
        <div class="hint">Doit correspondre exactement au username Discord pour l'avatar</div>
      </div>

      <div class="field">
        <label for="inp-msg">Message</label>
        <textarea id="inp-msg" placeholder="ex: $TSLA 150.00-155.00 entry long&#10;target 160 stop 148">$TSLA 150.00-155.00 entry long</textarea>
      </div>

      <div class="row">
        <div class="field">
          <label for="inp-time">Heure</label>
          <input type="time" id="inp-time" value="">
        </div>
        <div class="field">
          <label>&nbsp;</label>
          <button class="btn btn-secondary" id="btn-now" style="width:100%;justify-content:center;">Maintenant</button>
        </div>
      </div>

      <div id="status-msg" class="status-bar"></div>

      <button class="btn btn-primary" id="btn-generate" style="margin-top:8px;">
        <span id="gen-icon">⚡</span> Generer l'image
      </button>
    </div>

    <!-- Avatars connus -->
    <div>
      <div class="section-title">Avatars personnalises</div>
      <div class="avatar-list" id="avatar-list">
        <div style="color:#80848e;font-size:12px;">Chargement...</div>
      </div>
    </div>
  </div>

  <!-- Panneau droit : apercu + historique -->
  <div class="content">
    <div>
      <div class="section-title">Apercu</div>
      <div class="preview-box" id="preview-box">
        <div class="preview-placeholder" id="preview-placeholder">Cliquez sur "Generer l'image" pour voir un apercu</div>
        <img id="preview-img" style="display:none;" alt="apercu">
      </div>
      <div id="preview-actions" style="margin-top:12px; display:none;">
        <button class="btn btn-success" id="btn-download">⬇ Telecharger PNG</button>
        <button class="btn btn-secondary" id="btn-copy-url">🔗 Copier URL</button>
      </div>
    </div>

    <div>
      <div class="section-title">Historique de session <span id="hist-count" style="font-weight:400;"></span></div>
      <div class="history-grid" id="history-grid">
        <div style="color:#80848e;font-size:12px;">Aucune image generee dans cette session.</div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  var timeNow = function() {
    var d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  };
  document.getElementById('inp-time').value = timeNow();
  document.getElementById('btn-now').addEventListener('click', function() {
    document.getElementById('inp-time').value = timeNow();
  });

  var history = [];
  var lastUrl = null;

  function showStatus(msg, type) {
    var el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = 'status-bar ' + type;
    if (type === 'ok') { setTimeout(function() { el.className = 'status-bar'; }, 6000); }
  }

  function buildPreviewUrl(author, message, timeVal) {
    var ts = '';
    if (timeVal) {
      var parts = timeVal.split(':');
      var d = new Date();
      d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
      ts = d.toISOString();
    }
    return '/preview?author=' + encodeURIComponent(author) + '&message=' + encodeURIComponent(message) + (ts ? '&ts=' + encodeURIComponent(ts) : '');
  }

  document.getElementById('btn-generate').addEventListener('click', function() {
    var author = document.getElementById('inp-author').value.trim() || 'Z';
    var msg = document.getElementById('inp-msg').value.trim();
    var timeVal = document.getElementById('inp-time').value;
    if (!msg) { showStatus('Le message ne peut pas etre vide.', 'err'); return; }

    var btn = document.getElementById('btn-generate');
    var icon = document.getElementById('gen-icon');
    btn.disabled = true;
    icon.innerHTML = '<span class="spinner"></span>';

    var url = buildPreviewUrl(author, msg, timeVal);
    var img = document.getElementById('preview-img');
    var placeholder = document.getElementById('preview-placeholder');
    var actions = document.getElementById('preview-actions');

    var tempImg = new Image();
    tempImg.onload = function() {
      img.src = url + '&nocache=' + Date.now();
      img.style.display = 'block';
      placeholder.style.display = 'none';
      actions.style.display = 'flex';
      lastUrl = url;
      btn.disabled = false;
      icon.textContent = '\u26a1';
      showStatus('Image generee avec succes !', 'ok');
      addHistory(author, msg, timeVal, url);
    };
    tempImg.onerror = function() {
      btn.disabled = false;
      icon.textContent = '\u26a1';
      showStatus('Erreur lors de la generation de l image.', 'err');
    };
    tempImg.src = url + '&nocache=' + Date.now();
  });

  document.getElementById('btn-download').addEventListener('click', function() {
    if (!lastUrl) return;
    fetch(lastUrl + '&nocache=' + Date.now())
      .then(function(r) { return r.blob(); })
      .then(function(blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        var author = document.getElementById('inp-author').value.trim() || 'signal';
        a.download = 'boom-signal-' + author + '-' + Date.now() + '.png';
        a.click();
      })
      .catch(function() { showStatus('Erreur lors du telechargement.', 'err'); });
  });

  document.getElementById('btn-copy-url').addEventListener('click', function() {
    if (!lastUrl) return;
    var fullUrl = window.location.origin + lastUrl;
    navigator.clipboard.writeText(fullUrl).then(function() {
      showStatus('URL copiee dans le presse-papier !', 'ok');
    });
  });

  function addHistory(author, msg, timeVal, url) {
    var entry = { author: author, msg: msg, timeVal: timeVal, url: url, ts: new Date().toLocaleTimeString('fr-FR') };
    history.unshift(entry);
    if (history.length > 20) history.pop();
    renderHistory();
  }

  function renderHistory() {
    var grid = document.getElementById('history-grid');
    var cnt = document.getElementById('hist-count');
    if (history.length === 0) {
      grid.innerHTML = '<div style="color:#80848e;font-size:12px;">Aucune image generee dans cette session.</div>';
      cnt.textContent = '';
      return;
    }
    cnt.textContent = '(' + history.length + ')';
    grid.innerHTML = '';
    history.forEach(function(e, i) {
      var item = document.createElement('div');
      item.className = 'history-item';
      var imgEl = document.createElement('img');
      imgEl.src = e.url + '&nocache=' + (i + '_' + Date.now());
      imgEl.alt = e.author;
      imgEl.loading = 'lazy';
      var meta = document.createElement('div');
      meta.className = 'history-meta';
      meta.innerHTML = '<span>' + e.ts + ' — ' + escHtml(e.author) + '</span>';
      var dlBtn = document.createElement('button');
      dlBtn.textContent = 'Telecharger';
      dlBtn.addEventListener('click', (function(eu, ea) {
        return function() {
          fetch(eu + '&nocache=' + Date.now()).then(function(r) { return r.blob(); }).then(function(blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'boom-' + ea + '-' + Date.now() + '.png';
            a.click();
          });
        };
      })(e.url, e.author));
      meta.appendChild(dlBtn);
      item.appendChild(imgEl);
      item.appendChild(meta);
      grid.appendChild(item);
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Charger avatars connus depuis /api/custom-filters (ou affichage statique)
  fetch('/api/custom-filters')
    .then(function(r) { return r.json(); })
    .then(function() {
      // On affiche les auteurs vus dans le log
      return fetch('/api/messages');
    })
    .then(function(r) { return r.json(); })
    .then(function(msgs) {
      var seen = {};
      msgs.forEach(function(m) { if (m.author) seen[m.author] = true; });
      var authors = Object.keys(seen);
      var list = document.getElementById('avatar-list');
      if (authors.length === 0) {
        list.innerHTML = '<div style="color:#80848e;font-size:12px;">Aucun auteur vu pour l instant.</div>';
        return;
      }
      list.innerHTML = '';
      authors.forEach(function(a) {
        var item = document.createElement('div');
        item.className = 'avatar-item';
        var useBtn = document.createElement('button');
        useBtn.textContent = 'Utiliser';
        useBtn.style.cssText = 'background:#5865f222;border:1px solid #5865f244;color:#5865f2;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;';
        useBtn.addEventListener('click', (function(name){ return function(){ document.getElementById('inp-author').value = name; }; })(a));
        item.innerHTML = '<div class="avatar-circle">' + escHtml(a.slice(0,2).toUpperCase()) + '</div>' +
          '<div style="flex:1"><div class="avatar-name">' + escHtml(a) + '</div></div>';
        item.appendChild(useBtn);
        list.appendChild(item);
      });
    })
    .catch(function() {
      document.getElementById('avatar-list').innerHTML = '<div style="color:#80848e;font-size:12px;">Impossible de charger les auteurs.</div>';
    });
})();
</script>
</div>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────
//  Page Messages Bruts — tous les messages Discord sans filtre
// ─────────────────────────────────────────────────────────────────────
const RAW_MESSAGES_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Messages Bruts</title>
<style>
  ${COMMON_CSS}
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #aaa; flex-shrink: 0; transition: background .3s; }
  #dot.on { background: #3ba55d; box-shadow: 0 0 6px #3ba55d; }
  #dot.off { background: #ed4245; }
  #lbl { font-size: 12px; color: #80848e; }
  #cnt { margin-left: auto; font-size: 12px; color: #80848e; }
  #wrap { padding: 16px 24px; }
  #search-bar { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; }
  #search-input { flex: 1; background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 7px 12px; font-size: 13px; outline: none; }
  #search-input:focus { border-color: #5865f2; }
  #search-input::placeholder { color: #80848e; }
  #filter-author { background: #2b2d31; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 7px 10px; font-size: 13px; outline: none; cursor: pointer; }
  #filter-author:focus { border-color: #5865f2; }
  .msg-card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
  .msg-card.new { animation: flash .8s ease-out; }
  .msg-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .msg-author { font-weight: 700; color: #D649CC; font-size: 14px; }
  .msg-channel { font-size: 12px; color: #80848e; }
  .msg-time { font-size: 12px; color: #80848e; margin-left: auto; }
  .msg-body { font-size: 14px; color: #dcddde; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .msg-reply { font-size: 12px; color: #80848e; border-left: 2px solid #3f4147; padding-left: 8px; margin-bottom: 4px; font-style: italic; }
  .badge { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .b-entry   { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit    { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter  { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .b-convo   { background: #2e2e2e; color: #80848e; border: 1px solid #80848e44; }
  #empty { padding: 60px 24px; text-align: center; color: #80848e; }
  @keyframes flash { from { background: #2a3040; } to { background: #2b2d31; } }
</style>
</head>
<body>
${sidebarHTML('/raw-messages')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Raw Messages</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting…</span>
  <span id="cnt"></span>
</div>
<div id="wrap">
  <div id="search-bar">
    <input type="text" id="search-input" placeholder="Rechercher dans les messages...">
    <select id="filter-author"><option value="">Tous les auteurs</option></select>
  </div>
  <div id="msg-list"><div id="empty">Aucun message pour l instant...</div></div>
</div>
<script>
(function(){
  var dot = document.getElementById('dot');
  var lbl = document.getElementById('lbl');
  var cnt = document.getElementById('cnt');
  var list = document.getElementById('msg-list');
  var searchInput = document.getElementById('search-input');
  var filterAuthor = document.getElementById('filter-author');

  var allMessages = [];
  var authorsSet = {};

  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function badgeClass(e) {
    if (e.passed) {
      if (e.type === 'entry') return 'b-entry';
      if (e.type === 'exit') return 'b-exit';
      return 'b-neutral';
    }
    if (e.reason === 'Conversational' || e.reason === 'No content') return 'b-convo';
    return 'b-filter';
  }

  function badgeLabel(e) {
    if (e.passed) return e.type ? e.type.toUpperCase() : 'ACCEPTE';
    return 'FILTRE — ' + (e.reason || '');
  }

  function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function buildCard(e, isNew) {
    var card = document.createElement('div');
    card.className = 'msg-card' + (isNew ? ' new' : '');
    card.dataset.id = e.id;
    card.dataset.author = e.author || '';
    card.dataset.content = (e.content || '').toLowerCase();

    var header = '<div class="msg-header">' +
      '<span class="msg-author">' + escHtml(e.author) + '</span>' +
      '<span class="msg-channel">#' + escHtml(e.channel) + '</span>' +
      '<span class="badge ' + badgeClass(e) + '">' + escHtml(badgeLabel(e)) + '</span>' +
      '<span class="msg-time">' + fmtTime(e.ts) + '</span>' +
      '</div>';

    var reply = '';
    if (e.isReply && e.parentPreview) {
      reply = '<div class="msg-reply">Reponse a <strong>' + escHtml(e.parentAuthor || '?') + '</strong> : ' + escHtml(e.parentPreview) + '</div>';
    }

    var body = '<div class="msg-body">' + escHtml(e.content || '') + '</div>';

    card.innerHTML = header + reply + body;
    return card;
  }

  function applyFilters() {
    var search = searchInput.value.toLowerCase();
    var author = filterAuthor.value;
    var cards = list.querySelectorAll('.msg-card');
    var visible = 0;
    cards.forEach(function(c) {
      var matchAuthor = !author || c.dataset.author === author;
      var matchSearch = !search || c.dataset.content.includes(search);
      c.style.display = (matchAuthor && matchSearch) ? '' : 'none';
      if (matchAuthor && matchSearch) visible++;
    });
    cnt.textContent = visible + ' message' + (visible > 1 ? 's' : '');
  }

  function addAuthorOption(name) {
    if (authorsSet[name]) return;
    authorsSet[name] = true;
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    filterAuthor.appendChild(opt);
  }

  function prependCard(e, isNew) {
    var empty = document.getElementById('empty');
    if (empty) empty.remove();
    var card = buildCard(e, isNew);
    list.insertBefore(card, list.firstChild);
    addAuthorOption(e.author || '');
    applyFilters();
  }

  // Charger les messages existants
  fetch('/api/messages')
    .then(function(r) { return r.json(); })
    .then(function(msgs) {
      allMessages = msgs;
      // msgs est newest-first, on les affiche dans l ordre (newest en haut)
      msgs.forEach(function(m) {
        var empty = document.getElementById('empty');
        if (empty) empty.remove();
        var card = buildCard(m, false);
        list.appendChild(card);
        addAuthorOption(m.author || '');
      });
      cnt.textContent = msgs.length + ' message' + (msgs.length > 1 ? 's' : '');
    })
    .catch(function() { lbl.textContent = 'Erreur chargement'; });

  // SSE pour les nouveaux messages en temps reel
  var es = new EventSource('/api/events');
  es.onopen = function() { dot.className = 'on'; lbl.textContent = 'Live'; };
  es.onerror = function() { dot.className = 'off'; lbl.textContent = 'Deconnecte'; };
  es.onmessage = function(ev) {
    try {
      var e = JSON.parse(ev.data);
      prependCard(e, true);
    } catch(_) {}
  };

  searchInput.addEventListener('input', applyFilters);
  filterAuthor.addEventListener('change', applyFilters);
})();
</script>
</div>
</body>
</html>`;

app.get('/raw-messages', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(RAW_MESSAGES_HTML);
});

app.get('/image-generator', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(IMAGE_GEN_HTML);
});

// Mise a jour de /preview pour supporter le parametre ?ts=
app.get('/preview', async (req, res) => {
  try {
    const author = req.query.author || 'Z';
    const message = req.query.message || '$TSLA 150.00-155.00';
    const ts = req.query.ts || new Date().toISOString();
    const buf = await generateImage(author, message, ts);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  Proof Generator: /proof-generator + /api/find-alert + /api/proof-image
// ─────────────────────────────────────────────────────────────────────

// Find original entry alert for a ticker in message history (last 90 days)
app.get('/api/find-alert', requireAuth, (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase().replace('$', '');
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  if (!ticker) return res.json({ alerts: [] });

  const alerts = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const msgs = i === 0
      ? messageLog.filter(m => m.ts && m.ts.slice(0, 10) === dateKey)
      : loadDailyFile(dateKey);
    msgs.forEach(m => {
      if (!m.passed || !m.ticker) return;
      if (m.ticker.toUpperCase() !== ticker) return;
      alerts.push({
        id: m.id,
        ts: m.ts,
        author: m.author,
        content: m.content || m.preview || '',
        ticker: m.ticker,
        type: m.type,
      });
    });
  }
  // Newest first
  alerts.sort((a, b) => (b.ts || '') < (a.ts || '') ? -1 : 1);
  res.json({ ticker, alerts: alerts.slice(0, 20) });
});

// Generate proof image
app.get('/api/proof-image', requireAuth, async (req, res) => {
  try {
    const { alertAuthor, alertContent, alertTs, recapAuthor, recapContent, recapTs } = req.query;
    if (!alertContent || !recapContent) return res.status(400).json({ error: 'Missing params' });
    const buf = await generateProofImage(
      alertAuthor || 'Unknown', alertContent, alertTs,
      recapAuthor || 'Unknown', recapContent, recapTs
    );
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PROOF_GEN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Proof Generator</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; gap: 24px; max-width: 1200px; flex-wrap: wrap; }
  .panel { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; flex: 1; min-width: 320px; }
  .panel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 14px; }
  label { font-size: 12px; color: #b5bac1; display: block; margin-bottom: 5px; margin-top: 12px; }
  input, textarea, select { width: 100%; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; color: #dcddde; padding: 8px 10px; font-size: 13px; font-family: inherit; }
  input:focus, textarea:focus { outline: none; border-color: #5865f2; }
  textarea { resize: vertical; min-height: 70px; }
  .btn { background: #5865f2; color: #fff; border: none; border-radius: 4px; padding: 10px 20px; cursor: pointer; font-size: 13px; font-weight: 600; width: 100%; margin-top: 16px; }
  .btn:hover { background: #4752c4; }
  .btn-sm { background: #3ba55d22; border: 1px solid #3ba55d44; color: #3ba55d; border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 12px; font-weight: 600; width: auto; margin-top: 0; }
  .btn-sm:hover { background: #3ba55d44; }
  .alert-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-height: 300px; overflow-y: auto; }
  .alert-item { background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 8px 10px; cursor: pointer; transition: border-color .15s; }
  .alert-item:hover { border-color: #5865f2; }
  .alert-item.selected { border-color: #3ba55d; background: #1a3a2a; }
  .alert-author { font-weight: 700; color: #D649CC; font-size: 12px; }
  .alert-content { font-size: 13px; color: #dcddde; margin-top: 3px; }
  .alert-ts { font-size: 11px; color: #80848e; margin-top: 2px; }
  .alert-type { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
  .type-entry { background: #1a3a2a; color: #3ba55d; }
  .type-neutral { background: #1a2a3a; color: #5865f2; }
  #preview-wrap { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; flex: 0 0 100%; }
  #preview-wrap img { max-width: 100%; border-radius: 6px; display: block; margin: 0 auto; }
  .search-row { display: flex; gap: 8px; align-items: flex-end; }
  .search-row input { flex: 1; }
  #status { font-size: 12px; color: #80848e; margin-top: 8px; min-height: 16px; }
  .download-btn { background: #3ba55d; color: #fff; border: none; border-radius: 4px; padding: 8px 20px; cursor: pointer; font-size: 13px; font-weight: 600; margin-top: 12px; display: none; }
  .download-btn:hover { background: #2d7d46; }
</style>
</head>
<body>
${sidebarHTML('/proof-generator')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Proof Generator</h1></div>
<div id="wrap">
  <!-- Left: Alert search -->
  <div class="panel">
    <div class="panel-title">1. Trouver l'alerte originale</div>
    <div class="search-row">
      <div style="flex:1;">
        <label>Ticker</label>
        <input id="ticker-input" type="text" placeholder="TSLA" maxlength="10">
      </div>
      <button class="btn-sm" id="search-btn" style="margin-bottom:1px;">Chercher</button>
    </div>
    <div id="status"></div>
    <div id="alert-list" class="alert-list"></div>
    <div style="margin-top:14px;border-top:1px solid #3f4147;padding-top:14px;">
      <div class="panel-title" style="margin-bottom:8px;">Alerte sélectionnée</div>
      <label>Analyste</label>
      <input id="alert-author" type="text" placeholder="AR">
      <label>Message</label>
      <textarea id="alert-content" placeholder="$TSLA 150.00 entry..."></textarea>
      <label>Date/Heure</label>
      <input id="alert-ts" type="datetime-local">
    </div>
  </div>

  <!-- Right: Recap message -->
  <div class="panel">
    <div class="panel-title">2. Message recap (résultat)</div>
    <label>Analyste</label>
    <input id="recap-author" type="text" placeholder="Z">
    <label>Message</label>
    <textarea id="recap-content" placeholder="$TSLA 150.00-155.00 🔥"></textarea>
    <label>Date/Heure</label>
    <input id="recap-ts" type="datetime-local">
    <button class="btn" id="generate-btn">🖼️ Générer l'image proof</button>
  </div>

  <!-- Preview -->
  <div id="preview-wrap" style="display:none;">
    <div class="panel-title">Aperçu</div>
    <img id="preview-img" src="" alt="proof image">
    <a id="download-link" style="display:none;"><button class="download-btn" id="dl-btn" style="display:block;">⬇️ Télécharger</button></a>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTs(ts){
    if(!ts) return '';
    var d = new Date(ts);
    var pad = n => String(n).padStart(2,'0');
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  }

  var selectedAlert = null;

  document.getElementById('search-btn').addEventListener('click', function(){
    var ticker = document.getElementById('ticker-input').value.trim().toUpperCase().replace('$','');
    if(!ticker) return;
    document.getElementById('status').textContent = 'Recherche...';
    document.getElementById('alert-list').innerHTML = '';
    fetch('/api/find-alert?ticker='+encodeURIComponent(ticker)+'&days=30')
      .then(function(r){return r.json();})
      .then(function(data){
        var alerts = data.alerts || [];
        document.getElementById('status').textContent = alerts.length + ' alerte(s) trouvée(s)';
        if(!alerts.length){
          document.getElementById('alert-list').innerHTML = '<div style="color:#80848e;font-size:12px;padding:8px;">Aucune alerte trouvée pour ' + esc(ticker) + '</div>';
          return;
        }
        var html = '';
        alerts.forEach(function(a, i){
          var typeHtml = a.type ? '<span class="alert-type type-'+(a.type||'neutral')+'">'+esc(a.type)+'</span>' : '';
          var d = new Date(a.ts);
          var dateStr = d.toLocaleDateString('fr-CA') + ' ' + d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'});
          html += '<div class="alert-item" data-idx="'+i+'">'
            + '<div class="alert-author">'+esc(a.author)+typeHtml+'</div>'
            + '<div class="alert-content">'+esc(a.content)+'</div>'
            + '<div class="alert-ts">'+dateStr+'</div>'
            + '</div>';
        });
        document.getElementById('alert-list').innerHTML = html;
        // Store alerts for click
        window._alerts = alerts;
        document.querySelectorAll('.alert-item').forEach(function(el){
          el.addEventListener('click', function(){
            document.querySelectorAll('.alert-item').forEach(function(e){e.classList.remove('selected');});
            el.classList.add('selected');
            var idx = parseInt(el.getAttribute('data-idx'));
            var a = window._alerts[idx];
            document.getElementById('alert-author').value = a.author || '';
            document.getElementById('alert-content').value = a.content || '';
            document.getElementById('alert-ts').value = fmtTs(a.ts);
          });
        });
      })
      .catch(function(){ document.getElementById('status').textContent = 'Erreur de recherche'; });
  });

  document.getElementById('ticker-input').addEventListener('keydown', function(e){
    if(e.key === 'Enter') document.getElementById('search-btn').click();
  });

  document.getElementById('generate-btn').addEventListener('click', function(){
    var alertAuthor = document.getElementById('alert-author').value.trim();
    var alertContent = document.getElementById('alert-content').value.trim();
    var alertTs = document.getElementById('alert-ts').value;
    var recapAuthor = document.getElementById('recap-author').value.trim();
    var recapContent = document.getElementById('recap-content').value.trim();
    var recapTs = document.getElementById('recap-ts').value;

    if(!alertContent || !recapContent){ alert('Remplis les deux messages.'); return; }

    var params = new URLSearchParams({
      alertAuthor, alertContent, recapAuthor, recapContent,
      alertTs: alertTs ? new Date(alertTs).toISOString() : new Date().toISOString(),
      recapTs: recapTs ? new Date(recapTs).toISOString() : new Date().toISOString(),
    });
    var url = '/api/proof-image?' + params.toString();
    var img = document.getElementById('preview-img');
    img.src = url;
    img.onload = function(){
      document.getElementById('preview-wrap').style.display = '';
      var link = document.getElementById('download-link');
      link.href = url;
      link.download = 'proof-' + (recapAuthor||'boom') + '.png';
      link.style.display = '';
    };
    img.onerror = function(){ alert('Erreur génération image'); };
  });
})();
</script>
</div>
</body>
</html>`;

app.get('/proof-generator', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(PROOF_GEN_HTML);
});

// ─────────────────────────────────────────────────────────────────────
//  Page Statistiques /stats
// ─────────────────────────────────────────────────────────────────────
const STATS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Stats</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card-full { grid-column: 1 / -1; }
  .progress-bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,0.06); margin-top: 14px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 5px; transition: width .4s; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-label { width: 80px; font-size: 12px; color: #a0a0b0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { flex: 1; height: 14px; background: rgba(255,255,255,0.06); border-radius: 6px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; transition: width .4s; }
  .bar-val { width: 30px; font-size: 12px; color: #a0a0b0; text-align: left; }
  .badge-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-badge { display: flex; flex-direction: column; align-items: center; padding: 14px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; min-width: 80px; }
  .stat-badge .num { font-size: 28px; font-weight: 800; }
  .b-entry { background: #1e3a2f; color: #3ba55d; border: 1px solid #3ba55d44; }
  .b-exit { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .b-neutral { background: #2a2e3d; color: #5865f2; border: 1px solid #5865f244; }
  .b-filter { background: #3a2e1e; color: #faa61a; border: 1px solid #faa61a44; }
  .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 80px; margin-top: 10px; }
  .hour-col { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .hour-bar { width: 100%; border-radius: 2px 2px 0 0; min-height: 1px; }
  .hour-lbl { font-size: 9px; color: #80848e; margin-top: 3px; }
  .period-btns { display: flex; gap: 6px; margin-left: 16px; }
  .perf-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .perf-table th { text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; padding: 0 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .perf-table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; vertical-align: middle; }
  .perf-table tr:last-child td { border-bottom: none; }
  .perf-author { font-weight: 700; color: #D649CC; }
  .perf-acc { color: #3ba55d; }
  .perf-flt { color: #faa61a; }
  .perf-bar-wrap { width: 80px; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
  .perf-bar-fill { height: 100%; border-radius: 4px; }
  .perf-ticker { color: #5865f2; font-size: 11px; }
  @media (max-width: 700px) { #wrap { grid-template-columns: 1fr; } .card-full { grid-column: 1; } }
</style>
</head>
<body>
${sidebarHTML('/stats')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">Stats</h1>
  <div class="period-btns">
    <button class="btn-period active" id="btn-today" data-period="today">Aujourd&#39;hui</button>
    <button class="btn-period" id="btn-7d" data-period="7d">7 jours</button>
    <button class="btn-period" id="btn-30d" data-period="30d">30 jours</button>
  </div>
  <button class="btn-refresh" id="btn-refresh">Actualiser</button>
</div>
<div id="wrap">
  <div class="card">
    <div class="card-title">Taux acceptation</div>
    <div class="big-number" id="accept-pct">—</div>
    <div class="big-sub" id="accept-sub">chargement...</div>
    <div class="progress-bar"><div class="progress-fill" id="accept-bar" style="width:0%;background:#3ba55d;"></div></div>
  </div>
  <div class="card">
    <div class="card-title">Repartition des signaux</div>
    <div class="badge-row" id="type-badges">
      <div class="stat-badge b-entry"><span class="num" id="cnt-entry">0</span>Entry</div>
      <div class="stat-badge b-exit"><span class="num" id="cnt-exit">0</span>Exit</div>
      <div class="stat-badge b-neutral"><span class="num" id="cnt-neutral">0</span>Neutral</div>
      <div class="stat-badge b-filter"><span class="num" id="cnt-filtered">0</span>Filtre</div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">Top 5 auteurs</div>
    <div id="top-authors"></div>
  </div>
  <div class="card">
    <div class="card-title">Top 5 tickers</div>
    <div id="top-tickers"></div>
  </div>
  <div class="card card-full">
    <div class="card-title">Top 10 tickers — taux de succes</div>
    <div id="ticker-success-wrap"><span style="color:#80848e;font-size:12px;">Chargement...</span></div>
  </div>
  <div class="card card-full">
    <div class="card-title">Performance par auteur</div>
    <div id="author-perf-wrap"><span style="color:#80848e;font-size:12px;">Chargement...</span></div>
  </div>
  <div class="card card-full">
    <div class="card-title" id="vol-chart-title">Volume par heure (24h)</div>
    <div class="hour-chart" id="hour-chart"></div>
  </div>
  <div class="card card-full">
    <div class="card-title">Analyst Performance — 30 jours</div>
    <div id="perf-chart"><span style="color:#80848e;font-size:12px;">Chargement...</span></div>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  var currentPeriod = 'today';

  function periodFromTs() {
    var now = new Date();
    if (currentPeriod === 'today') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
    } else if (currentPeriod === '7d') {
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (currentPeriod === '30d') {
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    return null;
  }

  function renderBars(containerId, data, color) {
    var container = document.getElementById(containerId);
    if (!data.length) { container.innerHTML = '<span style="color:#80848e;font-size:12px;">Aucune donnee</span>'; return; }
    var max = data[0][1] || 1;
    container.innerHTML = '';
    data.forEach(function(item) {
      var pct = Math.round(item[1] / max * 100);
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = '<span class="bar-label" title="' + esc(item[0]) + '">' + esc(item[0]) + '</span>'
        + '<div class="bar-wrap"><div class="bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>'
        + '<span class="bar-val">' + item[1] + '</span>';
      container.appendChild(row);
    });
  }

  function renderAuthorPerf(msgs) {
    var wrap = document.getElementById('author-perf-wrap');
    var authorStats = {};
    msgs.forEach(function(m) {
      if (!m.author) return;
      if (!authorStats[m.author]) authorStats[m.author] = { total: 0, accepted: 0, filtered: 0, tickers: {} };
      var s = authorStats[m.author];
      s.total++;
      if (m.passed) s.accepted++; else s.filtered++;
      if (m.ticker) s.tickers[m.ticker] = (s.tickers[m.ticker] || 0) + 1;
    });
    var rows = Object.keys(authorStats).map(function(a) { return [a, authorStats[a]]; })
      .sort(function(x, y) { return y[1].total - x[1].total; }).slice(0, 10);
    if (!rows.length) { wrap.innerHTML = '<span style="color:#80848e;font-size:12px;">Aucune donnee</span>'; return; }
    var html = '<table class="perf-table"><thead><tr>'
      + '<th>Auteur</th><th>Total</th><th>Acceptes</th><th>Filtres</th><th>Taux</th><th>Ticker top</th>'
      + '</tr></thead><tbody>';
    rows.forEach(function(row) {
      var name = row[0], s = row[1];
      var rate = s.total ? Math.round(s.accepted / s.total * 100) : 0;
      var barColor = rate >= 50 ? '#3ba55d' : rate >= 25 ? '#faa61a' : '#ed4245';
      var topTicker = '';
      var topCount = 0;
      Object.keys(s.tickers).forEach(function(t) { if (s.tickers[t] > topCount) { topCount = s.tickers[t]; topTicker = t; } });
      html += '<tr>'
        + '<td class="perf-author">' + esc(name) + '</td>'
        + '<td>' + s.total + '</td>'
        + '<td class="perf-acc">' + s.accepted + '</td>'
        + '<td class="perf-flt">' + s.filtered + '</td>'
        + '<td><span class="perf-bar-wrap"><span class="perf-bar-fill" style="width:' + rate + '%;background:' + barColor + ';"></span></span>' + rate + '%</td>'
        + '<td class="perf-ticker">' + esc(topTicker) + '</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function renderVolumeChart(msgs) {
    var isMultiDay = currentPeriod === '7d' || currentPeriod === '30d';
    var chart = document.getElementById('hour-chart');
    var title = document.getElementById('vol-chart-title');
    chart.innerHTML = '';

    if (isMultiDay) {
      title.textContent = currentPeriod === '7d' ? 'Volume par jour (7 jours)' : 'Volume par jour (30 jours)';
      var dayMap = {};
      msgs.forEach(function(m) {
        var d = m.ts ? m.ts.slice(0, 10) : '';
        if (!d) return;
        if (!dayMap[d]) dayMap[d] = { total: 0, accepted: 0 };
        dayMap[d].total++;
        if (m.passed) dayMap[d].accepted++;
      });
      var days = Object.keys(dayMap).sort();
      var maxV = 0;
      days.forEach(function(d) { if (dayMap[d].total > maxV) maxV = dayMap[d].total; });
      maxV = maxV || 1;
      days.forEach(function(d) {
        var v = dayMap[d].total;
        var acc = dayMap[d].accepted;
        var heightPct = Math.round(v / maxV * 100);
        var accRate = v ? acc / v : 0;
        var barColor = accRate >= 0.5 ? '#3ba55d' : accRate >= 0.25 ? '#faa61a' : '#ed4245';
        if (v === 0) barColor = '#3f4147';
        var lbl = d.slice(5); // MM-DD
        var col = document.createElement('div');
        col.className = 'hour-col';
        col.innerHTML = '<div class="hour-bar" title="' + v + ' msg" style="height:' + heightPct + '%;background:' + barColor + ';"></div>'
          + '<span class="hour-lbl">' + esc(lbl) + '</span>';
        chart.appendChild(col);
      });
    } else {
      title.textContent = 'Volume par heure (24h)';
      var hourBuckets = new Array(24).fill(0);
      var hourAccepted = new Array(24).fill(0);
      msgs.forEach(function(m) {
        var h = new Date(m.ts).getHours();
        hourBuckets[h]++;
        if (m.passed) hourAccepted[h]++;
      });
      var maxH = Math.max.apply(null, hourBuckets) || 1;
      for (var i = 0; i < 24; i++) {
        var v = hourBuckets[i];
        var heightPct = Math.round(v / maxH * 100);
        var accRate = v ? hourAccepted[i] / v : 0;
        var barColor = accRate >= 0.5 ? '#3ba55d' : accRate >= 0.25 ? '#faa61a' : '#ed4245';
        if (v === 0) barColor = '#3f4147';
        var col = document.createElement('div');
        col.className = 'hour-col';
        col.innerHTML = '<div class="hour-bar" title="' + v + ' msg" style="height:' + heightPct + '%;background:' + barColor + ';"></div>'
          + '<span class="hour-lbl">' + String(i).padStart(2, '0') + '</span>';
        chart.appendChild(col);
      }
    }
  }

  function renderTickerSuccess(msgs) {
    var wrap = document.getElementById('ticker-success-wrap');
    var tickerStats = {};
    // Sort messages by time ascending so we capture the earliest alert first
    var sorted = msgs.slice().sort(function(a, b) { return new Date(a.ts) - new Date(b.ts); });
    sorted.forEach(function(m) {
      if (!m.ticker) return;
      if (!tickerStats[m.ticker]) tickerStats[m.ticker] = { total: 0, accepted: 0, firstEntry: null };
      tickerStats[m.ticker].total++;
      if (m.passed) {
        tickerStats[m.ticker].accepted++;
        // Record entry price from the first accepted alert for this ticker
        if (tickerStats[m.ticker].firstEntry === null && m.entry_price != null) {
          tickerStats[m.ticker].firstEntry = m.entry_price;
        }
      }
    });
    var rows = Object.keys(tickerStats).map(function(t) { return [t, tickerStats[t]]; })
      .sort(function(a, b) { return b[1].total - a[1].total; }).slice(0, 10);
    if (!rows.length) { wrap.innerHTML = '<span style="color:#80848e;font-size:12px;">Aucune donnee</span>'; return; }
    var html = '<table class="perf-table"><thead><tr>'
      + '<th>#</th><th>Ticker</th><th>Prix entree</th><th>Total</th><th>Acceptes</th><th>Filtres</th><th>Taux succes</th>'
      + '</tr></thead><tbody>';
    rows.forEach(function(row, i) {
      var t = row[0], s = row[1];
      var rate = s.total ? Math.round(s.accepted / s.total * 100) : 0;
      var barColor = rate >= 50 ? '#3ba55d' : rate >= 25 ? '#faa61a' : '#ed4245';
      var entryCell = s.firstEntry != null
        ? '<span style="color:#faa61a;font-weight:700;">$' + s.firstEntry + '</span>'
        : '<span style="color:#4f5660;">—</span>';
      html += '<tr>'
        + '<td style="color:#80848e;">' + (i + 1) + '</td>'
        + '<td class="perf-ticker" style="font-weight:700;font-size:13px;">$' + esc(t) + '</td>'
        + '<td>' + entryCell + '</td>'
        + '<td>' + s.total + '</td>'
        + '<td class="perf-acc">' + s.accepted + '</td>'
        + '<td class="perf-flt">' + (s.total - s.accepted) + '</td>'
        + '<td><span class="perf-bar-wrap"><span class="perf-bar-fill" style="width:' + rate + '%;background:' + barColor + ';"></span></span>' + rate + '%</td>'
        + '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function loadStats() {
    var fromTs = periodFromTs();
    var url = '/api/messages' + (fromTs ? '?from=' + encodeURIComponent(fromTs) : '');
    fetch(url)
      .then(function(r){ return r.json(); })
      .then(function(msgs) {
        var total = msgs.length;
        var accepted = msgs.filter(function(m){ return m.passed; }).length;
        var pct = total ? Math.round(accepted / total * 100) : 0;

        document.getElementById('accept-pct').textContent = pct + '%';
        document.getElementById('accept-sub').textContent = accepted + ' acceptes sur ' + total + ' total';
        document.getElementById('accept-bar').style.width = pct + '%';
        document.getElementById('accept-bar').style.background = pct >= 50 ? '#3ba55d' : pct >= 25 ? '#faa61a' : '#ed4245';

        var cEntry = 0, cExit = 0, cNeutral = 0, cFiltered = 0;
        msgs.forEach(function(m){
          if (!m.passed) { cFiltered++; return; }
          if (m.type === 'entry') cEntry++;
          else if (m.type === 'exit') cExit++;
          else cNeutral++;
        });
        document.getElementById('cnt-entry').textContent = cEntry;
        document.getElementById('cnt-exit').textContent = cExit;
        document.getElementById('cnt-neutral').textContent = cNeutral;
        document.getElementById('cnt-filtered').textContent = cFiltered;

        var authorMap = {};
        msgs.forEach(function(m){ if(m.author) authorMap[m.author] = (authorMap[m.author]||0) + 1; });
        var topAuthors = Object.keys(authorMap).map(function(k){ return [k, authorMap[k]]; })
          .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);
        renderBars('top-authors', topAuthors, '#D649CC');

        var tickerMap = {};
        msgs.forEach(function(m){ if(m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker]||0) + 1; });
        var topTickers = Object.keys(tickerMap).map(function(k){ return [k, tickerMap[k]]; })
          .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);
        renderBars('top-tickers', topTickers, '#5865f2');

        renderAuthorPerf(msgs);
        renderVolumeChart(msgs);
        renderTickerSuccess(msgs);
      })
      .catch(function(){ document.getElementById('accept-sub').textContent = 'Erreur de chargement'; });
  }

  function setPeriod(p) {
    currentPeriod = p;
    document.querySelectorAll('.btn-period').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-period') === p);
    });
    loadStats();
  }

  document.getElementById('btn-today').addEventListener('click', function() { setPeriod('today'); });
  document.getElementById('btn-7d').addEventListener('click', function() { setPeriod('7d'); });
  document.getElementById('btn-30d').addEventListener('click', function() { setPeriod('30d'); });

  loadStats();
  document.getElementById('btn-refresh').addEventListener('click', loadStats);

  // ── Analyst Performance Chart ──
  fetch('/api/analyst-performance?days=30')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var wrap = document.getElementById('perf-chart');
      if (!data.datasets || !data.datasets.length) {
        wrap.innerHTML = '<span style="color:#80848e;font-size:12px;">Aucune donnee</span>';
        return;
      }
      var labels = data.labels || [];
      var datasets = data.datasets;
      var maxVal = 1;
      datasets.forEach(function(ds){ ds.data.forEach(function(v){ if(v>maxVal) maxVal=v; }); });

      var W = 760, H = 220, PAD_L = 30, PAD_B = 24, PAD_T = 10, PAD_R = 10;
      var chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;
      var stepX = labels.length > 1 ? chartW / (labels.length - 1) : chartW;

      var svg = '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;">';
      // Grid lines
      for (var g = 0; g <= 4; g++) {
        var gy = PAD_T + chartH - (g/4)*chartH;
        svg += '<line x1="'+PAD_L+'" y1="'+gy+'" x2="'+(W-PAD_R)+'" y2="'+gy+'" stroke="#3f4147" stroke-width="0.5"/>';
        svg += '<text x="'+(PAD_L-4)+'" y="'+(gy+3)+'" fill="#80848e" font-size="9" text-anchor="end">'+Math.round(maxVal*g/4)+'</text>';
      }
      // Lines
      datasets.forEach(function(ds) {
        var pts = [];
        ds.data.forEach(function(v, i){
          var x = PAD_L + i * stepX;
          var y = PAD_T + chartH - (v / maxVal) * chartH;
          pts.push(x+','+y);
        });
        svg += '<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+ds.color+'" stroke-width="2" stroke-linejoin="round"/>';
        // Dots
        ds.data.forEach(function(v, i){
          if (v > 0) {
            var x = PAD_L + i * stepX;
            var y = PAD_T + chartH - (v / maxVal) * chartH;
            svg += '<circle cx="'+x+'" cy="'+y+'" r="2.5" fill="'+ds.color+'"/>';
          }
        });
      });
      svg += '</svg>';

      // Legend
      var legend = '<div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap;">';
      datasets.forEach(function(ds){
        legend += '<div style="display:flex;align-items:center;gap:5px;font-size:12px;"><span style="width:10px;height:10px;border-radius:2px;background:'+ds.color+';display:inline-block;"></span><span style="color:#dcddde;">'+ds.author+'</span></div>';
      });
      legend += '</div>';
      wrap.innerHTML = svg + legend;
    });
})();
</script>
</div>
</body>
</html>`;

app.get('/stats', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(STATS_HTML);
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 2: addProfitMessage — profit counter with milestone alerts
// ─────────────────────────────────────────────────────────────────────
async function addProfitMessage(content) {
  const dateKey = todayKey();
  const data = loadProfitData(dateKey);
  if (!data.milestones) data.milestones = [];
  const entries = countProfitEntries(content);
  data.count = (data.count || 0) + entries;
  saveProfitData(dateKey, data);
  console.log('[profits] +' + entries + ' profit(s) — total: ' + data.count);

  // Check milestones
  for (const milestone of PROFIT_MILESTONES) {
    if (data.count >= milestone && !data.milestones.includes(milestone)) {
      data.milestones.push(milestone);
      saveProfitData(dateKey, data);
      // Post to profits channel
      if (PROFITS_CHANNEL_ID && client && !profitsBotSilent) {
        try {
          const ch = client.channels.cache.get(PROFITS_CHANNEL_ID);
          if (ch && ch.send) {
            await ch.send('🎯 Milestone reached — **' + milestone + ' profits today!** 🔥');
            console.log('[profits] Milestone ' + milestone + ' posted to #profits');
          }
        } catch (e) {
          console.error('[profits] Error posting milestone:', e.message);
        }
      }
    }
  }
  return data.count;
}

// ─────────────────────────────────────────────────────────────────────
//  Daily profit summary — posted at 20:00 EDT to #profits
//  Tracks all-time record to encourage members
// ─────────────────────────────────────────────────────────────────────
function getProfitRecord() {
  // Scan last 90 days to find the all-time record
  let recordCount = 109;
  let recordDate = null;
  for (let i = 0; i < 90; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const data = loadProfitData(dateKey);
    if ((data.count || 0) > recordCount) {
      recordCount = data.count;
      recordDate = dateKey;
    }
  }
  return { count: recordCount, date: recordDate };
}

let lastProfitSummaryDate = null;

async function sendDailyProfitSummary() {
  if (!PROFITS_CHANNEL_ID || !client || profitsBotSilent) return;
  try {
    const ch = client.channels.cache.get(PROFITS_CHANNEL_ID);
    if (!ch || !ch.send) return;

    const dateKey = todayKey();
    const data = loadProfitData(dateKey);
    const todayCount = data.count || 0;
    const record = getProfitRecord();

    // Build last 7 days bar chart (text-based)
    const days7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dk = d.toISOString().slice(0, 10);
      const pd = loadProfitData(dk);
      days7.push({ date: dk, count: pd.count || 0 });
    }
    const max7 = Math.max.apply(null, days7.map(d => d.count)) || 1;
    const chart = days7.map(d => {
      const bars = Math.round((d.count / max7) * 8);
      const bar = '█'.repeat(bars) + '░'.repeat(8 - bars);
      const label = d.date.slice(5); // MM-DD
      const isToday = d.date === dateKey;
      return (isToday ? '**' : '') + '`' + label + '` ' + bar + ' ' + d.count + (isToday ? ' ← today**' : '');
    }).join('\n');

    // Check if today is a new record
    const isNewRecord = todayCount > 0 && todayCount >= record.count && dateKey === record.date;
    const recordLine = isNewRecord
      ? '\n\n🏆 **NEW ALL-TIME RECORD! ' + todayCount + ' profits!** 🏆'
      : '\n\n📊 All-time record: **' + record.count + '** profits (' + record.date + ')';

    // Compare to yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayData = loadProfitData(yesterday.toISOString().slice(0, 10));
    const yesterdayCount = yesterdayData.count || 0;
    let comparison = '';
    if (yesterdayCount > 0) {
      const diff = todayCount - yesterdayCount;
      if (diff > 0) comparison = ' (📈 +' + diff + ' vs yesterday)';
      else if (diff < 0) comparison = ' (📉 ' + diff + ' vs yesterday)';
      else comparison = ' (➡️ same as yesterday)';
    }

    const msg = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
      + '📊 **Daily Profit Report**\n'
      + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
      + '🔥 **' + todayCount + '** profits posted today' + comparison + '\n\n'
      + '**Last 7 days:**\n' + chart
      + recordLine + '\n\n'
      + '-# Keep posting your wins! Every profit counts 💪';

    await ch.send(msg);
    console.log('[profits] Daily summary posted — ' + todayCount + ' profits today');
  } catch (e) {
    console.error('[profits] Summary error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Feature 4a: GET /api/profits-history?days=7
// ─────────────────────────────────────────────────────────────────────
app.get('/api/profits-history', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 90);
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const data = loadProfitData(dateKey);
    result.push({ date: dateKey, count: data.count || 0 });
  }
  res.json(result);
});

// Expose profit count increment via API (called externally or via Make.com)
app.post('/api/add-profit', requireAuth, async (req, res) => {
  try {
    const count = await addProfitMessage(req.body?.content || '');
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Modifier manuellement le count de profits du jour
app.post('/api/set-profit-count', requireAuth, (req, res) => {
  try {
    const newCount = parseInt(req.body?.count, 10);
    if (isNaN(newCount) || newCount < 0) return res.status(400).json({ error: 'Valeur invalide' });
    const dateKey = todayKey();
    const data = loadProfitData(dateKey);
    data.count = newCount;
    saveProfitData(dateKey, data);
    console.log('[profits] Count manually set to ' + newCount);
    res.json({ ok: true, count: newCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lire / modifier le paramètre "bot silencieux dans #profits"
let profitsBotSilent = false;

app.get('/api/profits-bot-silent', requireAuth, (req, res) => {
  res.json({ silent: profitsBotSilent });
});

app.post('/api/profits-bot-silent', requireAuth, (req, res) => {
  profitsBotSilent = !!req.body?.silent;
  console.log('[profits] Bot messages in #profits: ' + (profitsBotSilent ? 'DISABLED' : 'ENABLED'));
  res.json({ ok: true, silent: profitsBotSilent });
});

// ─────────────────────────────────────────────────────────────────────
//  Webhook endpoint pour Discord → profits (pas d'auth requise)
//  Configure le webhook Discord du salon #profits vers cette URL
// ─────────────────────────────────────────────────────────────────────
app.post('/api/webhook/profits', async (req, res) => {
  try {
    const body = req.body || {};
    // Discord webhook envoie les messages avec content + attachments
    const content = body.content || '';
    const attachments = body.attachments || body.embeds || [];
    const hasImage = Array.isArray(attachments) && attachments.some(a =>
      (a.content_type && a.content_type.startsWith('image/')) ||
      (a.url && /\.(png|jpg|jpeg|gif|webp)/i.test(a.url)) ||
      (a.image)
    );

    // Si pas d'image, vérifier dans embeds
    const embeds = body.embeds || [];
    const hasEmbedImage = Array.isArray(embeds) && embeds.some(e => e.image || e.thumbnail);

    if (!hasImage && !hasEmbedImage && attachments.length === 0) {
      console.log('[webhook/profits] Message sans image — ignoré');
      return res.json({ ok: true, skipped: true, reason: 'no image' });
    }

    const count = await addProfitMessage(content);
    console.log('[webhook/profits] Profit enregistré — total: ' + count);
    res.json({ ok: true, count });
  } catch (e) {
    console.error('[webhook/profits] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 4b: GET /profits — bar chart page
// ─────────────────────────────────────────────────────────────────────
const PROFITS_PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Profits</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 28px; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
  .period-btns { display: flex; gap: 6px; }
  .btn-period { background: #1e1f22; border: 1px solid #3f4147; color: #80848e; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-period:hover { background: #3f4147; color: #dcddde; }
  .btn-period.active { background: #5865f244; border-color: #5865f2; color: #5865f2; }
  .chart-wrap { position: relative; height: 220px; }
  svg.bar-chart { width: 100%; height: 100%; }
  .bar-chart .bar { fill: #3ba55d; transition: opacity .15s; cursor: default; }
  .bar-chart .bar:hover { opacity: 0.75; }
  .bar-chart .axis-label { fill: #80848e; font-size: 11px; font-family: 'Segoe UI', system-ui, sans-serif; }
  .bar-chart .value-label { fill: #dcddde; font-size: 10px; font-family: 'Segoe UI', system-ui, sans-serif; text-anchor: middle; }
  .summary-row { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 16px; }
  .stat-box { background: #1e1f22; border: 1px solid #3f4147; border-radius: 6px; padding: 14px 20px; flex: 1; min-width: 120px; }
  .stat-box .num { font-size: 30px; font-weight: 800; color: #3ba55d; }
  .stat-box .lbl { font-size: 12px; color: #80848e; margin-top: 4px; }
  .btn-add { background: #3ba55d; border: none; color: #fff; border-radius: 4px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-add:hover { background: #2d8049; }
</style>
</head>
<body>
${sidebarHTML('/profits')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Profits</h1></div>
<div id="wrap">
  <div class="card">
    <div class="card-title">
      <span>Profits par jour</span>
      <div class="period-btns">
        <button class="btn-period active" id="btn-7d" data-days="7">7 jours</button>
        <button class="btn-period" id="btn-30d" data-days="30">30 jours</button>
      </div>
    </div>
    <div class="chart-wrap">
      <svg class="bar-chart" id="profit-chart" viewBox="0 0 800 200" preserveAspectRatio="none"></svg>
    </div>
    <div class="summary-row" id="summary-row">
      <div class="stat-box"><div class="num" id="stat-today">—</div><div class="lbl">Aujourd'hui</div></div>
      <div class="stat-box"><div class="num" id="stat-total">—</div><div class="lbl">Total periode</div></div>
      <div class="stat-box"><div class="num" id="stat-avg">—</div><div class="lbl">Moyenne / jour</div></div>
      <div class="stat-box"><div class="num" id="stat-best">—</div><div class="lbl">Meilleur jour</div></div>
    </div>
  </div>
  <!-- Modifier le count du jour -->
  <div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
    <div style="flex:1;min-width:160px;">
      <div style="color:#dcddde;font-size:13px;font-weight:600;margin-bottom:4px;">Modifier les profits d'aujourd'hui</div>
      <div style="color:#80848e;font-size:12px;">Définir manuellement le compteur du jour</div>
    </div>
    <input type="number" id="input-set-count" min="0" step="1" placeholder="Nouveau total"
      style="width:120px;background:#2b2d31;border:1px solid #3f4147;color:#dcddde;border-radius:4px;padding:7px 10px;font-size:14px;" />
    <button class="btn-add" id="btn-set-count">Modifier</button>
    <button class="btn-add" id="btn-add-profit" style="background:#4f545c;">+ Ajouter 1</button>
    <span id="add-msg" style="font-size:13px;color:#3ba55d;display:none;"></span>
  </div>

  <!-- Toggle messages bot dans #profits -->
  <div class="card" style="display:flex;align-items:center;gap:16px;">
    <div style="flex:1;">
      <div style="color:#dcddde;font-size:13px;font-weight:600;margin-bottom:4px;">Messages du bot dans #profits</div>
      <div style="color:#80848e;font-size:12px;">Milestones et résumé quotidien</div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <span id="silent-label" style="font-size:13px;color:#80848e;">Activés</span>
      <div id="toggle-silent" style="position:relative;width:42px;height:22px;background:#3ba55d;border-radius:11px;cursor:pointer;transition:background .2s;">
        <div id="toggle-thumb" style="position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .2s;"></div>
      </div>
    </label>
  </div>
</div>
<script>
(function(){
  var currentDays = 7;

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderChart(data) {
    var svg = document.getElementById('profit-chart');
    svg.innerHTML = '';
    if (!data.length) return;
    var max = Math.max.apply(null, data.map(function(d){ return d.count; })) || 1;
    var W = 800, H = 200, padL = 30, padR = 10, padT = 20, padB = 30;
    var chartW = W - padL - padR;
    var chartH = H - padT - padB;
    var barW = Math.floor(chartW / data.length * 0.7);
    var gap  = Math.floor(chartW / data.length * 0.3);

    // Y axis labels
    for (var y = 0; y <= 4; y++) {
      var val = Math.round(max * y / 4);
      var yPos = padT + chartH - Math.round(chartH * y / 4);
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
      line.setAttribute('y1', yPos); line.setAttribute('y2', yPos);
      line.setAttribute('stroke', '#3f4147'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
      var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', padL - 4); txt.setAttribute('y', yPos + 4);
      txt.setAttribute('class', 'axis-label'); txt.setAttribute('text-anchor', 'end');
      txt.textContent = val;
      svg.appendChild(txt);
    }

    data.forEach(function(d, i) {
      var slotW = chartW / data.length;
      var x = padL + i * slotW + (slotW - barW) / 2;
      var barH = max ? Math.round(chartH * d.count / max) : 0;
      var y = padT + chartH - barH;

      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'bar');
      rect.setAttribute('x', x); rect.setAttribute('y', barH ? y : padT + chartH - 1);
      rect.setAttribute('width', barW); rect.setAttribute('height', barH || 1);
      rect.setAttribute('rx', '2');
      if (d.date === new Date().toISOString().slice(0,10)) rect.setAttribute('fill', '#faa61a');
      var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = d.date + ': ' + d.count + ' profits';
      rect.appendChild(title);
      svg.appendChild(rect);

      if (d.count > 0) {
        var vt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        vt.setAttribute('class', 'value-label');
        vt.setAttribute('x', x + barW / 2); vt.setAttribute('y', y - 4);
        vt.textContent = d.count;
        svg.appendChild(vt);
      }

      // X label (MM-DD)
      var lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('class', 'axis-label');
      lbl.setAttribute('x', x + barW / 2); lbl.setAttribute('y', H - 4);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.textContent = d.date.slice(5);
      if (data.length > 14 && i % 2 !== 0) lbl.setAttribute('display', 'none');
      svg.appendChild(lbl);
    });
  }

  function loadData(days) {
    fetch('/api/profits-history?days=' + days)
      .then(function(r){ return r.json(); })
      .then(function(data) {
        renderChart(data);
        var today = new Date().toISOString().slice(0,10);
        var todayEntry = data.find(function(d){ return d.date === today; });
        var total = data.reduce(function(s,d){ return s + d.count; }, 0);
        var avg = data.length ? (total / days).toFixed(1) : '0';
        var best = data.length ? Math.max.apply(null, data.map(function(d){ return d.count; })) : 0;
        document.getElementById('stat-today').textContent = todayEntry ? todayEntry.count : 0;
        document.getElementById('stat-total').textContent = total;
        document.getElementById('stat-avg').textContent = avg;
        document.getElementById('stat-best').textContent = best;
      })
      .catch(function(){ });
  }

  document.getElementById('btn-7d').addEventListener('click', function(){
    currentDays = 7;
    document.querySelectorAll('.btn-period').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-days')==='7'); });
    loadData(7);
  });
  document.getElementById('btn-30d').addEventListener('click', function(){
    currentDays = 30;
    document.querySelectorAll('.btn-period').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-days')==='30'); });
    loadData(30);
  });

  // Bouton +1
  document.getElementById('btn-add-profit').addEventListener('click', function(){
    var btn = this;
    btn.disabled = true;
    fetch('/api/add-profit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function(r){ return r.json(); })
      .then(function(data){
        showMsg('Profit #' + data.count + ' enregistre !', '#3ba55d');
        loadData(currentDays);
        btn.disabled = false;
      })
      .catch(function(){ btn.disabled = false; });
  });

  // Bouton Modifier (set count)
  document.getElementById('btn-set-count').addEventListener('click', function(){
    var input = document.getElementById('input-set-count');
    var val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) { showMsg('Valeur invalide', '#ed4245'); return; }
    var btn = this;
    btn.disabled = true;
    fetch('/api/set-profit-count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: val }) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        showMsg('Compteur mis à jour : ' + data.count, '#3ba55d');
        input.value = '';
        loadData(currentDays);
        btn.disabled = false;
      })
      .catch(function(){ btn.disabled = false; });
  });

  function showMsg(text, color) {
    var msg = document.getElementById('add-msg');
    msg.textContent = text;
    msg.style.color = color || '#3ba55d';
    msg.style.display = '';
    setTimeout(function(){ msg.style.display = 'none'; }, 4000);
  }

  // Toggle bot silent
  var silentToggle = document.getElementById('toggle-silent');
  var silentThumb  = document.getElementById('toggle-thumb');
  var silentLabel  = document.getElementById('silent-label');
  var isSilent = false;

  function applySilentUI(silent) {
    isSilent = silent;
    silentToggle.style.background = silent ? '#ed4245' : '#3ba55d';
    silentThumb.style.left = silent ? '23px' : '3px';
    silentLabel.textContent = silent ? 'Désactivés' : 'Activés';
    silentLabel.style.color = silent ? '#ed4245' : '#3ba55d';
  }

  fetch('/api/profits-bot-silent')
    .then(function(r){ return r.json(); })
    .then(function(d){ applySilentUI(d.silent); })
    .catch(function(){});

  silentToggle.addEventListener('click', function(){
    var newVal = !isSilent;
    fetch('/api/profits-bot-silent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ silent: newVal }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ applySilentUI(d.silent); })
      .catch(function(){});
  });

  loadData(7);
})();
</script>
</div>
</body>
</html>`;

app.get('/profits', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(PROFITS_PAGE_HTML);
});

// ─────────────────────────────────────────────────────────────────────
//  News Dashboard: /news + /api/recent-news + /api/news-events (SSE)
// ─────────────────────────────────────────────────────────────────────
app.get('/api/recent-news', requireAuth, (req, res) => {
  res.json(recentNews);
});

app.get('/api/news-events', requireAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const client = { res };
  newsSSEClients.push(client);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    const idx = newsSSEClients.indexOf(client);
    if (idx >= 0) newsSSEClients.splice(idx, 1);
  });
});

const NEWS_PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM News</title>
<style>
  ${COMMON_CSS}
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #ed4245; margin-left: auto; }
  #dot.ok { background: #3ba55d; }
  #lbl { font-size: 11px; color: #80848e; }
  #wrap { padding: 24px; max-width: 800px; }
  .news-card {
    background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px;
    padding: 10px 14px; margin-bottom: 10px; transition: background .2s;
    animation: fadeIn .4s ease;
  }
  .news-card:hover { background: #32353b; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
  .news-emoji { font-size: 18px; margin-right: 8px; }
  .news-title { font-weight: 600; color: #fff; font-size: 14px; }
  .news-meta { display: flex; gap: 10px; margin-top: 6px; font-size: 11px; color: #80848e; }
  .news-source { background: #1e1f22; padding: 1px 8px; border-radius: 3px; font-weight: 600; }
  .news-empty { text-align: center; padding: 60px; color: #80848e; }
  .count-badge { font-size: 11px; color: #80848e; margin-left: 8px; }
</style>
</head>
<body>
${sidebarHTML('/news')}
<div class="page-content">
<div class="page-header">
  <h1 class="page-title">News</h1>
  <span id="dot"></span>
  <span id="lbl">Connecting...</span>
</div>
<div id="wrap">
  <h2 style="color:#fff;font-size:15px;margin-bottom:16px;">&#x1F4F0; Live News Feed <span class="count-badge" id="count-badge"></span></h2>
  <div id="news-list"><div class="news-empty">Chargement...</div></div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTime(ts){
    if(!ts) return '';
    var d=new Date(ts);
    return d.toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'}) + ' — ' + d.toLocaleDateString('fr-CA');
  }
  function renderCard(n){
    return '<div class="news-card">'
      + '<span class="news-emoji">' + esc(n.emoji) + '</span>'
      + '<span class="news-title">' + esc(n.title) + '</span>'
      + '<div class="news-meta">'
      + '<span class="news-source">' + esc(n.source) + '</span>'
      + '<span>' + fmtTime(n.ts) + '</span>'
      + '</div></div>';
  }
  var list = document.getElementById('news-list');
  var badge = document.getElementById('count-badge');
  var allNews = [];

  function renderAll(){
    if(!allNews.length){ list.innerHTML='<div class="news-empty">Aucune actualite pour le moment</div>'; badge.textContent=''; return; }
    badge.textContent = '(' + allNews.length + ')';
    list.innerHTML = allNews.map(renderCard).join('');
  }

  fetch('/api/recent-news').then(function(r){return r.json();}).then(function(data){
    allNews = data || [];
    renderAll();
  });

  var es = new EventSource('/api/news-events');
  es.onopen = function(){ document.getElementById('dot').className='ok'; document.getElementById('lbl').textContent='Live'; };
  es.onerror = function(){ document.getElementById('dot').className=''; document.getElementById('lbl').textContent='Reconnecting...'; };
  es.onmessage = function(e){
    try {
      var n = JSON.parse(e.data);
      allNews.unshift(n);
      if(allNews.length > 50) allNews.pop();
      renderAll();
    } catch(_){}
  };
})();
</script>
</div>
</body>
</html>`;

app.get('/news', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(NEWS_PAGE_HTML);
});

// ─────────────────────────────────────────────────────────────────────
//  Analyst Performance API: /api/analyst-performance?days=30
// ─────────────────────────────────────────────────────────────────────
app.get('/api/analyst-performance', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  const dateLabels = [];
  const authorDayMap = {}; // { author: { 'YYYY-MM-DD': count } }

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    dateLabels.push(dateKey);
    const msgs = i === 0
      ? messageLog.filter(function(m) { return m.ts && m.ts.slice(0, 10) === dateKey; })
      : loadDailyFile(dateKey);
    msgs.forEach(function(m) {
      if (!m.passed || !m.author) return;
      if (!authorDayMap[m.author]) authorDayMap[m.author] = {};
      authorDayMap[m.author][dateKey] = (authorDayMap[m.author][dateKey] || 0) + 1;
    });
  }

  // Top 5 by total signals
  const totals = Object.keys(authorDayMap).map(function(a) {
    let total = 0;
    Object.values(authorDayMap[a]).forEach(function(v) { total += v; });
    return { author: a, total };
  }).sort(function(a, b) { return b.total - a.total; }).slice(0, 5);

  const colors = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#D649CC'];
  const datasets = totals.map(function(t, i) {
    return {
      author: t.author,
      color: colors[i % colors.length],
      data: dateLabels.map(function(d) { return (authorDayMap[t.author] || {})[d] || 0; }),
    };
  });

  res.json({ labels: dateLabels, datasets });
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 3: GET /leaderboard — 30-day leaderboard
// ─────────────────────────────────────────────────────────────────────
const LEADERBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Leaderboard</title>
<style>
  ${COMMON_CSS}
  body { overflow-x: hidden; }
  #wrap { padding: 24px; transition: margin-right .3s; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 10px 10px; border-bottom: 1px solid #3f4147; }
  tbody tr { border-bottom: 1px solid #2b2d31; transition: background .15s; cursor: pointer; }
  tbody tr:hover { background: #32353b; }
  tbody tr.active-row { background: #2a1e3f; border-left: 3px solid #D649CC; }
  td { padding: 10px 10px; vertical-align: middle; }
  .rank { font-size: 18px; font-weight: 800; color: #80848e; width: 40px; }
  .rank-1 { color: #ffd700; }
  .rank-2 { color: #c0c0c0; }
  .rank-3 { color: #cd7f32; }
  .author-name { font-weight: 700; color: #D649CC; font-size: 14px; }
  .author-name span { border-bottom: 1px dashed #D649CC55; }
  .signals-count { font-weight: 700; color: #3ba55d; font-size: 16px; }
  .ticker-badge { display: inline-block; background: #2a2e3d; border: 1px solid #5865f244; color: #5865f2; border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
  .bar-wrap { width: 120px; height: 8px; background: #3f4147; border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 6px; }
  .bar-fill { height: 100%; border-radius: 4px; background: #3ba55d; }
  .period-note { font-size: 12px; color: #80848e; margin-bottom: 16px; }

  /* ── Side panel ── */
  #side-panel {
    position: fixed; top: 0; right: -480px; width: 460px; height: 100vh;
    background: #2b2d31; border-left: 1px solid #3f4147;
    display: flex; flex-direction: column;
    transition: right .3s ease; z-index: 100; overflow: hidden;
  }
  #side-panel.open { right: 0; }
  #panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid #3f4147; flex-shrink: 0;
  }
  #panel-author { font-weight: 700; font-size: 16px; color: #D649CC; }
  #panel-count { font-size: 12px; color: #80848e; margin-top: 2px; }
  #panel-close {
    background: none; border: none; color: #80848e; font-size: 20px; cursor: pointer;
    padding: 4px 8px; border-radius: 4px; line-height: 1;
  }
  #panel-close:hover { background: #3f4147; color: #dcddde; }
  #panel-body { overflow-y: auto; flex: 1; padding: 12px 16px; }
  .signal-card {
    background: #1e1f22; border: 1px solid #3f4147; border-radius: 6px;
    padding: 12px 14px; margin-bottom: 10px;
  }
  .signal-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .signal-date { font-size: 11px; color: #80848e; }
  .signal-channel { font-size: 11px; color: #80848e; background: #2b2d31; padding: 1px 6px; border-radius: 3px; }
  .signal-ticker { display: inline-block; background: #2a2e3d; border: 1px solid #5865f244; color: #5865f2; border-radius: 4px; padding: 1px 7px; font-size: 12px; font-weight: 700; }
  .signal-prices { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .price-pill { font-size: 12px; padding: 2px 10px; border-radius: 12px; font-weight: 600; }
  .price-entry { background: #1a3a2a; color: #3ba55d; border: 1px solid #3ba55d44; }
  .price-target { background: #1a2a3a; color: #5865f2; border: 1px solid #5865f244; }
  .price-stop { background: #3a1e1e; color: #ed4245; border: 1px solid #ed424544; }
  .signal-content { font-size: 12px; color: #b5bac1; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  #panel-loading { text-align: center; padding: 40px; color: #80848e; font-size: 13px; }
  #panel-empty { text-align: center; padding: 40px; color: #80848e; font-size: 13px; }
  #overlay { display: none; position: fixed; inset: 0; background: #00000066; z-index: 99; }
  #overlay.show { display: block; }
</style>
</head>
<body>
${sidebarHTML('/leaderboard')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Leaderboard</h1></div>

<div id="overlay"></div>

<!-- Side panel -->
<div id="side-panel">
  <div id="panel-header">
    <div>
      <div id="panel-author">—</div>
      <div id="panel-count"></div>
    </div>
    <button id="panel-close">&#x2715;</button>
  </div>
  <div id="panel-body">
    <div id="panel-loading">Chargement...</div>
  </div>
</div>

<div id="wrap">
  <div class="card">
    <div class="card-title">&#x1F3C6; Leaderboard — 30 derniers jours</div>
    <div class="period-note" id="period-note">Chargement...</div>
    <div id="leaderboard-wrap"><span style="color:#80848e;font-size:12px;">Chargement...</span></div>
  </div>
</div>
<script>
(function(){
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString('fr-CA') + ' ' + d.toLocaleTimeString('fr-CA', {hour:'2-digit',minute:'2-digit'});
  }

  var currentDays = 30;
  var activeAuthor = null;

  // ── Panel logic ──
  var panel = document.getElementById('side-panel');
  var overlay = document.getElementById('overlay');
  var panelBody = document.getElementById('panel-body');
  var panelAuthor = document.getElementById('panel-author');
  var panelCount = document.getElementById('panel-count');

  function closePanel() {
    panel.classList.remove('open');
    overlay.classList.remove('show');
    document.querySelectorAll('tbody tr.active-row').forEach(function(r){ r.classList.remove('active-row'); });
    activeAuthor = null;
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);
  overlay.addEventListener('click', closePanel);

  function openPanel(author, days) {
    activeAuthor = author;
    panelAuthor.textContent = author;
    panelCount.textContent = '';
    panelBody.innerHTML = '<div id="panel-loading">Chargement des alertes...</div>';
    panel.classList.add('open');
    overlay.classList.add('show');

    fetch('/api/leaderboard/analyst?author=' + encodeURIComponent(author) + '&days=' + days)
      .then(function(r){ return r.json(); })
      .then(function(data) {
        var signals = data.signals || [];
        panelCount.textContent = signals.length + ' alerte' + (signals.length !== 1 ? 's' : '');
        if (!signals.length) {
          panelBody.innerHTML = '<div id="panel-empty">Aucune alerte trouvee</div>';
          return;
        }
        var html = '';
        signals.forEach(function(s) {
          var prices = '';
          if (s.entry_price !== null && s.entry_price !== undefined)
            prices += '<span class="price-pill price-entry">Entree ' + s.entry_price + '</span>';
          if (s.target_price !== null && s.target_price !== undefined)
            prices += '<span class="price-pill price-target">Cible ' + s.target_price + '</span>';
          if (s.stop_price !== null && s.stop_price !== undefined)
            prices += '<span class="price-pill price-stop">Stop ' + s.stop_price + '</span>';
          html += '<div class="signal-card">'
            + '<div class="signal-meta">'
            + '<span class="signal-ticker">$' + esc(s.ticker) + '</span>'
            + '<span class="signal-date">' + fmtDate(s.ts) + '</span>'
            + (s.channel ? '<span class="signal-channel">#' + esc(s.channel) + '</span>' : '')
            + '</div>'
            + (prices ? '<div class="signal-prices">' + prices + '</div>' : '')
            + '<div class="signal-content">' + esc(s.content) + '</div>'
            + '</div>';
        });
        panelBody.innerHTML = html;
      })
      .catch(function() {
        panelBody.innerHTML = '<div id="panel-empty" style="color:#ed4245;">Erreur de chargement</div>';
      });
  }

  // ── Leaderboard table ──
  fetch('/api/leaderboard?days=30')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var wrap = document.getElementById('leaderboard-wrap');
      var note = document.getElementById('period-note');
      note.textContent = data.period || '30 derniers jours';
      currentDays = 30;
      if (!data.rows || !data.rows.length) {
        wrap.innerHTML = '<span style="color:#80848e;font-size:12px;">Aucune donnee sur cette periode</span>';
        return;
      }
      var maxSig = data.rows[0] ? data.rows[0].signals : 1;
      var html = '<table><thead><tr><th>#</th><th>Analyste</th><th>Signaux</th><th>Ticker favori</th><th>Progression</th></tr></thead><tbody>';
      data.rows.forEach(function(row, i) {
        var rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
        var medal = i === 0 ? '&#x1F947;' : i === 1 ? '&#x1F948;' : i === 2 ? '&#x1F949;' : (i+1);
        var pct = maxSig ? Math.round(row.signals / maxSig * 100) : 0;
        html += '<tr data-author="' + esc(row.author) + '">'
          + '<td class="rank ' + rankCls + '">' + medal + '</td>'
          + '<td class="author-name"><span>' + esc(row.author) + '</span></td>'
          + '<td class="signals-count">' + row.signals + '</td>'
          + '<td>' + (row.topTicker ? '<span class="ticker-badge">$' + esc(row.topTicker) + '</span>' : '—') + '</td>'
          + '<td><span class="bar-wrap"><span class="bar-fill" style="width:' + pct + '%;"></span></span>' + pct + '%</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
      wrap.innerHTML = html;

      // Attach click handlers
      wrap.querySelectorAll('tbody tr').forEach(function(tr) {
        tr.addEventListener('click', function() {
          var author = tr.getAttribute('data-author');
          if (!author) return;
          wrap.querySelectorAll('tbody tr').forEach(function(r){ r.classList.remove('active-row'); });
          tr.classList.add('active-row');
          openPanel(author, currentDays);
        });
      });
    })
    .catch(function() {
      document.getElementById('leaderboard-wrap').innerHTML = '<span style="color:#ed4245;font-size:12px;">Erreur de chargement</span>';
    });
})();
</script>
</div>
</body>
</html>`;

app.get('/leaderboard', requireAuth, (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(LEADERBOARD_HTML);
});

app.get('/api/leaderboard', requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  const authorStats = {};
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    // Try daily file first
    const dailyMsgs = loadDailyFile(dateKey);
    // Also look at in-memory messageLog for today
    const msgs = i === 0
      ? messageLog.filter(function(m) { return m.ts && m.ts.slice(0, 10) === dateKey; })
      : dailyMsgs;
    msgs.forEach(function(m) {
      if (!m.passed || !m.author) return;
      if (!m.ticker) return;
      const prices = extractPrices(m.content || '');
      if (prices.entry_price === null || prices.target_price === null) return;
      if (!authorStats[m.author]) authorStats[m.author] = { signals: 0, tickers: {} };
      authorStats[m.author].signals++;
      authorStats[m.author].tickers[m.ticker] = (authorStats[m.author].tickers[m.ticker] || 0) + 1;
    });
  }
  const rows = Object.keys(authorStats).map(function(author) {
    const s = authorStats[author];
    let topTicker = null, topCount = 0;
    Object.keys(s.tickers).forEach(function(t) {
      if (s.tickers[t] > topCount) { topCount = s.tickers[t]; topTicker = t; }
    });
    return { author, signals: s.signals, topTicker };
  }).sort(function(a, b) { return b.signals - a.signals; });

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days + 1);
  const period = fromDate.toISOString().slice(0, 10) + ' → ' + new Date().toISOString().slice(0, 10);
  res.json({ rows, period });
});

// GET /api/leaderboard/analyst?author=AR&days=30
// Returns the full list of valid signals for a specific author
app.get('/api/leaderboard/analyst', requireAuth, (req, res) => {
  const author = (req.query.author || '').trim();
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  if (!author) return res.json({ signals: [] });

  const signals = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const msgs = i === 0
      ? messageLog.filter(function(m) { return m.ts && m.ts.slice(0, 10) === dateKey; })
      : loadDailyFile(dateKey);
    msgs.forEach(function(m) {
      if (!m.passed || !m.author || m.author !== author) return;
      if (!m.ticker) return;
      const prices = extractPrices(m.content || '');
      if (prices.entry_price === null || prices.target_price === null) return;
      signals.push({
        ts: m.ts,
        ticker: m.ticker,
        content: m.content || '',
        channel: m.channel || '',
        entry_price: prices.entry_price,
        target_price: prices.target_price,
        stop_price: prices.stop_price || null,
      });
    });
  }
  // Newest first
  signals.sort(function(a, b) { return (b.ts || '') < (a.ts || '') ? -1 : 1; });
  res.json({ author, signals });
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 7: GET /config — read-only config display page
// ─────────────────────────────────────────────────────────────────────
app.get('/config', requireAuth, (req, res) => {
  // Reload overrides fresh
  const overrides = loadConfigOverrides();
  const aliases = Object.assign({}, AUTHOR_ALIASES_DEFAULT, overrides.authorAliases || {});
  const channelOverrides = overrides.allowedChannels || [];
  const safeFilters = {
    blocked: customFilters.blocked || [],
    allowed: customFilters.allowed || [],
    blockedAuthors: customFilters.blockedAuthors || [],
    allowedAuthors: customFilters.allowedAuthors || [],
    allowedChannels: customFilters.allowedChannels || [],
  };

  const configPageHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BOOM Config</title>
<style>
  ${COMMON_CSS}
  #wrap { padding: 24px; display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
  .card { background: #2b2d31; border: 1px solid #3f4147; border-radius: 8px; padding: 20px; }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #80848e; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #80848e; padding: 0 8px 8px; border-bottom: 1px solid #3f4147; }
  tbody tr { border-bottom: 1px solid #2b2d31; }
  tbody tr:hover { background: #32353b; }
  td { padding: 7px 8px; font-size: 13px; vertical-align: middle; }
  .alias-key { font-weight: 700; color: #D649CC; }
  .alias-val { color: #dcddde; }
  .tag { display: inline-block; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 2px 8px; font-size: 12px; margin: 3px; }
  .tag-blocked { border-color: #ed424544; color: #ed4245; background: #3a1e1e; }
  .tag-allowed { border-color: #3ba55d44; color: #3ba55d; background: #1e3a2f; }
  .tag-author  { border-color: #D649CC44; color: #D649CC; background: #2a1e2e; }
  .tag-channel { border-color: #5865f244; color: #5865f2; background: #2a2e3d; }
  .env-row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .env-key { font-size: 12px; color: #80848e; width: 220px; flex-shrink: 0; }
  .env-val { font-size: 12px; color: #dcddde; background: #1e1f22; border: 1px solid #3f4147; border-radius: 4px; padding: 4px 10px; flex: 1; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { font-size: 12px; color: #80848e; margin-top: 8px; font-style: italic; }
</style>
</head>
<body>
${sidebarHTML('/config')}
<div class="page-content">
<div class="page-header"><h1 class="page-title">Config</h1></div>
<div id="wrap">
  <div class="card">
    <div class="card-title">Variables d'environnement</div>
    <div class="env-row"><span class="env-key">TRADING_CHANNEL</span><span class="env-val">${String(process.env.TRADING_CHANNEL || 'trading-floor (defaut)')}</span></div>
    <div class="env-row"><span class="env-key">PROFITS_CHANNEL_ID</span><span class="env-val">${process.env.PROFITS_CHANNEL_ID ? '*** (defini)' : '— (non defini)'}</span></div>
    <div class="env-row"><span class="env-key">DASHBOARD_PASSWORD</span><span class="env-val">*** (masque)</span></div>
    <div class="env-row"><span class="env-key">MAKE_WEBHOOK_URL</span><span class="env-val">${process.env.MAKE_WEBHOOK_URL ? '*** (defini)' : '— (non defini)'}</span></div>
    <div class="env-row"><span class="env-key">RAILWAY_PUBLIC_DOMAIN</span><span class="env-val">${String(process.env.RAILWAY_PUBLIC_DOMAIN || '— (local)')}</span></div>
    <div class="note">Les variables d'environnement sont definies dans Railway ou le fichier .env local.</div>
  </div>

  <div class="card">
    <div class="card-title">Aliases auteurs (AUTHOR_ALIASES)</div>
    ${Object.keys(aliases).length === 0
      ? '<span style="color:#80848e;font-size:12px;font-style:italic">Aucun alias configure — editer config-overrides.json pour en ajouter.</span>'
      : '<table><thead><tr><th>Username Discord</th><th>Nom affiche</th></tr></thead><tbody>'
        + Object.keys(aliases).map(function(k) {
            return '<tr><td class="alias-key">' + k.replace(/</g,'&lt;') + '</td><td class="alias-val">' + String(aliases[k]).replace(/</g,'&lt;') + '</td></tr>';
          }).join('')
        + '</tbody></table>'
    }
    <div class="note">Editer <code>config-overrides.json</code> dans DATA_DIR pour modifier les aliases.</div>
  </div>

  <div class="card">
    <div class="card-title">Filtres actifs (customFilters)</div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#80848e;margin-bottom:6px;">Phrases bloqu&#233;es (${safeFilters.blocked.length})</div>
      ${safeFilters.blocked.length ? safeFilters.blocked.map(function(p){ return '<span class="tag tag-blocked">' + p.replace(/</g,'&lt;').substring(0,60) + '</span>'; }).join('') : '<span style="color:#80848e;font-size:12px;font-style:italic">Aucune</span>'}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#80848e;margin-bottom:6px;">Phrases autoris&#233;es (${safeFilters.allowed.length})</div>
      ${safeFilters.allowed.length ? safeFilters.allowed.map(function(p){ return '<span class="tag tag-allowed">' + p.replace(/</g,'&lt;').substring(0,60) + '</span>'; }).join('') : '<span style="color:#80848e;font-size:12px;font-style:italic">Aucune</span>'}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#80848e;margin-bottom:6px;">Auteurs bloqu&#233;s (${safeFilters.blockedAuthors.length})</div>
      ${safeFilters.blockedAuthors.length ? safeFilters.blockedAuthors.map(function(a){ return '<span class="tag tag-blocked">' + a.replace(/</g,'&lt;') + '</span>'; }).join('') : '<span style="color:#80848e;font-size:12px;font-style:italic">Aucun</span>'}
    </div>
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#80848e;margin-bottom:6px;">Auteurs autoris&#233;s (${safeFilters.allowedAuthors.length})</div>
      ${safeFilters.allowedAuthors.length ? safeFilters.allowedAuthors.map(function(a){ return '<span class="tag tag-allowed">' + a.replace(/</g,'&lt;') + '</span>'; }).join('') : '<span style="color:#80848e;font-size:12px;font-style:italic">Aucun</span>'}
    </div>
    <div class="note">Modifier les filtres depuis le Dashboard (boutons ✕ ❌ ✅ sur chaque message).</div>
  </div>

  <div class="card">
    <div class="card-title">Canaux de trading autoris&#233;s</div>
    <span class="tag tag-channel">${String(process.env.TRADING_CHANNEL || 'trading-floor')}</span>
    ${channelOverrides.map(function(c){ return '<span class="tag tag-channel">' + c.replace(/</g,'&lt;') + '</span>'; }).join('')}
    <div class="note">Canal principal defini par TRADING_CHANNEL. Canaux additionnels via config-overrides.json.</div>
  </div>
</div>
</div>
</body>
</html>`;
  res.set('Content-Type', 'text/html');
  res.send(configPageHtml);
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 8: GET /promo-image/latest — serve last promo image
// ─────────────────────────────────────────────────────────────────────
app.get('/promo-image/latest', (req, res) => {
  if (!lastPromoImageBuffer) return res.status(404).json({ error: 'No promo image available' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-cache');
  res.send(lastPromoImageBuffer);
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));

async function generateImage(author, content, timestamp, parentAuthor, parentContent) {
  // Normalise vers le nom affiché (ex: "traderzz1m" → "Z")
  author = getDisplayName(author);
  if (parentAuthor) parentAuthor = getDisplayName(parentAuthor);
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

  // Username — dégradé pour tous sauf Legacy Trading (rouge)
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 16px ' + FONT;
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

  // tag_boom.png
  const TAG_H = 18;
  const badgeX = CONTENT_X + nameW + 6;
  const badgeY = nameY - TAG_H + 2;
  let BADGE_W = 0;
  try {
    const tagImg = await loadImage(path.join(__dirname, 'avatar', 'tag_boom.png'));
    // Conserver le ratio de l'image
    const tagRatio = tagImg.width / tagImg.height;
    BADGE_W = Math.round(TAG_H * tagRatio);
    ctx.drawImage(tagImg, badgeX, badgeY, BADGE_W, TAG_H);
  } catch(e) {
    // Fallback texte si image manquante
    ctx.font = 'bold 10px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOOM', badgeX, badgeY + TAG_H / 2);
    ctx.textBaseline = 'alphabetic';
    BADGE_W = 50;
  }

  // Logo BOOM circulaire entre le badge et l'heure
  const LOGO_SIZE = 18;
  const logoX = badgeX + BADGE_W + 6;
  const logoCY = badgeY + TAG_H / 2;
  let logoEndX = logoX;
  try {
    const logoImg = await loadImage(path.join(__dirname, 'logo_boom.png'));
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + LOGO_SIZE / 2, logoCY, LOGO_SIZE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(logoImg, logoX, logoCY - LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.restore();
    logoEndX = logoX + LOGO_SIZE + 6;
  } catch(e) {
    logoEndX = logoX;
  }

  // Time — fuseau EST/EDT (America/New_York)
  const d = timestamp ? new Date(timestamp) : new Date();
  const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  ctx.fillStyle = CONFIG.TIME_COLOR;
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, logoEndX, nameY - 1);

  // (gain% in X post text, not in image)

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
//  generateProofImage — composite: original alert + recap proof
// ─────────────────────────────────────────────────────────────────────
async function drawMessageBlock(ctx, author, content, timestamp, yStart, W, label, labelColor) {
  const PADDING_V = 14;
  const PADDING_L = 16;
  const AVATAR_D = 40;
  const AVATAR_X = PADDING_L;
  const CONTENT_X = PADDING_L + AVATAR_D + 16;
  const MAX_TW = W - CONTENT_X - PADDING_L;
  const LINE_H = 22;
  const NAME_H = 20;
  const FONT = 'gg sans, Segoe UI, Arial, sans-serif';

  // Label badge (ORIGINAL ALERT or RESULT)
  const labelH = 22;
  ctx.fillStyle = labelColor + '22';
  const labelW = ctx.measureText(label).width + 24;
  ctx.beginPath();
  ctx.roundRect(PADDING_L, yStart + 4, labelW, labelH, 4);
  ctx.fill();
  ctx.fillStyle = labelColor;
  ctx.font = 'bold 11px ' + FONT;
  ctx.textAlign = 'left';
  ctx.fillText(label, PADDING_L + 12, yStart + 4 + labelH / 2 + 4);

  const blockY = yStart + labelH + 10;

  // Avatar
  const avatarCX = AVATAR_X + AVATAR_D / 2;
  const avatarCY = blockY + PADDING_V + NAME_H / 2 + 2;
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

  const nameY = blockY + PADDING_V + NAME_H - 3;
  ctx.font = 'bold 16px ' + FONT;
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

  // Time
  const d = timestamp ? new Date(timestamp) : new Date();
  const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  ctx.fillStyle = '#72767d';
  ctx.font = '12px ' + FONT;
  ctx.fillText(timeStr, CONTENT_X + nameW + 10, nameY - 1);

  // Content
  const tmpC = createCanvas(W, 400);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px ' + FONT;
  const lines = wrapText(tmpCtx, content, MAX_TW);
  ctx.fillStyle = '#dcddde';
  ctx.font = '16px ' + FONT;
  let ty = nameY + LINE_H;
  for (const line of lines) {
    ctx.fillText(line, CONTENT_X, ty);
    ty += LINE_H;
  }

  const blockHeight = labelH + 10 + PADDING_V + NAME_H + lines.length * LINE_H + PADDING_V;
  return blockHeight;
}

async function generateProofImage(alertAuthor, alertContent, alertTimestamp, recapAuthor, recapContent, recapTimestamp) {
  alertAuthor = getDisplayName(alertAuthor);
  recapAuthor = getDisplayName(recapAuthor);

  const W = 740;
  const FONT = 'gg sans, Segoe UI, Arial, sans-serif';

  // Measure heights
  const tmpC = createCanvas(W, 1000);
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.font = '16px ' + FONT;
  const CONTENT_X = 16 + 40 + 16;
  const MAX_TW = W - CONTENT_X - 16;
  const LINE_H = 22;
  const LABEL_H = 32;
  const PADDING_V = 14;
  const NAME_H = 20;

  const alertLines = wrapText(tmpCtx, alertContent, MAX_TW);
  const recapLines = wrapText(tmpCtx, recapContent, MAX_TW);

  const blockH = (lines) => LABEL_H + PADDING_V + NAME_H + lines.length * LINE_H + PADDING_V;
  const alertH = blockH(alertLines);
  const recapH = blockH(recapLines);
  const DIVIDER_H = 44;
  const HEADER_H = 52;
  const FOOTER_H = 50;

  const H = HEADER_H + alertH + DIVIDER_H + recapH + FOOTER_H;
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
  ctx.fillText('Trade Proof  •  discord.gg/templeofboom', 52 + ctx.measureText('BOOM').width + 14, HEADER_H / 2);
  ctx.textBaseline = 'alphabetic';

  // Alert block
  let y = HEADER_H + 8;
  await drawMessageBlock(ctx, alertAuthor, alertContent, alertTimestamp, y, W, '📣  ORIGINAL ALERT', '#3ba55d');

  // Divider with arrow
  y += alertH;
  ctx.strokeStyle = '#3f4147';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(40, y + DIVIDER_H / 2);
  ctx.lineTo(W - 40, y + DIVIDER_H / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#3ba55d';
  ctx.font = 'bold 22px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('↓', W / 2, y + DIVIDER_H / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Recap block
  y += DIVIDER_H;
  await drawMessageBlock(ctx, recapAuthor, recapContent, recapTimestamp, y, W, '✅  RESULT', '#faa61a');

  // Footer
  y = H - FOOTER_H;
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, y, W, FOOTER_H);
  ctx.fillStyle = '#4f545c';
  ctx.font = '13px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('discord.gg/templeofboom', W / 2, y + FOOTER_H / 2);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────
//  Feature 8: generatePromoImage — 1080x1080 square for X/Instagram
// ─────────────────────────────────────────────────────────────────────
async function generatePromoImage(ticker, gainPct, entryPrice, targetPrice) {
  const W = 1080, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // Subtle gradient overlay (top stripe)
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#2a1e3a');
  grad.addColorStop(0.5, '#1a2a3a');
  grad.addColorStop(1, '#1a3a2a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 180);

  // Top left: BOOM branding
  ctx.fillStyle = '#D649CC';
  ctx.font = 'bold 28px ' + FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('🔥 BOOM', 60, 50);

  // Try to draw logo
  try {
    const logoImg = await loadImage(path.join(__dirname, 'logo_boom.png'));
    ctx.save();
    ctx.beginPath();
    ctx.arc(60 + 20, 50 + 20 + 40, 22, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logoImg, 60, 110, 44, 44);
    ctx.restore();
  } catch(e) {}

  // Ticker — centered, large gradient text
  const tickerDisplay = ticker ? '$' + ticker.toUpperCase() : '$???';
  const tickerGrad = ctx.createLinearGradient(W / 2 - 200, 0, W / 2 + 200, 0);
  tickerGrad.addColorStop(0, '#D649CC');
  tickerGrad.addColorStop(1, '#5865f2');
  ctx.font = 'bold 160px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = tickerGrad;
  ctx.fillText(tickerDisplay, W / 2, 350);

  // Gain percentage — large green
  const gainStr = gainPct != null
    ? (gainPct >= 0 ? '+' : '') + gainPct.toFixed(0) + '%'
    : '';
  if (gainStr) {
    ctx.font = 'bold 200px ' + FONT;
    ctx.fillStyle = gainPct >= 0 ? '#3ba55d' : '#ed4245';
    ctx.textAlign = 'center';
    ctx.fillText(gainStr, W / 2, 580);
  }

  // Entry → Target prices
  if (entryPrice != null && targetPrice != null) {
    ctx.font = '48px ' + FONT;
    ctx.fillStyle = '#b5bac1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const priceStr = '$' + entryPrice + '  →  $' + targetPrice;
    ctx.fillText(priceStr, W / 2, 760);
  }

  // Separator line
  ctx.strokeStyle = '#3f4147';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 860);
  ctx.lineTo(W - 80, 860);
  ctx.stroke();

  // Bottom: discord.gg link
  ctx.font = '32px ' + FONT;
  ctx.fillStyle = '#80848e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('discord.gg/templeofboom', W / 2, 960);

  // Bottom right: date
  ctx.font = '22px ' + FONT;
  ctx.fillStyle = '#3f4147';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(new Date().toISOString().slice(0, 10), W - 60, H - 40);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────────────
// extractPrices — Detecte prix entree, sortie et stop dans un message
// Reconnait: 0.64, $0.63, 9.86-11, 9.86-11.50, 150.00-155.00
// ─────────────────────────────────────────────────────────────────────
function extractPrices(content) {
  if (!content) return { entry_price: null, target_price: null, stop_price: null, exit_price: null, gain_pct: null };
  const c = content.replace(/,/g, '.');
  let entry = null;
  let target = null;
  let stop = null;

  // Priorite 1: TICKER PRIX-PRIX (ex: $TSLA 150.00-155.00 ou NCT 2.60-4.06)
  const rangeM = c.match(/(?:\$?[A-Z]{1,6}\s+)\$?(\d+(?:\.\d+)?)\s*[-\u2013]\s*\$?(\d+(?:\.\d+)?)/i);
  if (rangeM) {
    const a = parseFloat(rangeM[1]), b = parseFloat(rangeM[2]);
    entry  = Math.min(a, b);
    target = Math.max(a, b);
  }

  // Priorite 1b: prix seul range sans ticker (ex dans une reponse: "3.43-4.32")
  if (!entry) {
    const standaloneRange = c.match(/^\s*\$?(\d+(?:\.\d+)?)\s*[-\u2013]\s*\$?(\d+(?:\.\d+)?)\s*$/);
    if (standaloneRange) {
      const a = parseFloat(standaloneRange[1]), b = parseFloat(standaloneRange[2]);
      entry  = Math.min(a, b);
      target = Math.max(a, b);
    }
  }

  // Priorite 2: "in at PRIX" / "entry PRIX" / "long PRIX" / "achat PRIX"
  if (!entry) {
    const em = c.match(/(?:in\s+at|entry|bought?|long\s+at|achat|entree)\s+\$?(\d+(?:\.\d+)?)/i);
    if (em) entry = parseFloat(em[1]);
  }

  // Priorite 3: "target PRIX" / "tp PRIX" / "out at PRIX" / "exit PRIX"
  if (!target) {
    const xm = c.match(/(?:target|tp|out\s+at|exit\s+at|sold?\s+at|sortie|objectif)\s+\$?(\d+(?:\.\d+)?)/i);
    if (xm) target = parseFloat(xm[1]);
  }

  // Priorite 4: stop / sl
  const sm = c.match(/(?:stop|sl|stoploss|stop[-\s]?loss)\s+\$?(\d+(?:\.\d+)?)/i);
  if (sm) stop = parseFloat(sm[1]);

  // Priorite 5: Niveaux separes par ... ou to (ex: 2.50...3.50)
  if (!entry || !target) {
    const lm = c.match(/\$?(\d+(?:\.\d+)?)\s*(?:\.{2,}|\bto\b)\s*\$?(\d+(?:\.\d+)?)/i);
    if (lm) {
      const a = parseFloat(lm[1]), b = parseFloat(lm[2]);
      if (!entry)  entry  = Math.min(a, b);
      if (!target) target = Math.max(a, b);
    }
  }

  let gain_pct = null;
  if (entry !== null && target !== null && entry > 0) {
    gain_pct = parseFloat((((target - entry) / entry) * 100).toFixed(2));
  }

  // exit_price kept for backward compat
  return { entry_price: entry, target_price: target, stop_price: stop, exit_price: target, gain_pct };
}
// ─────────────────────────────────────────────────────────────────────

function extractTicker(content) {
    if (!content) return '';
    const m = content.match(/\$([A-Z]{1,6})/i) || content.match(/\b([A-Z]{2,6})\b/);
    return m ? m[1].toUpperCase() : '';
}
function enrichContent(content) {
  const { gain_pct } = extractPrices(content);
  if (gain_pct === null) return content;
  const sign = gain_pct >= 0 ? '+' : '';
  return content + ' | Gain: ' + sign + gain_pct + '%';
}
const TICKER_IGNORE = new Set(['I','A','THE','AND','OR','TO','IN','AT','ON','BY','FOR','OF','UP','OK']);
function detectTicker(content) {
  if (!content) return null;
  const m1 = content.match(/\$([A-Z]{1,6})/i);
  if (m1) return m1[1].toUpperCase();
  const m2 = content.match(/\b([A-Z]{2,5})\b/g);
  if (m2) {
    for (const t of m2) {
      if (!TICKER_IGNORE.has(t)) return t;
    }
  }
  return null;
}

function classifySignal(content) {
  if (!content) return { type: null, reason: 'No content', confidence: 90, ticker: null };
  const lower = content.toLowerCase();
  const ticker = detectTicker(content);

  // 1. Liste blanche custom — bypass tous les filtres (corrections faux-negatifs)
  for (const phrase of customFilters.allowed) {
    if (lower.includes(phrase.toLowerCase())) {
      return { type: 'neutral', reason: 'Accepted', confidence: 90, ticker };
    }
  }

  // 2. Liste noire custom — regles apprises (faux-positifs corriges)
  for (const phrase of customFilters.blocked) {
    if (lower.includes(phrase.toLowerCase())) {
      return { type: null, reason: 'Learned filter', confidence: 90, ticker };
    }
  }

  // 3. Mots-cles bloques (hardcodes)
  const blocked = ['news', 'sec', 'ipo', 'offering', 'halted', 'form 8-k', 'reverse stock split'];
  for (const b of blocked) {
    if (lower.includes(b)) return { type: null, reason: 'Blocked keyword', confidence: 95, ticker };
  }
  // REQUIS: ticker ($TSLA, AAPL, NCT...)
  const hasTicker = /\$[A-Z]{1,6}/i.test(content) || /\b[A-Z]{2,5}\b/.test(content);
  if (!hasTicker) {
    console.log('[FILTER] No ticker, ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'No ticker', confidence: 90, ticker: null };
  }
  if (lower.includes('entree') || lower.includes('entry') || lower.includes('long') || lower.includes('scalp')) {
    const hasPrice = /\d+(?:\.\d+)?/.test(content);
    return { type: 'entry', reason: 'Accepted', confidence: hasPrice ? 90 : 70, ticker };
  }
  if (lower.includes('sortie') || lower.includes('exit') || lower.includes('stop')) {
    const hasPrice = /\d+(?:\.\d+)?/.test(content);
    return { type: 'exit', reason: 'Accepted', confidence: hasPrice ? 90 : 70, ticker };
  }
  // FILTRE: messages conversationnels (questions/chat sans prix)
  const hasPrice = /\$?\d+(?:\.\d+)?(?:\s*[-\u2013]\s*\$?\d+(?:\.\d+)?)?/.test(content);
  const isQuestion = content.trim().endsWith('?');
  const startsConvo = /^(and\s+)?(how|who|what|when|why|did|do|are|is|can|any|anyone|has|have|congrats|gg|nice|good|great|lol|haha|check|look|wow|reminder|just|btw|fyi|ok|okay)\b/i.test(content.trim());
  if ((isQuestion || startsConvo) && !hasPrice) {
    console.log('[FILTER] Conversational ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'Conversational', confidence: 75, ticker };
  }
  // Neutral requires BOTH ticker AND price
  if (!hasPrice) {
    console.log('[FILTER] No price for neutral, ignored: ' + content.substring(0, 60));
    return { type: null, reason: 'No price', confidence: 70, ticker };
  }
  return { type: 'neutral', reason: 'Accepted', confidence: 60, ticker };
}

// ─────────────────────────────────────────────────────────────────────
//  Resume journalier Discord — envoye a 18h00 heure locale
// ─────────────────────────────────────────────────────────────────────
let lastSummaryDate = null;

function sendDailySummary() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayMsgs = messageLog.filter(function(m) { return new Date(m.ts) >= midnight; });
  const total = todayMsgs.length;
  const accepted = todayMsgs.filter(function(m) { return m.passed; }).length;
  const filtered = total - accepted;
  const rate = total ? Math.round(accepted / total * 100) : 0;

  const tickerMap = {};
  todayMsgs.forEach(function(m) { if (m.ticker) tickerMap[m.ticker] = (tickerMap[m.ticker] || 0) + 1; });
  const topTickers = Object.keys(tickerMap).map(function(k) { return [k, tickerMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);

  const authorMap = {};
  todayMsgs.forEach(function(m) { if (m.author) authorMap[m.author] = (authorMap[m.author] || 0) + 1; });
  const topAuthors = Object.keys(authorMap).map(function(k) { return [k, authorMap[k]]; })
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);

  const tickersStr = topTickers.length ? topTickers.map(function(t) { return t[0] + ' (' + t[1] + ')'; }).join(', ') : 'None';
  const authorsStr = topAuthors.length ? topAuthors.map(function(a) { return a[0] + ' (' + a[1] + ')'; }).join(', ') : 'None';

  const summaryText = [
    '**BOOM Daily Summary** — ' + todayStr,
    '> Total messages: **' + total + '**',
    '> Accepted: **' + accepted + '** | Filtered: **' + filtered + '**',
    '> Acceptance rate: **' + rate + '%**',
    '> Top tickers: ' + tickersStr,
    '> Top analysts: ' + authorsStr,
  ].join('\n');

  try {
    const channel = client.channels.cache.find(function(ch) {
      return ch.name && ch.name.includes(TRADING_CHANNEL);
    });
    if (channel && channel.send) {
      channel.send(summaryText).then(function() {
        console.log('[summary] Resume journalier envoye dans #' + channel.name);
      }).catch(function(err) {
        console.error('[summary] Erreur envoi resume:', err.message);
      });
    } else {
      console.warn('[summary] Channel introuvable pour le resume journalier');
    }
  } catch (e) {
    console.error('[summary] Erreur:', e.message);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ─────────────────────────────────────────────────────────────────────
//  Feature 6: Auto backup to GitHub at midnight EDT
// ─────────────────────────────────────────────────────────────────────
let lastBackupDate = null;
const backupLog = [];

function runGitBackup() {
  const dateKey = todayKey();
  const dataGlob = path.join(DATA_DIR, '*.json').replace(/\\/g, '/');
  const cmd = 'git -C "' + __dirname.replace(/\\/g, '/') + '" add "' + dataGlob + '" && git -C "' + __dirname.replace(/\\/g, '/') + '" commit -m "Auto backup data ' + dateKey + '" --allow-empty && git -C "' + __dirname.replace(/\\/g, '/') + '" push';
  console.log('[backup] Running git backup for ' + dateKey);
  exec(cmd, function(err, stdout, stderr) {
    const entry = {
      date: new Date().toISOString(),
      success: !err,
      stdout: (stdout || '').trim().substring(0, 300),
      stderr: (stderr || '').trim().substring(0, 300),
      error: err ? err.message : null,
    };
    backupLog.unshift(entry);
    if (backupLog.length > 30) backupLog.pop();
    if (err) {
      console.error('[backup] Git backup failed:', err.message);
    } else {
      console.log('[backup] Git backup success:', stdout.trim().substring(0, 100));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Multi-source News Feed → Discord
//  Polls RSS feeds every 2 minutes, posts new headlines to NEWS_CHANNEL_ID
// ─────────────────────────────────────────────────────────────────────
const NEWS_FEEDS = [
  { name: 'FJ', url: 'https://www.financialjuice.com/feed.ashx?xy=rss', cleanTitle: t => t.replace(/^FinancialJuice:\s*/i, '') },
];
const NEWS_POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes
const newsSeenGuids = new Set();
const recentNews = []; // last 50 items for !news command + dashboard
const newsSSEClients = [];
let newsInitialized = {};

const RSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
};

function parseRssItems(xml, feed) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
      return m ? m[1].trim() : '';
    };
    const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
    const rawTitle = decode(get('title'));
    items.push({
      title: feed.cleanTitle(rawTitle),
      link: get('link'),
      pubDate: get('pubDate'),
      guid: get('guid') || get('link') || rawTitle.substring(0, 60),
      description: decode(get('description').replace(/<[^>]+>/g, '')).trim(),
      source: feed.name,
    });
  }
  return items;
}

// ── Emoji categories ──
function getNewsEmoji(title) {
  const t = title.toLowerCase();
  if (/\b(oil|crude|wti|brent|opec|lng|natural gas|energy|petroleum)\b/.test(t)) return '🛢️';
  if (/\b(fed|fomc|powell|ecb|boj|boe|central bank|interest rate|rate cut|rate hike|treasury|treasuries)\b/.test(t)) return '🏦';
  if (/\b(bitcoin|btc|ethereum|eth|crypto|blockchain|coinbase|binance)\b/.test(t)) return '₿';
  if (/\b(gold|silver|copper|commodit)/i.test(t)) return '🥇';
  if (/\b(forex|dollar|usd|eur\/|gbp|jpy|dxy|currency|currencies)\b/.test(t)) return '💵';
  if (/\b(tariff|sanction|trade deal|embargo|geopolitic|war|military|missile|troops)\b/.test(t)) return '🌍';
  if (/\b(stock|s&p|spx|nasdaq|dow|earning|ipo|rally|market|index|nyse|sell.?off|bull|bear)\b/.test(t)) return '📈';
  return '📰';
}

// ── News filter ──
// Whitelist — au moins un de ces mots doit être présent dans le titre
const NEWS_KEYWORDS = [
  // Banques centrales & politique monétaire
  'fed', 'federal reserve', 'fomc', 'powell', 'inflation', 'cpi', 'pce', 'ppi',
  'interest rate', 'rate cut', 'rate hike', 'rate decision', 'central bank',
  'quantitative', 'balance sheet', 'ecb', 'lagarde', 'boj', 'boe', 'monetary policy',
  // Macro-économie
  'gdp', 'jobs report', 'nonfarm', 'payroll', 'unemployment', 'jobless claims',
  'pmi', 'ism', 'retail sales', 'consumer confidence', 'consumer sentiment',
  'housing starts', 'durable goods', 'trade balance', 'recession', 'soft landing',
  'stagflation', 'deficit', 'debt ceiling', 'credit rating', 'downgrade',
  // Événements marché structurels (pas variations quotidiennes)
  'stock market', 'wall street', 'circuit breaker', 'market halt',
  'volatility', 'vix', 'margin call', 'short squeeze', 'flash crash',
  // Résultats d'entreprises
  'earnings', 'eps', 'revenue', 'guidance', 'outlook',
  'beats estimates', 'misses estimates', 'profit warning', 'ipo', 'buyback',
  'dividend', 'merger', 'acquisition', 'layoffs', 'restructuring',
  // Grandes capitalisations
  'tesla', 'apple', 'nvidia', 'amazon', 'google', 'alphabet', 'meta', 'microsoft',
  'berkshire', 'jpmorgan', 'goldman sachs', 'morgan stanley', 'blackrock',
  'exxon', 'chevron', 'palantir', 'openai', 'anthropic',
  // Trésorerie & obligations
  'treasury', 'yield', 't-bill', 'bond', '10-year', '2-year', 'yield curve',
  'spread', 'auction', 'debt',
  // Matières premières
  'oil', 'crude', 'wti', 'brent', 'opec', 'gold', 'silver', 'copper', 'natural gas', 'commodity',
  // Crypto
  'bitcoin', 'btc', 'ethereum', 'crypto',
  // Forex
  'dollar', 'dxy', 'usd', 'eur/usd', 'currency', 'forex',
  // Politique & géopolitique
  'trump', 'biden', 'harris', 'white house', 'congress', 'senate', 'president',
  'executive order', 'government shutdown', 'election', 'legislation',
  'tariff', 'trade war', 'trade deal', 'sanction', 'embargo', 'export ban',
  'chip ban', 'trade deficit', 'geopolitical', 'war', 'conflict', 'china',
  'ukraine', 'middle east', 'opec+',
];

// Blacklist — bloque même si un keyword whitelist est présent
const NEWS_BLOCKED = [
  'sport', 'football', 'soccer', 'basketball', 'nba', 'nfl', 'mlb', 'tennis',
  'olympic', 'fifa', 'world cup', 'celebrity', 'kardashian', 'hollywood',
  'movie', 'film', 'actor', 'actress', 'grammy', 'oscar', 'emmy',
  'entertainment', 'reality tv', 'concert', 'album', 'music', 'gaming',
  'video game', 'esport',
];

// Bloque les titres de variation d'index quotidienne (ex: "Nasdaq drops 1.4%")
const INDEX_VARIATION_REGEX = /\b(s&p\s*500?|spx|spy|qqq|nasdaq|dow\s*jones|dow|russell\s*2000?|nikkei|ftse|dax|cac\s*40?)\b.{0,40}(\bup\b|\bdown\b|\brises?\b|\bfalls?\b|\bgains?\b|\blosses?\b|\bslips?\b|\bclimbs?\b|\bdrops?\b|\bsurges?\b|\bplunges?\b|\badvances?\b|\bdeclines?\b|\btrims?\b|\bpares?\b|\bsheds?\b|\badds?\b|\bsinks?\b|\brallies\b|\bslumps?\b|\breadjust|\brebounds?\b)/i;

function isNewsRelevant(item) {
  const title = item.title || '';
  const text = (title + ' ' + (item.description || '')).toLowerCase();

  // 1. Bloquer les variations d'index quotidiennes
  if (INDEX_VARIATION_REGEX.test(title)) return false;

  // 2. Bloquer les sujets hors finance
  for (const b of NEWS_BLOCKED) {
    if (text.includes(b.toLowerCase())) return false;
  }

  // 3. Whitelist — doit contenir au moins un keyword
  for (const kw of NEWS_KEYWORDS) {
    if (text.includes(kw)) return true;
  }

  return false;
}

function extractSource(title) {
  const m = title.match(/^([^:]{3,50}):\s/);
  return m ? m[1].trim() : null;
}

function addToRecentNews(item) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    ts: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    title: item.title,
    emoji: getNewsEmoji(item.title),
    source: item.source || 'FJ',
    link: item.link,
  };
  recentNews.unshift(entry);
  if (recentNews.length > 50) recentNews.pop();
  // Broadcast to SSE clients
  const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
  newsSSEClients.forEach((c, i) => { try { c.res.write(payload); } catch (_) { newsSSEClients.splice(i, 1); } });
}

async function pollNewsFeed(feed) {
  if (!NEWS_CHANNEL_ID) return [];
  try {
    const res = await fetch(feed.url, { timeout: 15000, headers: RSS_HEADERS });
    if (!res.ok) {
      if (res.status === 429) console.error('[news][' + feed.name + '] Rate limited (429)');
      else console.error('[news][' + feed.name + '] Fetch failed:', res.status);
      return [];
    }
    const xml = await res.text();
    const items = parseRssItems(xml, feed);

    if (!newsInitialized[feed.name]) {
      items.forEach(i => newsSeenGuids.add(feed.name + ':' + i.guid));
      newsInitialized[feed.name] = true;
      console.log('[news][' + feed.name + '] Initialized — ' + items.length + ' headlines marked as seen');
      return [];
    }

    const newItems = items.filter(i => {
      const key = feed.name + ':' + i.guid;
      if (newsSeenGuids.has(key)) return false;
      newsSeenGuids.add(key);
      return true;
    }).reverse();

    return newItems.filter(i => isNewsRelevant(i));
  } catch (e) {
    console.error('[news][' + feed.name + '] Error:', e.message);
    return [];
  }
}

async function pollAllNewsFeeds() {
  if (!NEWS_CHANNEL_ID) return;
  let allRelevant = [];
  for (const feed of NEWS_FEEDS) {
    const items = await pollNewsFeed(feed);
    allRelevant = allRelevant.concat(items);
  }

  if (!allRelevant.length) return;

  // Add to recent news + SSE
  allRelevant.forEach(i => addToRecentNews(i));

  const channel = client.channels.cache.get(NEWS_CHANNEL_ID);
  if (!channel || !channel.send) {
    console.error('[news] Channel not found:', NEWS_CHANNEL_ID);
    return;
  }

  // Group consecutive headlines by source person
  const groups = [];
  for (const item of allRelevant) {
    const src = extractSource(item.title);
    const last = groups.length ? groups[groups.length - 1] : null;
    if (src && last && last.source === src) {
      last.items.push(item);
    } else {
      groups.push({ source: src, items: [item] });
    }
  }

  const lines = [];
  for (const g of groups) {
    if (g.source && g.items.length > 1) {
      const emoji = getNewsEmoji(g.items[0].title);
      lines.push(emoji + ' ' + g.source + ':');
      for (const item of g.items) {
        const text = item.title.replace(g.source + ': ', '').replace(g.source + ':', '').trim();
        lines.push('> • ' + text);
      }
    } else {
      for (const item of g.items) {
        lines.push(getNewsEmoji(item.title) + ' ' + item.title);
      }
    }
  }
  const combined = lines.join('\n');
  const chunks = [];
  if (combined.length <= 2000) {
    chunks.push(combined);
  } else {
    let current = '';
    for (const line of lines) {
      if (current.length + line.length + 1 > 2000) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current) chunks.push(current);
  }
  for (const chunk of chunks) {
    try { await channel.send(chunk); } catch (e) { console.error('[news] Send error:', e.message); }
  }
  console.log('[news] Posted ' + allRelevant.length + ' headline(s) in ' + chunks.length + ' message(s)');

  // Keep seen set manageable
  if (newsSeenGuids.size > 1000) {
    const arr = Array.from(newsSeenGuids);
    arr.splice(0, arr.length - 500);
    newsSeenGuids.clear();
    arr.forEach(g => newsSeenGuids.add(g));
  }
}

client.once('ready', () => {
  console.log('Bot connected as ' + client.user.tag);
  console.log('Listening for channels containing: ' + TRADING_CHANNEL);

  // Start multi-source news feed
  if (NEWS_CHANNEL_ID) {
    console.log('[news] News feeds active — posting to channel ' + NEWS_CHANNEL_ID);
    console.log('[news] Sources: ' + NEWS_FEEDS.map(f => f.name).join(', '));
    pollAllNewsFeeds();
    setInterval(pollAllNewsFeeds, NEWS_POLL_INTERVAL);
  } else {
    console.log('[news] NEWS_CHANNEL_ID not set — news feeds disabled');
  }

  // Verification toutes les minutes pour le resume a 18h00 et backup midnight EDT
  setInterval(function() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Resume journalier a 21h00 heure locale
    if (now.getHours() === 21 && now.getMinutes() === 0) {
      if (lastSummaryDate !== todayStr) {
        lastSummaryDate = todayStr;
        sendDailySummary();
      }
    }

    // Daily profit summary at 20:00 EDT
    // 20:00 EDT = 00:00 UTC (summer) or 01:00 UTC (winter)
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const is20hEDT = (utcH === 0 || utcH === 1) && utcM === 0;
    if (is20hEDT && lastProfitSummaryDate !== todayStr) {
      lastProfitSummaryDate = todayStr;
      sendDailyProfitSummary();
    }

    // Backup a minuit EDT (UTC-4 en ete, UTC-5 en hiver)
    // Minuit EDT = 04:00 UTC en ete, 05:00 UTC en hiver
    // On essaie les deux: 04:00 et 05:00 UTC
    const isMidnightEDT = (utcH === 4 || utcH === 5) && utcM === 0;
    if (isMidnightEDT && lastBackupDate !== todayStr) {
      lastBackupDate = todayStr;
      runGitBackup();
    }
  }, 60000);
});

// ─────────────────────────────────────────────────────────────────────
//  !profits command — fonctionne dans tous les salons
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const cmd = message.content.trim().toLowerCase();
  if (cmd !== '!profits' && cmd !== '!bilan') return;
  console.log('[!profits] Command received from ' + message.author.username + ' in #' + (message.channel.name || message.channel.id));

  const dateKey = todayKey();
  const data = loadProfitData(dateKey);
  const count = data.count || 0;
  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' });

  const record = getProfitRecord();
  const recordLine = (count > 0 && count >= record.count)
    ? '\n> 🏆 **NEW RECORD!**'
    : '\n> 📊 Record: **' + record.count + '** (' + record.date + ')';

  try {
    await message.reply(
      '📊 **Daily Profits — ' + dateStr + '**\n'
      + '> 🔥 **' + count + '** profit' + (count !== 1 ? 's' : '') + ' posted today'
      + recordLine
    );
  } catch (e) {
    console.error('[!profits]', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  !news command — last 5 headlines in any channel
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!news') return;

  if (!recentNews.length) {
    try { await message.reply('📰 No recent news available.'); } catch (_) {}
    return;
  }
  const top5 = recentNews.slice(0, 5);
  const lines = ['📰 **Latest News**'];
  top5.forEach((n, i) => {
    lines.push('> ' + (i + 1) + '. ' + n.emoji + ' ' + n.title);
  });
  try { await message.reply(lines.join('\n')); } catch (e) { console.error('[!news]', e.message); }
});

// ─────────────────────────────────────────────────────────────────────
//  Profit counter — écoute #profits pour les messages avec images
// ─────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!PROFITS_CHANNEL_ID) return;
  if (message.channel.id !== PROFITS_CHANNEL_ID) return;

  const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
  const hasImage = message.attachments.some(a =>
    (a.contentType && a.contentType.startsWith('image/')) ||
    (a.url && IMAGE_EXT.test(a.url)) ||
    (a.name && IMAGE_EXT.test(a.name))
  );
  const content = message.content || '';
  const textCount = countProfitEntries(content);
  const hasTicker = !!detectTicker(content);

  // Ignorer si aucun signal détecté (ni image, ni price range, ni ticker)
  if (!hasImage && textCount === 0 && !hasTicker) return;

  // Priorité : price ranges > image/ticker seul
  // Ticker seul ou image seule → 1 profit
  const profitCount = textCount > 0 ? textCount : 1;

  const reason = hasImage ? 'image' : (textCount > 0 ? 'price range(s)' : 'ticker');
  console.log('[profits] ' + reason + ' in #profits from ' + message.author.username + ' → ' + profitCount + ' profit(s)');
  await addProfitMessage(content);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const channelName = message.channel.name || '';
  console.log('Message received - channel: "' + channelName + '", author: ' + message.author.username);
  if (!channelName.includes(TRADING_CHANNEL)) return;

  const content = message.content;
  const authorName = message.author.username;

  // ── Feature 1: Discord commands !top and !stats TICKER ─────────────────────
  if (content.trim() === '!top') {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayMsgs = messageLog.filter(function(m) { return m.passed && new Date(m.ts) >= midnight; });
    const authorMap = {};
    todayMsgs.forEach(function(m) {
      if (m.author) authorMap[m.author] = (authorMap[m.author] || 0) + 1;
    });
    const top = Object.keys(authorMap).map(function(k) { return [k, authorMap[k]]; })
      .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);
    const dateStr = new Date().toISOString().slice(0, 10);
    const medals = ['1.', '2.', '3.'];
    const lines = ['**🏆 Top Analysts — ' + dateStr + '**'];
    if (!top.length) {
      lines.push('> No accepted signals today');
    } else {
      top.forEach(function(t, i) {
        lines.push('> ' + medals[i] + ' **' + t[0] + '** — ' + t[1] + ' signal' + (t[1] > 1 ? 's' : ''));
      });
    }
    try { await message.reply(lines.join('\n')); } catch(e) { console.error('[!top]', e.message); }
    return;
  }

  const statsMatch = content.trim().match(/^!stats\s+([A-Z$]{1,7})/i);
  if (statsMatch) {
    const ticker = statsMatch[1].replace('$', '').toUpperCase();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayMsgs = messageLog.filter(function(m) { return new Date(m.ts) >= midnight && m.ticker && m.ticker.toUpperCase() === ticker; });
    const total = todayMsgs.length;
    const accepted = todayMsgs.filter(function(m) { return m.passed; }).length;
    const filtered = total - accepted;
    const authorMap = {};
    todayMsgs.filter(function(m) { return m.passed; }).forEach(function(m) {
      if (m.author) authorMap[m.author] = (authorMap[m.author] || 0) + 1;
    });
    const topAuthors = Object.keys(authorMap).map(function(k) { return k + ' (' + authorMap[k] + ')'; })
      .sort(function(a, b) { return authorMap[b.split(' ')[0]] - authorMap[a.split(' ')[0]]; });
    const authorStr = topAuthors.length ? topAuthors.join(', ') : 'Aucun';
    const lines = [
      '**📈 Stats $' + ticker + ' — aujourd\'hui**',
      '> Signaux : ' + total,
      '> Acceptés : ' + accepted + ' | Filtrés : ' + filtered,
      '> Auteurs : ' + authorStr,
    ];
    try { await message.reply(lines.join('\n')); } catch(e) { console.error('[!stats]', e.message); }
    return;
  }
  // ───────────────────────────────────────────────────────────────────────────

  // ── Filtre par auteur ──────────────────────────────────────────────────────
  if ((customFilters.blockedAuthors || []).includes(authorName)) {
    console.log('[AUTHOR BLOCKED] ' + authorName);
    logEvent(authorName, channelName, content, null, 'Auteur bloqué');
    return;
  }
  const authorAllowed = (customFilters.allowedAuthors || []).includes(authorName);
  // ──────────────────────────────────────────────────────────────────────────

  // ── Détection de réponse + enrichissement de contexte ─────────────────────
  let parentContent = null;
  let parentAuthor  = null;
  let isReply       = false;

  if (message.reference?.messageId) {
    try {
      const parentMsg = await message.channel.messages.fetch(message.reference.messageId);
      parentContent = parentMsg.content || '';
      parentAuthor  = parentMsg.author?.username || null;
      isReply       = true;
      console.log('[REPLY] Parent: ' + parentContent.substring(0, 60));
    } catch (e) {
      console.warn('[REPLY] Could not fetch parent message:', e.message);
    }
  }

  // Contenu enrichi : si c'est une réponse, on fusionne parent + reply
  // pour que le ticker/prix du parent bénéficient à la classification de la réponse
  const classifyContent = isReply && parentContent
    ? parentContent + ' ' + content
    : content;

  const extra = {
    isReply,
    parentPreview: parentContent ? (parentContent.length > 80 ? parentContent.slice(0, 80) + '…' : parentContent) : null,
    parentAuthor,
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Toujours analyser le contenu pour des stats précises
  const result         = classifySignal(classifyContent);
  const filterType     = result.type;       // ce que le filtre de contenu a décidé
  const filterReason   = result.reason;
  const signalConfidence = result.confidence;
  const signalTicker   = result.ticker;

  const pricesForLog = extractPrices(classifyContent);
  const extraWithSignal = Object.assign({}, extra, {
    confidence: signalConfidence,
    ticker: signalTicker,
    entry_price: pricesForLog.entry_price != null ? pricesForLog.entry_price : null,
  });

  if (!filterType && !authorAllowed) {
    // Filtré ET auteur non autorisé → bloqué
    console.log('Filtered (' + filterReason + '): ' + content.substring(0, 80));
    logEvent(authorName, channelName, content, null, filterReason, extraWithSignal);
    return;
  }

  if (!filterType && authorAllowed) {
    // Filtré par le contenu MAIS auteur autorisé → on logue passed:false (stats honnêtes)
    // mais on continue quand même pour envoyer le signal
    console.log('[AUTHOR ALLOWED bypass] ' + authorName + ': ' + content.substring(0, 60));
    logEvent(authorName, channelName, content, null, 'Auteur autorise (contenu filtre)', extraWithSignal);
    // on ne return pas : on envoie quand même l'image/webhook
  } else {
    // Filtre passé normalement
    logEvent(authorName, channelName, content, filterType, filterReason, extraWithSignal);
  }
  const sendType = filterType || 'neutral';
  console.log('[' + sendType.toUpperCase() + ']' + (isReply ? ' [REPLY]' : '') + ' ' + content);

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

  // ── Auto Proof Image — détecte recap + alerte originale ──────────────────
  const recapPrices = extractPrices(classifyContent);
  const isRecap = signalTicker
    && recapPrices.entry_price !== null
    && recapPrices.target_price !== null
    && recapPrices.target_price > recapPrices.entry_price; // exit > entry = profit confirmé

  if (isRecap) {
    try {
      // Chercher l'alerte originale dans l'historique (30 derniers jours)
      let originalAlert = null;

      // 1. Si c'est une réponse Discord, utiliser le message parent directement
      if (isReply && parentContent && parentAuthor) {
        originalAlert = { author: parentAuthor, content: parentContent, ts: null };
      }

      // 2. Sinon chercher dans l'historique le dernier signal d'entrée pour ce ticker
      if (!originalAlert) {
        for (let i = 0; i < 30 && !originalAlert; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dk = d.toISOString().slice(0, 10);
          const msgs = i === 0
            ? messageLog.filter(m => m.ts && m.ts.slice(0, 10) === dk)
            : loadDailyFile(dk);
          const found = msgs.find(m =>
            m.passed &&
            m.ticker && m.ticker.toUpperCase() === signalTicker.toUpperCase() &&
            m.id !== undefined && // not the current message
            new Date(m.ts) < message.createdAt // must be BEFORE the recap
          );
          if (found) {
            originalAlert = { author: found.author, content: found.content || found.preview || '', ts: found.ts };
          }
        }
      }

      if (originalAlert) {
        console.log('[proof] Generating proof image for $' + signalTicker + ' — original by ' + originalAlert.author);
        const proofBuf = await generateProofImage(
          originalAlert.author,
          originalAlert.content,
          originalAlert.ts,
          message.author.username,
          content,
          message.createdAt.toISOString()
        );
        // Post the proof image directly in the channel
        await message.channel.send({
          files: [{ attachment: proofBuf, name: 'proof-' + signalTicker.toLowerCase() + '.png' }]
        });
        console.log('[proof] Proof image posted for $' + signalTicker);
      } else {
        console.log('[proof] No original alert found for $' + signalTicker);
      }
    } catch (err) {
      console.error('[proof] Error generating proof image:', err.message);
    }
  }

  // Feature 8: Generate promo image for complete signals (has ticker + prices)
  const pricesData = extractPrices(classifyContent);
  let promoImageBase64 = null;
  if (signalTicker && pricesData.entry_price != null && pricesData.target_price != null) {
    try {
      const promoBuf = await generatePromoImage(signalTicker, pricesData.gain_pct, pricesData.entry_price, pricesData.target_price);
      lastPromoImageBuffer = promoBuf;
      promoImageBase64 = promoBuf.toString('base64');
      console.log('[promo] Promo image generated for $' + signalTicker);
    } catch (err) {
      console.error('[promo] Promo image error:', err.message);
    }
  }

  try {
    const result = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        author: message.author.username,
        channel: channelName,
        signal_type: sendType,
        timestamp: message.createdAt.toISOString(),
        image_url: imageUrl,
        ticker: extractTicker(classifyContent),
        is_reply: isReply,
        parent_content: parentContent,
        parent_author: parentAuthor,
        promo_image_base64: promoImageBase64,
        ...pricesData
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
