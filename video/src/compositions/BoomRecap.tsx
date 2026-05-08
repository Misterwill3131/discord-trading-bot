import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from 'remotion';
import { z } from 'zod';
import { zTextarea, zColor } from '@remotion/zod-types';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { RecapDateStinger } from '../components/RecapDateStinger';
import { RecapHeroStat } from '../components/RecapHeroStat';
import { RecapTickerWaterfall } from '../components/RecapTickerWaterfall';
import { RecapTop3Highlight } from '../components/RecapTop3Highlight';
import { RecapClosingStat } from '../components/RecapClosingStat';
import { RecapOutro } from '../components/RecapOutro';

const { fontFamily } = loadInter('normal', {
  weights: ['400', '600', '700', '900'],
});

// ─── Zod schema ─────────────────────────────────────────────────────
const recapTickerSchema = z.object({
  ticker:  z.string().describe("Symbol sans le $"),
  gainPct: z.number().describe("Pourcentage de gain (positif)"),
  swing:   z.boolean().default(false),
  isHero:  z.boolean().default(false).describe("≥100% → glow doré"),
});

export const boomRecapSchema = z.object({
  date:          z.string().describe("YYYY-MM-DD ou label custom"),
  dateLabel:     z.string().default("RECAP"),
  tickers:       z.array(recapTickerSchema).min(1).max(20),
  runnersHit:    z.number().nullable().default(null),
  runnersTotal:  z.number().nullable().default(null),
  totalGainPct:  z.number(),
  tagline:       zTextarea().default("Plenty of chances to bank today."),
  ctaText:       z.string().default("Join the channel"),
  ctaUrl:        z.string().default(""),
  accentColor:   zColor().default("#fbbf24"),  // doré pour hero
  successColor:  zColor().default("#10b981"),  // vert pour wins normaux
  bgColor:       zColor().default("#0a0a0f"),
  musicVolume:   z.number().min(0).max(1).default(0.6),
  sfxEnabled:    z.boolean().default(true),
  showTop3Phase: z.boolean().default(true),
  lifestyleSeed: z.number().default(0),
});

export type BoomRecapProps = z.infer<typeof boomRecapSchema>;

// ─── Frame budget par phase ─────────────────────────────────────────
// Ces valeurs sont les durées NOMINALES. calculateMetadata adapte
// dynamiquement la phase 3 (waterfall) selon le nombre de tickers.
export const RECAP_FRAMES = {
  STINGER:    60,   // 2s
  HERO_STAT:  90,   // 3s
  // WATERFALL = dynamique (12-24f par ticker)
  TOP3:      180,   // 6s (skipped si showTop3Phase=false)
  CLOSING:   240,   // 8s
  OUTRO:      90,   // 3s
};

const MIN_FRAMES = 900;   // 30s
const MAX_FRAMES = 1800;  // 60s

// ─── Computed durations helper (réutilisé par calculateMetadata + le composant) ──
export function computeWaterfallFrames(tickers: BoomRecapProps['tickers']) {
  return tickers.reduce((sum, t) => sum + (t.isHero ? 24 : 12), 0);
}

export function computeTotalFrames(props: BoomRecapProps) {
  const waterfall = computeWaterfallFrames(props.tickers);
  const top3 = props.showTop3Phase ? RECAP_FRAMES.TOP3 : 0;
  const total = RECAP_FRAMES.STINGER + RECAP_FRAMES.HERO_STAT + waterfall
              + top3 + RECAP_FRAMES.CLOSING + RECAP_FRAMES.OUTRO;
  return Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, total));
}

// ─── Composition ────────────────────────────────────────────────────
export const BoomRecap: React.FC<BoomRecapProps> = (props) => {
  const { bgColor, musicVolume } = props;

  const waterfallFrames = computeWaterfallFrames(props.tickers);
  const top3Frames = props.showTop3Phase ? RECAP_FRAMES.TOP3 : 0;

  let cursor = 0;
  const stingerStart   = cursor; cursor += RECAP_FRAMES.STINGER;
  const heroStart      = cursor; cursor += RECAP_FRAMES.HERO_STAT;
  const waterfallStart = cursor; cursor += waterfallFrames;
  const top3Start      = cursor; cursor += top3Frames;
  const closingStart   = cursor; cursor += RECAP_FRAMES.CLOSING;
  const outroStart     = cursor;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily }}>
      {/* Phase 1: DateStinger */}
      <Sequence from={stingerStart} durationInFrames={RECAP_FRAMES.STINGER}>
        <RecapDateStinger
          date={props.date}
          dateLabel={props.dateLabel}
          accentColor={props.accentColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>

      {/* Phase 2: HeroStat */}
      <Sequence from={heroStart} durationInFrames={RECAP_FRAMES.HERO_STAT}>
        <RecapHeroStat
          totalGainPct={props.totalGainPct}
          accentColor={props.accentColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>

      {/* Phase 3: TickerWaterfall */}
      <Sequence from={waterfallStart} durationInFrames={waterfallFrames}>
        <RecapTickerWaterfall
          tickers={props.tickers}
          accentColor={props.accentColor}
          successColor={props.successColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>

      {/* Phase 4: Top3Highlight (conditional) */}
      {props.showTop3Phase && (
        <Sequence from={top3Start} durationInFrames={RECAP_FRAMES.TOP3}>
          <RecapTop3Highlight
            tickers={props.tickers}
            accentColor={props.accentColor}
            lifestyleSeed={props.lifestyleSeed}
            sfxEnabled={props.sfxEnabled}
          />
        </Sequence>
      )}

      {/* Phase 5: ClosingStat */}
      <Sequence from={closingStart} durationInFrames={RECAP_FRAMES.CLOSING}>
        <RecapClosingStat
          runnersHit={props.runnersHit}
          runnersTotal={props.runnersTotal}
          tagline={props.tagline}
          ctaText={props.ctaText}
          ctaUrl={props.ctaUrl}
          accentColor={props.accentColor}
          sfxEnabled={props.sfxEnabled}
        />
      </Sequence>

      {/* Phase 6: Outro */}
      <Sequence from={outroStart} durationInFrames={RECAP_FRAMES.OUTRO}>
        <RecapOutro accentColor={props.accentColor} />
      </Sequence>

      {/* Background music (Task 12 finalise le mix) */}
      <Audio
        src={staticFile('audio/proof-track.mp3')}
        volume={(f) => {
          const totalFrames = computeTotalFrames(props);
          const fadeStart = totalFrames - 60;
          if (f < fadeStart) return musicVolume;
          return interpolate(f, [fadeStart, totalFrames], [musicVolume, 0], { extrapolateRight: 'clamp' });
        }}
      />
    </AbsoluteFill>
  );
};

// Placeholder visuel simple — affiche le label de la phase + résumé.
// Remplacé phase par phase dans Tasks 7-12.
const PhasePlaceholder: React.FC<{ label: string; props: BoomRecapProps }> = ({ label, props }) => (
  <AbsoluteFill style={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 80,
    fontWeight: 900,
    textAlign: 'center',
    padding: 40,
  }}>
    <div>
      <div style={{ color: props.accentColor }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 600, color: '#888', marginTop: 20 }}>
        {props.dateLabel} • {props.date}
      </div>
      <div style={{ fontSize: 24, fontWeight: 400, color: '#666', marginTop: 10 }}>
        {props.tickers.length} tickers, +{Math.round(props.totalGainPct)}% total
      </div>
    </div>
  </AbsoluteFill>
);
