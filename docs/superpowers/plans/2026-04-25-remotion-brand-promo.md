# Remotion fondation + Brand Promo (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mettre en place un sous-projet `video/` autonome qui rend le template Brand Promo (9:16 vertical, 15 s, 3 beats) en MP4 via une commande CLI locale, sans toucher au bot principal.

**Architecture:** Sous-projet TypeScript à la racine du repo (`video/`), avec son propre `package.json`, ses propres dépendances Remotion, et son propre runner de test (Vitest). Aucun couplage avec le bot Node/JS racine. Trigger CLI local : `cd video && npm run render` produit `video/out/brand-promo.mp4`.

**Tech Stack:** Remotion 4.x, React 18, TypeScript 5, Vitest, ESBuild (intégré à Remotion).

---

## File Structure

Fichiers créés ou modifiés en Phase 1 :

```
discord-trading-bot/
├── .gitignore                     ← MODIFIÉ : ajouter video/node_modules/, video/out/
└── video/                         ← NOUVEAU sous-projet
    ├── .gitignore                 (NEW : ignore node_modules, out, *.log)
    ├── package.json               (NEW : deps Remotion + scripts)
    ├── tsconfig.json              (NEW : config TS strict mode + react-jsx)
    ├── remotion.config.ts         (NEW : config bundler)
    ├── vitest.config.ts           (NEW : timeout 60 s pour les bundles)
    ├── src/
    │   ├── index.ts               (NEW : registerRoot)
    │   ├── Root.tsx               (NEW : Composition registry)
    │   ├── compositions/
    │   │   └── BrandPromo.tsx     (NEW : 3 Sequences enchaînés)
    │   ├── components/
    │   │   ├── HookBeat.tsx       (NEW : Beat 1)
    │   │   ├── ValueBeat.tsx      (NEW : Beat 2)
    │   │   └── CtaBeat.tsx        (NEW : Beat 3)
    │   └── __tests__/
    │       └── composition.test.ts (NEW : selectComposition)
    └── public/
        ├── logo_boom.png          (COPIÉ depuis racine)
        └── audio/
            └── .gitkeep           (NEW : slot audio réservé)
```

---

### Task 1 : Scaffold du sous-projet `video/`

**Files:**
- Create: `video/package.json`
- Create: `video/tsconfig.json`
- Create: `video/remotion.config.ts`
- Create: `video/vitest.config.ts`
- Create: `video/.gitignore`
- Create: `video/src/index.ts`
- Create: `video/src/Root.tsx` (provisoire vide)
- Create: `video/public/audio/.gitkeep`
- Modify: `.gitignore` (racine)

- [ ] **Step 1: Créer la structure de répertoires**

Run depuis la racine du repo :

```bash
mkdir -p video/src/compositions video/src/components video/src/__tests__ video/public/audio video/out
```

- [ ] **Step 2: Créer `video/package.json`**

```json
{
  "name": "boom-video",
  "version": "1.0.0",
  "private": true,
  "description": "Remotion sub-project for BOOM marketing videos",
  "scripts": {
    "studio": "remotion studio",
    "render": "remotion render BrandPromo out/brand-promo.mp4",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@remotion/bundler": "^4.0.0",
    "@remotion/cli": "^4.0.0",
    "@remotion/renderer": "^4.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "remotion": "^4.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 3: Créer `video/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Créer `video/remotion.config.ts`**

```ts
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
```

- [ ] **Step 5: Créer `video/vitest.config.ts`**

Le bundle Remotion peut prendre 5-30 s sur le premier run. On augmente le timeout pour éviter les faux échecs.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 6: Créer `video/.gitignore`**

```
node_modules/
out/
*.log
.DS_Store
```

- [ ] **Step 7: Créer `video/src/index.ts`**

```ts
import { registerRoot } from 'remotion';
import { Root } from './Root';

registerRoot(Root);
```

- [ ] **Step 8: Créer `video/src/Root.tsx` (provisoire — pas encore de composition)**

```tsx
export const Root = () => {
  return <></>;
};
```

- [ ] **Step 9: Créer `video/public/audio/.gitkeep`**

Fichier vide pour que git track le répertoire :

```bash
touch video/public/audio/.gitkeep
```

- [ ] **Step 10: Mettre à jour le `.gitignore` racine**

