import { AbsoluteFill, Sequence } from 'remotion';
import { RevealAct } from '../components/RevealAct';
import { DataAct } from '../components/DataAct';

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
    </AbsoluteFill>
  );
};
