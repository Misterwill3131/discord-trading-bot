import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
import { RevealAct } from '../components/RevealAct';
import { DataAct } from '../components/DataAct';
import { CtaAct } from '../components/CtaAct';

export type SignalAlertProps = {
  ticker: string;
  type: 'entry' | 'exit';
  direction?: 'long' | 'short';
  entry?: string;
  target?: string;
  stop?: string;
  pnl?: string;
  author: string;
};

export const SignalAlert = ({ ticker, type, direction, entry, target, stop, pnl, author }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/signal-track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/signal-track.mp3')} /> */}

      <Sequence from={0} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
      <Sequence from={60} durationInFrames={90}>
        <DataAct
          type={type}
          direction={direction}
          entry={entry}
          target={target}
          stop={stop}
          pnl={pnl}
          author={author}
        />
      </Sequence>
      <Sequence from={150} durationInFrames={30}>
        <CtaAct />
      </Sequence>
    </AbsoluteFill>
  );
};
