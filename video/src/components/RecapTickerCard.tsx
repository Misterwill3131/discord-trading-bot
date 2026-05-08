import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = {
  ticker: string;
  gainPct: number;
  swing: boolean;
  isHero: boolean;
  startFrame: number;       // frame absolu où la carte apparaît
  durationFrames: number;   // durée pendant laquelle elle anime (12 ou 24)
  accentColor: string;      // doré pour hero
  successColor: string;     // vert pour standard
  yPosition: number;        // px depuis le top
};

export const RecapTickerCard: React.FC<Props> = ({
  ticker, gainPct, swing, isHero,
  startFrame, durationFrames,
  accentColor, successColor, yPosition,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = frame - startFrame;
  if (localFrame < 0) return null;  // pas encore apparu

  // Spring slide-in depuis la droite
  const slideProgress = spring({
    frame: localFrame,
    fps,
    config: { damping: isHero ? 8 : 12, stiffness: isHero ? 120 : 200 },
  });
  const translateX = interpolate(slideProgress, [0, 1], [600, 0]);
  const opacity = interpolate(localFrame, [0, 4], [0, 1], {
    extrapolateRight: 'clamp',
  });

  // Hero pulse glow continu
  const glowIntensity = isHero
    ? 0.5 + 0.3 * Math.sin(localFrame / 4)
    : 0;

  const bgColor = isHero ? `${accentColor}22` : `${successColor}18`;
  const borderColor = isHero ? accentColor : successColor;
  const textColor = isHero ? accentColor : successColor;
  const cardHeight = isHero ? 140 : 100;

  return (
    <div style={{
      position: 'absolute',
      top: yPosition,
      left: 60,
      right: 60,
      height: cardHeight,
      transform: `translateX(${translateX}px)`,
      opacity,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 40px',
      backgroundColor: bgColor,
      border: `2px solid ${borderColor}`,
      borderRadius: 16,
      boxShadow: isHero ? `0 0 ${40 + glowIntensity * 40}px ${accentColor}88` : 'none',
    }}>
      <div style={{
        color: '#fff',
        fontSize: isHero ? 64 : 48,
        fontWeight: 900,
        letterSpacing: -1,
      }}>
        ${ticker}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div style={{
          color: textColor,
          fontSize: isHero ? 64 : 48,
          fontWeight: 900,
        }}>
          +{gainPct}%
        </div>
        {swing && (
          <div style={{
            color: '#888',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 2,
          }}>
            SWING
          </div>
        )}
      </div>
    </div>
  );
};
