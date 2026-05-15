import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { z } from 'zod';
import { zTextarea, zColor } from '@remotion/zod-types';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';

// Charge Inter (poids 700 + 900 pour les gros titres + corps).
// fontFamily est utilisable dans tous les sous-composants via inheritance.
const { fontFamily } = loadInter('normal', {
  weights: ['400', '600', '700', '900'],
});
import { Stinger } from '../components/Stinger';
import { NarrationSubtitles } from '../components/NarrationSubtitles';
import { LifestyleHook } from '../components/LifestyleHook';
import { ResultTease } from '../components/ResultTease';
import { TimePassAct } from '../components/TimePassAct';
import { ProofImageAct } from '../components/ProofImageAct';
import { ResultCta } from '../components/ResultCta';
import { SharedOutro } from '../components/SharedOutro';

// Frames pour le SharedOutro (image lion brandée TOB) ajouté en fin de
// composition. 90 frames @ 30fps = 3s de Ken Burns zoom + fade in/out.
// Si tu changes cette valeur, mets à jour Root.tsx durationInFrames
// (518 frames TransitionSeries + 90 SharedOutro = 608 total).
const SHARED_OUTRO_FRAMES = 90;
const TRANSITION_SERIES_END = 518;

// Zod schema : Studio génère automatiquement un formulaire d'édition riche
// (text fields validés, textareas multi-line, etc.) à partir de cette
// définition. Les props peuvent être modifiées en live sans toucher au code.
export const chartTemplateSchema = z.object({
  ticker: z.string().min(1).max(10).describe('Ticker stock (ex: TSLA, GDC)'),
  entryAuthor: z.string().min(1).describe("Pseudo Discord de l'analyste qui a posté l'entry"),
  entryMessage: zTextarea().describe("Texte du message d'entry"),
  entryTimestamp: z.string().describe("Timestamp ISO 8601 de l'entry (ex: 2026-04-25T13:32:00-04:00)"),
  exitAuthor: z.string().min(1).describe("Pseudo Discord de l'analyste qui a clôt"),
  exitMessage: zTextarea().describe("Texte du message d'exit"),
  exitTimestamp: z.string().describe('Timestamp ISO 8601 de l\'exit'),
  pnl: z.string().regex(/^[+-]?\d+(\.\d+)?%$/).describe('Gain en % (ex: +20%, -5%)'),
  proofImageDataUrl: z
    .string()
    .nullable()
    .optional()
    .describe('Data URL PNG (image canvas entry+exit). Vide = placeholder.'),
  chartImageDataUrl: z
    .string()
    .nullable()
    .optional()
    .describe('Data URL PNG du chart TradingView du jour (fetched par le worker via chart-img). Vide = ChartExplosion synthétique en fallback.'),
  // ─── Text overrides éditables dans Studio ───
  teaseSubtext: z
    .string()
    .optional()
    .describe('Sous-titre tease (default "watch how {author} did it"). Vide = utilise le default avec entryAuthor.'),
  ctaUrl: z.string().default('discord.gg/boom').describe('URL ou handle dans le CTA final'),
  // ─── Couleurs ───
  accentColor: zColor().default('#10b981').describe('Couleur d\'accent (vert pour proof, ticker pnl + glows)'),
  // ─── Audio ───
  musicVolume: z.number().min(0).max(1).default(0.55).describe('Volume music background (0 = mute, 1 = max)'),
  sfxEnabled: z.boolean().default(true).describe('Active les SFX (whoosh, impact, cha-ching)'),
  // ─── Lifestyle ───
  lifestyleSeedOverride: z
    .string()
    .optional()
    .describe('Override du seed lifestyle hook. Vide = auto depuis ticker+entryTimestamp.'),
  // ─── TTS narration (optionnel) ───
  narrationDataUrl: z
    .string()
    .nullable()
    .optional()
    .describe('Data URL MP3 voice-over (data:audio/mpeg;base64,...). Vide = pas de voix off.'),
  narrationText: z
    .string()
    .nullable()
    .optional()
    .describe('Texte narration pour subtitles burned-in (autoplay muet). Vide = pas de subs.'),
});

// Inferred TypeScript type — cohérent avec le schema, plus de duplication.
export type ChartTemplateProps = z.infer<typeof chartTemplateSchema>;

// Transitions courtes (~0.2s) entre chaque phase pour fluidité sans ralentir.
// Sequences gonflées pour préserver le timing visuel d'origine malgré les overlaps.
//
// Math : 12+96+66+98+188+90 = 550 frames de Sequences
// Transitions : 4 + 6 + 8 + 8 + 6 = 32 frames d'overlap
// Total visible : 550 - 32 = 518 ✓ (cf Root.tsx)
const FADE_FRAMES = 6;
const SLIDE_FRAMES = 8;

// Audio cues : timestamps approximatifs (en frames) où les SFX se déclenchent.
const SFX_STINGER = 0;          // Cha-ching sur le flash d'ouverture
const SFX_TRANS_1 = 12;         // Whoosh stinger → lifestyle
const SFX_TRANS_2 = 108;        // Whoosh lifestyle → tease (~3.6s)
const SFX_IMPACT = 222;         // Impact bass au climax du chart (~7.4s)
const SFX_REVEAL = 460;         // Cha-ching sur le résultat final (~15.3s)

