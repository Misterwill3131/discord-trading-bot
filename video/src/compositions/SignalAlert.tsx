import { AbsoluteFill } from 'remotion';

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

export const SignalAlert = (_props: SignalAlertProps) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }} />
  );
};
