# Remotion — fondation + Brand Promo (Phase 1) — design

## Contexte

L'utilisateur veut générer des vidéos marketing courtes pour les réseaux sociaux à partir des données et de l'identité de BOOM. Quatre formats ont été identifiés (Signal Alert, Weekly Recap, Proof Video, Brand Promo). Pour découper le risque, cette Phase 1 livre :

1. **La fondation Remotion** : sous-projet `video/` autonome dans le repo, capable de rendre n'importe quelle composition React en MP4 via CLI.
2. **Un premier template** : Brand Promo (vertical 9:16, 15 s, 3 beats) — pas de dépendance aux données du bot, focus 100 % sur la stack.

Les autres templates (A Signal Alert, B Weekly Recap, C Proof Video) seront ajoutés dans des sessions futures, chacun en réutilisant la fondation.

## Architecture

### Stack et localisation

- **Sous-projet `video/`** à la racine du repo, avec son propre `package.json`, ses propres dépendances et son propre lockfile.
- **Stack** : Remotion (latest), React 18, TypeScript, ESBuild bundler intégré à Remotion.
- **Pas d'impact sur le bot principal** : le `package.json` racine reste en JavaScript, sans React ni TypeScript. Railway ne déploie que la racine ; il ignore `video/` car le `start` script du bot ne le touche pas.
- **Rendu local CLI** uniquement pour Phase 1. La commande `npm run render` dans `video/` produit un MP4 dans `video/out/`. Aucun rendu côté serveur.

### Structure de fichiers

```
discord-trading-bot/
├── canvas/                  (existant, JS)
├── discord/                 (existant)
├── video/                   ← nouveau sous-projet TypeScript
│   ├── package.json         (dépendances Remotion)
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── remotion.config.ts   (config bundler)
│   ├── src/
│   │   ├── index.ts         (entrée Remotion : registerRoot)
│   │   ├── Root.tsx         (registre des compositions)
│   │   ├── compositions/
│   │   │   └── BrandPromo.tsx
│   │   └── components/
│   │       ├── HookBeat.tsx
│   │       ├── ValueBeat.tsx
│   │       └── CtaBeat.tsx
│   ├── public/
│   │   ├── logo_boom.png    (copié de la racine)
│   │   └── audio/
│   │       └── .gitkeep     (slot audio réservé, vide pour Phase 1)
│   └── out/                 (gitignored, MP4 sortis)
├── docs/
├── package.json             (inchangé)
└── .gitignore               (ajout : video/node_modules/, video/out/)
```

### Pourquoi un sous-projet plutôt qu'un workspace ou une intégration directe

- **Sous-projet (choisi)** : isolation propre, deux mondes qui ne se mélangent pas, déploiement Railway intact.
- **Workspace npm** : surcharge de configuration, peu de bénéfice pour ce cas (pas de partage de code prévu pour Phase 1).
- **Intégration directe** : forcerait le bot à passer en TypeScript ou à mélanger les deux ; sapperait Railway (Chromium dans le container).

## Composition : Brand Promo

**Spécifications techniques :**
- Format : 1080 × 1920 (9:16 vertical)
- Durée : 15 s
- Frame rate : 30 fps → `durationInFrames: 450`
- Codec : H.264 (MP4)
- ID composition : `BrandPromo`

**Structure narrative (3 beats) :**

| Beat | Frames | Durée | Contenu |
|------|--------|-------|---------|
| 1. Hook | 0–90 | 0–3 s | Texte « STOP GUESSING TRADES » sur fond noir. Animation : flash + zoom in via `spring()`. |
| 2. Value | 90–330 | 3–11 s | Texte « Real-time signals from top traders » + 3 cartes Discord (Z, Bora, Viking) qui apparaissent séquentiellement (1 carte par seconde, slide-up). Fond gradient noir → bleu nuit. |
| 3. CTA | 330–450 | 11–15 s | Logo BOOM qui pulse (scale `spring`), tagline « Trading signals. Real results. », bouton « JOIN NOW → », URL `discord.gg/boom`. Fond radial gradient bleu. Flash blanc final aux 3 dernières frames. |

**Audio :** slot réservé via `<Audio src={staticFile('audio/track.mp3')} />` placé dans la composition mais commenté. L'utilisateur ajoute son MP3 dans `video/public/audio/track.mp3` plus tard, décommente la ligne, re-rend.

**Texte hardcodé** dans Phase 1 (variables des composants `HookBeat`, `ValueBeat`, `CtaBeat`). Les changer plus tard nécessite d'éditer les `.tsx`. Pas de CLI args ni de config externe en Phase 1 (YAGNI).

## Pipeline de rendu

### Trigger : CLI

