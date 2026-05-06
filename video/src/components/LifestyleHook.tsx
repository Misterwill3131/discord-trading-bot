import { AbsoluteFill, Img, useCurrentFrame, interpolate } from 'remotion';
import { LIFESTYLE_IMAGES } from '../lifestyle';

type Props = {
  overlayText?: string;
};

// Phase de hook lifestyle : 3s = 90 frames @ 30fps.
// 4 images de LIFESTYLE_IMAGES s'enchaînent en slots de 22 frames (~0.73s),
// avec un flash blanc bref entre chaque cut (3 frames).
// Le texte overlay (si fourni) fade-in à la fin du slot 2 (frames 60-75)
// et reste visible sur le slot 3 (frames 66-89).
export const LifestyleHook = ({ overlayText }: Props) => {
  const frame = useCurrentFrame();

  // Index de l'image courante (0..3) basé sur le frame.
  const slotDuration = 22; // frames par image (légèrement < 24 = 0.8s pour avoir un peu d'overlap)
  // 22*4 = 88 frames ; le clamp à 3 garantit que la dernière image
  // (slot 3) couvre les 2 frames restantes (88-89), donc 24 frames au total.
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
