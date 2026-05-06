// build_launch_plan.js — Generates "Temple of Boom — Plan de lancement.docx"
// Usage: node build_launch_plan.js

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber,
} = require('docx');

// ── Page setup (A4) ────────────────────────────────────────────────
const A4_WIDTH = 11906;
const A4_HEIGHT = 16838;
const MARGIN = 1134; // ~2cm
const CONTENT_W = A4_WIDTH - 2 * MARGIN; // 9638

// ── Colors ─────────────────────────────────────────────────────────
const TEXT = "1F2937";
const TEXT_LIGHT = "6B7280";
const HEADING = "111827";
const ACCENT = "1E40AF";
const ACCENT_SOFT = "3B82F6";
const BORDER = "D1D5DB";
const HEADER_BG = "EEF2F7";
const ALT_ROW = "F9FAFB";

const border = { style: BorderStyle.SINGLE, size: 1, color: BORDER };
const borders = { top: border, bottom: border, left: border, right: border };

// ── Helpers ────────────────────────────────────────────────────────
function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, color: TEXT, ...opts })],
    spacing: { after: 120, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

function spacer(after = 100) {
  return new Paragraph({ children: [], spacing: { after } });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: "bullets", level },
    children: [new TextRun({ text, size: 22, color: TEXT })],
    spacing: { after: 60, line: 280 },
  });
}

function numbered(text, opts = {}) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    children: [new TextRun({ text, size: 22, color: TEXT, ...opts })],
    spacing: { after: 60, line: 280 },
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun(text)],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun(text)],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [new TextRun(text)],
  });
}

function cell(content, opts = {}) {
  const { bold = false, fill, width, align, color } = opts;
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    ...(fill ? { shading: { fill, type: ShadingType.CLEAR } } : {}),
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    children: [
      new Paragraph({
        ...(align ? { alignment: align } : {}),
        children: [new TextRun({ text: String(content), bold, size: 20, color: color || TEXT })],
      }),
    ],
  });
}

function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h, i) =>
          cell(h, { bold: true, fill: HEADER_BG, width: widths[i], color: HEADING })
        ),
      }),
      ...rows.map((row, idx) =>
        new TableRow({
          children: row.map((c, i) => {
            const fill = idx % 2 === 1 ? ALT_ROW : undefined;
            if (typeof c === 'object' && c !== null) {
              return cell(c.text, { ...c, width: widths[i], fill: c.fill || fill });
            }
            return cell(c, { width: widths[i], fill });
          }),
        })
      ),
    ],
  });
}

// Priority badge styling
function pri(level) {
  const colors = { P0: "B91C1C", P1: "B45309", P2: "047857" };
  return { text: level, bold: true, color: colors[level] || TEXT, align: AlignmentType.CENTER };
}

// ── Title page ─────────────────────────────────────────────────────
const titlePage = [
  new Paragraph({ children: [], spacing: { before: 4500 } }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Temple of Boom", size: 64, bold: true, color: HEADING, font: "Arial" })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: "Plan de lancement", size: 40, color: ACCENT, font: "Arial" })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240 },
    children: [new TextRun({
      text: "État du produit, taches restantes, couts et ordre d’exécution",
      size: 22, italics: true, color: TEXT_LIGHT, font: "Arial",
    })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 1800 },
    children: [new TextRun({ text: "3 mai 2026", size: 22, color: TEXT_LIGHT, font: "Arial" })],
  }),
  new Paragraph({ pageBreakBefore: true, children: [] }),
];

