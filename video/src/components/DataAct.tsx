import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

type Props = {
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
};

const COLOR_GREEN = '#10b981';
const COLOR_RED = '#ef4444';

function pickColor(type: 'entry' | 'exit', direction: 'long' | 'short' | undefined, pnl: string | undefined): string {
  if (type === 'entry') {
    return direction === 'short' ? COLOR_RED : COLOR_GREEN;
  }
  // exit
  if (pnl && pnl.startsWith('-')) return COLOR_RED;
  return COLOR_GREEN;
}

export const DataAct = ({ type, direction, entry, target, stop, pnl, author }: Props) => {
  const frame = useCurrentFrame();

  // Cascade : direction puis prices puis auteur, chaque élément fade in sur 15 frames.
  const directionOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });
  const pricesOpacity = interpolate(frame, [15, 30], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });
  const authorOpacity = interpolate(frame, [30, 45], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  const color = pickColor(type, direction, pnl);
  const directionLabel = type === 'entry' ? (direction || 'long').toUpperCase() : 'OUT';

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        fontFamily: 'sans-serif',
        padding: '180px 60px 100px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          color,
          fontSize: 110,
          fontWeight: 900,
          textAlign: 'center',
          letterSpacing: 4,
          opacity: directionOpacity,
        }}
      >
        {directionLabel}
      </div>

      <div
        style={{
          opacity: pricesOpacity,
          color: 'white',
          fontSize: 56,
          fontWeight: 700,
          textAlign: 'center',
          marginTop: 40,
        }}
      >
        {type === 'entry' && entry ? (
          <div>
            Entry <span style={{ color }}>{entry}</span>
          </div>
        ) : null}
        {type === 'entry' && target ? (
          <div style={{ marginTop: 12, fontSize: 44, color: '#dcddde' }}>Target {target}</div>
        ) : null}
        {type === 'entry' && stop ? (
          <div style={{ marginTop: 4, fontSize: 44, color: '#dcddde' }}>Stop {stop}</div>
        ) : null}
        {type === 'exit' && pnl ? (
          <div style={{ fontSize: 110, color, fontWeight: 900 }}>{pnl}</div>
        ) : null}
      </div>

      <div
        style={{
          opacity: authorOpacity,
          color: '#D649CC',
          fontSize: 48,
          fontWeight: 700,
          textAlign: 'center',
          marginTop: 'auto',
        }}
      >
        — {author}
      </div>
    </AbsoluteFill>
  );
};
