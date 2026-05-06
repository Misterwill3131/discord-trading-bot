import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';
import { SignalAlert, SignalAlertProps } from './compositions/SignalAlert';

const signalAlertDefaults: SignalAlertProps = {
  ticker: 'TSLA',
  type: 'entry',
  direction: 'long',
  entry: '150-155',
  target: '165',
  stop: '148',
  author: 'Z',
  message: '$TSLA 150-155 entry long',
  timestamp: '2026-04-25T13:32:00-04:00',
};

export const Root = () => {
  return (
    <>
      <Composition
        id="BrandPromo"
        component={BrandPromo}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="SignalAlert"
        component={SignalAlert}
        durationInFrames={270}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={signalAlertDefaults}
      />
    </>
  );
};
