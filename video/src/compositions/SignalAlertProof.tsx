import { AbsoluteFill } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
// import { Audio, staticFile } from 'remotion';
import { LifestyleHook } from '../components/LifestyleHook';
import { ResultTease } from '../components/ResultTease';
import { DiscordCard } from '../components/DiscordCard';
import { TimePassAct } from '../components/TimePassAct';
import { ResultCta } from '../components/ResultCta';

export type SignalAlertProofProps = {
  ticker: string;
  entryAuthor: string;
  entryMessage: string;
  entryTimestamp: string;
  exitAuthor: string;
  exitMessage: string;
  exitTimestamp: string;
  pnl: string;
};

// Transitions courtes (~0.2s) entre chaque phase pour fluidité sans ralentir.
// Note : les durations des Sequences sont gonflées de la durée des transitions
// adjacentes pour préserver le timing visuel d'origine. Le Total composition
// reste 510 frames car TransitionSeries fait overlapper les sequences sur la
// durée des transitions.
//
// Math : 96+66+98+98+96+90 = 544 frames de Sequences
// Transitions : 3×6 + 2×8 = 34 frames d'overlap
// Total visible : 544 - 34 = 510 ✓
const FADE_FRAMES = 6;
const SLIDE_FRAMES = 8;

export const SignalAlertProof = ({
  ticker, entryAuthor, entryMessage, entryTimestamp,
  exitAuthor, exitMessage, exitTimestamp, pnl,
}: SignalAlertProofProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/proof-track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/proof-track.mp3')} /> */}

      <TransitionSeries>
        {/* Phase 1 — Lifestyle hook (0-3s, +0.2s pour overlap fade) */}
        <TransitionSeries.Sequence durationInFrames={96}>
          <LifestyleHook overlayText={pnl} seed={`${ticker}-${entryTimestamp}`} />
        </TransitionSeries.Sequence>

        {/* Cross-fade vers le tease */}
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 2 — Result tease (3-5s, +0.2s pour overlap fade) */}
        <TransitionSeries.Sequence durationInFrames={66}>
          <ResultTease ticker={ticker} pnl={pnl} author={entryAuthor} />
        </TransitionSeries.Sequence>

        {/* Cross-fade vers la entry card */}
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 3 — Entry card (5-8s, +0.27s pour overlap slide) */}
        <TransitionSeries.Sequence durationInFrames={98}>
          <DiscordCard
            author={entryAuthor}
            message={entryMessage}
            timestamp={entryTimestamp}
            position="center"
          />
        </TransitionSeries.Sequence>

        {/* Slide-left vers le time pass (sens du temps) */}
        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: SLIDE_FRAMES })}
        />

        {/* Phase 4 — Time pass + chart (8-11s, +0.27s pour overlap slide) */}
        <TransitionSeries.Sequence durationInFrames={98}>
          <TimePassAct entryTimestamp={entryTimestamp} exitTimestamp={exitTimestamp} />
        </TransitionSeries.Sequence>

        {/* Slide-left vers la exit card (continuité temporelle) */}
        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: SLIDE_FRAMES })}
        />

        {/* Phase 5 — Exit card (11-14s, +0.2s pour overlap fade) */}
        <TransitionSeries.Sequence durationInFrames={96}>
          <DiscordCard
            author={exitAuthor}
            message={exitMessage}
            timestamp={exitTimestamp}
            position="center"
          />
        </TransitionSeries.Sequence>

        {/* Cross-fade vers le CTA final */}
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 6 — Result + CTA (14-17s) */}
        <TransitionSeries.Sequence durationInFrames={90}>
          <ResultCta pnl={pnl} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
