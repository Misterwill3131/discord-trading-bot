import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  date: string;          // "2026-05-08"
  dateLabel: string;     // "RECAP"
  accentColor: string;
  sfxEnabled: boolean;
};

// Format "MAY 8" depuis "2026-05-08"
function formatHumanDate(iso: string): string {
  const [, mm, dd] = iso.split('-');
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monthIdx = parseInt(mm, 10) - 1;
  const dayNum = parseInt(dd, 10);
  return `${monthNames[monthIdx]} ${dayNum}`;
}

export const RecapDateStinger: React.FC<Props> = ({ date, dateLabel, accentColor, sfxEnabled }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Flash blanc 0-6 frames
  const flashOpacity = interpolate(frame, [0, 3, 8], [1, 1, 0], {
    extrapolateRight: 'clamp',
  });

  // Texte arrive en spring après le flash
  const textProgress = spring({
    frame: frame - 6,
    fps,
    config: { damping: 12, stiffness: 100 },
  });
  const textScale = interpolate(textProgress, [0, 1], [0.5, 1]);
  const textOpacity = interpolate(frame, [4, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#000',
    }}>
      {/* Flash blanc d'ouverture */}
      <AbsoluteFill style={{
        backgroundColor: '#fff',
        opacity: flashOpacity,
      }} />

      {/* Date + label centré */}
      <div style={{
        transform: `scale(${textScale})`,
        opacity: textOpacity,
        textAlign: 'center',
        zIndex: 2,
      }}>
        <div style={{
          color: '#fff',
          fontSize: 96,
          fontWeight: 900,
          letterSpacing: -2,
          lineHeight: 1,
        }}>
          {formatHumanDate(date)}
        </div>
        <div style={{
          color: accentColor,
          fontSize: 64,
          fontWeight: 700,
          letterSpacing: 4,
          marginTop: 16,
        }}>
          {dateLabel}
        </div>
      </div>

      {/* SFX impact bass au frame 0 */}
      {sfxEnabled && (
        <Audio
          src={staticFile('audio/impact-bass.mp3')}
          volume={1.0}
          startFrom={0}
        />
      )}
    </AbsoluteFill>
  );
};
