# Remotion — Signal Alert template (Phase 2) — design

## Contexte

Phase 1 a livré la fondation Remotion + le template Brand Promo (vidéo statique de marque). Phase 2 ajoute le **template A — Signal Alert** : une vidéo courte (6 s, vertical 9:16) piloté par les données d'un signal de trading, prête à être rendue à la demande pour chaque alerte du bot.

**Cas d'usage typique** : quand un analyste poste un signal sur Discord (ex: `Z · $TSLA 150-155 entry long`), l'utilisateur peut générer une vidéo verticale stylée pour Reels/TikTok/Shorts en passant les données via la ligne de commande, sans toucher au code.

L'automatisation (le bot déclenche le rendu automatiquement à chaque signal) est explicitement **Phase 3** — Phase 2 se concentre sur la composition et la paramétrisation.

## Architecture

### Réutilisation de la fondation Phase 1

- Même sous-projet `video/` (TypeScript + Remotion 4.x + Vitest).
- Même format vertical 9:16 / 1080×1920 / 30 fps / codec h264.
- Même pipeline de rendu local CLI.
- Même stratégie audio : slot commenté dans la composition.
- Même registre `Root.tsx` étendu — pas de refactoring (les noms de composants restent distincts entre Phase 1 et 2).

### Spécifique à Phase 2 : paramétrisation via props

Choix architectural majeur : la composition `SignalAlert` est **paramétrée** (contrairement à `BrandPromo` qui est statique). Trois conséquences :

1. La composition Remotion déclare un type `SignalAlertProps`.
2. `<Composition>` dans `Root.tsx` reçoit `defaultProps` (valeurs raisonnables pour le studio).
3. Au rendu CLI, l'utilisateur peut surcharger via `--props='{...}'`.

Cette approche s'appuie sur le mécanisme officiel Remotion documenté pour la paramétrisation, et prépare Phase 3 (le bot pourra appeler `renderMedia({ inputProps })` programmatiquement avec exactement les mêmes props).

## Composition `SignalAlert`

**Spécifications techniques :**
- Format : 1080 × 1920 (9:16 vertical)
- Durée : 6 s
- Frame rate : 30 fps → `durationInFrames: 180`
- Codec : h264 (MP4)
- ID : `SignalAlert`

### Props

```ts
type SignalAlertProps = {
  ticker: string;                     // ex: 'TSLA'
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';       // requis si type === 'entry'
  entry?: string;                     // ex: '150-155' ou '150' (zone ou prix unique)
  target?: string;                    // ex: '165'
  stop?: string;                      // ex: '148'
  pnl?: string;                       // ex: '+10%' (uniquement si type === 'exit')
  author: string;                     // ex: 'Z'
};
```

**defaultProps** (valeurs montrées dans le studio sans CLI override) :

```ts
{
  ticker: 'TSLA',
  type: 'entry',
  direction: 'long',
  entry: '150-155',
  target: '165',
  stop: '148',
  author: 'Z',
}
```

Le composant lit les props avec `getInputProps<SignalAlertProps>()` au sommet et passe les fragments pertinents à chaque acte.

### Structure narrative (3 actes)

| Acte | Frames | Durée | Contenu | Composant |
|------|--------|-------|---------|-----------|
| 1. Reveal | 0–60 | 0–2 s | Logo BOOM (réutilise `staticFile('logo_boom.png')` de Phase 1) en haut, fond gradient bleu nuit, ticker `$TSLA` qui zoom in via `spring()` au centre | `RevealAct` |
| 2. Data | 60–150 | 2–5 s | Direction (`LONG` en vert / `SHORT` en rouge / `OUT +10%` en vert ou rouge selon pnl), entry zone, target & stop apparaissent en cascade (slide-up + fade), nom de l'auteur en bas (`Z` en violet `#D649CC`, sans avatar image) | `DataAct` |
| 3. CTA | 150–180 | 5–6 s | URL `discord.gg/boom` qui slide in du bas + flash blanc final sur les 3 dernières frames | `CtaAct` |

**Couleurs sémantiques :**
- `direction === 'long'` → vert `#10b981`
- `direction === 'short'` → rouge `#ef4444`
- `type === 'exit'` avec `pnl` commençant par `+` → vert `#10b981`
- `type === 'exit'` avec `pnl` commençant par `-` → rouge `#ef4444`
- Texte par défaut : blanc
- Auteur : violet `#D649CC` (cohérent avec le bot)
- Fond : gradient `linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)` (réutilise le pattern de `ValueBeat`)

**Audio :** slot `<Audio>` commenté dans `SignalAlert.tsx`, identique au pattern de `BrandPromo.tsx`. L'utilisateur active en déposant un MP3 dans `video/public/audio/signal-track.mp3`.