Ajouter ces deux lignes (ne PAS toucher aux autres) :

```
video/node_modules/
video/out/
```

- [ ] **Step 11: Installer les dépendances**

```bash
cd video && npm install
```

Expected: install termine sans erreur. Le `node_modules/` peut peser 200-500 MB (Remotion + Chromium).

- [ ] **Step 12: Vérifier la compilation TypeScript**

```bash
cd video && npm run typecheck
```

Expected: aucune erreur (le projet est minimal, juste un Root vide).

- [ ] **Step 13: Commit**

```bash
git add video/.gitignore video/package.json video/package-lock.json video/tsconfig.json video/remotion.config.ts video/vitest.config.ts video/src/index.ts video/src/Root.tsx video/public/audio/.gitkeep .gitignore
git commit -m "chore: scaffold video/ sub-project for Remotion

Sous-projet TypeScript autonome avec ses propres dépendances
(Remotion 4.x + React 18 + Vitest). Aucun impact sur le bot principal.
Root.tsx vide pour l'instant — la première composition arrive au
prochain commit."
```

---

### Task 2 : Composition `BrandPromo` minimale + test de validation

**Files:**
- Create: `video/src/compositions/BrandPromo.tsx`
- Create: `video/src/__tests__/composition.test.ts`
- Modify: `video/src/Root.tsx` (registre la composition)

- [ ] **Step 1: Écrire le test qui échoue**

Crée `video/src/__tests__/composition.test.ts` :

```ts
import { describe, expect, test, beforeAll } from 'vitest';
import { bundle } from '@remotion/bundler';
import { selectComposition } from '@remotion/renderer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let bundleLocation: string;

beforeAll(async () => {
  bundleLocation = await bundle({
    entryPoint: path.join(__dirname, '..', 'index.ts'),
  });
});

describe('BrandPromo composition', () => {
  test('is registered with correct dimensions and duration', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'BrandPromo',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(30);
    expect(comp.durationInFrames).toBe(450);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
cd video && npm test
```

Expected: échec. Soit le bundle échoue (Root vide, pas de composition `BrandPromo`), soit `selectComposition` rejette parce que l'id `BrandPromo` n'existe pas. Le message d'erreur doit mentionner `BrandPromo` introuvable.

- [ ] **Step 3: Créer la composition minimale**

Crée `video/src/compositions/BrandPromo.tsx` :

```tsx
import { AbsoluteFill } from 'remotion';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }} />
  );
};
```

- [ ] **Step 4: Enregistrer la composition dans Root**

Remplace `video/src/Root.tsx` par :

```tsx
import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';

export const Root = () => {
  return (
    <>
      <Composition
        id="BrandPromo"
        component={BrandPromo}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
```

- [ ] **Step 5: Relancer le test**

```bash
cd video && npm test
```

Expected: 1 pass, 0 fail. Le test peut prendre 10-30 s (premier bundle).

- [ ] **Step 6: Vérifier le typecheck**

```bash
cd video && npm run typecheck
```

Expected: aucune erreur.

- [ ] **Step 7: Commit**

```bash
git add video/src/compositions/BrandPromo.tsx video/src/Root.tsx video/src/__tests__/composition.test.ts
git commit -m "feat(video): composition BrandPromo registered (1080x1920 / 30fps / 15s)

Composition minimale (AbsoluteFill noir) + test selectComposition
qui valide width=1080, height=1920, fps=30, durationInFrames=450.
Les beats Hook/Value/CTA arrivent dans les commits suivants."
```

---

### Task 3 : Beat 1 — `HookBeat` (« STOP GUESSING TRADES »)

**Files:**
- Create: `video/src/components/HookBeat.tsx`
- Modify: `video/src/compositions/BrandPromo.tsx`

- [ ] **Step 1: Créer le composant `HookBeat`**

Crée `video/src/components/HookBeat.tsx` :

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion';

