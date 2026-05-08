import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

type Props = {
  accentColor: string;
};

export const RecapOutro: React.FC<Props> = ({ accentColor }) => {
  const frame = useCurrentFrame();

  // Slow zoom-in continu sur le logo
  const scale = 1 + 0.1 * (frame / 90);

  // Fade-in puis hold
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      backgroundColor: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        transform: `scale(${scale})`,
        opacity,
        textAlign: 'center',
      }}>
        <div style={{
          color: accentColor,
          fontSize: 160,
          fontWeight: 900,
          letterSpacing: -8,
          textShadow: `0 0 100px ${accentColor}aa`,
          lineHeight: 1,
        }}>
          BOOM
        </div>
        <div style={{
          color: '#666',
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: 8,
          marginTop: 20,
        }}>
          DAILY RECAP
        </div>
      </div>
    </AbsoluteFill>
  );
};
