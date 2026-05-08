import { AbsoluteFill, Audio, staticFile } from 'remotion';
import { RecapTickerCard } from './RecapTickerCard';

type TickerData = {
  ticker: string;
  gainPct: number;
  swing: boolean;
  isHero: boolean;
};

type Props = {
  tickers: TickerData[];
  accentColor: string;
  successColor: string;
  sfxEnabled: boolean;
};

const CARD_HEIGHT_HERO = 140;
const CARD_HEIGHT_NORMAL = 100;
const CARD_GAP = 16;
const TOP_OFFSET = 100;
const HERO_DURATION = 24;
const NORMAL_DURATION = 12;

export const RecapTickerWaterfall: React.FC<Props> = ({
  tickers, accentColor, successColor, sfxEnabled,
}) => {
  // Calcule offset cumulés (frame de début + position Y)
  let frameCursor = 0;
  let yCursor = TOP_OFFSET;
  const positioned = tickers.map(t => {
    const startFrame = frameCursor;
    const durationFrames = t.isHero ? HERO_DURATION : NORMAL_DURATION;
    const yPosition = yCursor;
    const cardHeight = t.isHero ? CARD_HEIGHT_HERO : CARD_HEIGHT_NORMAL;

    frameCursor += durationFrames;
    yCursor += cardHeight + CARD_GAP;

    return { ...t, startFrame, durationFrames, yPosition };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: '#0a0a0f' }}>
      {positioned.map((t, i) => (
        <RecapTickerCard
          key={`${t.ticker}-${t.gainPct}-${i}`}
          ticker={t.ticker}
          gainPct={t.gainPct}
          swing={t.swing}
          isHero={t.isHero}
          startFrame={t.startFrame}
          durationFrames={t.durationFrames}
          accentColor={accentColor}
          successColor={successColor}
          yPosition={t.yPosition}
        />
      ))}

      {/* SFX whoosh sur chaque ticker drop */}
      {sfxEnabled && positioned.map((t, i) => (
        <Audio
          key={`sfx-${i}`}
          src={staticFile(t.isHero ? 'audio/chaching.mp3' : 'audio/whoosh-2.mp3')}
          volume={t.isHero ? 0.8 : 0.5}
          startFrom={t.startFrame}
        />
      ))}
    </AbsoluteFill>
  );
};
