import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { Stinger } from '../components/Stinger';
import { LifestyleHook } from '../components/LifestyleHook';
import { ResultTease } from '../components/ResultTease';
import { TimePassAct } from '../components/TimePassAct';
import { ProofImageAct } from '../components/ProofImageAct';
import { ResultCta } from '../components/ResultCta';

export type BoomProofProps = {
  ticker: string;
  entryAuthor: string;
  entryMessage: string;
  entryTimestamp: string;
  exitAuthor: string;
  exitMessage: string;
  exitTimestamp: string;
  pnl: string;
  // Data URL (data:image/png;base64,...) de l'image canvas-rendered
  // entry+exit conversation. Optionnel : si null, ProofImageAct affiche
  // un placeholder "image unavailable".
  proofImageDataUrl?: string | null;
};

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

export const BoomProof = ({
  ticker, entryAuthor, entryMessage: _entryMessage, entryTimestamp,
  exitAuthor, exitMessage: _exitMessage, exitTimestamp, pnl,
  proofImageDataUrl,
}: BoomProofProps) => {
  // Caption pour la phase ProofImage : ticker + auteur(s) + pnl.
  // Si entry et exit même auteur (cas le + fréquent), simplifie en un seul nom.
  // entryAuthor / exitAuthor sont assumed déjà resolved en display name côté
  // bot via getDisplayName (canvas/utils/authors.js) avant l'enqueue.
  const proofCaption = entryAuthor === exitAuthor
    ? `$${ticker} · ${entryAuthor} · ${pnl}`
    : `$${ticker} · ${entryAuthor} → ${exitAuthor} · ${pnl}`;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === AUDIO === */}
      <Audio src={staticFile('audio/proof-track.mp3')} volume={0.55} />

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
          <LifestyleHook overlayText={pnl} seed={`${ticker}-${entryTimestamp}`} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 2 — Result tease (~2s) */}
        <TransitionSeries.Sequence durationInFrames={66}>
          <ResultTease ticker={ticker} pnl={pnl} author={entryAuthor} />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={slide({ direction: 'from-right' })}
          timing={linearTiming({ durationInFrames: SLIDE_FRAMES })}
        />

        {/* Phase 3 — Chart explosion (~3s) */}
        <TransitionSeries.Sequence durationInFrames={98}>
          <TimePassAct entryTimestamp={entryTimestamp} exitTimestamp={exitTimestamp} />
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
          />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: FADE_FRAMES })}
        />

        {/* Phase 5 — Result CTA + money rain (~3s) */}
        <TransitionSeries.Sequence durationInFrames={90}>
          <ResultCta pnl={pnl} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
