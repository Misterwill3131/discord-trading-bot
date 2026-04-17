# Design Spec — Proof Generator Discord-style redesign

**Date:** 2026-04-16
**Scope:** Redesigner l'image générée par `/proof-generator` pour qu'elle ressemble à de vrais messages Discord avec avatar, badges de rôle et timestamp complet.

---

## Objectif

Remplacer les blocs colorés "ORIGINAL ALERT" / "RESULT" par deux messages Discord authentiques (avatar circulaire, badges de rôle, timestamp date+heure) pour que l'image proof soit visuellement identique à un screenshot Discord.

---

## 1. Layout de l'image générée (740px)

```
┌─ Header BOOM (inchangé) ──────────────────────────────────────┐
│  Logo BOOM  │  Trade Proof • discord.gg/templeofboom          │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  [avatar]  ZZ  [🔥 BOOM]  [boom]  13 avr. 2026 · 10:27      │
│            MNTS in small at 4.20                             │
│                                                               │
│  ─────────────────────────────────────────────────────────   │
│                                                               │
│  [avatar]  ZZ  [🔥 BOOM]  [boom]  13 avr. 2026 · 10:45      │
│            MNTS 4.2-4.72 🎉                                  │
│                                                               │
└─ Footer discord.gg/templeofboom (inchangé) ───────────────────┘
```

---

## 2. Composants d'un message Discord

### 2.1 Avatar
- Cercle de 40px de diamètre
- Source : `CUSTOM_AVATARS[author]` (fichiers locaux déjà en place)
- Fallback : cercle `#5865f2` avec initiales en blanc (comportement actuel conservé)

### 2.2 Ligne nom + badges + timestamp
Ordre : **nom** · **badge 🔥 BOOM** · **badge boom** · **timestamp**

**Nom :** gradient rose `#ff79f2` → `#d649cc`, bold 15px (inchangé sauf `Legacy Trading` = `#e84040`)

**Badge `🔥 BOOM` :**
- Fond : `rgba(214,73,204,0.15)` (rose transparent)
- Bordure : `rgba(214,73,204,0.4)`
- Texte : `#d649cc`, bold 10px
- Forme : pill (border-radius 3px), padding 2px 6px

**Badge `boom` :**
- Fond : `rgba(255,255,255,0.06)`
- Bordure : `rgba(255,255,255,0.12)`
- Texte : `#a0a0b0`, 10px
- Forme : pill identique

**Timestamp :** `13 avr. 2026 · 10:27` (format `fr-FR` locale date courte `{ day:'numeric', month:'short', year:'numeric' }` + ` · ` + heure HH:mm), couleur `#72767d`, 11px

### 2.3 Contenu du message
- Couleur `#dcddde`, 15px (inchangé)
- Wrapping identique à l'actuel

---

## 3. Séparateur entre les deux messages

Ligne horizontale fine `#3f4147`, opacité 60%, de x=40 à x=W-40, centrée dans un espace vertical de 20px.
Remplace l'actuelle grosse flèche ↓ et la ligne pointillée.

---

## 4. Ce qui ne change pas

- Header BOOM (logo + texte)
- Footer (`discord.gg/templeofboom`)
- Fonction `wrapText()`
- Map `CUSTOM_AVATARS`
- API endpoint `GET /api/proof-image` — mêmes paramètres
- Page web `/proof-generator` — aucun changement HTML/JS
- Auto-proof Discord (ligne ~5231) — appelle toujours `generateProofImage()`

---

## 5. Implémentation

### Fichiers concernés
- **Modifier :** `index.js` uniquement
  - `drawMessageBlock()` (~ligne 4075) : supprimer le label badge, ajouter badges Discord + timestamp complet
  - `generateProofImage()` (~ligne 4180) : supprimer le divider élaboré, remplacer par séparateur fin

### Calcul des hauteurs
`drawMessageBlock()` retourne la hauteur du bloc pour que `generateProofImage()` calcule `H` dynamiquement — ce mécanisme est conservé.

Nouvelle hauteur d'un bloc (sans label badge) :
```
blockH = PADDING_V + AVATAR_D + PADDING_V + lines.length * LINE_H + PADDING_V
```
(où `AVATAR_D` = 40px = hauteur de la ligne nom+badges)

### Hauteur du séparateur
`DIVIDER_H = 20` (réduit de 44 à 20)

---

## Hors scope

- Changement de la page web `/proof-generator`
- Badges dynamiques par utilisateur (fixed pour tous)
- Import d'avatars depuis Discord API (avatars locaux suffisants)
- Modification des autres générateurs d'images (promo, signal card)
