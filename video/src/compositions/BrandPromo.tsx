import { AbsoluteFill, Sequence } from 'remotion';
import { HookBeat } from '../components/HookBeat';
import { ValueBeat } from '../components/ValueBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={90}>
        <HookBeat />
      </Sequence>
      <Sequence from={90} durationInFrames={240}>
        <ValueBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
