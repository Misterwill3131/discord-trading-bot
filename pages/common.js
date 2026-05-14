// ─────────────────────────────────────────────────────────────────────
// pages/common.js — CSS et sidebar partagés par toutes les pages
// ─────────────────────────────────────────────────────────────────────
// COMMON_CSS est inliné dans chaque page via `<style>${COMMON_CSS}</style>`.
// Toute règle globale (sidebar, cards, boutons, typographie, scrollbar)
// vit ici pour garder un look unique à travers le dashboard.
//
// sidebarHTML(activePath) retourne la nav gauche en marquant comme
// `active` le lien correspondant à l'URL courante.
//
// Exporte :
//   COMMON_CSS                — chaîne CSS à inliner
//   sidebarHTML(activePath)   — chaîne HTML <nav>…</nav>
//   SIDEBAR_LINKS             — liste (href, icon, label) pour tests
// ─────────────────────────────────────────────────────────────────────

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

// Liens de la sidebar. Ajouter une page ? Ajouter une entrée ici et
// créer la route Express correspondante.
const SIDEBAR_LINKS = [
  { href: '/dashboard',       icon: '📡', label: 'Dashboard' },
  { href: '/stats',           icon: '📊', label: 'Stats' },
  { href: '/profits',         icon: '💰', label: 'Profits' },
  { href: '/news',            icon: '📰', label: 'News' },
  { href: '/leaderboard',     icon: '🏆', label: 'Leaderboard' },
  { href: '/image-generator', icon: '🖼️', label: 'Image Generator' },
  { href: '/proof-generator', icon: '🔍', label: 'Proof Generator' },
  { href: '/gallery',         icon: '🖼', label: 'Galerie' },
  { href: '/video-studio',    icon: '🎬', label: 'Video Studio' },
  { href: '/raw-messages',    icon: '📋', label: 'Raw Messages' },
  { href: '/db-viewer',       icon: '🗄️', label: 'DB Viewer' },
  { href: '/backup-log',      icon: '💾', label: 'Backup Log' },
  { href: '/welcome-log',     icon: '👋', label: 'Welcome Log' },
  { href: '/config',          icon: '⚙️', label: 'Config' },
];