// ── Synthèse ───────────────────────────────────────────────────────
const synthesis = [
  h1("Synthèse exécutive"),
  p("Temple of Boom est un produit SaaS qui relaie en temps réel des alertes de trading vers des serveurs Discord clients. Le système est composé de deux briques principales : un site web Next.js (vitrine, paiement, panel client, panel admin) et un bot Discord Node.js (réception et relais des alertes)."),
  p("À ce jour, l’architecture, les fonctionnalités cœur et l’intégration entre les deux services sont en place. La phase qui suit consiste à finaliser les éléments de mise en production (paiements live, domaine, conformité, contenu marketing) puis à exécuter la mise sur le marché."),
  p("Ce document décrit l’état actuel des deux briques, les taches restantes, les couts récurrents en phase de croissance, les couts ponctuels, ainsi qu’un ordre d’exécution recommandé pour la mise en production."),
  spacer(200),
  p("Légende des priorités utilisée dans les tableaux :"),
  bullet("P0 — critique, bloquant pour le lancement"),
  bullet("P1 — important, à finaliser avant ou pendant le soft launch"),
  bullet("P2 — nice-to-have, peut attendre la phase d’itération post-lancement"),
];

// ── Section 1 : Site internet ──────────────────────────────────────
const section1 = [
  new Paragraph({ pageBreakBefore: true, children: [] }),
  h1("1. Site internet"),

  h2("1.1 État actuel"),
  h3("Stack technique"),
  bullet("Frontend : Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS"),
  bullet("Backend : Server Components, Server Actions, Route Handlers"),
  bullet("Base de données : Neon Serverless Postgres (Vercel Marketplace) + Drizzle ORM 0.45"),
  bullet("Paiements : Stripe SDK 22.1 (mode test actif)"),
  bullet("Email transactionnel : Resend SDK"),
  bullet("Authentification : magic-link (HttpOnly cookies, 15 min) + scrypt password ; sessions admin HMAC-signées"),
  bullet("Hébergement : Vercel (preview + production en place)"),

  h3("Fonctionnalités déployées"),
  bullet("Landing page avec pricing dynamique géré par CMS"),
  bullet("Tunnel de paiement Stripe avec activation par magic-link 7 jours post-checkout"),
  bullet("Dashboard client : abonnement, compte, onboarding, Discord, annonces, aide, statistiques de signaux, historique des alertes"),
  bullet("Panel admin complet sur 11 sections : dashboard, clients, plans, dashboard client, annonces, marketing, emails, FAQ, légal, site, marque"),
  bullet("Flux de client de test pour QA (bypass Stripe, création compte avec password réel)"),
  bullet("Mirror cross-repo des signaux : le bot écrit dans signal_relays, le dashboard lit pour afficher stats + feed"),
  bullet("Support de 4 types d’alertes : trading signal, passthrough TrendVision, IPO, market alert"),
  bullet("Email lowercase normalisé (évite duplications de comptes lors du checkout)"),

  h3("Indicateurs"),
  bullet("11 sections d’admin opérationnelles"),
  bullet("8 cartes sur le dashboard client"),
  bullet("4 types d’alertes supportés et affichés avec icônes distinctes"),
  bullet("6 migrations Drizzle déployées (dernière : 0006 multi-type signal_relays)"),

  h2("1.2 Taches restantes"),
  p("Catégorisées par domaine. Les éléments P0 sont bloquants pour la mise en ligne publique."),
  spacer(120),
  table(
    ["Catégorie", "Tache", "Priorité", "Notes"],
    [
      ["Stripe", "Configurer compte Stripe en mode live", "P0", "KYC requis : pièce d’identité, IBAN, justificatif"],
      ["Stripe", "Webhook endpoint de production avec secret signé", "P0", "URL stable côté Vercel"],
      ["Stripe", "Plans avec prix réels (EUR) synchronisés", "P0", "stripe_price_id_monthly et _annual côté DB"],
      ["Stripe", "Tester paiement live avec carte réelle", "P0", "Refund immédiat après test"],
      ["Email", "Vérifier le domaine sur Resend", "P0", "DKIM + SPF + DMARC dans la zone DNS"],
      ["Email", "Switch RESEND_API_KEY vers la clé prod", "P0", "Variable Vercel"],
      ["Email", "Templates personnalisés à la marque", "P1", "Magic-link, activation, reçu de paiement"],
      ["Email", "Test delivery (mail-tester.com >= 9/10)", "P1", "Avant envoi en volume"],
      ["Domaine", "Acheter le domaine .com", "P0", "Cloudflare Registrar (proche du wholesale)"],
      ["Domaine", "Lier le domaine à Vercel + DNS", "P0", "SSL Let’s Encrypt automatique"],
      ["Domaine", "Redirect www -> apex (ou inverse)", "P1", "Cohérence SEO"],
      ["Contenu", "FAQ (8 à 12 questions clés)", "P1", "Section FAQ du panel admin"],
      ["Contenu", "Pages légales : CGV, CGU, mentions, privacy", "P0", "Section Legal du panel admin"],
      ["Contenu", "Copy marketing landing finalisé", "P1", "Headlines, sous-titres, preuve sociale"],
      ["Contenu", "Logo, favicon, image OG", "P1", "Cohérence visuelle multi-device"],
      ["Contenu", "Descriptions de plans + features", "P1", "Section Plans du panel admin"],
      ["Conformité", "CGV/CGU validées (templates ou avocat)", "P0", "Captain Contrat ~50€ ou avocat 500-2000€"],
      ["Conformité", "Mentions légales (SIREN, hébergeur, contact)", "P0", "Obligation légale FR"],
      ["Conformité", "Cookie banner RGPD avec consentement", "P1", "Tarteaucitron, Cookiebot, ou implémentation custom"],
      ["Conformité", "DPA signés (Stripe, Vercel, Resend, Neon)", "P0", "Sous-traitants RGPD"],
      ["Conformité", "Inscription registre traitements RGPD", "P1", "Registre interne"],
      ["Monitoring", "Sentry frontend + backend", "P1", "Capture erreurs JS et serveur"],
      ["Monitoring", "Vercel Analytics activé", "P1", "Inclus dans le plan Pro"],
      ["Monitoring", "Alerting sur erreurs critiques", "P1", "Slack / email via Sentry"],
      ["SEO", "Meta tags par page (title, description, OG)", "P1", "Next.js Metadata API"],
      ["SEO", "sitemap.xml et robots.txt", "P1", "Routes générées par Next.js"],
      ["SEO", "Structured data (LD+JSON pour Product / SaaS)", "P2", "Améliore les rich results"],
      ["Tests", "Tests E2E sur preview (Playwright ou manuel)", "P0", "Paiement, login, dashboard, admin"],
      ["Tests", "Smoke tests en production avant ouverture", "P0", "Compte test réel, refund après"],
      ["Tests", "Test de charge basique", "P2", "k6 ou Artillery, scénario landing -> checkout"],
    ],
    [1500, 4000, 800, 3338]
  ),
];