Deux scripts npm dans `video/package.json` :

```json
{
  "scripts": {
    "studio": "remotion studio",
    "render": "remotion render BrandPromo out/brand-promo.mp4"
  }
}
```

- `npm run studio` (depuis `video/`) — ouvre l'éditeur Remotion en local (preview, scrub, hot reload). Sert au développement.
- `npm run render` (depuis `video/`) — produit un MP4 dans `out/brand-promo.mp4`. Écrase le fichier précédent.

### Sortie

Fichier unique `video/out/brand-promo.mp4`. Si l'utilisateur veut conserver des versions, il renomme manuellement avant le prochain rendu. Pas de timestamping automatique en Phase 1 (YAGNI — on évite de polluer `out/` avec des fichiers oubliés).

### Distribution — local uniquement, upgrade-friendly

Phase 1 : **fichier MP4 local, point.** L'utilisateur ouvre `video/out/brand-promo.mp4` et l'upload manuellement où il veut (Instagram, TikTok, X, etc.). Aucun upload automatique, aucune URL publique, aucune notification.

Cette décision est explicite et cohérente avec :
- Un Brand Promo se rend rarement (une fois, puis utilisé pendant des mois) → la friction du upload manuel est négligeable.
- Architecture locale CLI déjà actée — pas de surface réseau, zéro infra à débugger.

**Porte d'entrée pour l'automatisation future** : la composition Remotion (`BrandPromo.tsx`) est totalement découplée du driver de rendu. Quand une session future ajoutera l'automatisation (par exemple : auto-post dans un canal Discord à chaque rendu, ou upload S3 quand A/B/C deviennent fréquents), le code ajouté wrappera l'appel `npm run render` ou `renderMedia()` sans toucher aux compositions. Aucun verrouillage architectural en Phase 1.

### Performance attendue

Sur une machine locale moderne, 15 s de rendu à 1080×1920 30 fps prennent ~10–30 s selon le CPU. Acceptable pour un usage manuel.

## Tests

Deux niveaux :

1. **Compilation TypeScript** : `tsc --noEmit` doit passer sur tout `video/src/`. Garantit que les imports résolvent et les types sont cohérents. Branché sur le script `npm test` de `video/`.

2. **Validation composition** : un test programmatique qui appelle `selectComposition` (API officielle de `@remotion/renderer`) sur le bundle pour vérifier que la composition `BrandPromo` est bien registered avec `width: 1080`, `height: 1920`, `fps: 30`, `durationInFrames: 450`. Utilise `vitest` comme runner. Lent (~3-5 s à cause du bundle) mais robuste — touche à la vraie API Remotion, pas un mock fragile.

3. **Manuel : end-to-end render** : l'utilisateur exécute `npm run render` une fois et vérifie visuellement le MP4 sorti. Non automatisé en CI (rendu trop coûteux ; nécessite Chromium binary).

Le test runner dans `video/` est `vitest` (nécessaire car Remotion = TypeScript + JSX, et le `node:test` racine ne gère pas le TSX). Le test runner racine reste `node:test`. Aucun couplage entre les deux.

## Hors scope (Phase 1)

- Templates A (Signal Alert), B (Weekly Recap), C (Proof Video) — phases futures.
- Server-side rendering, endpoint HTTP — Phase 3.
- Automatisation (auto-render à la réception d'un signal, cron hebdo) — Phase 3.
- Customisation par CLI args ou JSON — pas nécessaire pour D, viendra avec A/B/C.
- **Auto-post Discord, upload S3/CDN, post automatique sur les réseaux sociaux** — explicitement reportés. La composition est conçue pour rester compatible avec ces ajouts (cf. section Distribution ci-dessus).
- Génération en plusieurs ratios (1:1, 16:9) — Phase 1 = 9:16 seul.
- Import de musique — slot réservé mais l'utilisateur fournira le MP3 hors session.
- Préchargement des fonts custom — système font (sans-serif) suffit pour Phase 1.

## Vérification

Au sortir de Phase 1 :

1. `cd video && npm install` doit fonctionner sans erreur.
2. `cd video && npm run studio` doit ouvrir l'éditeur Remotion sur `http://localhost:3000` et afficher la composition `BrandPromo` jouable.
3. `cd video && npm test` doit passer (tous les smoke tests).
4. `cd video && npm run render` doit produire `video/out/brand-promo.mp4` (~5–10 MB) en moins de 60 s.
5. Le MP4 ouvert dans VLC/QuickTime doit montrer les 3 beats dans l'ordre, durée 15 s, 1080×1920.
6. Le bot principal (`npm test` à la racine) doit toujours passer ses 146 tests existants — aucune régression.
