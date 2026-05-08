import { AbsoluteFill, Audio, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { pickImages } from '../lifestyle';

type TickerData = {
  ticker: string;
  gainPct: number;
  swing: boolean;
  isHero: boolean;
};

type Props = {
  tickers: TickerData[];   // top 3 sortés desc déjà
  accentColor: string;
  lifestyleSeed: number;
  sfxEnabled: boolean;
};

const PHASE_DURATION = 180;  // 6s
const CARD_DURATION = 60;    // 2s par carte

export const RecapTop3Highlight: React.FC<Props> = ({
  tickers, accentColor, lifestyleSeed, sfxEnabled,
}) => {
  const frame = useCurrentFrame();
  const top3 = tickers.slice(0, 3);

  // Pick 3 lifestyle images via seedable picker (déterministe).
  // pickImages prend un seed string, donc on convertit le number en string.
  const lifestyleImgs = pickImages(`recap-${lifestyleSeed}`, 3);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {top3.map((t, i) => {
        const cardStart = i * CARD_DURATION;
        const localFrame = frame - cardStart;
        if (localFrame < 0 || localFrame >= CARD_DURATION) return null;

        const opacity = interpolate(localFrame, [0, 6, CARD_DURATION - 8, CARD_DURATION], [0, 1, 1, 0]);
        const dollyZoom = 1 + 0.15 * (localFrame / CARD_DURATION);  // slow zoom-in

        return (
          <AbsoluteFill key={i} style={{ opacity }}>
            {/* Background lifestyle photo */}
            <Img
              src={lifestyleImgs[i] || lifestyleImgs[0]}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: `scale(${dollyZoom})`,
                filter: 'brightness(0.4) saturate(1.2)',
              }}
            />

            {/* Centered text overlay */}
            <AbsoluteFill style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              padding: 60,
            }}>
              <div style={{
                color: '#fff',
                fontSize: 42,
                fontWeight: 700,
                letterSpacing: 6,
                marginBottom: 20,
                opacity: 0.7,
              }}>
                #{i + 1} TODAY
              </div>
              <div style={{
                color: '#fff',
                fontSize: 200,
                fontWeight: 900,
                letterSpacing: -6,
                lineHeight: 1,
              }}>
                ${t.ticker}
              </div>
              <div style={{
                color: accentColor,
                fontSize: 160,
                fontWeight: 900,
                letterSpacing: -4,
                marginTop: 20,
                textShadow: `0 0 80px ${accentColor}aa`,
              }}>
                +{t.gainPct}%
              </div>
              {t.swing && (
                <div style={{
                  color: '#fff',
                  fontSize: 28,
                  fontWeight: 700,
                  letterSpacing: 4,
                  marginTop: 16,
                  padding: '8px 24px',
                  background: `${accentColor}33`,
                  borderRadius: 8,
                }}>
                  SWING
                </div>
              )}
            </AbsoluteFill>
          </AbsoluteFill>
        );
      })}

      {sfxEnabled && top3.map((_, i) => (
        <Audio
          key={`sfx-${i}`}
          src={staticFile('audio/whoosh-1.mp3')}
          volume={0.6}
          startFrom={i * CARD_DURATION}
        />
      ))}
    </AbsoluteFill>
  );
};
