# Remotion Signal Alert (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une nouvelle composition Remotion `SignalAlert` (vertical 9:16, 6 s, paramétrée via props) au sous-projet `video/`, rendue via `npm run render:signal` avec override CLI `--props='{...}'`.

**Architecture:** Étendre la fondation Phase 1 (sous-projet `video/`). Nouvelle composition `SignalAlert` qui consomme un type `SignalAlertProps` strictement typé. 3 actes (`RevealAct`, `DataAct`, `CtaAct`) chacun dans son propre fichier dans `video/src/components/`. `Root.tsx` enregistre la nouvelle composition à côté de `BrandPromo` avec `defaultProps`.

**Tech Stack:** Remotion 4.x (`@remotion/bundler`, `@remotion/renderer`, `@remotion/cli`), React 18, TypeScript 5, Vitest.

---

## File Structure

```
video/
├── package.json                          ← MODIFIÉ (ajout script render:signal)
├── src/
│   ├── compositions/
│   │   ├── BrandPromo.tsx                (existant, inchangé)
│   │   └── SignalAlert.tsx               ← NEW
│   ├── components/
│   │   ├── HookBeat.tsx                  (existant, inchangé)
│   │   ├── ValueBeat.tsx                 (existant, inchangé)
│   │   ├── CtaBeat.tsx                   (existant, inchangé)
│   │   ├── RevealAct.tsx                 ← NEW (Act 1)
│   │   ├── DataAct.tsx                   ← NEW (Act 2)
│   │   └── CtaAct.tsx                    ← NEW (Act 3)
│   ├── Root.tsx                          ← MODIFIÉ (enregistrer SignalAlert)
│   └── __tests__/
│       └── composition.test.ts           ← MODIFIÉ (3 nouveaux tests)
```

Chaque acte est un composant pur React qui reçoit ses props depuis `SignalAlert`. Les couleurs sémantiques (LONG=vert, SHORT=rouge, OUT selon pnl) sont calculées dans `DataAct`.

---

### Task 1 : Skeleton — composition `SignalAlert` minimale + Root + script + tests

Le but : avoir une composition `SignalAlert` registered avec les bonnes dimensions, durée, et `defaultProps` ; pouvoir lancer `npm run render:signal` ; tests valident le tout. Le contenu visuel est un simple AbsoluteFill noir — les actes arrivent dans Tasks 2-4.

**Files:**
- Create: `video/src/compositions/SignalAlert.tsx`
- Modify: `video/src/Root.tsx`
- Modify: `video/src/__tests__/composition.test.ts`
- Modify: `video/package.json`

- [ ] **Step 1: Écrire les 3 tests qui échouent**

Ouvre `video/src/__tests__/composition.test.ts` et ajoute ce bloc À LA FIN du fichier (après le `describe('BrandPromo composition', ...)` existant, sans le toucher) :

```ts
describe('SignalAlert composition', () => {
  test('is registered with correct dimensions and duration', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlert',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(30);
    expect(comp.durationInFrames).toBe(180);
  });

  test('has default props with expected fields', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlert',
    });
    expect(comp.defaultProps).toMatchObject({
      ticker: 'TSLA',
      type: 'entry',
      direction: 'long',
      entry: '150-155',
      target: '165',
      stop: '148',
      author: 'Z',
    });
  });

  test('accepts inputProps override without throwing', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlert',
      inputProps: {
        ticker: 'NVDA',
        author: 'Bora',
        type: 'entry',
        direction: 'long',
        entry: '870',
      },
    });
    expect(comp.id).toBe('SignalAlert');
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `cd video && npm test`

Expected: BrandPromo test passe (1/1), les 3 SignalAlert tests échouent avec un message du type "Could not find composition with ID SignalAlert".

- [ ] **Step 3: Créer la composition minimale `SignalAlert`**

Crée `video/src/compositions/SignalAlert.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill } from 'remotion';

export type SignalAlertProps = {
  ticker: string;
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
};

