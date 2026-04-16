# Design Spec — Refonte légère de l'interface web

**Date :** 2026-04-16  
**Scope :** Toutes les pages web du bot (desktop uniquement)  
**Approche choisie :** Option A — Refonte légère

---

## Objectif

Moderniser l'ergonomie et l'apparence de l'interface web sans restructurer la logique métier ni risquer de régressions. Le HTML de chaque page vit dans `index.js` comme template string ; on injecte un bloc CSS+HTML commun dans chacun.

---

## Structure globale

Layout deux colonnes sur toutes les pages authentifiées :

- **Sidebar fixe gauche (220px)** — logo, navigation, état actif
- **Zone contenu** — prend le reste de la largeur (`calc(100vw - 220px)`)

La page `/login` reste sans sidebar (layout plein écran centré).

---

## Sidebar

### Éléments

| Icône | Label            | Route              |
|-------|------------------|--------------------|
| 📡    | Dashboard        | `/dashboard`       |
| 📊    | Stats            | `/stats`           |
| 💰    | Profits          | `/profits`         |
| 📰    | News             | `/news`            |
| 🏆    | Leaderboard      | `/leaderboard`     |
| 🖼️   | Image Generator  | `/image-generator` |
| 🔍    | Proof Generator  | `/proof-generator` |
| 📋    | Raw Messages     | `/raw-messages`    |
| ⚙️   | Config           | `/config`          |

### Comportement

- Page active détectée via `window.location.pathname` en JS inline.
- Lien actif : fond `#5865f222`, texte `#5865f2`, bordure gauche `3px solid #5865f2`.
- Logo "BOOM" en haut de la sidebar.
- Pas de dépendance externe (pas de bibliothèque d'icônes — Unicode uniquement).

### Suppression du header actuel

Le `<header>` existant contenant les `nav-link` est supprimé sur toutes les pages. Un titre de page léger (`<h1>`) est intégré en haut de la zone contenu à la place.

---

## Palette de couleurs

| Rôle               | Valeur    |
|--------------------|-----------|
| Sidebar fond       | `#1a1b1e` |
| Fond principal     | `#1e1f22` |
| Panels / cards     | `#2b2d31` |
| Bordures           | `#3f4147` |
| Accent UI          | `#5865f2` |
| Texte primaire     | `#f2f3f5` |
| Texte secondaire   | `#80848e` |
| Noms d'auteurs     | `#D649CC` (inchangé) |

---

## Typographie

- Police principale : `Inter` (Google Fonts, weights 400/600/700)
- Fallback : `system-ui, sans-serif`
- Le `<link>` Google Fonts est injecté dans le `<head>` de chaque template.

---

## Composants visuels

### Cards / Panels
- `border-radius: 8px`
- `border: 1px solid #3f4147`
- Espacement intérieur : `16px`
- Fond : `#2b2d31`

### Boutons
- Confirm / positif : vert `#3ba55d`
- Danger / négatif : rouge `#ed4245`
- Action neutre : bleu `#5865f2`
- Style unifié : `border-radius: 6px`, `padding: 6px 14px`, `font-weight: 600`
- Hover : légère surbrillance de fond

### Tableaux
- Inchangés structurellement
- `thead` : `font-size: 11px`, uppercase, `color: #80848e`
- Lignes alternées légèrement plus visibles au hover

---

## Implémentation

### Stratégie

Créer un bloc CSS+HTML unique (`SIDEBAR_HTML` + `COMMON_CSS`) à injecter dans chaque template. Chaque template reçoit :

1. Le `<link>` Inter dans `<head>`
2. Le CSS commun dans `<style>`
3. Le HTML de la sidebar juste après `<body>`
4. Un wrapper `<div id="page-content">` autour du contenu existant

### Fichier concerné

`index.js` — les 9 constantes HTML :
- `DASHBOARD_HTML`
- `STATS_HTML`
- `PROFITS_PAGE_HTML`
- `NEWS_PAGE_HTML`
- `LEADERBOARD_HTML`
- `IMAGE_GEN_HTML`
- `PROOF_GEN_HTML`
- `RAW_MESSAGES_HTML`
- Un template pour `/config` (généré dynamiquement, à vérifier)

### Ce qui ne change pas

- Toute la logique JS côté client de chaque page
- Les routes Express
- Les appels API
- Les couleurs spécifiques aux badges (`b-entry`, `b-exit`, etc.)
- Les couleurs des noms d'auteurs (`#D649CC`)

---

## Hors scope

- Responsive mobile
- Animations de transition entre pages
- Refonte des composants spécifiques (canvas image, formulaires complexes)
- Authentification ou logique serveur