export const HookBeat = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Le composant tourne dans une Sequence de 90 frames (3 s).
  // frame 0..90 ; spring d'entrée : 0..30 (1 s).
  const scale = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 100, mass: 0.8 },
  });

  // Légère vibration sur "STOP" pendant la première seconde (2 px d'amplitude).
  const shakeX = frame < 30 ? Math.sin(frame * 1.6) * 2 : 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: 'black',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 60,
      }}
    >
      <div
        style={{
          transform: `scale(${scale}) translateX(${shakeX}px)`,
          color: 'white',
          fontSize: 130,
          fontWeight: 900,
          fontFamily: 'sans-serif',
          letterSpacing: -2,
          lineHeight: 1.05,
          textAlign: 'center',
        }}
      >
        STOP GUESSING<br />TRADES
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Brancher `HookBeat` dans `BrandPromo` via Sequence**

Remplace `video/src/compositions/BrandPromo.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
import { HookBeat } from '../components/HookBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={90}>
        <HookBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Vérifier le typecheck et le test**

```bash
cd video && npm run typecheck && npm test
```

Expected: typecheck OK, test passe (la composition est toujours registered avec les bons params, le beat 1 est un detail d'implémentation interne).

- [ ] **Step 4: Vérification visuelle dans Remotion Studio**

```bash
cd video && npm run studio
```

Ouvre `http://localhost:3000` (ou le port indiqué par Remotion). Sélectionne `BrandPromo`, scrub la timeline de 0 à 90 frames. Tu dois voir :
- Texte « STOP GUESSING / TRADES » qui apparaît avec un effet de scale (zoom in)
- Légère vibration horizontale pendant la première seconde
- Fond noir
- Frames 90+ : retour au noir vide (les autres beats arrivent plus tard)

Ferme le studio (Ctrl+C) une fois validé.

- [ ] **Step 5: Commit**

```bash
git add video/src/components/HookBeat.tsx video/src/compositions/BrandPromo.tsx
git commit -m "feat(video): Brand Promo Beat 1 — Hook \"STOP GUESSING TRADES\"

90 frames (0-3s). Texte blanc géant qui apparaît via spring scale,
légère vibration horizontale sur la première seconde. Fond noir."
```

---

### Task 4 : Beat 2 — `ValueBeat` (3 cartes Discord)

**Files:**
- Create: `video/src/components/ValueBeat.tsx`
- Modify: `video/src/compositions/BrandPromo.tsx`

- [ ] **Step 1: Créer le composant `ValueBeat`**

Crée `video/src/components/ValueBeat.tsx` :

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

const CARDS = [
  { author: 'Z', time: '9:32am', message: '$TSLA 150 entry long', color: '#dcddde' },
  { author: 'Bora', time: '10:15am', message: '$NVDA 870 scalp', color: '#dcddde' },
  { author: 'Viking', time: '11:02am', message: '$AMD out +8%', color: '#10b981' },
];

type CardProps = {
  index: number;
  author: string;
  time: string;
  message: string;
  color: string;
};

const SignalCard = ({ index, author, time, message, color }: CardProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ValueBeat dure 240 frames (8 s). Les cartes apparaissent à
  // 30, 90, 150 frames (1 s, 3 s, 5 s après le début du beat).
  const startFrame = 30 + index * 60;
  const localFrame = frame - startFrame;

  const opacity = interpolate(localFrame, [0, 15], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });
  const translateY = spring({
    frame: localFrame,
    fps,
    config: { damping: 14 },
    durationInFrames: 30,
  });
  const y = interpolate(translateY, [0, 1], [60, 0]);

  return (
    <div
      style={{
        background: '#1e1f22',
        padding: '24px 28px',
        borderRadius: 12,
        marginBottom: 18,
        opacity,
        transform: `translateY(${y}px)`,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <span style={{ color: '#D649CC', fontWeight: 700, fontSize: 32 }}>{author}</span>
        <span style={{ color: '#80848e', fontSize: 22 }}>{time}</span>
      </div>
      <div style={{ color, fontSize: 32, fontWeight: 600 }}>{message}</div>
    </div>
  );
};

export const ValueBeat = () => {
  const frame = useCurrentFrame();
  const headerOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        padding: '120px 60px 60px',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          color: 'white',
          fontSize: 56,
          fontWeight: 700,
          textAlign: 'center',
          marginBottom: 60,
          opacity: headerOpacity,
          lineHeight: 1.2,
        }}
      >
        Real-time signals<br />from top traders
      </div>
      {CARDS.map((c, i) => (
        <SignalCard key={c.author} index={i} {...c} />
      ))}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Ajouter la Sequence `ValueBeat` dans `BrandPromo`**

