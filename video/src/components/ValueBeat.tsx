import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';

const CARDS = [
  { author: 'Z', time: '9:32am', message: '$TSLA 150 entry long', color: '#dcddde' },
  { author: 'Bora', time: '10:15am', message: '$NVDA 870 scalp', color: '#dcddde' },
  { author: 'Viking', time: '11:02am', message: '$AMD out +8%', color: '#10b981' },
];

type CardProps = {
  index: number;
  author: string;
  time: string;
  message: string;
  color: string;
};

const SignalCard = ({ index, author, time, message, color }: CardProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ValueBeat dure 240 frames (8 s). Les cartes apparaissent à
  // 30, 90, 150 frames (1 s, 3 s, 5 s après le début du beat).
  const startFrame = 30 + index * 60;
  const localFrame = frame - startFrame;

  const opacity = interpolate(localFrame, [0, 15], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });
  const translateY = spring({
    frame: localFrame,
    fps,
    config: { damping: 14 },
    durationInFrames: 30,
  });
  const y = interpolate(translateY, [0, 1], [60, 0]);

  return (
    <div
      style={{
        background: '#1e1f22',
        padding: '24px 28px',
        borderRadius: 12,
        marginBottom: 18,
        opacity,
        transform: `translateY(${y}px)`,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <span style={{ color: '#D649CC', fontWeight: 700, fontSize: 32 }}>{author}</span>
        <span style={{ color: '#80848e', fontSize: 22 }}>{time}</span>
      </div>
      <div style={{ color, fontSize: 32, fontWeight: 600 }}>{message}</div>
    </div>
  );
};

export const ValueBeat = () => {
  const frame = useCurrentFrame();
  const headerOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        padding: '120px 60px 60px',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          color: 'white',
          fontSize: 56,
          fontWeight: 700,
          textAlign: 'center',
          marginBottom: 60,
          opacity: headerOpacity,
          lineHeight: 1.2,
        }}
      >
        Real-time signals<br />from top traders
      </div>
      {CARDS.map((c, i) => (
        <SignalCard key={c.author} index={i} {...c} />
      ))}
    </AbsoluteFill>
  );
};