// ── Section 2 : Bot Discord ────────────────────────────────────────
const section2 = [
  new Paragraph({ pageBreakBefore: true, children: [] }),
  h1("2. Bot Discord"),

  h2("2.1 État actuel"),
  h3("Stack technique"),
  bullet("Discord.js 14 + Node.js"),
  bullet("better-sqlite3 (audit log local + cache des licences)"),
  bullet("pg : connexion Postgres partagée avec le site (customers, licenses, signal_relays)"),
  bullet("Hébergement : Railway"),

  h3("Fonctionnalités déployées"),
  bullet("Commande /connect avec claim_code : consomme le code, crée la licence, lie le guild Discord au customer"),
  bullet("Broadcast de signaux de trading : ticker, side (long/short), entry/target/stop"),
  bullet("Passthrough des alertes TrendVision en mode raw"),
  bullet("Annonces IPO multi-ticker"),
  bullet("Market alerts : gaps, volume spikes, filtre RTH (9h30-16h ET), break PDH/PDL sur 2 jours"),
  bullet("Synchronisation périodique Postgres -> SQLite des cancellations"),
  bullet("Mirror des signaux vers Postgres signal_relays (alimente le dashboard client)"),
  bullet("Failover si Postgres indisponible : fallback SQLite legacy maintenu"),

  h2("2.2 Polish à faire"),
  p("Items orientés robustesse, observabilité et confort d’opération."),
  spacer(120),
  table(
    ["Catégorie", "Tache", "Priorité", "Notes"],
    [
      ["Tests", "Tests E2E avec un serveur Discord réel", "P0", "Couvre /connect, broadcast 4 types, mirror Postgres"],
      ["Tests", "Test rate-limit Discord (429)", "P1", "Vérif backoff et retry"],
      ["Monitoring", "Uptime check externe (UptimeRobot, Better Stack)", "P0", "Détecte si le bot est offline"],
      ["Monitoring", "Logs centralisés (Railway Pro logs ou Datadog)", "P1", "Recherche et alerting"],
      ["Monitoring", "Alerting sur erreurs Postgres répétées", "P1", "Webhook Slack/Discord"],
      ["Backup", "Sauvegarde quotidienne du SQLite", "P1", "Cron Railway + S3 ou rclone"],
      ["Sécurité", "Rotation périodique du token Discord", "P2", "Si compromission suspectée"],
      ["Sécurité", "Audit des permissions du bot dans chaque guild", "P1", "Principe de moindre privilège"],
      ["Doc", "README opérationnel : déploiement, env vars, runbook", "P1", "Pour onboarding futur"],
      ["Doc", "Liste documentée des commandes admin du bot", "P2", "Slash-commands inventory"],
      ["Performance", "Rate limiting per-guild côté bot", "P2", "Évite l’abus côté client"],
      ["Performance", "Métriques de latence broadcast", "P2", "p50/p95 par type d’alerte"],
    ],
    [1500, 4000, 800, 3338]
  ),
];

