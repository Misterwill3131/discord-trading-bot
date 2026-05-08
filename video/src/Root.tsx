import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';
import { SignalAlert, SignalAlertProps } from './compositions/SignalAlert';
import { BoomProof, boomProofSchema } from './compositions/BoomProof';
import { BoomEntry, boomEntrySchema } from './compositions/BoomEntry';

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

const boomProofDefaults = {
  ticker: 'TSLA',
  entryAuthor: 'Z',
  entryMessage: '$TSLA 150 entry long',
  entryTimestamp: '2026-04-25T13:32:00-04:00',
  exitAuthor: 'Z',
  exitMessage: '$TSLA out +20%',
  exitTimestamp: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
  proofImageDataUrl: null,
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
      <Composition
        id="BoomProof"
        component={BoomProof}
        durationInFrames={518}
        fps={30}
        width={1080}
        height={1920}
        schema={boomProofSchema}
        defaultProps={boomProofDefaults}
      />
      <Composition
        id="BoomEntry"
        component={BoomEntry}
        durationInFrames={376}
        fps={30}
        width={1080}
        height={1920}
        schema={boomEntrySchema}
        defaultProps={{
          ticker: 'TSLA',
          author: 'Z',
          message: '$TSLA 150-155 entry long',
          timestamp: '2026-04-25T13:32:00-04:00',
          entryImageDataUrl: null,
        }}
      />
    </>
  );
};
