import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
import { LifestyleHook } from '../components/LifestyleHook';
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
  message: string;            // NEW
  timestamp: string;
};

export const SignalAlert = ({ ticker, author, message, timestamp }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/signal-track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/signal-track.mp3')} /> */}

      <Sequence from={0} durationInFrames={90}>
        <LifestyleHook overlayText={`$${ticker}`} />
      </Sequence>
      <Sequence from={90} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
      <Sequence from={150} durationInFrames={90}>
        <DataAct author={author} message={message} timestamp={timestamp} />
      </Sequence>
      <Sequence from={240} durationInFrames={30}>
        <CtaAct />
      </Sequence>
    </AbsoluteFill>
  );
};
