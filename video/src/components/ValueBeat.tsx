import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

// Cards pré-générées via canvas/proof.js generateImage() — vraies images
// Discord avec avatars custom, BOOM tags, role pills (cohérent avec ce que
// le bot poste). Régénérer via : node scripts/generate-brand-promo-cards.js
// (TODO: scriptifier). Pour l'instant, regen manuelle :
//   const { generateImage } = require('./canvas/proof');
//   await generateImage('Z', '$TSLA 150 entry long', '2026-04-25T09:32:00-04:00')
const CARDS = [
  { src: staticFile('brand-promo/card-0.png') },  // Z $TSLA 150 entry long
  { src: staticFile('brand-promo/card-1.png') },  // Bora $NVDA 870 scalp
  { src: staticFile('brand-promo/card-2.png') },  // Viking $AMD out +8%
];

type CardProps = {
  index: number;
  src: string;
};

const SignalCard = ({ index, src }: CardProps) => {
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

  // Width 100% du parent (qui a un padding réduit pour donner ~1020px de
  // place horizontale aux cards). Source rendue scale=2 native → sharp
  // même à display 100% width (downscale léger).
  return (
    <Img
      src={src}
      style={{
        width: '100%',
        height: 'auto',
        marginBottom: 30,
        borderRadius: 12,
        opacity,
        transform: `translateY(${y}px)`,
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      }}
    />
  );
};

export const ValueBeat = () => {
  const frame = useCurrentFrame();
  const headerOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        padding: '120px 30px 60px',
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
        <SignalCard key={i} index={i} src={c.src} />
      ))}
    </AbsoluteFill>
  );
};
