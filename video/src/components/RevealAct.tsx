import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, spring } from 'remotion';

type Props = { ticker: string };

export const RevealAct = ({ ticker }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Logo : entrée fade en 15 frames.
  const logoOpacity = spring({
    frame,
    fps,
    config: { damping: 14 },
    durationInFrames: 15,
  });

  // Ticker : spring scale-in plus tardif (frames 10-40).
  const tickerScale = spring({
    frame: frame - 10,
    fps,
    config: { damping: 12, stiffness: 100 },
    durationInFrames: 30,
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <Img
        src={staticFile('logo_boom.png')}
        style={{
          width: 200,
          height: 200,
          alignSelf: 'center',
          marginTop: 120,
          opacity: logoOpacity,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(-50%, -50%) scale(${tickerScale})`,
          color: 'white',
          fontSize: 220,
          fontWeight: 900,
          letterSpacing: -5,
        }}
      >
        ${ticker}
      </div>
    </AbsoluteFill>
  );
};
