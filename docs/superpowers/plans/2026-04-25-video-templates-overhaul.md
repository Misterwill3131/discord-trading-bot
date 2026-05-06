# Video templates overhaul (Phase 2.5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Étendre le sous-projet `video/` avec un hook lifestyle réutilisable, refondre la composition `SignalAlert` (carte Discord native), et ajouter une nouvelle composition `SignalAlertProof` (proof video 17s avec entry + exit + chart explosion).

**Architecture:** Sous-projet `video/` étendu (pas refait). 4 nouveaux composants partagés (`LifestyleHook`, `DiscordCard`, `ChartExplosion`, et 3 phases proof : `ResultTease`, `TimePassAct`, `ResultCta`). 3 compositions au final (`BrandPromo` modifié, `SignalAlert` modifié, `SignalAlertProof` nouveau). 10 images lifestyle placeholders + 17 avatars + badge BOOM dans `video/public/`.

**Tech Stack:** Remotion 4.x, React 18, TypeScript 5, Vitest, `@napi-rs/canvas` (déjà dans bot deps, utilisé par script de génération de placeholders).

---

## File Structure

Créés ou modifiés en Phase 2.5 :

```
discord-trading-bot/
├── scripts/
│   └── generate-lifestyle-placeholders.js  ← NEW (génère les 10 PNGs)
└── video/
    ├── package.json                        ← MODIFIÉ (script render:proof)
    ├── public/
    │   ├── tag_boom.png                    ← NEW (copié de avatar/tag_boom.png)
    │   ├── avatars/                        ← NEW dir, 17 PNGs copiés
    │   └── lifestyle/                      ← NEW dir, 10 PNGs générés
    └── src/
        ├── Root.tsx                        ← MODIFIÉ (durations, register Proof)
        ├── lifestyle.ts                    ← NEW (LIFESTYLE_IMAGES mapping)
        ├── avatars.ts                      ← NEW (CUSTOM_AVATARS mapping)
        ├── compositions/
        │   ├── BrandPromo.tsx              ← MODIFIÉ (greffe LifestyleHook)
        │   ├── SignalAlert.tsx             ← MODIFIÉ (greffe + DataAct refait)
        │   └── SignalAlertProof.tsx        ← NEW
        ├── components/
        │   ├── LifestyleHook.tsx           ← NEW
        │   ├── DiscordCard.tsx             ← NEW
        │   ├── ChartExplosion.tsx          ← NEW
        │   ├── ResultTease.tsx             ← NEW (proof phase 2)
        │   ├── TimePassAct.tsx             ← NEW (proof phase 4)
        │   ├── ResultCta.tsx               ← NEW (proof phase 6)
        │   ├── DataAct.tsx                 ← MODIFIÉ (utilise DiscordCard)
        │   ├── HookBeat.tsx                (existant, inchangé)
        │   ├── ValueBeat.tsx               (existant, inchangé)
        │   ├── CtaBeat.tsx                 (existant, inchangé)
        │   ├── RevealAct.tsx               (existant, inchangé)
        │   └── CtaAct.tsx                  (existant, inchangé)
        └── __tests__/
            └── composition.test.ts          ← MODIFIÉ (durations + 3 tests Proof)
```

---

### Task 1 : Assets (lifestyle placeholders + avatars + tag_boom + mappings)

**Files:**
- Create: `scripts/generate-lifestyle-placeholders.js`
- Create: `video/public/lifestyle/yacht-1.png` (et 9 autres, générés par le script)
- Copy: `video/public/avatars/*.png` (17 fichiers depuis `avatar/`)
- Copy: `video/public/tag_boom.png` (depuis `avatar/tag_boom.png`)
- Create: `video/src/lifestyle.ts`
- Create: `video/src/avatars.ts`

- [ ] **Step 1: Créer le script de génération des placeholders lifestyle**

Crée `scripts/generate-lifestyle-placeholders.js` :

```js
// Génère 10 PNGs placeholder dans video/public/lifestyle/.
// Chaque PNG est 1920×1080, gradient bleu nuit + label texte.
// L'utilisateur peut remplacer par de vraies photos luxe plus tard.

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const IMAGES = [
  { filename: 'yacht-1.png',          label: 'YACHT 1',          hue: 200 },
  { filename: 'yacht-2.png',          label: 'YACHT 2',          hue: 210 },
  { filename: 'supercar-red.png',     label: 'SUPERCAR RED',     hue: 0 },
  { filename: 'supercar-yellow.png',  label: 'SUPERCAR YELLOW',  hue: 50 },
  { filename: 'penthouse-view.png',   label: 'PENTHOUSE VIEW',   hue: 280 },
  { filename: 'penthouse-night.png',  label: 'PENTHOUSE NIGHT',  hue: 260 },
  { filename: 'watch-luxury.png',     label: 'WATCH',            hue: 30 },
  { filename: 'money-stack.png',      label: 'MONEY',            hue: 120 },
  { filename: 'private-jet.png',      label: 'PRIVATE JET',      hue: 220 },
  { filename: 'skyline-night.png',    label: 'SKYLINE',          hue: 240 },
];

const OUT_DIR = path.join(__dirname, '..', 'video', 'public', 'lifestyle');
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const img of IMAGES) {
  const W = 1920, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Gradient bg
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, `hsl(${img.hue}, 50%, 15%)`);
  grad.addColorStop(1, `hsl(${img.hue + 20}, 60%, 8%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 120px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(img.label, W / 2, H / 2);

  ctx.font = '32px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('Placeholder — remplacer par une vraie photo', W / 2, H / 2 + 100);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(OUT_DIR, img.filename), buf);
  console.log(`  ✓ ${img.filename}`);
}

