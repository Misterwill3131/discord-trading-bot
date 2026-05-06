import { AbsoluteFill, Sequence } from 'remotion';
import { RevealAct } from '../components/RevealAct';

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

export const SignalAlert = ({ ticker }: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={60}>
        <RevealAct ticker={ticker} />
      </Sequence>
    </AbsoluteFill>
  );
};
