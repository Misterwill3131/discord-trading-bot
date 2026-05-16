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
import { SharedOutro } from '../components/SharedOutro';
import { NarrationSubtitles } from '../components/NarrationSubtitles';
import { LogoOverlay } from '../components/LogoOverlay';
import { Sting } from '../components/Sting';

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
  narrationDataUrl: z.string().nullable().optional(),
  // Texte de la narration pour subtitles burned-in (autoplay muet).
  narrationText: z.string().nullable().optional(),
  // Logo overlay watermark configurable.
  logoUrl: z.string().nullable().optional(),
  logoCorner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
  // Intro/outro stings (URLs ou data URLs vers de courts MP4).
  introStingUrl: z.string().nullable().optional(),
  introStingFrames: z.number().min(15).max(180).default(45),
  outroStingUrl: z.string().nullable().optional(),
  outroStingFrames: z.number().min(15).max(180).default(45),
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
  OUTRO:      90,   // 3s — RecapOutro existant (BOOM logo + DAILY RECAP)
  SHARED_OUTRO: 90, // 3s — image lion brandée TOB (Ken Burns zoom)
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
  const introSting = props.introStingUrl ? (props.introStingFrames || 45) : 0;
  const outroSting = props.outroStingUrl ? (props.outroStingFrames || 45) : 0;
  const baseTotal = RECAP_FRAMES.STINGER + RECAP_FRAMES.HERO_STAT + waterfall
              + top3 + RECAP_FRAMES.CLOSING + RECAP_FRAMES.OUTRO + RECAP_FRAMES.SHARED_OUTRO;
  // Clamp basé sur le base total (sans stings) pour préserver le contrat
  // MIN/MAX original, puis on rajoute les stings par-dessus (ils sont
  // optionnels donc on ne veut pas qu'ils pushent le total > MAX_FRAMES
  // au point de couper la dernière phase).
  const clampedBase = Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, baseTotal));
  return introSting + clampedBase + outroSting;
}

// ─── Composition ────────────────────────────────────────────────────
export const BoomRecap: React.FC<BoomRecapProps> = (props) => {
  const { bgColor, musicVolume, narrationText, logoUrl, logoCorner, introStingUrl, introStingFrames, outroStingUrl, outroStingFrames } = props;

  const waterfallFrames = computeWaterfallFrames(props.tickers);
  const top3Frames = props.showTop3Phase ? RECAP_FRAMES.TOP3 : 0;

  // Sting cursors — si pas d'URL, fr=0 et toutes les autres phases démarrent
  // à frame 0 comme avant (pas de phase morte).
  const introStingFr = introStingUrl ? (introStingFrames || 45) : 0;
  const outroStingFr = outroStingUrl ? (outroStingFrames || 45) : 0;

  let cursor = 0;
  const introStingStart  = cursor; cursor += introStingFr;
  const stingerStart    = cursor; cursor += RECAP_FRAMES.STINGER;
  const heroStart       = cursor; cursor += RECAP_FRAMES.HERO_STAT;
  const waterfallStart  = cursor; cursor += waterfallFrames;
  const top3Start       = cursor; cursor += top3Frames;
  const closingStart    = cursor; cursor += RECAP_FRAMES.CLOSING;
  const outroStart      = cursor; cursor += RECAP_FRAMES.OUTRO;
  const sharedOutroStart = cursor; cursor += RECAP_FRAMES.SHARED_OUTRO;
  const outroStingStart = cursor;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily }}>
      {/* === Overlays full-duration (sting compris) === */}
      {narrationText && (
        <NarrationSubtitles text={narrationText} totalFrames={computeTotalFrames(props)} />
      )}
      <LogoOverlay logoUrl={logoUrl} corner={logoCorner} />

      {/* Intro sting — joué AVANT le DateStinger */}
      {introStingUrl && (
        <Sequence from={introStingStart} durationInFrames={introStingFr}>
          <Sting stingUrl={introStingUrl} />
        </Sequence>
      )}

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

      {/* Phase 6: Outro (BOOM logo + DAILY RECAP) */}
      <Sequence from={outroStart} durationInFrames={RECAP_FRAMES.OUTRO}>
        <RecapOutro accentColor={props.accentColor} />
      </Sequence>

      {/* Phase 7: SharedOutro brandé TOB (image lion + URL, Ken Burns zoom) */}
      <Sequence from={sharedOutroStart} durationInFrames={RECAP_FRAMES.SHARED_OUTRO}>
        <SharedOutro seed={`recap-${props.date}`} />
      </Sequence>

      {/* Outro sting — joué APRÈS le SharedOutro */}
      {outroStingUrl && (
        <Sequence from={outroStingStart} durationInFrames={outroStingFr}>
          <Sting stingUrl={outroStingUrl} />
        </Sequence>
      )}

      {/* Background music. Ducké à 0.3× quand TTS narration active. */}
      <Audio
        src={staticFile('audio/proof-track.mp3')}
        volume={(f) => {
          const totalFrames = computeTotalFrames(props);
          const fadeStart = totalFrames - 60;
          const baseVol = props.narrationDataUrl ? musicVolume * 0.3 : musicVolume;
          if (f < fadeStart) return baseVol;
          return interpolate(f, [fadeStart, totalFrames], [baseVol, 0], { extrapolateRight: 'clamp' });
        }}
      />
      {props.narrationDataUrl && (
        <Audio src={props.narrationDataUrl} volume={1} />
      )}
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