## Pipeline de rendu

### Nouveau script npm

Dans `video/package.json` :

```json
{
  "scripts": {
    "render": "remotion render BrandPromo out/brand-promo.mp4",
    "render:signal": "remotion render SignalAlert out/signal-alert.mp4"
  }
}
```

(Le `render` existant reste inchangé — il continue à rendre Brand Promo avec ses defaults.)

### Usage avec données par défaut

```bash
cd video && npm run render:signal
```

→ produit `video/out/signal-alert.mp4` avec les defaultProps (`TSLA / Z / long / 150-155`).

### Usage avec données custom (CLI override)

```bash
cd video && npm run render:signal -- --props='{"ticker":"NVDA","author":"Bora","entry":"870","direction":"long","type":"entry"}'
```

→ produit `video/out/signal-alert.mp4` avec les props fournies. Les props non fournies tombent sur les defaultProps (sauf `ticker`, `type`, `author` qui doivent toujours être fournis).

### Output

Fichier unique `video/out/signal-alert.mp4` (écrase à chaque rendu). Pas de timestamping — l'utilisateur renomme manuellement s'il veut conserver des versions. Cohérent avec Phase 1.

## Tests

Trois tests dans `video/src/__tests__/composition.test.ts` (extension du fichier existant) :

1. **`SignalAlert` est registered avec dimensions/durée correctes**
   - `selectComposition({ id: 'SignalAlert' })` retourne `width: 1080, height: 1920, fps: 30, durationInFrames: 180`

2. **`SignalAlert` defaultProps a la forme attendue**
   - `selectComposition` retourne `defaultProps` avec les 7 champs hardcodés (ticker `'TSLA'`, type `'entry'`, direction `'long'`, entry `'150-155'`, target `'165'`, stop `'148'`, author `'Z'`)

3. **L'override `inputProps` ne provoque pas d'erreur**
   - `selectComposition({ id: 'SignalAlert', inputProps: { ticker: 'NVDA', author: 'Bora', type: 'entry' } })` résout sans throw. Le rendu visuel correct des props est validé manuellement via `npm run render:signal -- --props='...'` puis lecture du MP4.

Plus la non-régression du test `BrandPromo` existant (1/1 toujours pass).

Pas de test E2E sur le rendu visuel (manuel comme Phase 1).

## Hors scope (Phase 2)

- **Automatisation** : le bot ne déclenche PAS automatiquement le rendu en Phase 2. C'est Phase 3 (hook `discord/handler.js` qui appelle `renderMedia()` programmatiquement).
- **Image avatar de l'auteur** : Phase 2 utilise du texte uniquement. Faire passer les PNG de `avatar/` vers `video/public/avatars/` est reporté (potentiel Phase 4 si besoin).
- **Server-side rendering / endpoint HTTP / Remotion Lambda** : reportés.
- **Validation runtime des props** : Phase 2 fait confiance aux types TypeScript. Si l'utilisateur passe des props invalides au CLI (ex: `direction: 'sideways'`), Remotion ne validera pas — le composant rendra ce qu'il peut. Validation JSON-schema viendra avec Phase 3 si nécessaire.
- **Multiple ticker watermarks, animations complexes** : Phase 2 reste simple — les 3 actes sont l'animation. Pas d'effets de particules, pas de transitions custom.
- **Restructuration des `components/` en sous-dossiers par template** : reporté (les noms `RevealAct`/`DataAct`/`CtaAct` ne collisionnent pas avec `HookBeat`/`ValueBeat`/`CtaBeat`).

## Vérification

Au sortir de Phase 2 :

1. `cd video && npm run typecheck` — clean (composition + types des props OK).
2. `cd video && npm test` — 4/4 pass (1 BrandPromo + 3 SignalAlert).
3. `cd video && npm run studio` — l'éditeur affiche maintenant 2 compositions sélectionnables (`BrandPromo`, `SignalAlert`). `SignalAlert` est jouable avec les defaultProps.
4. `cd video && npm run render:signal` — produit `video/out/signal-alert.mp4` (~1-3 MB, 6 s, 1080×1920) avec les defaults.
5. `cd video && npm run render:signal -- --props='{"ticker":"NVDA","author":"Bora","type":"entry","direction":"long","entry":"870"}'` — produit le même fichier mais avec NVDA/Bora.
6. Le bot principal (`npm test` à la racine) — non régressé (124+ tests passent toujours).
7. Phase 1 toujours fonctionnel : `cd video && npm run render` (= Brand Promo) — produit `video/out/brand-promo.mp4` inchangé.