export const SignalAlert = (_props: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }} />
  );
};
```

(Le préfixe `_` sur `_props` est la convention pour signaler qu'on reçoit les props mais qu'on ne les utilise pas encore. Les actes consommeront les props dans Tasks 2-4. Pas d'eslint configuré dans `video/`, donc pas de directive nécessaire.)

- [ ] **Step 4: Enregistrer `SignalAlert` dans `Root.tsx`**

Remplace tout le contenu de `video/src/Root.tsx` par :

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
};

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
      <Composition
        id="SignalAlert"
        component={SignalAlert}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={signalAlertDefaults}
      />
    </>
  );
};
```

- [ ] **Step 5: Ajouter le script `render:signal` à `video/package.json`**

Dans `video/package.json`, dans la section `scripts`, AJOUTE la ligne `render:signal` après la ligne `render` existante. Le bloc final doit ressembler à :

```json
"scripts": {
  "studio": "remotion studio",
  "render": "remotion render BrandPromo out/brand-promo.mp4",
  "render:signal": "remotion render SignalAlert out/signal-alert.mp4",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
},
```

Ne touche à rien d'autre dans `package.json`.

- [ ] **Step 6: Relancer les tests pour vérifier qu'ils passent**

Run: `cd video && npm test`

Expected: 4/4 pass (BrandPromo + 3 SignalAlert). Le bundle peut prendre 10-30 s sur le premier run.

- [ ] **Step 7: Vérifier le typecheck**

Run: `cd video && npm run typecheck`

Expected: clean (aucune erreur). Le `_props: SignalAlertProps` ne déclenche pas d'erreur grâce au préfixe `_`.

- [ ] **Step 8: Vérifier que le bot principal n'a pas été cassé**

Run depuis la racine du repo : `npm test`

Expected: tous les tests existants du bot passent (le compte attendu peut être 124 ou plus selon l'état de main au moment du run — l'important est qu'aucun test ne casse à cause de notre ajout).

- [ ] **Step 9: Commit**

```bash
git add video/src/compositions/SignalAlert.tsx video/src/Root.tsx video/src/__tests__/composition.test.ts video/package.json
git commit -m "feat(video): SignalAlert composition skeleton + props + render script

Composition vide (AbsoluteFill noir) registered avec width=1080,
height=1920, fps=30, durationInFrames=180. defaultProps fournit
TSLA/Z/long/150-155 pour le studio. Script npm run render:signal
ajouté. Les 3 actes (Reveal/Data/CTA) arrivent dans les commits
suivants."
```

---

### Task 2 : RevealAct — Act 1 (0–2 s, logo + ticker zoom)

**Files:**
- Create: `video/src/components/RevealAct.tsx`
- Modify: `video/src/compositions/SignalAlert.tsx`

- [ ] **Step 1: Créer le composant `RevealAct`**

Crée `video/src/components/RevealAct.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring } from 'remotion';

type Props = { ticker: string };

export const RevealAct = ({ ticker }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Logo : entrée fade en 15 frames.
  const logoOpacity = spring({
    frame,
    fps,
    config: { damping: 14 },
    durationInFrames: 15,
  });

  // Ticker : spring scale-in plus tardif (frames 10-40).
  const tickerScale = spring({
    frame: frame - 10,
    fps,
    config: { damping: 12, stiffness: 100 },
    durationInFrames: 30,
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <Img
        src={staticFile('logo_boom.png')}
        style={{
          width: 200,
          height: 200,
          alignSelf: 'center',
          marginTop: 120,
          opacity: logoOpacity,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(-50%, -50%) scale(${tickerScale})`,
          color: 'white',
          fontSize: 220,
          fontWeight: 900,
          letterSpacing: -5,
        }}
      >
        ${ticker}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Brancher `RevealAct` dans `SignalAlert` via Sequence**

Remplace tout le contenu de `video/src/compositions/SignalAlert.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
import { RevealAct } from '../components/RevealAct';

export type SignalAlertProps = {
  ticker: string;
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
};

export const SignalAlert = ({ ticker }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
    </AbsoluteFill>
  );
};
```

