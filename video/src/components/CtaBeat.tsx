import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

export const CtaBeat = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // CtaBeat dure 120 frames (4 s).
  // Logo : pulse continu (sin) + entrée en spring sur les 20 premières frames.
  const entryScale = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 90 },
    durationInFrames: 20,
  });
  const pulse = 1 + Math.sin(frame * 0.15) * 0.04;
  const logoScale = entryScale * pulse;

  // Tagline + CTA : fade in à 25 frames.
  const taglineOpacity = interpolate(frame, [25, 45], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  // Flash blanc final sur les 3 dernières frames (117-119).
  const flashOpacity = interpolate(frame, [117, 119], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 50%, #5865f2 0%, #0a0a0a 75%)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 60,
        fontFamily: 'sans-serif',
      }}
    >
      <Img
        src={staticFile('logo_boom.png')}
        style={{ width: 320, height: 320, transform: `scale(${logoScale})` }}
      />
      <div
        style={{
          color: 'white',
          fontSize: 96,
          fontWeight: 900,
          letterSpacing: 8,
          marginTop: 32,
          transform: `scale(${entryScale})`,
        }}
      >
        BOOM
      </div>
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 38,
          textAlign: 'center',
          marginTop: 18,
          lineHeight: 1.3,
          opacity: taglineOpacity,
        }}
      >
        Trading signals.<br />Real results.
      </div>
      <div
        style={{
          marginTop: 48,
          padding: '20px 40px',
          background: 'white',
          color: 'black',
          fontSize: 38,
          fontWeight: 800,
          borderRadius: 12,
          opacity: taglineOpacity,
        }}
      >
        JOIN NOW →
      </div>
      <div
        style={{
          color: '#80848e',
          fontSize: 28,
          marginTop: 24,
          opacity: taglineOpacity,
        }}
      >
        discord.gg/boom
      </div>
      {/* Flash blanc final */}
      <AbsoluteFill style={{ background: 'white', opacity: flashOpacity }} />
    </AbsoluteFill>
  );
};
