# Video templates overhaul (Phase 2.5) — lifestyle hook + proof video — design

## Contexte

Phase 1 a livré `BrandPromo` (15s pure marque), Phase 2 a livré `SignalAlert` (6s alerte simple). Le retour utilisateur après livraison :

1. **Trop court** pour TikTok/Reels — il faut respirer la story
2. **Pas assez accrocheur** — manque d'éléments visuels qui stoppent le scroll
3. **Pas de proof complet** — montrer juste l'entrée OU la sortie ne raconte pas l'histoire
4. **Pas de visuel "richesse"** — les comptes trading qui font des vues utilisent imagery lifestyle (yacht, supercars, penthouse) en hook

Phase 2.5 livre 4 changements coordonnés :

1. **Greffe d'un hook lifestyle** (3s rapid cuts d'imagery luxe) au début de **chaque** composition
2. **Refonte de `DataAct`** dans la `SignalAlert` existante en carte Discord native (au lieu du LONG/Entry/Target/Stop abstrait)
3. **Nouvelle composition `SignalAlertProof`** — vidéo proof complète 17s : entry message → time pass + chart → exit message → result
4. **Capability chart explosion synthétique** — auto sur `pnl` positif

Pas un Phase 3 (bot automation) — toujours du rendu manuel CLI.

## Architecture

### Structure des assets après Phase 2.5

```
video/public/
├── logo_boom.png            (existant Phase 1)
├── tag_boom.png             (NEW : badge BOOM, copié de avatar/tag_boom.png)
├── audio/
│   └── .gitkeep             (existant Phase 1)
├── avatars/                 (NEW : 17 PNG copiés de avatar/)
│   ├── z-avatar.jpg
│   ├── AR_AVATAR.png
│   ├── beppels_avatar.png
│   ├── …
│   └── Protrader Alerts_avatar.png
└── lifestyle/               (NEW : starter pack CC0)
    ├── yacht-1.jpg
    ├── yacht-2.jpg
    ├── supercar-red.jpg
    ├── supercar-yellow.jpg
    ├── penthouse-view.jpg
    ├── penthouse-night.jpg
    ├── watch-luxury.jpg
    ├── money-stack.jpg
    ├── private-jet.jpg
    └── skyline-night.jpg     (10 images de starter pack)
```

### Sourcing du lifestyle starter pack (option C hybride)

Le plan d'implémentation aura un script Node simple qui télécharge les 10 images depuis Pexels/Unsplash via leurs URLs publiques (CC0, droits commerciaux OK). Critères :

- **Pexels** ou **Unsplash** uniquement (CC0 garanti, pas de licence ambiguë)
- **Pas de marques visibles** (pas de logo Lamborghini/Ferrari/Rolex reconnaissable — on va sur "luxury car", "sports car", "luxury watch" génériques)
- **Format paysage** ou **carré** (sera centré-cropped en 9:16 par CSS `objectFit: 'cover'`)
- **Résolution min 1080×1080** pour ne pas pixéliser en 1080×1920

L'utilisateur peut ensuite remplacer/ajouter ses propres assets dans `video/public/lifestyle/` sans toucher au code (le composant `LifestyleHook` lit le dossier ou un mapping fixé).

### 3 compositions

| Composition | Total | Frames | Trigger | Cas d'usage |
|---|---|---|---|---|
| `BrandPromo` (modifié) | 18s | 540 | `npm run render` | Marque pure, evergreen |
| `SignalAlert` (modifié) | 9s | 270 | `npm run render:signal` | Signal isolé (entry seul ou exit seul) |
| `SignalAlertProof` (NEW) | 17s | 510 | `npm run render:proof` | Trade clos avec entry + exit |

Toutes en 9:16 vertical 1080×1920 / 30fps / h264.

## Composant partagé : `LifestyleHook`

**Fichier :** `video/src/components/LifestyleHook.tsx` (NEW)

**Durée :** 3s = 90 frames

