# Design Spec — Refresh design system (SaaS modern)

**Date :** 2026-04-16
**Scope :** Refresh visuel global de toutes les pages web (desktop uniquement)
**Approche choisie :** Option A — Refresh du design system via `COMMON_CSS`

---

## Objectif

Rendre le site plus moderne (style Linear / Notion / Vercel) en agissant principalement sur le `COMMON_CSS` partagé par les 9 pages. Nouvelle palette plus contrastée, effet glassmorphism sur les cards, coins plus arrondis, ombres multicouches, animations subtiles, espacements plus généreux.

Aucune logique métier ni JavaScript n'est touché. Seul le CSS commun et les règles spécifiques par page sont mises à jour.

---

## 1. Palette

### Couleurs de fond

| Rôle               | Actuel        | Nouveau                          |
|--------------------|---------------|----------------------------------|
| Fond principal     | `#1e1f22`     | `#0a0a0f`                        |
| Sidebar            | `#1a1b1e`     | `#0f0f14`                        |
| Cards              | `#2b2d31`     | `rgba(255,255,255,0.03)`         |
| Bordures           | `#3f4147`     | `rgba(255,255,255,0.08)`         |
| Bordures hover     | —             | `rgba(139,92,246,0.3)`           |

### Texte

| Rôle               | Actuel        | Nouveau    |
|--------------------|---------------|------------|
| Primaire           | `#f2f3f5`     | `#fafafa`  |
| Secondaire         | `#80848e`     | `#a0a0b0`  |
| Désactivé          | —             | `#6b6b7a`  |
| Auteur (`.auth`)   | `#D649CC`     | inchangé   |

### Gradient signature

```css
--gradient-primary: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
```

**Utilisé sur :**
- Logo "BOOM" dans la sidebar (texte via `background-clip: text`)
- Bordure gauche du lien actif de la sidebar (3px, gradient vertical)
- Boutons primaires (`.btn-primary`, `.btn-refresh`, `.btn-add`)
- Barres de progression (Stats, Profits)
- Titres `h1.page-title` (effet subtil via underline gradient optionnel)

---

## 2. Glassmorphism, ombres & rayons

### Cards

```css
background: rgba(255, 255, 255, 0.03);
backdrop-filter: blur(20px);
-webkit-backdrop-filter: blur(20px);
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 12px;
box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.1);
```

### Cards hover

```css
transform: translateY(-2px);
box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(139, 92, 246, 0.3);
```

### Rayons de coins

| Élément        | Rayon   |
|----------------|---------|
| Cards          | `12px`  |
| Boutons        | `8px`   |
| Inputs/selects | `8px`   |
| Badges         | `6px`   |
| Tags           | `6px`   |

### Sidebar

Même traitement glass que les cards, avec bordure droite en dégradé vertical subtil :

```css
border-right: 1px solid rgba(255, 255, 255, 0.05);
background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.005));
backdrop-filter: blur(20px);
```

---

## 3. Typographie

Échelle de tailles et poids :

| Élément          | Taille  | Poids | Autres                                       |
|------------------|---------|-------|----------------------------------------------|
| `h1.page-title`  | 22px    | 700   | `letter-spacing: -0.02em`                    |
| `h2`             | 16px    | 600   | `letter-spacing: -0.01em`                    |
| `body`           | 14px    | 400   | `line-height: 1.5`                           |
| `.card-title`    | 11px    | 700   | `text-transform: uppercase, letter-spacing: 0.08em, color: #a0a0b0` |
| `.big-number`    | 52px    | 800   | `font-variant-numeric: tabular-nums`         |
| Stats / chiffres | variable| 700+  | `font-variant-numeric: tabular-nums`         |

---

## 4. Animations & transitions

### Global

Transitions appliquées aux éléments interactifs uniquement (pas `*`, pour éviter les animations indésirables sur tableaux/contenu statique) :

```css
a, button, .card, .btn, .nav-sidebar a, input, select, textarea {
  transition: background-color 200ms cubic-bezier(0.4, 0, 0.2, 1),
              border-color 200ms cubic-bezier(0.4, 0, 0.2, 1),
              color 200ms cubic-bezier(0.4, 0, 0.2, 1),
              transform 200ms cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Entrée de page

Cards animées à l'apparition :

```css
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.card { animation: fadeInUp 400ms cubic-bezier(0.4, 0, 0.2, 1) both; }
.card:nth-child(2) { animation-delay: 50ms; }
.card:nth-child(3) { animation-delay: 100ms; }
.card:nth-child(4) { animation-delay: 150ms; }
```

### Hover cards

```css
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(139, 92, 246, 0.3);
}
```

### Boutons primaires

Gradient qui "glisse" au hover :

```css
.btn-primary {
  background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
  background-size: 200% 200%;
  background-position: 0% 50%;
  transition: background-position 400ms ease, transform 200ms ease;
}
.btn-primary:hover { background-position: 100% 50%; transform: translateY(-1px); }
```

### Lien sidebar actif

Barre gauche qui reste visible, mais s'épaissit au hover :

```css
.nav-sidebar a { border-left: 3px solid transparent; }
.nav-sidebar a.active {
  border-left: 3px solid transparent;
  background-image: linear-gradient(180deg, #3b82f6, #8b5cf6);
  background-origin: border-box;
  background-clip: border-box;
}
```

*(approche simplifiée : bordure gauche en gradient vertical)*

### Loading shimmer

Remplace les "Chargement..." par un shimmer animé :

```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.shimmer {
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
```

---

## 5. Espacement

| Élément                  | Actuel       | Nouveau      |
|--------------------------|--------------|--------------|
| Padding cards            | `16–20px`    | `24px`       |
| Gap entre cards          | `12px`       | `20px`       |
| Padding `.page-header`   | `14px 24px`  | `20px 32px`  |
| Padding `#wrap`          | `16–24px`    | `24px 32px`  |
| Gap dans `.page-header`  | `10px`       | `14px`       |

---

## Implémentation

### Stratégie

Le gros du travail est dans `COMMON_CSS` (défini une fois dans `index.js` avant `DASHBOARD_HTML`). Quelques règles par page peuvent nécessiter des ajustements mineurs pour compatibilité (par ex. certaines pages ont leurs propres `.card`, `.btn-primary`, etc. — les règles page-level overrideront `COMMON_CSS` où nécessaire).

### Fichier concerné

`index.js` uniquement. Les pages touchées sont les mêmes 9 que l'itération précédente :
- `DASHBOARD_HTML`
- `STATS_HTML`
- `PROFITS_PAGE_HTML`
- `NEWS_PAGE_HTML`
- `LEADERBOARD_HTML`
- `IMAGE_GEN_HTML`
- `PROOF_GEN_HTML`
- `RAW_MESSAGES_HTML`
- `configPageHtml` (inline)

### Ce qui ne change pas

- Structure HTML (sidebar + page-content + page-header + contenu)
- Tous les JavaScripts
- Routes Express
- Logique métier

---

## Hors scope

- Responsive mobile (desktop uniquement, comme itération précédente)
- Refonte complète page par page (Option B brainstormée mais refusée)
- Passage à Tailwind ou framework CSS
- Redesign des graphiques SVG (Profits, Stats) — conserve la logique existante
- Icônes (on garde les emojis Unicode actuels)