(On déstructure uniquement `ticker` pour l'instant — les autres props seront consommées au fur et à mesure dans Tasks 3 et 4. TypeScript n'oblige pas à déstructurer toutes les propriétés, donc c'est légal.)

- [ ] **Step 3: Vérifier typecheck et tests**

Run: `cd video && npm run typecheck && npm test`

Expected: typecheck clean, 4/4 tests pass.

- [ ] **Step 4: Skip visual verification (différée à Task 5)**

NE PAS lancer `npm run studio`. Vérification visuelle = rendu MP4 à Task 5.

- [ ] **Step 5: Commit**

```bash
git add video/src/components/RevealAct.tsx video/src/compositions/SignalAlert.tsx
git commit -m "feat(video): SignalAlert Act 1 — RevealAct (logo + ticker zoom)

60 frames (0-2s). Logo BOOM (réutilise public/logo_boom.png) qui
fade in en haut, puis ticker \$TSLA qui zoom in via spring au centre.
Fond gradient noir → bleu nuit."
```

---

### Task 3 : DataAct — Act 2 (2–5 s, direction + prix + auteur)

**Files:**
- Create: `video/src/components/DataAct.tsx`
- Modify: `video/src/compositions/SignalAlert.tsx`

- [ ] **Step 1: Créer le composant `DataAct`**

Crée `video/src/components/DataAct.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

type Props = {
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
};

const COLOR_GREEN = '#10b981';
const COLOR_RED = '#ef4444';

function pickColor(type: 'entry' | 'exit', direction: 'long' | 'short' | undefined, pnl: string | undefined): string {
  if (type === 'entry') {
    return direction === 'short' ? COLOR_RED : COLOR_GREEN;
  }
  // exit
  if (pnl && pnl.startsWith('-')) return COLOR_RED;
  return COLOR_GREEN;
}

export const DataAct = ({ type, direction, entry, target, stop, pnl, author }: Props) => {
  const frame = useCurrentFrame();

  // Cascade : direction puis prices puis auteur, chaque élément fade in sur 15 frames.
  const directionOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });
  const pricesOpacity = interpolate(frame, [15, 30], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });
  const authorOpacity = interpolate(frame, [30, 45], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  const color = pickColor(type, direction, pnl);
  const directionLabel = type === 'entry' ? (direction || 'long').toUpperCase() : 'OUT';

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        fontFamily: 'sans-serif',
        padding: '180px 60px 100px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          color,
          fontSize: 110,
          fontWeight: 900,
          textAlign: 'center',
          letterSpacing: 4,
          opacity: directionOpacity,
        }}
      >
        {directionLabel}
      </div>

      <div
        style={{
          opacity: pricesOpacity,
          color: 'white',
          fontSize: 56,
          fontWeight: 700,
          textAlign: 'center',
          marginTop: 40,
        }}
      >
        {type === 'entry' && entry ? (
          <div>
            Entry <span style={{ color }}>{entry}</span>
          </div>
        ) : null}
        {type === 'entry' && target ? (
          <div style={{ marginTop: 12, fontSize: 44, color: '#dcddde' }}>Target {target}</div>
        ) : null}
        {type === 'entry' && stop ? (
          <div style={{ marginTop: 4, fontSize: 44, color: '#dcddde' }}>Stop {stop}</div>
        ) : null}
        {type === 'exit' && pnl ? (
          <div style={{ fontSize: 110, color, fontWeight: 900 }}>{pnl}</div>
        ) : null}
      </div>

      <div
        style={{
          opacity: authorOpacity,
          color: '#D649CC',
          fontSize: 48,
          fontWeight: 700,
          textAlign: 'center',
          marginTop: 'auto',
        }}
      >
        — {author}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Brancher `DataAct` dans `SignalAlert`**

Remplace tout le contenu de `video/src/compositions/SignalAlert.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
import { RevealAct } from '../components/RevealAct';
import { DataAct } from '../components/DataAct';

export type SignalAlertProps = {
  ticker: string;
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
};

export const SignalAlert = ({ ticker, type, direction, entry, target, stop, pnl, author }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
      <Sequence from={60} durationInFrames={90}>
        <DataAct
          type={type}
          direction={direction}
          entry={entry}
          target={target}
          stop={stop}
          pnl={pnl}
          author={author}
        />
      </Sequence>
    </AbsoluteFill>
  );
};
```

(Toutes les props sont maintenant utilisées : `ticker` par RevealAct, les 7 autres par DataAct.)

- [ ] **Step 3: Vérifier typecheck et tests**

Run: `cd video && npm run typecheck && npm test`

Expected: typecheck clean, 4/4 tests pass.

- [ ] **Step 4: Skip visual verification**

NE PAS lancer `npm run studio`.

- [ ] **Step 5: Commit**

```bash
git add video/src/components/DataAct.tsx video/src/compositions/SignalAlert.tsx
git commit -m "feat(video): SignalAlert Act 2 — DataAct (direction + prix + auteur)

