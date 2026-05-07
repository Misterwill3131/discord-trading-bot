import { AbsoluteFill, Img, useCurrentFrame, interpolate, Easing } from 'remotion';
import { useMemo } from 'react';
import { pickImages } from '../lifestyle';

type Props = {
  overlayText?: string;
  // Seed déterministe pour piquer 4 images dans le pool de 30. Chaque seed
  // différent donne une combinaison différente, donc 2 vidéos avec des seeds
  // différents (ex: ticker+timestamp) ont des hooks lifestyle uniques.
  seed?: string;
};

// Phase de hook lifestyle : 3s = 90 frames @ 30fps.
// 5 images du pool LIFESTYLE_IMAGES avec :
//  - crossfade 4 frames entre chaque cut (vs flash blanc dur précédent)
//  - Ken Burns : zoom-in subtil 1.05 → 1.15 sur la durée totale de chaque image
//  - pan directionnel par image pour un mouvement organique
//  - vignette radiale pour focus cinématique
//  - cuts plus rapides (18 frames vs 22 précédent) : speed ramp TikTok-style
const TOTAL_FRAMES = 90;
const SLOT = 18; // 5 cuts × 18 = 90 frames pile
const FADE = 4; // crossfade duration en frames
const NUM_IMAGES = 5;

type SlotProps = {
  src: string;
  slotIndex: number;
  pan: 'left' | 'right' | 'up' | 'down';
};

// Une image avec son propre cycle de vie (fade in/out + Ken Burns).
const ImageSlot = ({ src, slotIndex, pan }: SlotProps) => {
  const frame = useCurrentFrame();
  const slotStart = slotIndex * SLOT;
  const slotEnd = slotStart + SLOT;

  // Fade in : (slotStart - FADE) → slotStart. Première image skip fade-in.
  // Fade out : slotEnd → (slotEnd + FADE). Dernière image skip fade-out.
  // Note : interpolate exige des valeurs strictement croissantes.
  // Pour la première image, on commence à -1 (pas de fade-in visible).
  // Pour la dernière image, on termine à TOTAL_FRAMES+1 (pas de fade-out visible).
  const isLast = slotIndex === NUM_IMAGES - 1;
  const fadeInStart = slotIndex === 0 ? -1 : slotStart - FADE;
  const fadeInEnd = slotIndex === 0 ? 0 : slotStart;
  const fadeOutStart = isLast ? TOTAL_FRAMES : slotEnd;
  const fadeOutEnd = isLast ? TOTAL_FRAMES + 1 : slotEnd + FADE;

  const opacity = interpolate(
    frame,
    [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Ken Burns zoom : 1.05 → 1.15 sur toute la durée de vie de l'image
  // (du début du fade-in à la fin du fade-out).
  const lifetimeStart = fadeInStart;
  const lifetimeEnd = fadeOutEnd;
  const scale = interpolate(
    frame,
    [lifetimeStart, lifetimeEnd],
    [1.05, 1.15],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.linear }
  );

  // Pan : translation lente dans une direction au cours de la vie de l'image.
  // 40px de range, ce qui est subtil mais perceptible.
  const panProgress = interpolate(
    frame,
    [lifetimeStart, lifetimeEnd],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const panRange = 40;
  let translateX = 0;
  let translateY = 0;
  if (pan === 'left') translateX = -panProgress * panRange;
  else if (pan === 'right') translateX = panProgress * panRange;
  else if (pan === 'up') translateY = -panProgress * panRange;
  else translateY = panProgress * panRange;

  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const LifestyleHook = ({ overlayText, seed = 'default' }: Props) => {
  const frame = useCurrentFrame();
  const images = useMemo(() => pickImages(seed, NUM_IMAGES), [seed]);

  // Pans variés par image pour éviter la monotonie (5 valeurs pour 5 cuts).
  const pans: Array<'left' | 'right' | 'up' | 'down'> = ['right', 'left', 'up', 'right', 'down'];

  // Overlay text : fade-in + scale punch (spring-like) sur la dernière image.
  // Avec NUM_IMAGES=5 et SLOT=18, la dernière image apparaît au frame 72.
  const overlayOpacity = interpolate(
    frame,
    [72, 84],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }
  );
  const overlayScale = interpolate(
    frame,
    [72, 82, 86],
    [0.4, 1.15, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* 4 images empilées avec crossfades + Ken Burns */}
      {images.map((src, i) => (
        <ImageSlot key={i} src={src} slotIndex={i} pan={pans[i]} />
      ))}

      {/* Vignette cinématique (assombrit les bords pour focus centre) */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.55) 100%)',
          pointerEvents: 'none',
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
              textShadow:
                '0 0 60px rgba(0,0,0,0.95), 0 0 30px rgba(0,0,0,0.8), 0 4px 12px rgba(0,0,0,0.7)',
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
