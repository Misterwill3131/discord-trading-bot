import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion';

export const HookBeat = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Le composant tourne dans une Sequence de 90 frames (3 s).
  // frame 0..90 ; spring d'entrée : 0..30 (1 s).
  const scale = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 100, mass: 0.8 },
  });

  // Légère vibration sur "STOP" pendant la première seconde (2 px d'amplitude).
  const shakeX = frame < 30 ? Math.sin(frame * 1.6) * 2 : 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: 'black',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 60,
      }}
    >
      <div
        style={{
          transform: `scale(${scale}) translateX(${shakeX}px)`,
          color: 'white',
          fontSize: 130,
          fontWeight: 900,
          fontFamily: 'sans-serif',
          letterSpacing: -2,
          lineHeight: 1.05,
          textAlign: 'center',
        }}
      >
        STOP GUESSING<br />TRADES
      </div>
    </AbsoluteFill>
  );
};