90 frames (2-5s). Direction (LONG/SHORT/OUT) avec couleur sémantique
(vert long, rouge short, vert/rouge selon pnl pour exit), entry/target/
stop pour entries OU pnl pour exits, auteur en violet. Cascade fade-in
sur 3 phases (direction puis prices puis auteur)."
```

---

### Task 4 : CtaAct — Act 3 (5–6 s, URL + flash)

**Files:**
- Create: `video/src/components/CtaAct.tsx`
- Modify: `video/src/compositions/SignalAlert.tsx`

- [ ] **Step 1: Créer le composant `CtaAct`**

Crée `video/src/components/CtaAct.tsx` avec ce contenu EXACT :

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

export const CtaAct = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // CtaAct dure 30 frames (1 s).
  // URL : slide-up + fade in sur les 15 premières frames.
  const urlEntry = spring({
    frame,
    fps,
    config: { damping: 12 },
    durationInFrames: 15,
  });
  const urlY = interpolate(urlEntry, [0, 1], [80, 0]);

  // Flash blanc final sur les 3 dernières frames (27-29).
  const flashOpacity = interpolate(frame, [27, 29], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        fontFamily: 'sans-serif',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          color: 'white',
          fontSize: 64,
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

- [ ] **Step 2: Brancher `CtaAct` dans `SignalAlert`**

Remplace tout le contenu de `video/src/compositions/SignalAlert.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
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
};