function sidebarHTML(active) {
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${SIDEBAR_LINKS.map(l => `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}><span class="nav-sidebar-icon">${l.icon}</span>${l.label}</a>`).join('\n  ')}
</nav>`;
}

// ─────────────────────────────────────────────────────────────────────
// Layout PUBLIC — utilisé par les pages marketing (/ /pricing /faq etc.)
// et le panel customer (/account/*). Différent du dashboard admin :
//   - Header haut (pas de sidebar gauche)
//   - Footer avec liens légaux
//   - Pas de bouton dépendant de l'admin (pas de DB Viewer, etc.)
// ─────────────────────────────────────────────────────────────────────

const PUBLIC_CSS = `
  /* Header public */
  .public-header { display: flex; align-items: center; gap: 28px; padding: 16px 32px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(10,10,15,0.85); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 50; }
  .public-brand { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; text-decoration: none; }
  .public-nav { display: flex; gap: 24px; flex: 1; }
  .public-nav a { color: #a0a0b0; text-decoration: none; font-size: 14px; font-weight: 500; }
  .public-nav a:hover, .public-nav a.active { color: #fafafa; }
  .public-nav-cta { display: flex; gap: 12px; align-items: center; }
  .public-nav-cta a { font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 8px; text-decoration: none; }
  .public-nav-cta a.ghost { color: #a0a0b0; }
  .public-nav-cta a.ghost:hover { color: #fafafa; background: rgba(255,255,255,0.04); }
  .public-nav-cta a.primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .public-nav-cta a.primary:hover { box-shadow: 0 4px 16px rgba(139,92,246,0.4); transform: translateY(-1px); }

  /* Body wrapper public */
  .public-body { display: flex; flex-direction: column; min-height: 100vh; flex: 1; min-width: 0; }
  .public-main { flex: 1; padding: 48px 32px; max-width: 1200px; width: 100%; margin: 0 auto; }
  .public-section { margin-bottom: 80px; }
  .public-h1 { font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1.05; background: linear-gradient(135deg, #fafafa 0%, #c4b5fd 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; max-width: 900px; }
  .public-h2 { font-size: 36px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; color: #fafafa; margin-bottom: 16px; }
  .public-h3 { font-size: 20px; font-weight: 700; color: #fafafa; margin-bottom: 8px; letter-spacing: -0.01em; }
  .public-lead { font-size: 19px; color: #a0a0b0; max-width: 720px; line-height: 1.5; margin-top: 18px; }
  .public-prose p { color: #c0c0cc; font-size: 15px; line-height: 1.7; margin-bottom: 14px; }

  /* Footer public */
  .public-footer { padding: 32px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; flex-wrap: wrap; gap: 24px; align-items: center; color: #707080; font-size: 13px; max-width: 1200px; width: 100%; margin: 0 auto; }
  .public-footer .links { display: flex; gap: 18px; flex: 1; }
  .public-footer a { color: #a0a0b0; text-decoration: none; }
  .public-footer a:hover { color: #fafafa; }

  /* Hero CTA */
  .hero-cta { display: flex; gap: 14px; margin-top: 32px; flex-wrap: wrap; }
  .hero-cta a { padding: 14px 26px; border-radius: 10px; font-size: 15px; font-weight: 600; text-decoration: none; }
  .hero-cta a.primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; box-shadow: 0 4px 16px rgba(59,130,246,0.4); }
  .hero-cta a.primary:hover { box-shadow: 0 8px 32px rgba(139,92,246,0.5); transform: translateY(-2px); }
  .hero-cta a.secondary { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; }
  .hero-cta a.secondary:hover { background: rgba(255,255,255,0.08); }

  /* Feature grid */
  .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; margin-top: 32px; }
  .feature-icon { font-size: 28px; margin-bottom: 12px; }

  /* Pricing cards */
  .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-top: 32px; }
  .pricing-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 32px; display: flex; flex-direction: column; position: relative; }
  .pricing-card.highlight { border-color: rgba(139,92,246,0.5); box-shadow: 0 0 0 1px rgba(139,92,246,0.3), 0 12px 40px rgba(139,92,246,0.15); }
  .pricing-card .badge { position: absolute; top: -12px; right: 24px; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 999px; letter-spacing: 0.04em; text-transform: uppercase; }
  .pricing-card .name { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0a0b0; margin-bottom: 12px; }
  .pricing-card .price { font-size: 44px; font-weight: 800; color: #fafafa; letter-spacing: -0.03em; line-height: 1; }
  .pricing-card .price-suffix { font-size: 14px; color: #a0a0b0; font-weight: 500; }
  .pricing-card .desc { color: #a0a0b0; font-size: 14px; margin: 16px 0; min-height: 40px; }
  .pricing-card ul { list-style: none; margin: 8px 0 24px; flex: 1; }
  .pricing-card li { color: #c0c0cc; font-size: 14px; padding: 6px 0 6px 24px; position: relative; }
  .pricing-card li:before { content: '✓'; position: absolute; left: 0; color: #3ba55d; font-weight: 700; }
  .pricing-card .pay-buttons { display: flex; flex-direction: column; gap: 8px; }
  .pricing-card .pay-buttons button, .pricing-card .pay-buttons a { padding: 11px 18px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; text-decoration: none; text-align: center; display: block; }
  .pricing-card .pay-buttons .stripe { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #fff; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
  .pricing-card .pay-buttons .stripe:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
  .pricing-card .pay-buttons .launchpass { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #fafafa; }
  .pricing-card .pay-buttons .launchpass:hover { background: rgba(255,255,255,0.08); }

  /* FAQ accordion */
  .faq-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; margin-bottom: 12px; }
  .faq-item summary { padding: 18px 22px; cursor: pointer; font-weight: 600; color: #fafafa; font-size: 15px; list-style: none; display: flex; justify-content: space-between; align-items: center; }
  .faq-item summary::-webkit-details-marker { display: none; }
  .faq-item summary:after { content: '+'; font-size: 22px; font-weight: 300; color: #a0a0b0; }
  .faq-item[open] summary:after { content: '−'; }
  .faq-item[open] summary { border-bottom: 1px solid rgba(255,255,255,0.06); }
  .faq-item .answer { padding: 16px 22px 22px; color: #c0c0cc; font-size: 14px; line-height: 1.7; }
`;

// Génère un layout public complet (header + main + footer).
// `activePath` : marque le lien actif dans le header.
// `content` : HTML du <main>.
// `opts` : { title, brandName, brandDomain, year, isCustomerLoggedIn }.
function publicLayoutHTML(activePath, content, opts = {}) {
  const title = opts.title || 'Trading Signals';
  const brandName = opts.brandName || 'Trading Signals';
  const year = opts.year || new Date().getFullYear();
  const accountLink = opts.isCustomerLoggedIn
    ? `<a href="/account" class="ghost">My account</a>`
    : `<a href="/account/login" class="ghost">Login</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${COMMON_CSS}${PUBLIC_CSS}</style>
</head>
<body>
<div class="public-body">
  <header class="public-header">
    <a href="/" class="public-brand">${brandName}</a>
    <nav class="public-nav">
      <a href="/"${activePath === '/' ? ' class="active"' : ''}>Home</a>
      <a href="/pricing"${activePath === '/pricing' ? ' class="active"' : ''}>Pricing</a>
      <a href="/faq"${activePath === '/faq' ? ' class="active"' : ''}>FAQ</a>
    </nav>
    <div class="public-nav-cta">
      ${accountLink}
      <a href="/pricing" class="primary">Get started</a>
    </div>
  </header>
  <main class="public-main">
    ${content}
  </main>
  <footer class="public-footer">
    <div class="links">
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/faq">FAQ</a>
    </div>
    <div>© ${year} ${brandName}. All rights reserved.</div>
  </footer>
</div>
</body>
</html>`;
}

// Helper pour échapper du HTML user-input quand on injecte du contenu admin
// dans le DOM. Sécurise contre XSS sur les champs marketing/plans éditables.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  COMMON_CSS,
  PUBLIC_CSS,
  SIDEBAR_LINKS,
  sidebarHTML,
  publicLayoutHTML,
  escapeHtml,
};
