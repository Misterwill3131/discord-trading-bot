import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';
import { SignalAlert, SignalAlertProps } from './compositions/SignalAlert';
import { BoomProof, boomProofSchema } from './compositions/BoomProof';
import { BoomEntry, boomEntrySchema } from './compositions/BoomEntry';
import { BoomRecap, boomRecapSchema, computeTotalFrames } from './compositions/BoomRecap';

const signalAlertDefaults: SignalAlertProps = {
  ticker: 'TSLA',
  type: 'entry',
  direction: 'long',
  entry: '150-155',
  target: '165',
  stop: '148',
  author: 'Z',
  message: '$TSLA 150-155 entry long',
  timestamp: '2026-04-25T13:32:00-04:00',
};

const boomProofDefaults = {
  ticker: 'TSLA',
  entryAuthor: 'Z',
  entryMessage: '$TSLA 150 entry long',
  entryTimestamp: '2026-04-25T13:32:00-04:00',
  exitAuthor: 'Z',
  exitMessage: '$TSLA out +20%',
  exitTimestamp: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
  proofImageDataUrl: null,
  teaseSubtext: undefined,
  ctaUrl: 'discord.gg/boom',
  accentColor: '#10b981',
  musicVolume: 0.55,
  sfxEnabled: true,
  lifestyleSeedOverride: undefined,
};

const boomRecapDefaults = {
  date: '2026-05-08',
  dateLabel: 'RECAP',
  tickers: [
    { ticker: 'RXT',  gainPct: 380, swing: true,  isHero: true  },
    { ticker: 'REPL', gainPct: 133, swing: true,  isHero: true  },
    { ticker: 'AIIO', gainPct: 71,  swing: false, isHero: false },
    { ticker: 'TDIC', gainPct: 63,  swing: true,  isHero: false },
    { ticker: 'INOD', gainPct: 53,  swing: false, isHero: false },
  ],
  runnersHit:    5,
  runnersTotal:  6,
  totalGainPct:  700,
  tagline:       "Plenty of chances to bank today.",
  ctaText:       "Join the channel",
  ctaUrl:        "https://templeofboom.com/join",
  accentColor:   "#fbbf24",
  successColor:  "#10b981",
  bgColor:       "#0a0a0f",
  musicVolume:   0.6,
  sfxEnabled:    true,
  showTop3Phase: true,
  lifestyleSeed: 0,
};

export const Root = () => {
  return (
    <>
      <Composition
        id="BrandPromo"
        component={BrandPromo}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="SignalAlert"
        component={SignalAlert}
        durationInFrames={270}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={signalAlertDefaults}
      />
      <Composition
        id="BoomProof"
        component={BoomProof}
        durationInFrames={608}
        fps={30}
        width={1080}
        height={1920}
        schema={boomProofSchema}
        defaultProps={boomProofDefaults}
      />
      <Composition
        id="BoomEntry"
        component={BoomEntry}
        durationInFrames={466}
        fps={30}
        width={1080}
        height={1920}
        schema={boomEntrySchema}
        defaultProps={{
          ticker: 'TSLA',
          author: 'Z',
          message: '$TSLA 150-155 entry long',
          timestamp: '2026-04-25T13:32:00-04:00',
          entryImageDataUrl: null,
          stingerText: '🚨 LIVE',
          teaseAction: 'just called this.',
          teaseSubtext: 'Watch live →',
          cardLabel: '🚨 LIVE SIGNAL',
          ctaTitle: 'JOIN',
          ctaUrl: 'discord.gg/boom',
          ctaSubtitle: 'Get every signal live',
          accentColor: '#ef4444',
          musicVolume: 0.55,
          sfxEnabled: true,
          lifestyleSeedOverride: undefined,
          stingerFontSize: 220,
          tickerFontSize: 280,
          ctaTitleFontSize: 200,
          transitionType: 'fade' as const,
        }}
      />
      <Composition
        id="BoomRecap"
        component={BoomRecap}
        fps={30}
        width={1080}
        height={1920}
        schema={boomRecapSchema}
        defaultProps={boomRecapDefaults}
        calculateMetadata={({ props }) => ({
          durationInFrames: computeTotalFrames(props as any),
        })}
      />
    </>
  );
};
