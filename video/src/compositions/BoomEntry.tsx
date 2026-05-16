import { AbsoluteFill, Audio, Sequence, staticFile, Img, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from 'remotion';
import { TransitionSeries, linearTiming, TransitionPresentation } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import { flip } from '@remotion/transitions/flip';
import { z } from 'zod';
import { zTextarea, zColor } from '@remotion/zod-types';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { LifestyleHook } from '../components/LifestyleHook';
import { MoneyRain } from '../components/MoneyRain';
import { SharedOutro } from '../components/SharedOutro';
import { NarrationSubtitles } from '../components/NarrationSubtitles';
import { LogoOverlay } from '../components/LogoOverlay';
import { Sting } from '../components/Sting';

// Frames pour le SharedOutro (image lion brandée TOB) ajouté en fin de
// composition. 90 frames @ 30fps = 3s. Met à jour Root.tsx durationInFrames
// (376 frames TransitionSeries + 90 SharedOutro = 466 total).
const SHARED_OUTRO_FRAMES_BE = 90;
const TRANSITION_SERIES_END_BE = 376;

const { fontFamily } = loadInter('normal', { weights: ['400', '600', '700', '900'] });

// ─────────────────────────────────────────────────────────────────────
// BoomEntry — Template pour annoncer un signal d'entry live
// ─────────────────────────────────────────────────────────────────────
// Pendant que ChartTemplate célèbre une exit gagnante, BoomEntry annonce
// "🚨 LIVE: Z just called $TSLA" pour driver des conversions abonnement.
//
// Phases (~13s = 390 frames @ 30fps) :
//   0 : Stinger     (12 frames, 0.4s) — "🚨 LIVE" flash rouge
//   1 : Lifestyle   (60 frames, 2s)   — luxury hook bref
//   2 : Tease       (60 frames, 2s)   — "Z just called this"
//   3 : EntryCard   (150 frames, 5s)  — image canvas Discord du signal
//   4 : CTA         (100 frames, 3.3s) — discord.gg/boom + money rain
// ─────────────────────────────────────────────────────────────────────

export const boomEntrySchema = z.object({
  ticker: z.string().min(1).max(10).describe('Ticker stock (ex: TSLA, GDC)'),
  author: z.string().min(1).describe("Pseudo Discord de l'analyste"),
  message: zTextarea().describe('Texte du message entry (legacy, non affiché)'),
  timestamp: z.string().describe('Timestamp ISO 8601 (ex: 2026-04-25T13:32:00-04:00)'),
  entryImageDataUrl: z
    .string()
    .nullable()
    .optional()
    .describe('Data URL PNG (image canvas du signal entry). Vide = fallback static.'),
  // ─── Text overrides (tous éditables dans Studio) ───
  stingerText: z.string().default('🚨 LIVE').describe('Texte stinger d\'ouverture (default "🚨 LIVE")'),
  teaseAction: z.string().default('just called this.').describe('Action après le pseudo dans le tease (ex: "is going long")'),
  teaseSubtext: z.string().default('Watch live →').describe('Sous-texte du tease (ex: "Watch live →")'),
  cardLabel: z.string().default('🚨 LIVE SIGNAL').describe('Label rouge au-dessus de l\'image canvas'),
  ctaTitle: z.string().default('JOIN').describe('Titre du CTA final (ex: "JOIN", "GO LIVE")'),
  ctaUrl: z.string().default('discord.gg/boom').describe('URL ou handle (ex: "discord.gg/boom")'),
  ctaSubtitle: z.string().default('Get every signal live').describe('Sous-titre du CTA (ex: "Get every signal live")'),
  // ─── Couleurs ───
  accentColor: zColor().default('#ef4444').describe('Couleur d\'accent (rouge pour entry, glows + texte CTA + label)'),
  // ─── Audio ───
  musicVolume: z.number().min(0).max(1).default(0.55).describe('Volume music background (0 = mute, 1 = max)'),
  sfxEnabled: z.boolean().default(true).describe('Active les SFX (whoosh + cha-ching)'),
  // ─── Lifestyle ───
  lifestyleSeedOverride: z
    .string()
    .optional()
    .describe('Override du seed lifestyle hook. Vide = auto depuis ticker+timestamp.'),
  // ─── Tailles de font (pour ajuster le visuel sans toucher au code) ───
  stingerFontSize: z.number().min(80).max(400).default(220).describe('Taille font stinger d\'ouverture (px)'),
  tickerFontSize: z.number().min(120).max(400).default(280).describe('Taille font $TICKER dans le tease (px)'),
  ctaTitleFontSize: z.number().min(80).max(400).default(200).describe('Taille font titre CTA "JOIN" (px)'),
  // ─── Transition entre phases ───
  transitionType: z
    .enum(['fade', 'slide', 'wipe', 'flip'])
    .default('fade')
    .describe('Type de transition entre les phases (fade, slide, wipe, flip)'),
  // ─── TTS narration (optionnel) ───
  narrationDataUrl: z
    .string()
    .nullable()
    .optional()
    .describe('Data URL MP3 voice-over. Vide = pas de voix off.'),
  // Texte de la narration pour subtitles burned-in (autoplay muet TikTok/Reels).
  // Indépendant du dataUrl — on peut activer subtitles sans audio.
  narrationText: z
    .string()
    .nullable()
    .optional()
    .describe('Texte narration pour subtitles burned-in. Vide = pas de subs.'),
  // ─── Logo overlay watermark (optionnel) ───
  logoUrl: z.string().nullable().optional().describe('URL ou data URL du logo watermark. Vide = pas de logo.'),
  logoCorner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
  // ─── Intro/outro stings (clips brandés ~1-3s) ───
  // Si fourni, joué AVANT (intro) ou APRÈS (outro) la composition principale.
  // L'horloge interne de la composition (TransitionSeries + SharedOutro) est
  // wrap dans une <Sequence from={introStingFr}> donc tous les SFX/timings
  // restent local-relative inchangés.
  introStingUrl: z.string().nullable().optional().describe('URL ou data URL d\'un MP4 court (~1-3s) joué en intro. Vide = pas d\'intro sting.'),
  introStingFrames: z.number().min(15).max(180).default(45).describe('Durée du sting intro en frames @ 30fps. Default 45 (1.5s).'),
  outroStingUrl: z.string().nullable().optional().describe('URL ou data URL d\'un MP4 court joué en outro. Vide = pas d\'outro sting.'),
  outroStingFrames: z.number().min(15).max(180).default(45).describe('Durée du sting outro en frames @ 30fps. Default 45 (1.5s).'),
});

export type BoomEntryProps = z.infer<typeof boomEntrySchema>;

// Helper exporté pour calculer la durée totale de BoomEntry selon les
// stings activés. Used by Root.tsx via calculateMetadata().
const BOOM_ENTRY_BASE_FRAMES = 466;  // TransitionSeries (376) + SharedOutro (90)
export function computeBoomEntryTotalFrames(props: { introStingUrl?: string | null; introStingFrames?: number; outroStingUrl?: string | null; outroStingFrames?: number }): number {
  const introSting = props.introStingUrl ? (props.introStingFrames || 45) : 0;
  const outroSting = props.outroStingUrl ? (props.outroStingFrames || 45) : 0;
  return introSting + BOOM_ENTRY_BASE_FRAMES + outroSting;
}

const FADE_FRAMES = 6;
const SLIDE_FRAMES = 8;

// Helper : renvoie la TransitionPresentation correspondant au type choisi.
// Wipe + flip n'acceptent pas de direction obligatoire ; slide en a une.
// Type erased en `any` car les TransitionPresentation<T> ont des
// generic params différents (FadeProps, SlideProps, etc.) impossibles
// à unifier proprement sans complexifier le typing.
function pickTransition(type: 'fade' | 'slide' | 'wipe' | 'flip'): TransitionPresentation<any> {
  switch (type) {
    case 'slide': return slide({ direction: 'from-right' });
    case 'wipe':  return wipe();
    case 'flip':  return flip();
    case 'fade':
    default:      return fade();
  }
}

// ── Sub-component: Stinger LIVE rouge ──
const StingerLive = ({ text, color, fontSize }: { text: string; color: string; fontSize: number }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 2, 6, 9], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
  });
  const scale = interpolate(frame, [0, 3, 6, 9], [1.6, 1.0, 1.0, 1.4], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
  });
  const flashOpacity = interpolate(frame, [0, 1, 3], [0.8, 0.3, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        fontSize, fontWeight: 900, fontFamily, letterSpacing: -6,
        color, textShadow: `0 0 40px ${color}aa, 0 0 80px ${color}66`,
        opacity, transform: `scale(${scale})`, textAlign: 'center',
      }}>
        {text}
      </div>
      <AbsoluteFill style={{ background: '#fff', opacity: flashOpacity, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

// ── Sub-component: Tease "X just called this" ──
const TeaseAct = ({
  ticker, author, action, subtext, color, tickerFontSize,
}: { ticker: string; author: string; action: string; subtext: string; color: string; tickerFontSize: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tickerEntry = spring({ frame, fps, config: { damping: 10, stiffness: 100 }, durationInFrames: 25 });
  const tickerScale = tickerEntry * (1 + Math.sin(frame * 0.15) * 0.02);
  const captionOpacity = interpolate(frame, [20, 35], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{
      background: 'radial-gradient(circle at 50% 50%, #1a1a2e 0%, #0a0a0a 80%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily, padding: 60,
    }}>
      <div style={{
        color, fontSize: tickerFontSize, fontWeight: 900, letterSpacing: -6,
        transform: `scale(${tickerScale})`, textShadow: `0 0 80px ${color}aa`,
      }}>
        ${ticker}
      </div>
      <div style={{
        marginTop: 40, color: '#fff', fontSize: 56, fontWeight: 700, opacity: captionOpacity,
        textAlign: 'center',
      }}>
        {author} {action}
      </div>
      <div style={{
        marginTop: 16, color: 'rgba(255,255,255,0.5)', fontSize: 38, opacity: captionOpacity,
      }}>
        {subtext}
      </div>
    </AbsoluteFill>
  );
};

// ── Sub-component: EntryCard avec image canvas Discord ──
const EntryCardAct = ({
  src, label, color,
}: { src: string; label: string; color: string }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entry = spring({ frame, fps, config: { damping: 12 }, durationInFrames: 25 });
  const translateY = interpolate(entry, [0, 1], [80, 0]);
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const scale = interpolate(frame, [0, 150], [1.0, 1.04], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const glowPulse = 0.3 + Math.abs(Math.sin(frame * 0.06)) * 0.5;
  return (
    <AbsoluteFill style={{
      background: 'radial-gradient(circle at 50% 40%, #1a1a2e 0%, #0a0a0a 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 30,
    }}>
      <Img src={src} style={{
        width: '100%', height: 'auto', opacity,
        transform: `translateY(${translateY}px) scale(${scale})`,
        borderRadius: 24,
        boxShadow: `0 24px 100px rgba(0,0,0,0.85), 0 0 ${40 + glowPulse * 60}px ${color}${Math.round(glowPulse * 255).toString(16).padStart(2, '0')}`,
      }} />
      <div style={{
        position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center',
        color, fontSize: 40, fontWeight: 900, fontFamily, letterSpacing: 4,
        textShadow: `0 0 20px ${color}aa`,
      }}>
        {label}
      </div>
    </AbsoluteFill>
  );
};

// ── Sub-component: CTA discord.gg/boom + money rain ──
const CtaJoin = ({
  title, url, subtitle, color, titleFontSize,
}: { title: string; url: string; subtitle: string; color: string; titleFontSize: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleEntry = spring({ frame, fps, config: { damping: 10, stiffness: 100 }, durationInFrames: 22 });
  const titleScale = titleEntry * (1 + Math.sin(frame * 0.15) * 0.03);
  const urlEntry = spring({ frame: frame - 20, fps, config: { damping: 12 }, durationInFrames: 22 });
  const urlY = interpolate(urlEntry, [0, 1], [60, 0]);
  return (
    <AbsoluteFill style={{
      background: 'radial-gradient(circle at 50% 50%, #1a1a2e 0%, #0a0a0a 80%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 60, fontFamily,
    }}>
      <MoneyRain count={40} seed="entry-cta" />
      <div style={{
        color, fontSize: titleFontSize, fontWeight: 900, letterSpacing: -4,
        transform: `scale(${titleScale})`, textShadow: `0 0 80px ${color}aa`, zIndex: 2,
        textAlign: 'center',
      }}>
        {title}
      </div>
      <div style={{
        marginTop: 30, color: '#fff', fontSize: 64, fontWeight: 800,
        transform: `translateY(${urlY}px)`, opacity: urlEntry, zIndex: 2,
        textAlign: 'center',
      }}>
        {url}
      </div>
      <div style={{
        marginTop: 16, color: 'rgba(255,255,255,0.6)', fontSize: 36, opacity: urlEntry, zIndex: 2,
        textAlign: 'center',
      }}>
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};

// ── Main composition ──
export const BoomEntry = ({
  ticker, author, timestamp, entryImageDataUrl,
  stingerText, teaseAction, teaseSubtext, cardLabel,
  ctaTitle, ctaUrl, ctaSubtitle,
  accentColor, musicVolume, sfxEnabled, lifestyleSeedOverride,
  stingerFontSize, tickerFontSize, ctaTitleFontSize, transitionType,
  narrationDataUrl, narrationText,
  logoUrl, logoCorner,
  introStingUrl, introStingFrames, outroStingUrl, outroStingFrames,
}: BoomEntryProps) => {
  const fallbackSrc = staticFile('signal-alert/card-default.png');
  const cardSrc = entryImageDataUrl || fallbackSrc;
  const lifestyleSeed = lifestyleSeedOverride || `entry-${ticker}-${timestamp}`;
  const transitionPresentation = pickTransition(transitionType);
  // Duck music quand TTS narration active.
  const duckedMusicVolume = narrationDataUrl ? musicVolume * 0.3 : musicVolume;

  // Sting cursors — si absent, fr=0 et la composition se comporte comme
  // avant. Le wrap Sequence shift le main content pour que SFX absolus
  // (frames 0/70/290) restent local-relative inchangés.
  const introStingFr = introStingUrl ? (introStingFrames || 45) : 0;
  const outroStingFr = outroStingUrl ? (outroStingFrames || 45) : 0;
  const BASE_FRAMES = TRANSITION_SERIES_END_BE + SHARED_OUTRO_FRAMES_BE;  // 466
  const totalFrames = introStingFr + BASE_FRAMES + outroStingFr;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', fontFamily }}>
      {/* === Overlays full-duration (sting compris) === */}
      {narrationText && (
        <NarrationSubtitles text={narrationText} totalFrames={totalFrames} />
      )}
      <LogoOverlay logoUrl={logoUrl} corner={logoCorner} />

      {/* Intro sting (~1.5s) — joué AVANT le main content */}
      {introStingUrl && (
        <Sequence from={0} durationInFrames={introStingFr}>
          <Sting stingUrl={introStingUrl} />
        </Sequence>
      )}

      {/* === Main content wrap — shift par introStingFr === */}
      <Sequence from={introStingFr} durationInFrames={BASE_FRAMES}>
        <AbsoluteFill>
      {/* === AUDIO === */}
      <Audio src={staticFile('audio/proof-track.mp3')} volume={duckedMusicVolume} />
      {narrationDataUrl && (
        <Audio src={narrationDataUrl} volume={1} />
      )}
      {sfxEnabled && (
        <>
          <Sequence from={0} durationInFrames={45}>
            <Audio src={staticFile('audio/whoosh-3.mp3')} volume={0.85} />
          </Sequence>
          <Sequence from={70} durationInFrames={20}>
            <Audio src={staticFile('audio/whoosh-1.mp3')} volume={0.75} />
          </Sequence>
          <Sequence from={290} durationInFrames={60}>
            <Audio src={staticFile('audio/chaching.mp3')} volume={0.95} />
          </Sequence>
        </>
      )}

      <TransitionSeries>
        {/* Phase 0 — Stinger LIVE */}
        <TransitionSeries.Sequence durationInFrames={12}>
          <StingerLive text={stingerText} color={accentColor} fontSize={stingerFontSize} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={transitionPresentation} timing={linearTiming({ durationInFrames: 4 })} />

        {/* Phase 1 — Lifestyle hook bref (2s) */}
        <TransitionSeries.Sequence durationInFrames={66}>
          <LifestyleHook overlayText={`$${ticker}`} seed={lifestyleSeed} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={transitionPresentation} timing={linearTiming({ durationInFrames: FADE_FRAMES })} />

        {/* Phase 2 — Tease */}
        <TransitionSeries.Sequence durationInFrames={66}>
          <TeaseAct ticker={ticker} author={author} action={teaseAction} subtext={teaseSubtext} color={accentColor} tickerFontSize={tickerFontSize} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={transitionPresentation} timing={linearTiming({ durationInFrames: SLIDE_FRAMES })} />

        {/* Phase 3 — Entry card canvas (5s) */}
        <TransitionSeries.Sequence durationInFrames={156}>
          <EntryCardAct src={cardSrc} label={cardLabel} color={accentColor} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={transitionPresentation} timing={linearTiming({ durationInFrames: FADE_FRAMES })} />

        {/* Phase 4 — CTA */}
        <TransitionSeries.Sequence durationInFrames={100}>
          <CtaJoin title={ctaTitle} url={ctaUrl} subtitle={ctaSubtitle} color={accentColor} titleFontSize={ctaTitleFontSize} />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      {/* Phase 5 — SharedOutro brandé TOB (~3s). Démarre après la TransitionSeries (frame 376). */}
      <Sequence from={TRANSITION_SERIES_END_BE} durationInFrames={SHARED_OUTRO_FRAMES_BE}>
        <SharedOutro seed={`${ticker}-${timestamp}`} />
      </Sequence>
        </AbsoluteFill>
      </Sequence>

      {/* Outro sting (~1.5s) — joué APRÈS le SharedOutro */}
      {outroStingUrl && (
        <Sequence from={introStingFr + BASE_FRAMES} durationInFrames={outroStingFr}>
          <Sting stingUrl={outroStingUrl} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};