Remplace `video/src/compositions/BrandPromo.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
import { HookBeat } from '../components/HookBeat';
import { ValueBeat } from '../components/ValueBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={90}>
        <HookBeat />
      </Sequence>
      <Sequence from={90} durationInFrames={240}>
        <ValueBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Vérifier le typecheck et le test**

```bash
cd video && npm run typecheck && npm test
```

Expected: typecheck OK, test toujours OK.

- [ ] **Step 4: Vérification visuelle dans le studio**

```bash
cd video && npm run studio
```

Scrub de 90 à 330 frames. Tu dois voir :
- Header « Real-time signals from top traders » qui fade in
- 3 cartes Discord qui apparaissent une par une (à 1 s, 3 s, 5 s du début du beat — soit frames 120, 180, 240)
- Chaque carte slide-up + fade in
- Fond gradient noir → bleu nuit

- [ ] **Step 5: Commit**

```bash
git add video/src/components/ValueBeat.tsx video/src/compositions/BrandPromo.tsx
git commit -m "feat(video): Brand Promo Beat 2 — ValueBeat (3 cartes Discord)

240 frames (3-11s). Header puis 3 cartes auteur+message qui
apparaissent séquentiellement (slide-up + fade in). Z, Bora, Viking
en data hardcodée. Fond gradient noir → bleu nuit."
```

---

### Task 5 : Beat 3 — `CtaBeat` (logo + JOIN NOW)

**Files:**
- Copy: `logo_boom.png` (racine) → `video/public/logo_boom.png`
- Create: `video/src/components/CtaBeat.tsx`
- Modify: `video/src/compositions/BrandPromo.tsx`

- [ ] **Step 1: Copier le logo dans `video/public/`**

```bash
cp logo_boom.png video/public/logo_boom.png
```

Note : `staticFile()` de Remotion résout les chemins relatifs à `public/`, donc on l'appellera avec `staticFile('logo_boom.png')`.

- [ ] **Step 2: Créer le composant `CtaBeat`**

Crée `video/src/components/CtaBeat.tsx` :

```tsx
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

