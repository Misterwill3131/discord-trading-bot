import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from 'remotion';

type Props = {
  pnl: string;
};

// Stinger 0.3s (9 frames @ 30fps) : flash du PnL en gros sur fond noir
// avant le lifestyle hook. Capture le viewer en 0.1s ("scroll-stopping").
//
// Animation :
//   frames 0-3 : scale 1.5 → 1.0, opacity 0 → 1, fond noir
//   frames 3-6 : hold à scale 1.0
//   frames 6-9 : scale 1.0 → 1.4, opacity 1 → 0 (zoom-out vers la phase suivante)
export const Stinger = ({ pnl }: Props) => {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [0, 2, 6, 9],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }
  );
  const scale = interpolate(
    frame,
    [0, 3, 6, 9],
    [1.6, 1.0, 1.0, 1.4],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }
  );

  // Flash blanc bref au tout début (0-2 frames) pour effet "pop"
  const flashOpacity = interpolate(
    frame,
    [0, 1, 3],
    [0.7, 0.3, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Couleur du PnL : vert si +, rouge si -
  const isPositive = pnl.startsWith('+') || (!pnl.startsWith('-') && pnl !== '0%');
  const pnlColor = isPositive ? '#10b981' : '#ef4444';

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          fontSize: 280,
          fontWeight: 900,
          fontFamily: 'sans-serif',
          letterSpacing: -8,
          color: pnlColor,
          textShadow: `0 0 40px ${pnlColor}aa, 0 0 80px ${pnlColor}66`,
          opacity,
          transform: `scale(${scale})`,
        }}
      >
        {pnl}
      </div>

      {/* Flash blanc d'ouverture */}
      <AbsoluteFill
        style={{
          background: '#fff',
          opacity: flashOpacity,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