export const ChartTemplate = ({
  ticker, entryAuthor, entryMessage: _entryMessage, entryTimestamp,
  exitAuthor, exitMessage: _exitMessage, exitTimestamp, pnl,
  proofImageDataUrl, chartImageDataUrl, teaseSubtext, ctaUrl,
  accentColor, musicVolume, sfxEnabled, lifestyleSeedOverride,
  narrationDataUrl, narrationText,
}: ChartTemplateProps) => {
  const lifestyleSeed = lifestyleSeedOverride || `${ticker}-${entryTimestamp}`;
  // Caption pour la phase ProofImage : ticker + auteur(s) + pnl.
  // Si entry et exit même auteur (cas le + fréquent), simplifie en un seul nom.
  // entryAuthor / exitAuthor sont assumed déjà resolved en display name côté
  // bot via getDisplayName (canvas/utils/authors.js) avant l'enqueue.
  const proofCaption = entryAuthor === exitAuthor
    ? `$${ticker} · ${entryAuthor} · ${pnl}`
    : `$${ticker} · ${entryAuthor} → ${exitAuthor} · ${pnl}`;

  // Music volume ducké à ~0.3× quand TTS narration active, pour ne pas
  // masquer la voix off. Sans narration, volume normal du template.
  const duckedMusicVolume = narrationDataUrl ? musicVolume * 0.3 : musicVolume;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black', fontFamily }}>
      {/* === AUDIO === */}
      <Audio src={staticFile('audio/proof-track.mp3')} volume={duckedMusicVolume} />
      {narrationDataUrl && (
        <Audio src={narrationDataUrl} volume={1} />
      )}
      {narrationText && (
        <NarrationSubtitles
          text={narrationText}
          totalFrames={TRANSITION_SERIES_END + SHARED_OUTRO_FRAMES}
        />
      )}

      {sfxEnabled && (
        <>
          <Sequence from={SFX_STINGER} durationInFrames={45}>
            <Audio src={staticFile('audio/chaching.mp3')} volume={0.85} />
          </Sequence>
          <Sequence from={SFX_TRANS_1} durationInFrames={20}>
            <Audio src={staticFile('audio/whoosh-1.mp3')} volume={0.75} />
          </Sequence>
          <Sequence from={SFX_TRANS_2} durationInFrames={20}>
            <Audio src={staticFile('audio/whoosh-2.mp3')} volume={0.75} />
          </Sequence>
          <Sequence from={SFX_IMPACT} durationInFrames={60}>
            <Audio src={staticFile('audio/impact-bass.mp3')} volume={0.9} />
          </Sequence>
          <Sequence from={SFX_REVEAL} durationInFrames={60}>
            <Audio src={staticFile('audio/chaching.mp3')} volume={0.95} />
          </Sequence>
        </>
      )}

      {/* === VIDEO === */}
      <TransitionSeries>
        {/* Phase 0 — Stinger d'ouverture (~0.4s) : flash du PnL */}
        <TransitionSeries.Sequence durationInFrames={12}>
          <Stinger pnl={pnl} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 4 })}
        />

        {/* Phase 1 — Lifestyle hook (~3s, 5 cuts rapides) */}
        <TransitionSeries.Sequence durationInFrames={96}>
          <LifestyleHook overlayText={pnl} seed={lifestyleSeed} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 2 — Result tease (~2s) */}
        <TransitionSeries.Sequence durationInFrames={66}>
          <ResultTease ticker={ticker} pnl={pnl} author={entryAuthor} subtext={teaseSubtext} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: SLIDE_FRAMES })}
        />

        {/* Phase 3 — Chart real (TradingView via chart-img) ou ChartExplosion fallback (~3s) */}
        <TransitionSeries.Sequence durationInFrames={98}>
          <TimePassAct
            entryTimestamp={entryTimestamp}
            exitTimestamp={exitTimestamp}
            chartImageDataUrl={chartImageDataUrl}
          />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: SLIDE_FRAMES })}
        />

        {/* Phase 4 — Proof image (~6.3s) : "the receipts" — image canvas
            entry+exit Discord-styled (role pills, custom emojis, etc.) */}
        <TransitionSeries.Sequence durationInFrames={188}>
          <ProofImageAct
            src={proofImageDataUrl || undefined}
            caption={proofCaption}
            glowColor={accentColor}
          />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 5 — Result CTA + money rain (~3s) */}
        <TransitionSeries.Sequence durationInFrames={90}>
          <ResultCta pnl={pnl} url={ctaUrl} />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      {/* Phase 6 — SharedOutro brandé TOB (~3s) : image lion + URL.
          Picker seedé sur ticker+entryTimestamp pour cohérence entre
          re-renders. Démarre après la TransitionSeries (frame 518). */}
      <Sequence from={TRANSITION_SERIES_END} durationInFrames={SHARED_OUTRO_FRAMES}>
        <SharedOutro seed={`${ticker}-${entryTimestamp}`} />
      </Sequence>
    </AbsoluteFill>
  );
};
