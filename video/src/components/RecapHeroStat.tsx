import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame } from 'remotion';

type Props = {
  totalGainPct: number;
  accentColor: string;
  sfxEnabled: boolean;
};

export const RecapHeroStat: React.FC<Props> = ({ totalGainPct, accentColor, sfxEnabled }) => {
  const frame = useCurrentFrame();

  // Counter qui monte de 0 à totalGainPct sur 60 frames (2s)
  // ease-out cubic pour ralentir vers la fin
  const t = Math.min(1, frame / 60);
  const easeOut = 1 - Math.pow(1 - t, 3);
  const displayedValue = Math.round(totalGainPct * easeOut);

  // Subtitle slide-in après le counter
  const subtitleOpacity = interpolate(frame, [55, 75], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Subtle pulse sur le number final
  const pulseScale = frame > 60
    ? 1 + 0.04 * Math.sin((frame - 60) / 6)
    : 1;

  return (
    <AbsoluteFill style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      backgroundColor: '#0a0a0f',
    }}>
      <div style={{
        color: accentColor,
        fontSize: 220,
        fontWeight: 900,
        letterSpacing: -8,
        lineHeight: 1,
        textShadow: `0 0 60px ${accentColor}66`,
        transform: `scale(${pulseScale})`,
      }}>
        +{displayedValue}%
      </div>
      <div style={{
        color: '#aaa',
        fontSize: 36,
        fontWeight: 700,
        letterSpacing: 4,
        marginTop: 24,
        opacity: subtitleOpacity,
      }}>
        TOTAL GAINS TODAY
      </div>

      {sfxEnabled && (
        <Audio
          src={staticFile('audio/whoosh-1.mp3')}
          volume={0.7}
          startFrom={0}
        />
      )}
    </AbsoluteFill>
  );
};