export const SignalAlert = ({ ticker, type, direction, entry, target, stop, pnl, author }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
      <Sequence from={60} durationInFrames={90}>
        <DataAct
          type={type}
          direction={direction}
          entry={entry}
          target={target}
          stop={stop}
          pnl={pnl}
          author={author}
        />
      </Sequence>
      <Sequence from={150} durationInFrames={30}>
        <CtaAct />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Vérifier typecheck et tests**

Run: `cd video && npm run typecheck && npm test`

Expected: typecheck clean, 4/4 tests pass.

- [ ] **Step 4: Skip visual verification**

NE PAS lancer `npm run studio`.

- [ ] **Step 5: Commit**

```bash
git add video/src/components/CtaAct.tsx video/src/compositions/SignalAlert.tsx
git commit -m "feat(video): SignalAlert Act 3 — CtaAct (URL + flash final)

30 frames (5-6s). URL discord.gg/boom qui slide-up depuis le bas via
spring + fade in, flash blanc total sur les 3 dernières frames."
```

---

### Task 5 : Audio slot + rendu E2E (default + custom props)

**Files:**
- Modify: `video/src/compositions/SignalAlert.tsx` (ajout du slot audio commenté)

- [ ] **Step 1: Ajouter le slot audio commenté dans `SignalAlert`**

Remplace tout le contenu de `video/src/compositions/SignalAlert.tsx` par :

```tsx
import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
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
};

export const SignalAlert = ({ ticker, type, direction, entry, target, stop, pnl, author }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/signal-track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/signal-track.mp3')} /> */}

      <Sequence from={0} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
      <Sequence from={60} durationInFrames={90}>
        <DataAct
          type={type}
          direction={direction}
          entry={entry}
          target={target}
          stop={stop}
          pnl={pnl}
          author={author}
        />
      </Sequence>
      <Sequence from={150} durationInFrames={30}>
        <CtaAct />
      </Sequence>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Premier rendu avec defaultProps**

Run: `cd video && npm run render:signal`

Expected: bundle puis rend les 180 frames. Sortie : `video/out/signal-alert.mp4` (~1-3 MB). Durée ~30-60 s sur la première run (Chromium déjà téléchargé en Phase 1).

- [ ] **Step 3: Vérifier le MP4**

```bash
ls -la video/out/signal-alert.mp4
```

Expected: fichier existe, taille entre 0.5 MB et 5 MB. Si <0.5 MB ou render avait échoué, escalade.

- [ ] **Step 4: Rendu avec custom props (override CLI)**

Run: `cd video && npm run render:signal -- --props='{"ticker":"NVDA","author":"Bora","type":"entry","direction":"long","entry":"870","target":"885","stop":"865"}'`

Expected: re-rend `video/out/signal-alert.mp4` (écrase le précédent) avec NVDA/Bora cette fois. Durée ~10-30 s (bundle réutilisé).

- [ ] **Step 5: Vérifier que le MP4 a été re-rendu**

```bash
ls -la video/out/signal-alert.mp4
```

Expected: fichier existe toujours, modification time récente (au cours de la dernière minute). Taille similaire au premier rendu.

- [ ] **Step 6: Vérifier la suite de tests**

Run: `cd video && npm test`

Expected: 4/4 pass.

Run: `npm test` (depuis racine du repo)

Expected: tous les tests existants du bot passent.

- [ ] **Step 7: Commit**

```bash
git add video/src/compositions/SignalAlert.tsx
git commit -m "feat(video): SignalAlert slot audio commenté + Phase 2 prête

Slot Audio commenté avec instructions inline (déposer MP3 dans
video/public/audio/signal-track.mp3 puis décommenter).

Premier rendu E2E validé :
- npm run render:signal → MP4 avec defaultProps (TSLA/Z)
- npm run render:signal -- --props='...' → MP4 avec NVDA/Bora override

Phase 2 complète."
```

---

## Vérification finale

Après Task 5, l'état attendu :

- [ ] `cd video && npm run typecheck` — clean
- [ ] `cd video && npm test` — 4/4 pass (1 BrandPromo + 3 SignalAlert)
- [ ] `cd video && npm run studio` — l'éditeur affiche 2 compositions sélectionnables (BrandPromo, SignalAlert). SignalAlert est jouable avec defaultProps.
- [ ] `cd video && npm run render` — toujours fonctionnel (rend Brand Promo)
- [ ] `cd video && npm run render:signal` — produit `video/out/signal-alert.mp4` (~1-3 MB, 6 s, 1080×1920)
- [ ] `cd video && npm run render:signal -- --props='{"ticker":"NVDA","author":"Bora","type":"entry","direction":"long","entry":"870"}'` — re-rend avec NVDA/Bora
- [ ] `npm test` à la racine — non-régression du bot principal

Le MP4 ouvert dans un lecteur vidéo doit montrer :
- 0–2 s : logo BOOM puis ticker `$TSLA` (ou `$NVDA` selon les props) qui apparaît au centre en zoom
- 2–5 s : `LONG` en vert (ou `SHORT` rouge / `OUT +X%` selon les props), entry/target/stop, auteur en violet
- 5–6 s : URL `discord.gg/boom` qui slide-up + flash blanc final

Si les 3 actes apparaissent dans l'ordre attendu et que le ticker reflète les `--props` du CLI : Phase 2 livrée. Phase 3 (automatisation depuis le bot) sera son propre cycle dans une session future.
