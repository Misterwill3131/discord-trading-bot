import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';
import { SignalAlert, SignalAlertProps } from './compositions/SignalAlert';
import { ChartTemplate, chartTemplateSchema } from './compositions/ChartTemplate';
import { BoomEntry, boomEntrySchema } from './compositions/BoomEntry';
import { BoomRecap, boomRecapSchema, computeTotalFrames } from './compositions/BoomRecap';
import { TobBrandStory, tobBrandStorySchema, computeBrandStoryTotalFrames } from './compositions/TobBrandStory';
import { TobTradeRecap, tobTradeRecapSchema, computeTradeRecapTotalFrames } from './compositions/TobTradeRecap';

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

const chartTemplateDefaults = {
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
  narrationDataUrl: null,
  narrationText: null,
  logoUrl: null,
  logoCorner: 'top-right' as const,
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
  narrationDataUrl: null,
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
        id="ChartTemplate"
        component={ChartTemplate}
        durationInFrames={608}
        fps={30}
        width={1080}
        height={1920}
        schema={chartTemplateSchema}
        defaultProps={chartTemplateDefaults}
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
          narrationDataUrl: null,
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
      <Composition
        id="TobBrandStory"
        component={TobBrandStory}
        fps={30}
        width={1080}
        height={1920}
        schema={tobBrandStorySchema}
        defaultProps={{
          scenes: [
            { imagePath: 'brand-story/scene1.png', caption: 'Down again. -$3,200 this week.' },
            { imagePath: 'brand-story/scene2.png', caption: 'Same mistakes. Different chart.' },
            { imagePath: 'brand-story/scene3.png', caption: 'Stuck in the same trap.' },
            { imagePath: 'brand-story/scene4.png', caption: 'Then he found the Temple.' },
            { imagePath: 'brand-story/scene5.png', caption: 'Different rules. Different game.' },
            { imagePath: 'brand-story/scene6.png', caption: 'Join the pride.' },
          ],
          sceneDurationFrames: 150,
          accentColor: '#fbbf24',
          captionStyle: 'bold' as const,
          outroSeed: 'brand-story-preview',
        }}
        calculateMetadata={({ props }) => ({
          durationInFrames: computeBrandStoryTotalFrames(props as any),
        })}
      />
      <Composition
        id="TobTradeRecap"
        component={TobTradeRecap}
        fps={30}
        width={1080}
        height={1920}
        schema={tobTradeRecapSchema}
        defaultProps={{
          dateLabel: 'TODAY',
          trades: [
            { ticker: '$XOS',  entryPrice: 2.49,  hodPrice: 2.90 },
            { ticker: '$HAO',  entryPrice: 0.046, hodPrice: 0.071 },
            { ticker: '$DXYZ', entryPrice: 30,    hodPrice: 71 },
            { ticker: '$LABT', entryPrice: 3.17,  hodPrice: 3.16 },
            { ticker: '$ERNA', entryPrice: 7.91,  hodPrice: 14.80 },
          ],
          longTermInvestments: [{ ticker: '$DXYZ', entryPrice: 30, currentPrice: 71 }],
          alertImages: [],
          secondsPerAlert: 1.0,
          alertsHoldEndSeconds: 3,
          alertsFallbackSeconds: 4,
          accentColor: '#fbbf24' as const,
          successColor: '#10b981' as const,
          errorColor: '#ef4444' as const,
          bgColor: '#0a0a0f' as const,
          outroSeed: 'trade-recap-preview',
          narrationDataUrl: null,
          narrationText: null,
          logoUrl: null,
          logoCorner: 'top-right' as const,
        }}
        calculateMetadata={({ props }) => ({
          durationInFrames: computeTradeRecapTotalFrames(props as any),
        })}
      />
      {/* ─── Multi-aspect-ratio variants ───────────────────────────
          Mêmes composants, dimensions différentes pour TikTok/Reels
          (9:16, default), Instagram feed (1:1), YouTube/Twitter (16:9).
          NOTE : les composants ont actuellement des layouts optimisés
          pour 9:16. Les variants 1:1 et 16:9 sont rendus en "best
          effort" — certains éléments peuvent déborder ou paraître
          tassés. Refactor responsive par composition TBD. */}
      <Composition
        id="TobTradeRecap_1x1"
        component={TobTradeRecap}
        fps={30}
        width={1080}
        height={1080}
        schema={tobTradeRecapSchema}
        defaultProps={{
          dateLabel: 'TODAY',
          trades: [{ ticker: '$XOS', entryPrice: 2.49, hodPrice: 2.90 }],
          longTermInvestments: [],
          alertImages: [],
          secondsPerAlert: 1.0,
          alertsHoldEndSeconds: 3,
          alertsFallbackSeconds: 4,
          accentColor: '#fbbf24' as const,
          successColor: '#10b981' as const,
          errorColor: '#ef4444' as const,
          bgColor: '#0a0a0f' as const,
          outroSeed: 'trade-recap-1x1-preview',
          narrationDataUrl: null,
          narrationText: null,
          logoUrl: null,
          logoCorner: 'top-right' as const,
        }}
        calculateMetadata={({ props }) => ({
          durationInFrames: computeTradeRecapTotalFrames(props as any),
        })}
      />
      <Composition
        id="TobTradeRecap_16x9"
        component={TobTradeRecap}
        fps={30}
        width={1920}
        height={1080}
        schema={tobTradeRecapSchema}
        defaultProps={{
          dateLabel: 'TODAY',
          trades: [{ ticker: '$XOS', entryPrice: 2.49, hodPrice: 2.90 }],
          longTermInvestments: [],
          alertImages: [],
          secondsPerAlert: 1.0,
          alertsHoldEndSeconds: 3,
          alertsFallbackSeconds: 4,
          accentColor: '#fbbf24' as const,
          successColor: '#10b981' as const,
          errorColor: '#ef4444' as const,
          bgColor: '#0a0a0f' as const,
          outroSeed: 'trade-recap-16x9-preview',
          narrationDataUrl: null,
          narrationText: null,
          logoUrl: null,
          logoCorner: 'top-right' as const,
        }}
        calculateMetadata={({ props }) => ({
          durationInFrames: computeTradeRecapTotalFrames(props as any),
        })}
      />
      <Composition
        id="ChartTemplate_1x1"
        component={ChartTemplate}
        durationInFrames={608}
        fps={30}
        width={1080}
        height={1080}
        schema={chartTemplateSchema}
        defaultProps={chartTemplateDefaults}
      />
      <Composition
        id="ChartTemplate_16x9"
        component={ChartTemplate}
        durationInFrames={608}
        fps={30}
        width={1920}
        height={1080}
        schema={chartTemplateSchema}
        defaultProps={chartTemplateDefaults}
      />
    </>
  );
};
