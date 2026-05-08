import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  runnersHit: number | null;
  runnersTotal: number | null;
  tagline: string;
  ctaText: string;
  ctaUrl: string;
  accentColor: string;
  sfxEnabled: boolean;
};

export const RecapClosingStat: React.FC<Props> = ({
  runnersHit, runnersTotal, tagline, ctaText, ctaUrl,
  accentColor, sfxEnabled,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Spring big reveal pour le runners ratio
  const ratioSpring = spring({
    frame: frame - 6,
    fps,
    config: { damping: 8, stiffness: 80 },
  });
  const ratioScale = interpolate(ratioSpring, [0, 1], [0.4, 1]);
  const ratioOpacity = interpolate(frame, [4, 16], [0, 1], { extrapolateRight: 'clamp' });

  // Tagline arrive plus tard
  const taglineOpacity = interpolate(frame, [60, 80], [0, 1], { extrapolateRight: 'clamp' });

  // CTA en dernier
  const ctaOpacity = interpolate(frame, [120, 140], [0, 1], { extrapolateRight: 'clamp' });

  const hasRunners = runnersHit !== null && runnersTotal !== null;

  return (
    <AbsoluteFill style={{
      backgroundColor: '#0a0a0f',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 60,
    }}>
      {hasRunners && (
        <div style={{
          textAlign: 'center',
          transform: `scale(${ratioScale})`,
          opacity: ratioOpacity,
        }}>
          <div style={{
            color: '#fff',
            fontSize: 280,
            fontWeight: 900,
            letterSpacing: -10,
            lineHeight: 1,
          }}>
            <span style={{ color: accentColor }}>{runnersHit}</span>
            <span style={{ color: '#666', fontSize: 200 }}> / </span>
            <span style={{ color: '#fff' }}>{runnersTotal}</span>
          </div>
          <div style={{
            color: '#aaa',
            fontSize: 42,
            fontWeight: 700,
            letterSpacing: 6,
            marginTop: 20,
          }}>
            RUNNERS HIT
          </div>
        </div>
      )}

      <div style={{
        color: '#ddd',
        fontSize: 38,
        fontWeight: 600,
        textAlign: 'center',
        maxWidth: 900,
        marginTop: 60,
        opacity: taglineOpacity,
        lineHeight: 1.3,
      }}>
        {tagline}
      </div>

      {ctaUrl && (
        <div style={{
          marginTop: 80,
          opacity: ctaOpacity,
          textAlign: 'center',
        }}>
          <div style={{
            color: accentColor,
            fontSize: 56,
            fontWeight: 900,
            padding: '20px 48px',
            background: `${accentColor}22`,
            border: `3px solid ${accentColor}`,
            borderRadius: 16,
            display: 'inline-block',
            boxShadow: `0 0 60px ${accentColor}66`,
          }}>
            {ctaText}
          </div>
          <div style={{
            color: '#888',
            fontSize: 24,
            fontWeight: 600,
            marginTop: 16,
          }}>
            {ctaUrl}
          </div>
        </div>
      )}

      {sfxEnabled && (
        <Audio
          src={staticFile('audio/impact-bass.mp3')}
          volume={0.9}
          startFrom={6}
        />
      )}
    </AbsoluteFill>
  );
};
