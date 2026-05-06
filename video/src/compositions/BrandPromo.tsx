import { AbsoluteFill, Sequence } from 'remotion';
import { HookBeat } from '../components/HookBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={90}>
        <HookBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
