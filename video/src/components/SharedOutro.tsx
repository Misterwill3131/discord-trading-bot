import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { pickOutroImage } from '../outro-pool';

// ─────────────────────────────────────────────────────────────────────
// SharedOutro — Outro brandé Temple of Boom partagé entre toutes les
// compositions (BoomProof, BoomEntry, BoomRecap, etc.).
// ─────────────────────────────────────────────────────────────────────
// Affiche une des 4 images PNG du pool (video/public/outro/) en fin de
// vidéo, avec un Ken Burns zoom (1.0 → 1.1) sur la durée de la séquence
// pour effet cinéma. Fade in et fade out aux extrémités.
//
// L'image affichée est sélectionnée par seed (déterministe). Si pas de
// seed fourni, retourne toujours la première image (default).
//
// L'image est carrée (1024×1024) → en 1080×1920 (9:16) :
//  - objectFit: 'cover' pour remplir tout le frame (crop top/bottom)
//  - Le contenu important (lion + texte + URL) est déjà centré dans
//    l'image source, donc le crop ne perd quasiment rien
//  - Backdrop noir au cas où (pour rare cas où l'image charge en delay)
//
// Durée nominale : 90 frames @ 30fps = 3s. Caller peut override via
// la durée de la `<Sequence>` parent.
// ─────────────────────────────────────────────────────────────────────

type Props = {
  seed?: string | null;
  imagePathOverride?: string | null;
};

export const SharedOutro: React.FC<Props> = ({ seed, imagePathOverride }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Ken Burns slow zoom : 1.0 → 1.1 sur toute la durée de la séquence.
  // Effet cinéma sans être agressif. Si on était en `frame / 90` hardcodé
  // et que la durée parent change, le zoom serait déséquilibré.
  const scale = interpolate(frame, [0, durationInFrames], [1.0, 1.1], {
    extrapolateRight: 'clamp',
  });

  // Fade-in 0-12 frames, hold, fade-out 12 frames avant la fin.
  // Le clamp évite les valeurs hors [0, 1].
  const opacity = interpolate(
    frame,
    [0, 12, durationInFrames - 12, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const src = imagePathOverride || pickOutroImage(seed);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      <Img
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale})`,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};