// ── Section 3 : Couts mensuels ─────────────────────────────────────
const section3 = [
  new Paragraph({ pageBreakBefore: true, children: [] }),
  h1("3. Couts mensuels — phase croissance"),

  p("Hypothèses retenues pour la phase de croissance : 50 à 200 clients actifs, 5 à 20 guilds Discord connectés, 10 à 50 k emails par mois (transactionnels + magic-link + onboarding), 100 à 500 signaux relayés par jour, 1 à 5 Go de données Postgres."),

  h2("3.1 Services SaaS"),
  spacer(120),
  table(
    ["Service", "Plan", "Cout mensuel", "Justification"],
    [
      ["Vercel", "Pro", "20 USD", "Analytics, image optimization, password protect, sièges multiples"],
      ["Railway (bot)", "Hobby + usage", "5 - 20 USD", "5 USD de base + RAM/CPU selon nombre de guilds"],
      ["Neon Postgres", "Launch / Pro", "0 - 19 USD", "Free tier 500 Mo ; Pro 19 USD au-delà"],
      ["Resend", "Pro", "20 USD", "50 k emails/mois (Free = 3 k/mois, insuffisant en croissance)"],
      ["Sentry", "Team", "26 USD", "Error monitoring frontend + backend, 50 k errors/mois"],
      ["Better Stack", "Team", "0 - 25 USD", "Uptime + logs ; Free Hobby suffit au début"],
      ["Plausible / PostHog", "Starter", "9 - 19 USD", "Analytics privacy-friendly"],
      ["Domaine .com", "Annuel /12", "~1 USD", "12 USD/an chez Cloudflare"],
      [
        { text: "Sous-total fixe", bold: true },
        { text: "—", bold: true, align: AlignmentType.CENTER },
        { text: "~80 - 130 USD", bold: true, color: ACCENT },
        { text: "Hors frais variables", bold: true },
      ],
    ],
    [2300, 1900, 1700, 3738]
  ),

  spacer(200),
  h2("3.2 Frais variables Stripe"),
  p("Stripe applique des frais par transaction qui ne dépendent pas d’un abonnement à un plan, mais du volume payé."),
  spacer(80),
  table(
    ["Type de carte", "Frais", "Notes"],
    [
      ["Carte européenne (EEE)", "1,4 % + 0,25 €", "La majorité des clients FR/EU"],
      ["Carte hors EEE (US, etc.)", "2,9 % + 0,25 €", "Surcout international"],
      ["Conversion devise", "+ 2 %", "Si paiement dans une devise différente"],
      ["Stripe Tax (optionnel)", "0,5 % du volume taxé", "Si activation TVA automatique"],
      ["Radar for fraud teams (option)", "0,05 USD / tx", "Si activation"],
    ],
    [2800, 2200, 4638]
  ),

  spacer(200),
  h2("3.3 Estimation totale"),
  p("Pour un MRR de 1 000 € avec une moyenne de 30 € par client (~33 clients) et frais Stripe européens :"),
  bullet("Cout fixe : ~100 USD = ~92 €"),
  bullet("Cout Stripe : 33 tx x (1,4 % de 30 + 0,25 €) = 33 x (0,42 + 0,25) = 22,11 €"),
  bullet("Total approximatif : ~114 € / mois pour 1 000 € de MRR"),
  spacer(120),
  p("Pour un MRR de 5 000 €, le cout fixe reste sensiblement identique, le cout Stripe monte à ~110 € : marge brute infrastructure ~96 %."),

  spacer(200),
  h2("3.4 Note sur la phase de démarrage"),
  p("Avant 50 clients, la plupart des services restent gratuits (Vercel Hobby, Neon Free, Resend Free, Sentry Developer, UptimeRobot Free) : le cout fixe descend à ~6 USD/mois (Railway + domaine). Le passage aux plans payants se fait progressivement à mesure que les seuils sont atteints."),
];