console.log(`Done. ${IMAGES.length} placeholders dans ${OUT_DIR}`);
```

- [ ] **Step 2: Lancer le script depuis la racine du repo**

```bash
node scripts/generate-lifestyle-placeholders.js
```

Expected output : 10 lignes `✓ filename.png`. Vérifier que `video/public/lifestyle/` contient 10 fichiers PNG.

- [ ] **Step 3: Copier les 17 avatars du repo vers video/public/avatars/**

Run depuis la racine :

```bash
mkdir -p video/public/avatars
cp avatar/AR_AVATAR.png video/public/avatars/
cp avatar/Bora_avatar.png video/public/avatars/
cp avatar/CapitalGains_avatar.png video/public/avatars/
cp avatar/Gaz_avatar.png video/public/avatars/
cp avatar/L_avatar.png video/public/avatars/
cp "avatar/Legacy Trading_avatar.png" video/public/avatars/
cp avatar/Michael_avatar.png video/public/avatars/
cp avatar/ProTrader_avatar.png video/public/avatars/
cp "avatar/Protrader Alerts_avatar.png" video/public/avatars/
cp avatar/RF_AVATAR.png video/public/avatars/
cp "avatar/THE REVERSAL_avatar.png" video/public/avatars/
cp avatar/Viking_avatar.png video/public/avatars/
cp avatar/beppels_avatar.png video/public/avatars/
cp avatar/kestrel_avatar.png video/public/avatars/
cp avatar/the1albatross_avatar.png video/public/avatars/
cp avatar/thedutchess1_avatar.png video/public/avatars/
cp avatar/z-avatar.jpg video/public/avatars/
```

Expected : `ls video/public/avatars/ | wc -l` retourne `17`.

- [ ] **Step 4: Copier `tag_boom.png` à la racine de video/public/**

```bash
cp avatar/tag_boom.png video/public/tag_boom.png
```

- [ ] **Step 5: Créer `video/src/lifestyle.ts`**

```ts
import { staticFile } from 'remotion';

// Liste ordonnée d'images lifestyle pour le hook intro (3s rapid cuts).
// Le composant LifestyleHook utilise les 4 premières par défaut.
// L'utilisateur peut remplacer les fichiers PNG dans video/public/lifestyle/
// sans toucher à ce mapping (chemins relatifs = mêmes noms de fichier).
export const LIFESTYLE_IMAGES: string[] = [
  staticFile('lifestyle/yacht-1.png'),
  staticFile('lifestyle/supercar-red.png'),
  staticFile('lifestyle/penthouse-view.png'),
  staticFile('lifestyle/watch-luxury.png'),
  staticFile('lifestyle/yacht-2.png'),
  staticFile('lifestyle/supercar-yellow.png'),
  staticFile('lifestyle/penthouse-night.png'),
  staticFile('lifestyle/money-stack.png'),
  staticFile('lifestyle/private-jet.png'),
  staticFile('lifestyle/skyline-night.png'),
];
```

- [ ] **Step 6: Créer `video/src/avatars.ts`**

```ts
import { staticFile } from 'remotion';

// Mapping author → avatar path. Mirroite canvas/config.js CUSTOM_AVATARS.
// Si l'auteur n'est pas dans ce mapping, le composant DiscordCard tombe
// sur les initiales (2 premières lettres) sur cercle bleu Discord (#5865f2).
// Ajouter un nouvel avatar nécessite : (1) copier le PNG dans
// video/public/avatars/ et avatar/ ; (2) ajouter une entrée ici ET
// dans canvas/config.js.
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

- [ ] **Step 7: Vérifier que typecheck passe**

```bash
cd video && npm run typecheck
```

