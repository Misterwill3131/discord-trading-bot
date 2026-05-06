import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

export const CtaAct = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // CtaAct dure 30 frames (1 s).
  // URL : slide-up + fade in sur les 15 premières frames.
  const urlEntry = spring({
    frame,
    fps,
    config: { damping: 12 },
    durationInFrames: 15,
  });
  const urlY = interpolate(urlEntry, [0, 1], [80, 0]);

  // Flash blanc final sur les 3 dernières frames (27-29).
  const flashOpacity = interpolate(frame, [27, 29], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        fontFamily: 'sans-serif',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          color: 'white',
          fontSize: 64,
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