// ── Section 4 : Couts one-shot ─────────────────────────────────────
const section4 = [
  new Paragraph({ pageBreakBefore: true, children: [] }),
  h1("4. Couts one-shot"),
  p("Dépenses ponctuelles à prévoir pour le lancement. Les fourchettes basses correspondent à une approche DIY (templates, freelances bon marché), les fourchettes hautes à du sur-mesure professionnel."),
  spacer(120),
  table(
    ["Item", "Cout estimé", "Notes"],
    [
      ["Domaine (1ʳᵉ année)", "12 €", "Cloudflare Registrar (renouvellement ~12 €/an)"],
      ["Logo design", "0 - 500 €", "DIY (Figma/Canva), Fiverr ~50 €, ou designer freelance 200-500 €"],
      ["Image OG, favicon, assets visuels", "0 - 200 €", "DIY ou freelance"],
      ["CGV / CGU / Mentions légales", "0 - 2 000 €", "Templates Captain Contrat ~50-100 €, ou avocat 500-2 000 €"],
      ["Politique de confidentialité RGPD", "0 - 300 €", "Templates gratuits ou rédaction sur-mesure"],
      ["Setup Stripe production (KYC)", "0 €", "Temps admin uniquement (1 à 3 h)"],
      ["Vérification domaine email (DKIM/SPF/DMARC)", "0 €", "Configuration DNS, ~30 min"],
      ["Beta testers (compensation optionnelle)", "0 - 500 €", "Crédits, mois offerts, ou rémunération directe"],
      ["Compte développeur Discord", "0 €", "Gratuit"],
      ["Outils de design (Figma)", "0 - 12 €/mois", "Free tier suffisant pour usage perso"],
      ["Captures écran / vidéos démo landing", "0 - 200 €", "DIY (Loom, OBS) ou prestataire"],
      [
        { text: "Total fourchette basse", bold: true },
        { text: "~12 €", bold: true, color: ACCENT },
        { text: "Approche DIY maximale", bold: true },
      ],
      [
        { text: "Total fourchette haute", bold: true },
        { text: "~3 700 €", bold: true, color: ACCENT },
        { text: "Approche professionnelle (logo, légal, design)", bold: true },
      ],
      [
        { text: "Total recommandé pragmatique", bold: true, color: ACCENT },
        { text: "~300 - 700 €", bold: true, color: ACCENT },
        { text: "Domaine + logo Fiverr + CGV Captain Contrat + assets de base", bold: true, color: ACCENT },
      ],
    ],
    [3500, 2200, 3938]
  ),
];