Expected : clean (pas d'erreur, juste un import unused warning éventuel pour les modules non encore consommés — pas un blocker).

- [ ] **Step 8: Vérifier que les tests passent toujours**

```bash
cd video && npm test
```

Expected : 4/4 pass (les 4 tests existants, on n'en a pas encore ajouté).

- [ ] **Step 9: Commit**

```bash
git add scripts/generate-lifestyle-placeholders.js video/public/lifestyle/ video/public/avatars/ video/public/tag_boom.png video/src/lifestyle.ts video/src/avatars.ts
git commit -m "feat(video): assets phase 2.5 — lifestyle placeholders + avatars + tag

- Script de génération de 10 PNG placeholder lifestyle (1920×1080
  gradient + label) pour le hook intro
- 17 avatars copiés depuis avatar/ vers video/public/avatars/
- tag_boom.png copié à la racine de video/public/
- Mapping LIFESTYLE_IMAGES et CUSTOM_AVATARS en TypeScript

L'utilisateur peut remplacer les placeholders par de vraies photos
luxe plus tard sans toucher au code."
```

---

### Task 2 : Composant `LifestyleHook` (3s rapid cuts)

**Files:**
- Create: `video/src/components/LifestyleHook.tsx`

- [ ] **Step 1: Créer le composant**

Crée `video/src/components/LifestyleHook.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill, Img, useCurrentFrame, interpolate } from 'remotion';
import { LIFESTYLE_IMAGES } from '../lifestyle';

type Props = {
  overlayText?: string;
};

// Phase de hook lifestyle : 3s = 90 frames @ 30fps.
// 4 images de la liste s'enchaînent à 0.5s chacune (15 frames),
// avec un flash blanc bref entre chaque cut (3 frames).
// Sur la dernière image (frames 60-90), un texte overlay apparaît.
export const LifestyleHook = ({ overlayText }: Props) => {
  const frame = useCurrentFrame();

  // Index de l'image courante (0..3) basé sur le frame.
  const slotDuration = 22; // frames par image (légèrement < 24 = 0.8s pour avoir un peu d'overlap)
  const currentSlot = Math.min(3, Math.floor(frame / slotDuration));
  const images = LIFESTYLE_IMAGES.slice(0, 4);

  // Flash blanc entre les cuts : 3 frames d'opacity 1→0 au début de chaque slot.
  const flashStart = currentSlot * slotDuration;
  const flashOpacity = interpolate(
    frame,
    [flashStart, flashStart + 3],
    [1, 0],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Overlay text sur la dernière image (frames 60-90).
  const overlayOpacity = interpolate(
    frame,
    [60, 75],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );
  const overlayScale = interpolate(
    frame,
    [60, 70, 75],
    [0.5, 1.1, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* Image courante (cover, plein écran) */}
      <Img
        src={images[currentSlot]}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
      />

      {/* Flash blanc entre les cuts */}
      <AbsoluteFill
        style={{
          background: 'white',
          opacity: currentSlot > 0 ? flashOpacity : 0,
        }}
      />

      {/* Overlay text (sur la dernière image) */}
      {overlayText && (
        <AbsoluteFill
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 60,
          }}
        >
          <div
            style={{
              color: '#fff',
              fontSize: 180,
              fontWeight: 900,
              letterSpacing: -3,
              textAlign: 'center',
              fontFamily: 'sans-serif',
              textShadow: '0 0 40px rgba(0,0,0,0.8)',
              opacity: overlayOpacity,
              transform: `scale(${overlayScale})`,
            }}
          >
            {overlayText}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 3: Vérifier tests existants**

```bash
cd video && npm test
```

Expected : 4/4 pass (le composant n'est pas encore intégré dans une composition, donc pas de test pour lui).

- [ ] **Step 4: Commit**

```bash
git add video/src/components/LifestyleHook.tsx
git commit -m "feat(video): composant LifestyleHook (3s rapid cuts intro)

90 frames (3s) qui enchaînent 4 images de LIFESTYLE_IMAGES (slots de
22 frames), flash blanc bref entre chaque cut, overlay text optionnel
sur la dernière seconde (frames 60-90, scale spring + fade in)."
```

---

### Task 3 : Composant `DiscordCard` (carte Discord native)

**Files:**
- Create: `video/src/components/DiscordCard.tsx`

- [ ] **Step 1: Créer le composant**

Crée `video/src/components/DiscordCard.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { CUSTOM_AVATARS } from '../avatars';

type Props = {
  author: string;
  message: string;
  timestamp: string;            // ISO 8601
  scale?: number;               // Default 1
  position?: 'center' | 'top-left' | 'bottom-right';  // Default 'center'
};

// Format heure NY 24h, ex: "9:32am" → "09:32"
function formatTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}

// Initiales (2 premières lettres en majuscules) pour fallback avatar.
function initials(author: string): string {
  return (author || 'W').slice(0, 2).toUpperCase();
}

// Composant interne : avatar circulaire (image custom ou initiales).
const Avatar = ({ author }: { author: string }) => {
  const customSrc = CUSTOM_AVATARS[author];
  if (customSrc) {
    return (
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: '50%',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <Img
          src={customSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        width: 80,
        height: 80,
        borderRadius: '50%',
        backgroundColor: '#5865f2',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontWeight: 700,
        fontSize: 28,
        flexShrink: 0,
      }}
    >
      {initials(author)}
    </div>
  );
};

// Mapping position → CSS top/left/right/bottom + transform
function positionStyle(position: 'center' | 'top-left' | 'bottom-right'): React.CSSProperties {
  if (position === 'top-left') {
    return { top: '15%', left: '5%', transform: 'translate(0, 0)' };
  }
  if (position === 'bottom-right') {
    return { bottom: '15%', right: '5%', top: 'auto', left: 'auto', transform: 'translate(0, 0)' };
  }
  // center
  return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
}

export const DiscordCard = ({ author, message, timestamp, scale = 1, position = 'center' }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Slide-up + fade-in via spring (durationInFrames 20)
  const entry = spring({
    frame,
    fps,
    config: { damping: 14 },
    durationInFrames: 20,
  });
  const translateY = interpolate(entry, [0, 1], [120, 0]);

  // Couleur du nom : dégradé rose/violet, sauf Legacy Trading rouge
  const nameStyle: React.CSSProperties = author === 'Legacy Trading'
    ? { color: '#e84040' }
    : {
        background: 'linear-gradient(90deg, #ff79f2 0%, #d649cc 100%)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
      <div
        style={{
          position: 'absolute',
          ...positionStyle(position),
          width: 920,
          maxWidth: '90%',
          background: '#1e1f22',
          borderRadius: 24,
          padding: '36px 40px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          opacity: entry,
          transform: `${positionStyle(position).transform} translateY(${translateY}px) scale(${scale})`,
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <Avatar author={author} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ ...nameStyle, fontWeight: 700, fontSize: 36 }}>{author}</span>
            <Img
              src={staticFile('tag_boom.png')}
              style={{ height: 36, width: 'auto' }}
            />
            <Img
              src={staticFile('logo_boom.png')}
              style={{ width: 36, height: 36, borderRadius: '50%' }}
            />
            <span style={{ color: '#80848e', fontSize: 24 }}>{formatTime(timestamp)}</span>
          </div>
        </div>

        {/* Message body */}
        <div style={{ color: '#dcddde', fontSize: 36, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>
          {message}
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 3: Vérifier tests existants**

```bash
cd video && npm test
```

Expected : 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add video/src/components/DiscordCard.tsx
git commit -m "feat(video): composant DiscordCard (carte Discord native)

Mirroite generateImage() côté bot : avatar circulaire (custom ou
initiales fallback), nom dégradé rose/violet (rouge pour Legacy
Trading), badge BOOM + logo + timestamp NY 24h, message body
multi-ligne. Slide-up + fade-in via spring. Props pour scale et
position (center/top-left/bottom-right) — préparation pour le proof
video qui montre 2 cartes."
```

---

### Task 4 : Composant `ChartExplosion` (SVG synthétique)

**Files:**
- Create: `video/src/components/ChartExplosion.tsx`

- [ ] **Step 1: Créer le composant**

Crée `video/src/components/ChartExplosion.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

// Chart synthétique "rocket up" : courbe SVG qui se dessine de gauche
// à droite sur 30 frames, puis l'aire sous la courbe s'allume.
// Pas de vraies données — purement décoratif pour Phase 2.5.
export const ChartExplosion = () => {
  const frame = useCurrentFrame();

  // Path : commence plat à gauche (y=260), monte exponentiellement vers la droite (y=10).
  // Coordonnées sur SVG 600×300.
  const PATH = 'M 0,260 L 60,255 L 120,245 L 180,225 L 240,195 L 300,155 L 360,110 L 420,65 L 480,30 L 540,10';
  const PATH_LENGTH = 700; // longueur approximative pour le stroke-dasharray

  // Draw line: stroke-dashoffset va de PATH_LENGTH (caché) à 0 (visible) sur 30 frames.
  const drawProgress = interpolate(
    frame,
    [0, 30],
    [PATH_LENGTH, 0],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Area fill: opacity 0→0.4 entre frames 25 et 40
  const fillOpacity = interpolate(
    frame,
    [25, 40],
    [0, 0.4],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Glow pulse après que la ligne soit dessinée (frames 30+)
  const pulseScale = 1 + Math.sin(frame * 0.1) * 0.03;

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg
        viewBox="0 0 600 300"
        style={{
          width: 600,
          height: 300,
          transform: `scale(${pulseScale})`,
          filter: 'drop-shadow(0 0 12px rgba(16,185,129,0.8))',
        }}
      >
        <defs>
          <linearGradient id="chartGradGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Fill area (sous la courbe) */}
        <path
          d={`${PATH} L 540,300 L 0,300 Z`}
          fill="url(#chartGradGreen)"
          opacity={fillOpacity}
        />
        {/* Line (la courbe elle-même) */}
        <path
          d={PATH}
          fill="none"
          stroke="#10b981"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={PATH_LENGTH}
          strokeDashoffset={drawProgress}
        />
      </svg>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 3: Vérifier tests existants**

```bash
cd video && npm test
```

Expected : 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add video/src/components/ChartExplosion.tsx
git commit -m "feat(video): composant ChartExplosion (SVG synthétique)

Courbe SVG 'rocket up' qui se dessine de gauche à droite sur 30
frames (stroke-dasharray + dashoffset), aire sous la courbe qui
s'allume avec gradient vert, pulse glow continu. Pas de vraies
données — purement décoratif. Phase 3 ajoutera le support de points
réels en props."
```

---

### Task 5 : `BrandPromo` — greffer LifestyleHook

**Files:**
- Modify: `video/src/compositions/BrandPromo.tsx`
- Modify: `video/src/Root.tsx`
- Modify: `video/src/__tests__/composition.test.ts`

- [ ] **Step 1: Mettre à jour le test BrandPromo (durationInFrames 540)**

Dans `video/src/__tests__/composition.test.ts`, dans le bloc `describe('BrandPromo composition', ...)`, change la valeur attendue pour `durationInFrames` de `450` à `540`. Cherche la ligne :

```ts
expect(comp.durationInFrames).toBe(450);
```

Remplace par :

```ts
expect(comp.durationInFrames).toBe(540);
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
cd video && npm test
```

Expected : le test BrandPromo échoue (`Expected: 540, Received: 450`). Les 3 SignalAlert tests passent toujours.

- [ ] **Step 3: Mettre à jour `Root.tsx` pour BrandPromo durationInFrames=540**

Ouvre `video/src/Root.tsx`, trouve le `<Composition id="BrandPromo" ...>` et change `durationInFrames={450}` en `durationInFrames={540}`. Le bloc final doit ressembler à :

```tsx
<Composition
  id="BrandPromo"
  component={BrandPromo}
  durationInFrames={540}
  fps={30}
  width={1080}
  height={1920}
/>
```

(Le reste de Root.tsx, dont la composition SignalAlert, reste inchangé pour cette task.)

- [ ] **Step 4: Mettre à jour `BrandPromo.tsx` pour insérer LifestyleHook**

Remplace le contenu de `video/src/compositions/BrandPromo.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
import { LifestyleHook } from '../components/LifestyleHook';
import { HookBeat } from '../components/HookBeat';
import { ValueBeat } from '../components/ValueBeat';
import { CtaBeat } from '../components/CtaBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/track.mp3')} /> */}

      <Sequence from={0} durationInFrames={90}>
        <LifestyleHook overlayText="BOOM" />
      </Sequence>
      <Sequence from={90} durationInFrames={90}>
        <HookBeat />
      </Sequence>
      <Sequence from={180} durationInFrames={240}>
        <ValueBeat />
      </Sequence>
      <Sequence from={420} durationInFrames={120}>
        <CtaBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
```

Notes : LifestyleHook 0-90 (3s), HookBeat 90-180 (3s), ValueBeat 180-420 (8s), CtaBeat 420-540 (4s). Total 540.

- [ ] **Step 5: Relancer le test**

```bash
cd video && npm test
```

Expected : 4/4 pass (BrandPromo durationInFrames=540 maintenant validé).

- [ ] **Step 6: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 7: Commit**

```bash
git add video/src/compositions/BrandPromo.tsx video/src/Root.tsx video/src/__tests__/composition.test.ts
git commit -m "feat(video): BrandPromo greffe LifestyleHook (3s intro lifestyle)

Composition étendue de 15s → 18s (durationInFrames 450 → 540).
4 Sequences : LifestyleHook (0-3s, overlay BOOM) → HookBeat (3-6s)
→ ValueBeat (6-14s) → CtaBeat (14-18s). Le test composition.test.ts
mis à jour pour la nouvelle durée."
```

---

### Task 6 : `SignalAlert` — greffe LifestyleHook + DataAct refait en DiscordCard

**Files:**
- Modify: `video/src/compositions/SignalAlert.tsx`
- Modify: `video/src/components/DataAct.tsx`
- Modify: `video/src/Root.tsx`
- Modify: `video/src/__tests__/composition.test.ts`

- [ ] **Step 1: Mettre à jour les tests SignalAlert**

Dans `video/src/__tests__/composition.test.ts`, dans le bloc `describe('SignalAlert composition', ...)`, modifie deux choses :

1. Le test `is registered with correct dimensions and duration` change `durationInFrames` de `180` à `270` :

```ts
expect(comp.durationInFrames).toBe(270);
```

2. Le test `has default props with expected fields` ajoute `message` au `toMatchObject` :

```ts
expect(comp.defaultProps).toMatchObject({
  ticker: 'TSLA',
  type: 'entry',
  direction: 'long',
  entry: '150-155',
  target: '165',
  stop: '148',
  author: 'Z',
  message: '$TSLA 150-155 entry long',
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

```bash
cd video && npm test
```

Expected : 2 SignalAlert tests échouent (`Expected: 270, Received: 180` et le `toMatchObject` qui dit que `message` est manquant). BrandPromo et le 3ème SignalAlert test passent.

- [ ] **Step 3: Refactorer `DataAct.tsx` pour utiliser DiscordCard**

Remplace le contenu de `video/src/components/DataAct.tsx` par :

```tsx
import { DiscordCard } from './DiscordCard';

type Props = {
  author: string;
  message: string;
  timestamp: string;
};

// Phase 2 du SignalAlert. Refait en Phase 2.5 — affiche maintenant
// la carte Discord native (au lieu du LONG/Entry/Target/Stop abstrait).
// Wrapper pour DiscordCard avec position 'center' fixe.
export const DataAct = ({ author, message, timestamp }: Props) => {
  return <DiscordCard author={author} message={message} timestamp={timestamp} />;
};
```

(L'ancien fichier de 89 lignes est entièrement remplacé. Le composant garde le même nom pour minimiser les ripples.)

- [ ] **Step 4: Mettre à jour `SignalAlert.tsx`**

Remplace le contenu de `video/src/compositions/SignalAlert.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
import { LifestyleHook } from '../components/LifestyleHook';
import { RevealAct } from '../components/RevealAct';
import { DataAct } from '../components/DataAct';
import { CtaAct } from '../components/CtaAct';

export type SignalAlertProps = {
  ticker: string;
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
  message: string;            // NEW
  timestamp?: string;         // NEW
};

export const SignalAlert = ({ ticker, author, message, timestamp }: SignalAlertProps) => {
  // Si pas de timestamp fourni, utiliser la date courante (au render)
  const ts = timestamp || new Date().toISOString();

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/signal-track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/signal-track.mp3')} /> */}

      <Sequence from={0} durationInFrames={90}>
        <LifestyleHook overlayText={`$${ticker}`} />
      </Sequence>
      <Sequence from={90} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
      <Sequence from={150} durationInFrames={90}>
        <DataAct author={author} message={message} timestamp={ts} />
      </Sequence>
      <Sequence from={240} durationInFrames={30}>
        <CtaAct />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 5: Mettre à jour `Root.tsx`**

Ouvre `video/src/Root.tsx`. Modifie le `signalAlertDefaults` pour ajouter `message` et `timestamp`, et change `durationInFrames` de la composition SignalAlert de `180` à `270`. Le bloc final ressemble à :

```tsx
import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';
import { SignalAlert, SignalAlertProps } from './compositions/SignalAlert';

const signalAlertDefaults: SignalAlertProps = {
  ticker: 'TSLA',
  type: 'entry',
  direction: 'long',
  entry: '150-155',
  target: '165',
  stop: '148',
  author: 'Z',
  message: '$TSLA 150-155 entry long',
  timestamp: '2026-04-25T13:32:00-04:00',
};

export const Root = () => {
  return (
    <>
      <Composition
        id="BrandPromo"
        component={BrandPromo}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="SignalAlert"
        component={SignalAlert}
        durationInFrames={270}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={signalAlertDefaults}
      />
    </>
  );
};
```

- [ ] **Step 6: Relancer les tests**

```bash
cd video && npm test
```

Expected : 4/4 pass (BrandPromo + 3 SignalAlert avec nouveaux defaults et durée).

- [ ] **Step 7: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 8: Commit**

```bash
git add video/src/compositions/SignalAlert.tsx video/src/components/DataAct.tsx video/src/Root.tsx video/src/__tests__/composition.test.ts
git commit -m "feat(video): SignalAlert greffe LifestyleHook + DataAct refait DiscordCard

Composition étendue de 6s → 9s (durationInFrames 180 → 270).
4 Sequences : LifestyleHook (0-3s, overlay \$TICKER) → RevealAct
(3-5s) → DataAct refait en DiscordCard (5-8s, carte Discord native)
→ CtaAct (8-9s).

Props étendues : ajout de \`message\` (texte de la carte) et
\`timestamp?\` (ISO 8601, défaut au render). Les 5 anciens champs
structurés (type/direction/entry/target/stop/pnl) restent dans le
type pour backward compat mais le nouveau DataAct ne les lit pas.

Tests mis à jour : durationInFrames 270 + message dans defaultProps."
```

---

### Task 7 : Composants des phases du Proof video (`ResultTease`, `TimePassAct`, `ResultCta`)

**Files:**
- Create: `video/src/components/ResultTease.tsx`
- Create: `video/src/components/TimePassAct.tsx`
- Create: `video/src/components/ResultCta.tsx`

- [ ] **Step 1: Créer `ResultTease.tsx` (Phase 2 du Proof, frames 90-150 globaux = 0-60 locaux)**

Crée `video/src/components/ResultTease.tsx` :

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

type Props = {
  ticker: string;
  pnl: string;     // ex: "+20%"
  author: string;
};

// Phase 2 du SignalAlertProof : 60 frames (2s).
// Gros pnl qui zoom + ticker dessous + sous-texte tease.
export const ResultTease = ({ ticker, pnl, author }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // PNL : spring pop sur les 25 premières frames
  const pnlScale = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 110 },
    durationInFrames: 25,
  });

  // Ticker + sous-texte : fade in à 20 frames
  const subOpacity = interpolate(
    frame,
    [20, 35],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Couleur du pnl : vert si commence par + ou pas par -, rouge si -
  const pnlColor = pnl.startsWith('-') ? '#ef4444' : '#10b981';

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 60,
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          color: pnlColor,
          fontSize: 240,
          fontWeight: 900,
          letterSpacing: -4,
          transform: `scale(${pnlScale})`,
          textShadow: `0 0 60px ${pnlColor}88`,
        }}
      >
        {pnl}
      </div>
      <div
        style={{
          color: 'white',
          fontSize: 56,
          fontWeight: 800,
          letterSpacing: 2,
          marginTop: 24,
          opacity: subOpacity,
        }}
      >
        ${ticker}
      </div>
      <div
        style={{
          color: 'rgba(255,255,255,0.7)',
          fontSize: 34,
          marginTop: 18,
          opacity: subOpacity,
        }}
      >
        watch how {author} did it
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Créer `TimePassAct.tsx` (Phase 4 du Proof, 90 frames locaux)**

Crée `video/src/components/TimePassAct.tsx` :

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
import { ChartExplosion } from './ChartExplosion';

type Props = {
  entryTimestamp: string;     // ISO 8601
  exitTimestamp: string;      // ISO 8601
};

// Calcule la diff en heures/minutes lisible.
function timeDiffLabel(entry: string, exit: string): string {
  const diffMs = new Date(exit).getTime() - new Date(entry).getTime();
  if (diffMs <= 0) return 'moments later';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} later`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} later`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} later`;
}

// Phase 4 du SignalAlertProof : 90 frames (3s).
// Background gradient + texte "X hours later" + ChartExplosion centré.
export const TimePassAct = ({ entryTimestamp, exitTimestamp }: Props) => {
  const frame = useCurrentFrame();
  const label = timeDiffLabel(entryTimestamp, exitTimestamp);

  // Texte fade-in sur 0-20 frames
  const labelOpacity = interpolate(
    frame,
    [0, 20],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: 2,
          marginBottom: 20,
          opacity: labelOpacity,
        }}
      >
        {label}
      </div>
      <ChartExplosion />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Créer `ResultCta.tsx` (Phase 6 du Proof, 90 frames locaux)**

Crée `video/src/components/ResultCta.tsx` :

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

type Props = {
  pnl: string;
};

// Phase 6 du SignalAlertProof : 90 frames (3s) — final.
// Gros pnl confirmé qui pulse + URL slide-up + flash blanc final.
export const ResultCta = ({ pnl }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // PNL pop entrance + pulse continu
  const pnlEntry = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 100 },
    durationInFrames: 20,
  });
  const pnlPulse = 1 + Math.sin(frame * 0.15) * 0.03;
  const pnlScale = pnlEntry * pnlPulse;

  // URL slide-up sur 25-50 frames
  const urlEntry = spring({
    frame: frame - 25,
    fps,
    config: { damping: 12 },
    durationInFrames: 20,
  });
  const urlY = interpolate(urlEntry, [0, 1], [80, 0]);

  // Flash blanc final sur les 3 dernières frames (87-89)
  const flashOpacity = interpolate(
    frame,
    [87, 89],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  const pnlColor = pnl.startsWith('-') ? '#ef4444' : '#10b981';

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 50%, #1a1a2e 0%, #0a0a0a 80%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 60,
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          color: pnlColor,
          fontSize: 280,
          fontWeight: 900,
          letterSpacing: -6,
          transform: `scale(${pnlScale})`,
          textShadow: `0 0 80px ${pnlColor}aa`,
        }}
      >
        {pnl}
      </div>
      <div
        style={{
          marginTop: 50,
          color: 'white',
          fontSize: 48,
          fontWeight: 800,
          transform: `translateY(${urlY}px)`,
          opacity: urlEntry,
        }}
      >
        discord.gg/boom
      </div>
      {/* Flash blanc final */}
      <AbsoluteFill style={{ background: 'white', opacity: flashOpacity }} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 5: Vérifier tests existants**

```bash
cd video && npm test
```

Expected : 4/4 pass (les 3 nouveaux composants ne sont pas encore intégrés dans une composition, donc pas de test spécifique).

- [ ] **Step 6: Commit**

```bash
git add video/src/components/ResultTease.tsx video/src/components/TimePassAct.tsx video/src/components/ResultCta.tsx
git commit -m "feat(video): composants des phases du SignalAlertProof

3 composants pour la nouvelle composition Proof video :
- ResultTease (60 frames) : gros pnl pop + ticker + sous-texte
  'watch how X did it'
- TimePassAct (90 frames) : background gradient + texte 'X hours
  later' (calculé depuis entry/exit timestamps) + ChartExplosion
- ResultCta (90 frames) : gros pnl confirmé pulse + URL discord.gg/
  boom slide-up + flash blanc final

Pas encore intégrés — la composition SignalAlertProof arrive au
prochain commit."
```

---

### Task 8 : `SignalAlertProof` composition + tests + E2E render

**Files:**
- Create: `video/src/compositions/SignalAlertProof.tsx`
- Modify: `video/src/Root.tsx`
- Modify: `video/src/__tests__/composition.test.ts`
- Modify: `video/package.json`

- [ ] **Step 1: Ajouter les 3 tests pour SignalAlertProof**

Dans `video/src/__tests__/composition.test.ts`, ajoute ce bloc à la fin du fichier :

```ts
describe('SignalAlertProof composition', () => {
  test('is registered with correct dimensions and duration', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlertProof',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(30);
    expect(comp.durationInFrames).toBe(510);
  });

  test('has default props with expected fields', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlertProof',
    });
    expect(comp.defaultProps).toMatchObject({
      ticker: 'TSLA',
      entryAuthor: 'Z',
      entryMessage: '$TSLA 150 entry long',
      exitAuthor: 'Z',
      exitMessage: '$TSLA out +20%',
      pnl: '+20%',
    });
  });

  test('accepts inputProps override without throwing', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlertProof',
      inputProps: {
        ticker: 'NVDA',
        entryAuthor: 'Bora',
        entryMessage: '$NVDA 870 entry',
        entryTimestamp: '2026-04-25T13:30:00-04:00',
        exitAuthor: 'Bora',
        exitMessage: '$NVDA out +15%',
        exitTimestamp: '2026-04-25T15:00:00-04:00',
        pnl: '+15%',
      },
    });
    expect(comp.id).toBe('SignalAlertProof');
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

```bash
cd video && npm test
```

Expected : les 3 tests SignalAlertProof échouent (`Could not find composition with ID SignalAlertProof`). Les 4 tests existants passent.

- [ ] **Step 3: Créer la composition `SignalAlertProof.tsx`**

Crée `video/src/compositions/SignalAlertProof.tsx` :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
import { LifestyleHook } from '../components/LifestyleHook';
import { ResultTease } from '../components/ResultTease';
import { DiscordCard } from '../components/DiscordCard';
import { TimePassAct } from '../components/TimePassAct';
import { ResultCta } from '../components/ResultCta';

export type SignalAlertProofProps = {
  ticker: string;
  entryAuthor: string;
  entryMessage: string;
  entryTimestamp: string;
  exitAuthor: string;
  exitMessage: string;
  exitTimestamp: string;
  pnl: string;
};

export const SignalAlertProof = ({
  ticker, entryAuthor, entryMessage, entryTimestamp,
  exitAuthor, exitMessage, exitTimestamp, pnl,
}: SignalAlertProofProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/proof-track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/proof-track.mp3')} /> */}

      {/* Phase 1 — Lifestyle hook (0-3s) */}
      <Sequence from={0} durationInFrames={90}>
        <LifestyleHook overlayText={pnl} />
      </Sequence>

      {/* Phase 2 — Result tease (3-5s) */}
      <Sequence from={90} durationInFrames={60}>
        <ResultTease ticker={ticker} pnl={pnl} author={entryAuthor} />
      </Sequence>

      {/* Phase 3 — Entry card (5-8s) */}
      <Sequence from={150} durationInFrames={90}>
        <DiscordCard
          author={entryAuthor}
          message={entryMessage}
          timestamp={entryTimestamp}
          position="center"
        />
      </Sequence>

      {/* Phase 4 — Time pass + chart (8-11s) */}
      <Sequence from={240} durationInFrames={90}>
        <TimePassAct entryTimestamp={entryTimestamp} exitTimestamp={exitTimestamp} />
      </Sequence>

      {/* Phase 5 — Exit card (11-14s) */}
      <Sequence from={330} durationInFrames={90}>
        <DiscordCard
          author={exitAuthor}
          message={exitMessage}
          timestamp={exitTimestamp}
          position="center"
        />
      </Sequence>

      {/* Phase 6 — Result + CTA (14-17s) */}
      <Sequence from={420} durationInFrames={90}>
        <ResultCta pnl={pnl} />
      </Sequence>
    </AbsoluteFill>
  );
};
```

Total frames : 90+60+90+90+90+90 = 510. ✓

- [ ] **Step 4: Enregistrer SignalAlertProof dans Root.tsx**

Ouvre `video/src/Root.tsx` et ajoute :
1. L'import de `SignalAlertProof` et son type :
   ```tsx
   import { SignalAlertProof, SignalAlertProofProps } from './compositions/SignalAlertProof';
   ```
2. Un constant defaultProps :
   ```tsx
   const signalAlertProofDefaults: SignalAlertProofProps = {
     ticker: 'TSLA',
     entryAuthor: 'Z',
     entryMessage: '$TSLA 150 entry long',
     entryTimestamp: '2026-04-25T13:32:00-04:00',
     exitAuthor: 'Z',
     exitMessage: '$TSLA out +20%',
     exitTimestamp: '2026-04-25T16:30:00-04:00',
     pnl: '+20%',
   };
   ```
3. Un nouveau `<Composition>` avant la fermeture `</>` :
   ```tsx
   <Composition
     id="SignalAlertProof"
     component={SignalAlertProof}
     durationInFrames={510}
     fps={30}
     width={1080}
     height={1920}
     defaultProps={signalAlertProofDefaults}
   />
   ```

Le fichier final doit ressembler à (vérifie l'ordre des imports et compositions) :

```tsx
import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';
import { SignalAlert, SignalAlertProps } from './compositions/SignalAlert';
import { SignalAlertProof, SignalAlertProofProps } from './compositions/SignalAlertProof';

