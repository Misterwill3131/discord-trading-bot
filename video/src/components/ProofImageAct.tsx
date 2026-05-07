import { AbsoluteFill, Img, useCurrentFrame, interpolate, Easing } from 'remotion';

type Props = {
  // Data URL ou URL absolue de l'image PNG canvas-rendered (entry+exit
  // Discord conversation). Si null/undefined, le composant render un
  // background noir avec un message d'erreur (cas dégradé).
  src?: string | null;
  // Optionnel : caption en bas (ex: "$TSLA · ZZ → ZZ · +34%")
  caption?: string;
};

// Phase ProofImage : affiche l'image proof canvas (entry+exit Discord
// conversation) en fullscreen avec :
//  - fade-in 8 frames + Ken Burns subtil (zoom 1.0 → 1.05)
//  - vignette pour focus
//  - caption optionnelle en bas (overlay glow)
//  - fond gradient sombre derrière (l'image canvas est ~740px wide,
//    on la centre + cover en gardant aspect ratio)
export const ProofImageAct = ({ src, caption }: Props) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [0, 8],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }
  );

  // Ken Burns : zoom de 1.0 → 1.05 sur la durée totale (assumant ~150-200 frames).
  const scale = interpolate(
    frame,
    [0, 200],
    [1.0, 1.05],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Caption fade-in après l'image
  const captionOpacity = interpolate(
    frame,
    [16, 28],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 40%, #1a1a2e 0%, #0a0a0a 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 80,
      }}
    >
      {/* Image proof — 1080×1920 viewport, image is ~740px wide native.
          object-fit: contain garde le ratio + s'adapte. Cover-tinted dim
          background derrière déjà via le gradient parent. */}
      {src ? (
        <Img
          src={src}
          style={{
            maxWidth: '100%',
            maxHeight: '85%',
            objectFit: 'contain',
            opacity,
            transform: `scale(${scale})`,
            borderRadius: 24,
            boxShadow: '0 16px 80px rgba(0,0,0,0.7)',
          }}
        />
      ) : (
        // Fallback : pas d'image dispo (génération a échoué côté bot).
        <div
          style={{
            color: '#80848e',
            fontSize: 36,
            fontFamily: 'sans-serif',
            opacity,
          }}
        >
          (proof image unavailable)
        </div>
      )}

      {/* Vignette */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Caption en bas */}
      {caption && (
        <div
          style={{
            position: 'absolute',
            bottom: 80,
            left: 0,
            right: 0,
            textAlign: 'center',
            color: '#fff',
            fontSize: 42,
            fontWeight: 800,
            fontFamily: 'sans-serif',
            letterSpacing: -1,
            textShadow: '0 0 30px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.7)',
            opacity: captionOpacity,
            padding: '0 40px',
          }}
        >
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