// ── Section 5 : Ordre d'exécution ─────────────────────────────────
const section5 = [
  new Paragraph({ pageBreakBefore: true, children: [] }),
  h1("5. Ordre d’exécution recommandé"),
  p("Séquence des étapes du lancement, calibrée sur ~30 jours du J0 au lancement public. Les jours indiqués sont indicatifs et certaines étapes peuvent être parallélisées."),

  h2("5.1 Phase 1 — Infrastructure de production (J0 à J3)"),
  numbered("Acheter le domaine (Cloudflare Registrar). Configurer les DNS de base."),
  numbered("Créer le compte Stripe en mode live, lancer le KYC (pièce d’identité, IBAN, justificatif d’adresse)."),
  numbered("Créer le compte Resend en plan Pro, ajouter le domaine, configurer DKIM / SPF / DMARC dans le DNS."),
  numbered("Lier le domaine à Vercel : DNS, vérification SSL automatique, redirect www <-> apex."),
  numbered("Provisionner les variables d’environnement de production sur Vercel : clés Stripe live, clé Resend live, secret webhook, etc."),
  spacer(140),

  h2("5.2 Phase 2 — Contenu et conformité (J3 à J7)"),
  numbered("Remplir la FAQ via le panel admin (8 à 12 questions clés)."),
  numbered("Rédiger les pages légales : CGV, CGU, mentions légales, politique de confidentialité (templates Captain Contrat ou avocat)."),
  numbered("Finaliser le copy marketing de la landing, les descriptions de plans et les features."),
  numbered("Importer le logo, le favicon et l’image OG dans le CMS section Brand."),
  numbered("Implémenter le cookie banner RGPD avec consentement granulaire."),
  numbered("Signer et archiver les DPA (Stripe, Vercel, Resend, Neon)."),
  spacer(140),

  h2("5.3 Phase 3 — Configuration commerciale (J7 à J9)"),
  numbered("Créer les produits et prix dans Stripe (mode live)."),
  numbered("Synchroniser stripe_price_id_monthly et _annual dans la table plans côté DB."),
  numbered("Configurer le webhook de production avec le secret signé, le pointer vers /api/stripe/webhook."),
  numbered("Tester un paiement réel en mode live avec une carte personnelle, vérifier la création du customer + magic-link, refund immédiat."),
  spacer(140),

  h2("5.4 Phase 4 — Observabilité (J9 à J11)"),
  numbered("Activer Sentry frontend et backend, configurer l’alerting Slack / email."),
  numbered("Activer Vercel Analytics (Pro)."),
  numbered("Configurer un check uptime externe (Better Stack ou UptimeRobot) pour la landing, le bot Discord, l’endpoint webhook Stripe."),
  numbered("Mettre en place un check de santé DB (latence, connexions actives) via Sentry ou Better Stack."),
  spacer(140),

  h2("5.5 Phase 5 — Tests end-to-end (J11 à J14)"),
  numbered("Tests E2E en preview : paiement test, magic-link, dashboard client, panel admin (toutes les sections)."),
  numbered("Tests bot avec un serveur Discord réel : /connect avec un claim_code, broadcast des 4 types d’alertes, vérification du mirror Postgres."),
  numbered("Smoke test en production : 1 paiement réel, vérification email, login, dashboard, refund."),
  numbered("Vérifier les emails (mail-tester.com, score >= 9/10) et la délivrabilité chez Gmail / Outlook / Apple Mail."),
  spacer(140),

  h2("5.6 Phase 6 — Soft launch (J14 à J21)"),
  numbered("Inviter 5 à 10 beta testeurs (réseau personnel, Discord trading communities)."),
  numbered("Collecter les retours via formulaire ou DM Discord : bugs, friction d’onboarding, suggestions de copy."),
  numbered("Itérer rapidement : corrections P0 dans les 24h, P1 dans la semaine."),
  numbered("Affiner le copy de la landing en fonction des objections récurrentes."),
  spacer(140),

  h2("5.7 Phase 7 — Itération et optimisation (J21 à J30)"),
  numbered("Polir l’UX selon les retours beta : copy, micro-interactions, états d’erreur."),
  numbered("Optimiser la conversion landing : tests A/B headline et pricing si pertinent."),
  numbered("Préparer les supports d’acquisition : posts LinkedIn / X, vidéo démo Loom, landing alternatives."),
  numbered("Configurer (optionnel) un tracking d’attribution simple (UTM + Vercel Analytics)."),
  spacer(140),

  h2("5.8 Phase 8 — Lancement public (J30+)"),
  numbered("Annonce sur les canaux organiques : LinkedIn, X, communautés Discord, forums trading FR."),
  numbered("Activer (si budget) une campagne Meta Ads ou Google Ads ciblée."),
  numbered("Monitoring quotidien des metrics clés : visiteurs, conversion landing -> checkout, taux de complétion onboarding, taux de churn."),
  numbered("Routine hebdomadaire de revue produit : bugs prioritaires, features demandées, decisions roadmap."),
];

