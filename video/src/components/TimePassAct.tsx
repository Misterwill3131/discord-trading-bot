import { useCurrentFrame, AbsoluteFill, Img, interpolate } from 'remotion';

type Props = {
  entryTimestamp: string;             // ISO 8601
  exitTimestamp: string;              // ISO 8601
  chartImageDataUrl?: string | null;  // data:image/png;base64,... du chart TradingView
};

// Calcule la diff en heures/minutes lisible.
function timeDiffLabel(entry: string, exit: string): string {
  const diffMs = new Date(exit).getTime() - new Date(entry).getTime();
  if (diffMs <= 0) return 'moments later';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} later`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} later`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} later`;
}

// Phase 3 du ChartTemplate : 98 frames (~3.3s).
// Background gradient + texte "X hours later" + CHART RÉEL (chart-img.com)
// avec Ken Burns subtle zoom-in.
//
// Si chartImageDataUrl est null (chart-img KO ou pas de clé), on skip
// la partie chart et on n'affiche que le label "X hours later" centré.
// La phase garde sa durée pour préserver le timing global de la composition.
export const TimePassAct = ({ entryTimestamp, exitTimestamp, chartImageDataUrl }: Props) => {
  const frame = useCurrentFrame();
  const label = timeDiffLabel(entryTimestamp, exitTimestamp);

  // Texte fade-in sur 0-20 frames
  const labelOpacity = interpolate(
    frame,
    [0, 20],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

  // Chart fade-in sur 20-40 frames (juste après le label) + Ken Burns
  // zoom 1.0 → 1.06 sur toute la durée pour effet cinéma léger.
  const chartOpacity = interpolate(
    frame,
    [20, 40],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );
  const chartScale = interpolate(frame, [20, 98], [1.0, 1.06], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: 2,
          marginBottom: 40,
          opacity: labelOpacity,
        }}
      >
        {label}
      </div>
      {chartImageDataUrl && (
        <div style={{
          width: '90%',
          maxWidth: 960,
          opacity: chartOpacity,
          transform: `scale(${chartScale})`,
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 12px 48px rgba(0,0,0,0.6), 0 0 24px rgba(16,185,129,0.15)',
        }}>
          <Img
            src={chartImageDataUrl}
            style={{ width: '100%', display: 'block' }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};