const signalAlertDefaults: SignalAlertProps = {
  ticker: 'TSLA',
  type: 'entry',
  direction: 'long',
  entry: '150-155',
  target: '165',
  stop: '148',
  author: 'Z',
  message: '$TSLA 150-155 entry long',
  timestamp: '2026-04-25T13:32:00-04:00',
};

const signalAlertProofDefaults: SignalAlertProofProps = {
  ticker: 'TSLA',
  entryAuthor: 'Z',
  entryMessage: '$TSLA 150 entry long',
  entryTimestamp: '2026-04-25T13:32:00-04:00',
  exitAuthor: 'Z',
  exitMessage: '$TSLA out +20%',
  exitTimestamp: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
};

export const Root = () => {
  return (
    <>
      <Composition
        id="BrandPromo"
        component={BrandPromo}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="SignalAlert"
        component={SignalAlert}
        durationInFrames={270}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={signalAlertDefaults}
      />
      <Composition
        id="SignalAlertProof"
        component={SignalAlertProof}
        durationInFrames={510}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={signalAlertProofDefaults}
      />
    </>
  );
};
```

- [ ] **Step 5: Ajouter le script `render:proof` à `video/package.json`**

Dans `video/package.json`, dans la section `scripts`, ajoute la ligne `render:proof` après `render:signal`. Le bloc final ressemble à :

```json
"scripts": {
  "studio": "remotion studio",
  "render": "remotion render BrandPromo out/brand-promo.mp4",
  "render:signal": "remotion render SignalAlert out/signal-alert.mp4",
  "render:proof": "remotion render SignalAlertProof out/signal-alert-proof.mp4",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

- [ ] **Step 6: Relancer les tests**

```bash
cd video && npm test
```

Expected : 7/7 pass (1 BrandPromo + 3 SignalAlert + 3 SignalAlertProof).

- [ ] **Step 7: Vérifier typecheck**

```bash
cd video && npm run typecheck
```

Expected : clean.

- [ ] **Step 8: Premier rendu E2E des 3 vidéos**

```bash
cd video && npm run render
```

Expected : produit `video/out/brand-promo.mp4` (~2-4 MB, 18s, lifestyle hook + 3 beats existants). Durée ~30-60s pour le rendu.

```bash
cd video && npm run render:signal
```

Expected : produit `video/out/signal-alert.mp4` (~1-2 MB, 9s, lifestyle hook + RevealAct + DiscordCard + CtaAct).

```bash
cd video && npm run render:proof
```

Expected : produit `video/out/signal-alert-proof.mp4` (~2-4 MB, 17s, full proof avec entry+chart+exit).

- [ ] **Step 9: Test override CLI sur SignalAlertProof**

```bash
cd video && npm run render:proof -- --props='{"ticker":"NVDA","entryAuthor":"Bora","entryMessage":"$NVDA 870 entry","entryTimestamp":"2026-04-25T13:30:00-04:00","exitAuthor":"Bora","exitMessage":"$NVDA out +15%","exitTimestamp":"2026-04-25T15:00:00-04:00","pnl":"+15%"}'
```

Expected : re-rend `video/out/signal-alert-proof.mp4` avec les NVDA/Bora props. ~30s.

- [ ] **Step 10: Vérifier que le bot principal n'a pas été cassé**

```bash
npm test
```

(depuis la racine du repo). Expected : tests du bot continuent à passer (les 2 échecs pré-existants `saas/relay`, `services/llm-classify` peuvent rester — non causés par Phase 2.5).

- [ ] **Step 11: Commit final**

```bash
git add video/src/compositions/SignalAlertProof.tsx video/src/Root.tsx video/src/__tests__/composition.test.ts video/package.json
git commit -m "feat(video): SignalAlertProof composition (proof video 17s) + Phase 2.5 prête

Nouvelle composition de 510 frames (17s) avec 6 phases :
LifestyleHook → ResultTease → DiscordCard (entry) → TimePassAct
(chart explosion + 'X hours later') → DiscordCard (exit) → ResultCta.

Props : ticker, entryAuthor/entryMessage/entryTimestamp,
exitAuthor/exitMessage/exitTimestamp, pnl. Tous obligatoires —
sans les deux messages, pas de proof video.

Script npm run render:proof ajouté. Tests vont de 4 à 7 (3 nouveaux
pour SignalAlertProof).

Premier rendu E2E validé : brand-promo.mp4 (18s), signal-alert.mp4
(9s), signal-alert-proof.mp4 (17s). Override CLI testé sur Proof
avec NVDA/Bora.

Phase 2.5 complète."
```

---

## Vérification finale

Après Task 8 :

- [ ] `cd video && npm run typecheck` — clean
- [ ] `cd video && npm test` — 7/7 pass (1 BrandPromo + 3 SignalAlert + 3 SignalAlertProof)
- [ ] `cd video && npm run studio` — affiche 3 compositions sélectionnables
- [ ] `cd video && npm run render` — `out/brand-promo.mp4` existe
- [ ] `cd video && npm run render:signal` — `out/signal-alert.mp4` existe
- [ ] `cd video && npm run render:proof` — `out/signal-alert-proof.mp4` existe
- [ ] `cd video && npm run render:proof -- --props='{...}'` — re-rend avec override
- [ ] `npm test` à la racine — bot non régressé
- [ ] Visionnage manuel des 3 MP4 :
  - **brand-promo.mp4** : 0-3s lifestyle rapid cuts + "BOOM" overlay → 3-6s "STOP GUESSING TRADES" → 6-14s 3 cartes Discord → 14-18s logo + JOIN NOW + flash
  - **signal-alert.mp4** : 0-3s lifestyle + "$TSLA" overlay → 3-5s gros ticker zoom → 5-8s carte Discord native (Z + message) → 8-9s URL + flash
  - **signal-alert-proof.mp4** : 0-3s lifestyle + "+20%" overlay → 3-5s gros +20% pop → 5-8s entry card → 8-11s "3 hours later" + chart explosion → 11-14s exit card → 14-17s gros +20% confirmé + URL + flash

Si les 3 vidéos rendent correctement leurs 6 phases respectives : Phase 2.5 livrée. Phase 3 (bot automation) reste à faire dans une session future.