**Comportement :**
- 4 images sont sélectionnées dans `video/public/lifestyle/` (les 4 premières du tableau ordonné dans `video/src/lifestyle.ts`)
- Chaque image est affichée 0.5s (15 frames)
- Entre chaque image : flash blanc bref (3 frames d'opacity 1→0)
- Total séquence : 4 × 18 frames = 72 frames, plus 18 frames de transition vers la composition principale (fade-out de la dernière image)
- L'image est `objectFit: 'cover'` plein-écran (9:16)
- Texte overlay sur la dernière image (frames 60-90) : un mot/phrase d'amorce — pour BrandPromo `"BOOM"`, pour SignalAlert/Proof `"+${pnl}"` (le résultat tease) si fourni, sinon `ticker`

**Mapping ordonné** (`video/src/lifestyle.ts`) :

```ts
import { staticFile } from 'remotion';

export const LIFESTYLE_IMAGES: string[] = [
  staticFile('lifestyle/yacht-1.jpg'),
  staticFile('lifestyle/supercar-red.jpg'),
  staticFile('lifestyle/penthouse-view.jpg'),
  staticFile('lifestyle/watch-luxury.jpg'),
  staticFile('lifestyle/yacht-2.jpg'),
  staticFile('lifestyle/supercar-yellow.jpg'),
  staticFile('lifestyle/penthouse-night.jpg'),
  staticFile('lifestyle/money-stack.jpg'),
  staticFile('lifestyle/private-jet.jpg'),
  staticFile('lifestyle/skyline-night.jpg'),
];
```

**Props :**

```ts
type LifestyleHookProps = {
  overlayText?: string;  // Texte sur la dernière image (ex: "+20%", "BOOM", "$TSLA")
};
```

## Composition 1 : `BrandPromo` (modifié)

### Changements

- Durée passe de **15s → 18s** (+3s pour le hook)
- `durationInFrames` passe de **450 → 540**
- 4 Sequences au lieu de 3 :
  1. `LifestyleHook` (frames 0-90, 3s) — overlay text `"BOOM"`
  2. `HookBeat` (frames 90-180, 3s) — inchangé
  3. `ValueBeat` (frames 180-420, 8s) — inchangé
  4. `CtaBeat` (frames 420-540, 4s) — inchangé

### Test de validation

`composition.test.ts` doit être mis à jour pour `durationInFrames: 540`. C'est une régression de la valeur Phase 1 (450) — explicit et acceptée.

## Composition 2 : `SignalAlert` (modifié)

### Changements

- Durée passe de **6s → 9s** (+3s pour le hook)
- `durationInFrames` passe de **180 → 270**
- 4 Sequences au lieu de 3 :
  1. `LifestyleHook` (frames 0-90, 3s) — overlay text `"$TSLA"` (le ticker)
  2. `RevealAct` (frames 90-150, 2s) — inchangé
  3. `DataAct` **refactoré** (frames 150-240, 3s) — voir ci-dessous
  4. `CtaAct` (frames 240-270, 1s) — inchangé

### Refonte de `DataAct` en carte Discord native

L'ancien DataAct (LONG/SHORT badge + Entry/Target/Stop empilés) est **remplacé** par un composant qui rend une carte Discord. Le contenu de la carte mirroite ce que `canvas/proof.js generateImage()` produit côté bot :

- Carte fond `#1e1f22`, borderRadius 24px, ombre portée
- Avatar circulaire 80×80 (lookup dans `CUSTOM_AVATARS_VIDEO`, fallback initiales sur cercle bleu Discord)
- Nom auteur en dégradé rose/violet `#ff79f2 → #d649cc` (sauf `Legacy Trading` → rouge `#e84040`)
- Badge BOOM (`<Img src={staticFile('tag_boom.png')}>`)
- Logo BOOM circulaire 36×36
- Timestamp 24px gris `#80848e`, format NY 24h
- Message body 36px blanc `#dcddde`, multi-ligne avec wrap auto
- Animation : slide-up 120px → 0 + fade-in via spring (durationInFrames 20)

### Props étendues

```ts
type SignalAlertProps = {
  ticker: string;                 // RevealAct hero (inchangé)
  type: 'entry' | 'exit';         // (inchangé, plus utilisé dans le nouveau DataAct)
  direction?: 'long' | 'short';   // (inchangé, plus utilisé)
  entry?: string;                 // (inchangé, plus utilisé)
  target?: string;                // (inchangé, plus utilisé)
  stop?: string;                  // (inchangé, plus utilisé)
  pnl?: string;                   // (inchangé, plus utilisé)
  author: string;                 // Discord card author
  message: string;                // NEW : Discord card message text
  timestamp?: string;             // NEW : ISO date, défaut hardcoded pour reproductibilité
};
```

Les 5 anciens champs structurés (`type`, `direction`, `entry`, `target`, `stop`, `pnl`) restent dans le type pour backward compat des tests et préparation Phase 3, mais le nouveau DataAct ne les lit pas.

### Mapping `CUSTOM_AVATARS_VIDEO` (`video/src/avatars.ts` — NEW)

Mirroite `canvas/config.js CUSTOM_AVATARS` mais avec des chemins `staticFile()` :

```ts
import { staticFile } from 'remotion';

export const CUSTOM_AVATARS: Record<string, string> = {
  'Z':                staticFile('avatars/z-avatar.jpg'),
  'AR':               staticFile('avatars/AR_AVATAR.png'),
  'beppels':          staticFile('avatars/beppels_avatar.png'),
  'L':                staticFile('avatars/L_avatar.png'),
  'RF':               staticFile('avatars/RF_AVATAR.png'),
  'Viking':           staticFile('avatars/Viking_avatar.png'),
  'ProTrader':        staticFile('avatars/ProTrader_avatar.png'),
  'Gaz':              staticFile('avatars/Gaz_avatar.png'),
  'CapitalGains':     staticFile('avatars/CapitalGains_avatar.png'),
  'THE REVERSAL':     staticFile('avatars/THE REVERSAL_avatar.png'),
  'kestrel':          staticFile('avatars/kestrel_avatar.png'),
  'the1albatross':    staticFile('avatars/the1albatross_avatar.png'),
  'Bora':             staticFile('avatars/Bora_avatar.png'),
  'Michael':          staticFile('avatars/Michael_avatar.png'),
  'thedutchess1':     staticFile('avatars/thedutchess1_avatar.png'),
  'Legacy Trading':   staticFile('avatars/Legacy Trading_avatar.png'),
  'Protrader Alerts': staticFile('avatars/Protrader Alerts_avatar.png'),
};
```

Maintenance : ajouter un avatar = 2 actions (copier PNG dans `video/public/avatars/` ET dans `avatar/`, ajouter mapping dans `canvas/config.js` ET `video/src/avatars.ts`).

## Composition 3 : `SignalAlertProof` (NEW)

### Spécifications techniques

- 1080 × 1920 (9:16 vertical)
- 30 fps
- Durée : **17s = 510 frames**
- Codec : h264

### Structure narrative (6 phases)

| Phase | Frames | Durée | Composant | Contenu |
|---|---|---|---|---|
| 1. Lifestyle hook | 0-90 | 0-3s | `LifestyleHook` | Rapid cuts luxe + overlay text `"+${pnl}"` (ex: "+20%") sur la dernière image |
| 2. Result tease | 90-150 | 3-5s | `ResultTease` (NEW) | Gros pnl `+20%` qui zoom + ticker `$TSLA` + sous-texte `"watch how Z did it"` |
| 3. Entry card | 150-240 | 5-8s | `DiscordCard` (réutilise le composant de `SignalAlert`) | Carte Discord avec entryAuthor + entryMessage + entryTimestamp. Slide-up. |
| 4. Time pass + chart | 240-330 | 8-11s | `TimePassAct` (NEW) | La carte d'entrée glisse vers le haut/gauche et rétrécit (-30%). Chart vert `ChartExplosion` (NEW) se dessine au centre. Texte `"3 hours later"` ou similaire dérivé de la diff entry/exit timestamp. |
| 5. Exit card | 330-420 | 11-14s | `DiscordCard` | Carte Discord avec exitAuthor + exitMessage + exitTimestamp. Slide-up à droite/dessous de la carte d'entrée (les deux visibles). |
| 6. Result + CTA | 420-510 | 14-17s | `ResultCta` (NEW) | Gros pnl confirmé, URL `discord.gg/boom`, flash blanc final sur les 3 dernières frames. |

### Props

```ts
type SignalAlertProofProps = {
  ticker: string;             // Pour LifestyleHook overlay et ResultTease
  entryAuthor: string;
  entryMessage: string;       // Ex: "$TSLA 150 entry long"
  entryTimestamp: string;     // ISO 8601
  exitAuthor: string;         // Souvent === entryAuthor mais peut différer
  exitMessage: string;        // Ex: "$TSLA out +20%"
  exitTimestamp: string;      // ISO 8601
  pnl: string;                // Ex: "+20%" — drive le chart auto + le ResultTease + le ResultCta
};
```

`pnl` est **obligatoire** (sans pnl, pas de proof video — ça n'a pas de sens).

### defaultProps

```ts
const signalAlertProofDefaults: SignalAlertProofProps = {
  ticker: 'TSLA',
  entryAuthor: 'Z',
  entryMessage: '$TSLA 150 entry long',
  entryTimestamp: '2026-04-25T13:32:00-04:00', // 9:32am NY
  exitAuthor: 'Z',
  exitMessage: '$TSLA out +20%',
  exitTimestamp: '2026-04-25T16:30:00-04:00', // 12:30pm NY (3h après)
  pnl: '+20%',
};
```

### Composant partagé `DiscordCard`

Pour éviter de dupliquer le rendu carte Discord entre `SignalAlert` (DataAct) et `SignalAlertProof` (Phase 3 + 5), le composant carte est extrait dans `video/src/components/DiscordCard.tsx` (NEW). Il prend :

```ts
type DiscordCardProps = {
  author: string;
  message: string;
  timestamp: string;
  scale?: number;       // Pour le shrink dans TimePassAct (default 1)
  position?: 'center' | 'top-left' | 'bottom-right';  // Pour le layout proof
};
```

Le DataAct refactoré et les phases entry/exit du proof l'utilisent tous les deux.

### Composant `ChartExplosion` (NEW)

**Fichier :** `video/src/components/ChartExplosion.tsx`

Chart synthétique : SVG path qui dessine une courbe "rocket up" sur 30 frames. Pas de vraies données.

**Spec visuel :**
- Largeur 600px, hauteur 300px (centré dans le frame)
- Stroke vert `#10b981`, width 4px
- Drop shadow `rgba(16,185,129,0.8)` 8px blur
- Path hardcoded : commence plat sur la gauche, monte exponentiellement vers la droite. Ex : `M 0,260 L 60,255 L 120,245 L 180,225 L 240,195 L 300,155 L 360,110 L 420,65 L 480,30 L 540,10`
- Animation : `stroke-dasharray` + `stroke-dashoffset` pour dessiner la ligne progressivement (technique standard SVG line draw)
- Fill area : gradient vert vers transparent en dessous de la ligne (opacity 40%, fade-in après le draw)

Pas de "vraies données" en Phase 2.5 — Phase 3 pourra passer des points en props.

## Scripts npm

`video/package.json` étendu :

```json
{
  "scripts": {
    "studio": "remotion studio",
    "render": "remotion render BrandPromo out/brand-promo.mp4",
    "render:signal": "remotion render SignalAlert out/signal-alert.mp4",
    "render:proof": "remotion render SignalAlertProof out/signal-alert-proof.mp4",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Override CLI fonctionne pour les 3 :
```bash
npm run render:proof -- --props='{"ticker":"NVDA","entryAuthor":"Bora","entryMessage":"$NVDA 870 entry","entryTimestamp":"2026-04-25T13:30:00-04:00","exitAuthor":"Bora","exitMessage":"$NVDA out +15%","exitTimestamp":"2026-04-25T15:00:00-04:00","pnl":"+15%"}'
```

## Tests

Mises à jour dans `video/src/__tests__/composition.test.ts` :

1. **`BrandPromo` durationInFrames** : assert `540` (était 450) — régression de la valeur Phase 1 acceptée
2. **`SignalAlert` durationInFrames** : assert `270` (était 180)
3. **`SignalAlert` defaultProps a `message`** : nouveau champ ajouté dans les defaults
4. **`SignalAlertProof` est registered** : new test, dimensions 1080×1920, 30fps, 510 frames
5. **`SignalAlertProof` defaultProps a la forme attendue** : new test, vérifie les 8 champs
6. **`SignalAlertProof` accepte `inputProps` override** : new test no-throw

Total : 6 tests (au lieu des 4 actuels).

Pas de tests visuels automatiques (vérification manuelle via render des MP3 + visionnage). Pattern Phase 1+2 conservé.

## Hors scope (Phase 2.5)

- **Vraies données chart** (Yahoo Finance) — Phase 3
- **Bot automation** (rendu auto à la réception d'un signal/exit) — Phase 3
- **Audio music** — slot commenté sur chaque composition, l'utilisateur dépose un MP3 plus tard
- **Rich text rendering** dans le message Discord card (emojis Discord, role mentions) — texte brut en Phase 2.5
- **Image avatar de marque** sur les 17 auteurs (pas de Will, pas de nouveaux avatars) — l'utilisateur ajoute manuellement plus tard
- **Multi-format** (1:1 carré, 16:9 horizontal) — toujours 9:16 only
- **Reuse du `canvas/proof.js`** code (parseRichSegments, drawRichLine) — non porté côté Remotion
- **Plus de 10 images lifestyle** — starter pack 10 images, l'utilisateur ajoute s'il veut

## Vérification

Au sortir de Phase 2.5 :

1. `cd video && npm install` — OK
2. `cd video && npm run typecheck` — clean
3. `cd video && npm test` — 6/6 pass
4. `cd video && npm run studio` — éditeur affiche 3 compositions sélectionnables (`BrandPromo`, `SignalAlert`, `SignalAlertProof`)
5. `cd video && npm run render` — produit `video/out/brand-promo.mp4` (~2-4 MB, 18s, lifestyle hook + ancien BrandPromo)
6. `cd video && npm run render:signal` — produit `video/out/signal-alert.mp4` (~1-2 MB, 9s, lifestyle hook + RevealAct + Discord card + CtaAct)
7. `cd video && npm run render:proof` — produit `video/out/signal-alert-proof.mp4` (~2-4 MB, 17s, full proof avec entry+chart+exit)
8. `cd video && npm run render:proof -- --props='{"ticker":"NVDA","entryAuthor":"Bora","entryMessage":"$NVDA 870 entry","exitMessage":"$NVDA out +15%","pnl":"+15%","entryTimestamp":"...","exitTimestamp":"...","exitAuthor":"Bora"}'` — re-rend avec NVDA/Bora
9. `npm test` à la racine — bot non régressé
10. Visionnage manuel des 3 MP4 — chaque vidéo doit afficher son lifestyle hook intro + le contenu attendu

## Notes scope et risques

- **Scope élevé** : 3 nouveaux composants partagés (`LifestyleHook`, `DiscordCard`, `ChartExplosion`), 3 nouveaux composants spécifiques au proof (`ResultTease`, `TimePassAct`, `ResultCta`), refonte de DataAct, modifications BrandPromo + SignalAlert, 10 nouveaux assets lifestyle, 17 avatars copiés, mapping CUSTOM_AVATARS dupliqué. Plan d'implémentation aura ~10-12 tasks.
- **Risque licence assets lifestyle** : restreindre à Pexels/Unsplash CC0 sans logos visibles évite tout litige. Si l'utilisateur ajoute ensuite ses propres images, c'est sa responsabilité.
- **Risque tests Phase 1 cassés** : `BrandPromo` durationInFrames change. Il faut explicitement mettre à jour le test existant. Acceptable.
- **Risque visuels en cascade** : 3 compositions partagent du code. Un bug dans `LifestyleHook` ou `DiscordCard` casse 2-3 vidéos. Tests programmatiques limitent au composition-level (dimensions/durée), pas au pixel.