// ── Conclusion ─────────────────────────────────────────────────────
const conclusion = [
  new Paragraph({ pageBreakBefore: true, children: [] }),
  h1("Conclusion"),
  p("Le produit est techniquement prêt à 80 %. Les 20 % restants sont essentiellement de la mise en production externe (Stripe live, Resend, domaine, conformité légale) et du contenu marketing, plus que du développement."),
  p("Le cout d’entrée en phase démarrage est très faible (~6 USD/mois) grace aux free tiers. Le passage à la phase de croissance se fait par paliers, et reste sous les 130 USD de cout fixe mensuel pour servir des centaines de clients, soit une marge brute infrastructure supérieure à 95 % au-delà de quelques milliers d’euros de MRR."),
  p("L’ordre d’exécution proposé permet d’aller du J0 à un soft launch documenté en environ 14 jours, et à un lancement public en 30 jours, en supposant qu’aucun blocage majeur ne survient sur le KYC Stripe (qui peut prendre 2 à 5 jours ouvrés)."),
  p("Les principaux risques résiduels à surveiller : 1) la délivrabilité email dès les premiers volumes, 2) la stabilité du bot Discord en cas de pic de signaux, 3) la conformité légale FR/EU avec une attention particulière sur la TVA si dépassement des seuils."),
];

// ── Document complet ──────────────────────────────────────────────
const doc = new Document({
  creator: "Temple of Boom",
  title: "Temple of Boom — Plan de lancement",
  description: "Plan de lancement complet : état du produit, taches restantes, couts, ordre d’exécution",
  styles: {
    default: { document: { run: { font: "Arial", size: 22, color: TEXT } } },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: HEADING },
        paragraph: { spacing: { before: 480, after: 240 }, outlineLevel: 0 },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: ACCENT },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 1 },
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: ACCENT_SOFT },
        paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 2 },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
          {
            level: 1,
            format: LevelFormat.BULLET,
            text: "◦",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
          },
        ],
      },
      {
        reference: "numbers",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: A4_WIDTH, height: A4_HEIGHT },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({
                text: "Temple of Boom — Plan de lancement",
                size: 18, color: TEXT_LIGHT, italics: true, font: "Arial",
              })],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "Page ", size: 18, color: TEXT_LIGHT, font: "Arial" }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: TEXT_LIGHT, font: "Arial" }),
                new TextRun({ text: " / ", size: 18, color: TEXT_LIGHT, font: "Arial" }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: TEXT_LIGHT, font: "Arial" }),
              ],
            }),
          ],
        }),
      },
      children: [
        ...titlePage,
        ...synthesis,
        ...section1,
        ...section2,
        ...section3,
        ...section4,
        ...section5,
        ...conclusion,
      ],
    },
  ],
});

Packer.toBuffer(doc)
  .then((buf) => {
    const out = path.join(__dirname, "Temple-of-Boom-Plan-de-lancement.docx");
    fs.writeFileSync(out, buf);
    console.log("OK:", out);
    console.log("Size:", buf.length, "bytes");
  })
  .catch((err) => {
    console.error("Failed to build docx:", err);
    process.exit(1);
  });
