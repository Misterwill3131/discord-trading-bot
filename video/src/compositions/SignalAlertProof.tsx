import { AbsoluteFill, Sequence } from 'remotion';
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

      {/* Phase 1 — Lifestyle hook (0-3s) */}
      <Sequence from={0} durationInFrames={90}>
        <LifestyleHook overlayText={pnl} />
      </Sequence>

      {/* Phase 2 — Result tease (3-5s) */}
      <Sequence from={90} durationInFrames={60}>
        <ResultTease ticker={ticker} pnl={pnl} author={entryAuthor} />
      </Sequence>

      {/* Phase 3 — Entry card (5-8s) */}
      <Sequence from={150} durationInFrames={90}>
        <DiscordCard
          author={entryAuthor}
          message={entryMessage}
          timestamp={entryTimestamp}
          position="center"
        />
      </Sequence>

      {/* Phase 4 — Time pass + chart (8-11s) */}
      <Sequence from={240} durationInFrames={90}>
        <TimePassAct entryTimestamp={entryTimestamp} exitTimestamp={exitTimestamp} />
      </Sequence>

      {/* Phase 5 — Exit card (11-14s) */}
      <Sequence from={330} durationInFrames={90}>
        <DiscordCard
          author={exitAuthor}
          message={exitMessage}
          timestamp={exitTimestamp}
          position="center"
        />
      </Sequence>

      {/* Phase 6 — Result + CTA (14-17s) */}
      <Sequence from={420} durationInFrames={90}>
        <ResultCta pnl={pnl} />
      </Sequence>
    </AbsoluteFill>
  );
};