export const CtaBeat = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // CtaBeat dure 120 frames (4 s).
  // Logo : pulse continu (sin) + entrée en spring sur les 20 premières frames.
  const entryScale = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 90 },
    durationInFrames: 20,
  });
  const pulse = 1 + Math.sin(frame * 0.15) * 0.04;
  const logoScale = entryScale * pulse;

  // Tagline + CTA : fade in à 25 frames.
  const taglineOpacity = interpolate(frame, [25, 45], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  // Flash blanc final sur les 3 dernières frames (117-119).
  const flashOpacity = interpolate(frame, [117, 119], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 50%, #5865f2 0%, #0a0a0a 75%)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 60,
        fontFamily: 'sans-serif',
      }}
    >
      <Img
        src={staticFile('logo_boom.png')}
        style={{ width: 320, height: 320, transform: `scale(${logoScale})` }}
      />
      <div
        style={{
          color: 'white',
          fontSize: 96,
          fontWeight: 900,
          letterSpacing: 8,
          marginTop: 32,
          transform: `scale(${entryScale})`,
        }}
      >
        BOOM
      </div>
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 38,
          textAlign: 'center',
          marginTop: 18,
          lineHeight: 1.3,
          opacity: taglineOpacity,
        }}
      >
        Trading signals.<br />Real results.
      </div>
      <div
        style={{
          marginTop: 48,
          padding: '20px 40px',
          background: 'white',
          color: 'black',
          fontSize: 38,
          fontWeight: 800,
          borderRadius: 12,
          opacity: taglineOpacity,
        }}
      >
        JOIN NOW →
      </div>
      <div
        style={{
          color: '#80848e',
          fontSize: 28,
          marginTop: 24,
          opacity: taglineOpacity,
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

- [ ] **Step 3: Ajouter la Sequence `CtaBeat` dans `BrandPromo`**

Remplace `video/src/compositions/BrandPromo.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
import { HookBeat } from '../components/HookBeat';
import { ValueBeat } from '../components/ValueBeat';
import { CtaBeat } from '../components/CtaBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={90}>
        <HookBeat />
      </Sequence>
      <Sequence from={90} durationInFrames={240}>
        <ValueBeat />
      </Sequence>
      <Sequence from={330} durationInFrames={120}>
        <CtaBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Vérifier le typecheck et le test**

```bash
cd video && npm run typecheck && npm test
```

Expected: typecheck OK, test OK.

- [ ] **Step 5: Vérification visuelle dans le studio**

```bash
cd video && npm run studio
```

Scrub de 330 à 450 frames. Tu dois voir :
- Logo BOOM qui apparaît en spring puis pulse doucement
- Tagline + bouton « JOIN NOW → » + URL qui fade in à frame ~355
- Flash blanc total sur les 3 dernières frames (447-449)
- Fond radial bleu → noir

- [ ] **Step 6: Commit**

```bash
git add video/public/logo_boom.png video/src/components/CtaBeat.tsx video/src/compositions/BrandPromo.tsx
git commit -m "feat(video): Brand Promo Beat 3 — CTA (logo + JOIN NOW)

120 frames (11-15s). Logo BOOM avec entrée spring + pulse continu,
tagline et bouton JOIN NOW qui fade in, URL discord.gg/boom, flash
blanc sur les 3 dernières frames. Fond radial bleu Discord → noir."
```

---

### Task 6 : Slot audio + premier rendu E2E

**Files:**
- Modify: `video/src/compositions/BrandPromo.tsx` (ajout import Audio commenté)

- [ ] **Step 1: Ajouter le slot audio commenté dans `BrandPromo`**

Remplace `video/src/compositions/BrandPromo.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
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
        <HookBeat />
      </Sequence>
      <Sequence from={90} durationInFrames={240}>
        <ValueBeat />
      </Sequence>
      <Sequence from={330} durationInFrames={120}>
        <CtaBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Premier rendu E2E**

```bash
cd video && npm run render
```

Expected: Remotion bundle puis rend les 450 frames. Logs en console montrent la progression. Au bout de ~30-90 s (selon CPU), le fichier `video/out/brand-promo.mp4` est créé. Taille attendue : 5-15 MB.

- [ ] **Step 3: Vérification visuelle du MP4**

Ouvre `video/out/brand-promo.mp4` dans VLC, QuickTime, Windows Media Player, ou tout autre lecteur vidéo. Vérifie :
- Durée exacte 15 s
- Résolution 1080×1920 (vertical)
- Beat 1 (0-3 s) : « STOP GUESSING TRADES » avec scale + vibration
- Beat 2 (3-11 s) : header puis 3 cartes Discord qui apparaissent
- Beat 3 (11-15 s) : logo BOOM + tagline + JOIN NOW + URL + flash blanc final
- Pas d'audio (slot vide)

Si le fichier semble OK : continue. Si quelque chose est cassé : lance le studio (`npm run studio`) pour debugger.

- [ ] **Step 4: Vérifier que le bot principal n'a pas été cassé**

Depuis la racine du repo :

```bash
npm test
```

Expected: tous les tests existants du bot passent (146 tests). Aucune régression liée à l'ajout de `video/`.

- [ ] **Step 5: Commit final**

```bash
git add video/src/compositions/BrandPromo.tsx
git commit -m "feat(video): slot audio commenté + Brand Promo prêt à rendre

Slot Audio commenté avec instructions inline pour l'utilisateur :
déposer un MP3 dans video/public/audio/track.mp3 puis décommenter.

Premier rendu E2E validé : video/out/brand-promo.mp4, 15 s, 1080x1920,
3 beats enchaînés. Phase 1 complète."
```

---

## Vérification finale

Après Task 6, l'état attendu :

- [ ] `cd video && npm install` → OK (a déjà tourné en Task 1)
- [ ] `cd video && npm run typecheck` → OK
- [ ] `cd video && npm test` → 1 test pass (composition validée)
- [ ] `cd video && npm run studio` → ouvre l'éditeur, BrandPromo lisible
- [ ] `cd video && npm run render` → produit `video/out/brand-promo.mp4` (~5-15 MB, 15 s)
- [ ] Le fichier MP4 ouvert dans un lecteur montre les 3 beats dans l'ordre
- [ ] `npm test` à la racine → 146 tests passent (aucune régression)

Si tout coche : Phase 1 livrée. Phases futures (templates A/B/C, automatisation) auront chacune leur propre cycle spec → plan → impl en réutilisant cette fondation.
