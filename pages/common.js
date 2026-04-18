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
  { href: '/raw-messages',    icon: '📋', label: 'Raw Messages' },
  { href: '/db-viewer',       icon: '🗄️', label: 'DB Viewer' },
  { href: '/backup-log',      icon: '💾', label: 'Backup Log' },
  { href: '/config',          icon: '⚙️', label: 'Config' },
];

function sidebarHTML(active) {
  return `<nav class="nav-sidebar">
  <div class="nav-sidebar-logo">🔥 BOOM</div>
  ${SIDEBAR_LINKS.map(l => `<a href="${l.href}"${active === l.href ? ' class="active"' : ''}><span class="nav-sidebar-icon">${l.icon}</span>${l.label}</a>`).join('\n  ')}
</nav>`;
}

module.exports = {
  COMMON_CSS,
  SIDEBAR_LINKS,
  sidebarHTML,
};
