import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { MoneyRain } from './MoneyRain';

type Props = {
  pnl: string;
};

// Phase 6 du BoomProof : 90 frames (3s) — final.
// Gros pnl confirmé qui pulse + URL slide-up + flash blanc final.
export const ResultCta = ({ pnl }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // PNL pop entrance + pulse continu
  const pnlEntry = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 100 },
    durationInFrames: 20,
  });
  const pnlPulse = 1 + Math.sin(frame * 0.15) * 0.03;
  const pnlScale = pnlEntry * pnlPulse;

  // URL slide-up sur 25-50 frames
  const urlEntry = spring({
    frame: frame - 25,
    fps,
    config: { damping: 12 },
    durationInFrames: 20,
  });
  const urlY = interpolate(urlEntry, [0, 1], [80, 0]);

  // Flash blanc final sur les 3 dernières frames (87-89)
  const flashOpacity = interpolate(
    frame,
    [87, 89],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  const pnlColor = pnl.startsWith('-') ? '#ef4444' : '#10b981';

  // Money rain seulement si gain (pas pour les pertes).
  const showMoneyRain = !pnl.startsWith('-');

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 50%, #1a1a2e 0%, #0a0a0a 80%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 60,
        fontFamily: 'sans-serif',
      }}
    >
      {/* Money rain en arrière-plan (sous le texte mais au-dessus du fond) */}
      {showMoneyRain && <MoneyRain count={40} seed={`cta-${pnl}`} />}

      <div
        style={{
          color: pnlColor,
          fontSize: 280,
          fontWeight: 900,
          letterSpacing: -6,
          transform: `scale(${pnlScale})`,
          textShadow: `0 0 80px ${pnlColor}aa`,
          zIndex: 2,
        }}
      >
        {pnl}
      </div>
      <div
        style={{
          marginTop: 50,
          color: 'white',
          fontSize: 48,
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
