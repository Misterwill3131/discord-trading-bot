import { useCurrentFrame, AbsoluteFill, interpolate } from 'remotion';
import { ChartExplosion } from './ChartExplosion';

type Props = {
  entryTimestamp: string;     // ISO 8601
  exitTimestamp: string;      // ISO 8601
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

// Phase 4 du BoomProof : 90 frames (3s).
// Background gradient + texte "X hours later" + ChartExplosion centré.
//
// Note layout : ChartExplosion retourne un AbsoluteFill (position: absolute)
// donc il ne participe pas au flex du parent. On le wrappe dans un container
// `position: relative` avec dimensions fixes (600×300) pour qu'il s'affiche
// au centre sans recouvrir le label "X hours later" au-dessus.
export const TimePassAct = ({ entryTimestamp, exitTimestamp }: Props) => {
  const frame = useCurrentFrame();
  const label = timeDiffLabel(entryTimestamp, exitTimestamp);

  // Texte fade-in sur 0-20 frames
  const labelOpacity = interpolate(
    frame,
    [0, 20],
    [0, 1],
    { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }
  );

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
      <div style={{ position: 'relative', width: 600, height: 300 }}>
        <ChartExplosion />
      </div>
    </AbsoluteFill>
  );
};
