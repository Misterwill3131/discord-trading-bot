import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

type Props = {
  ticker: string;
  pnl: string;     // ex: "+20%"
  author: string;
};

// Phase 2 du BoomProof : 60 frames (2s).
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
