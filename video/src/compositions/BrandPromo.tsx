import { AbsoluteFill, Sequence } from 'remotion';
// import { Audio, staticFile } from 'remotion';
import { HookBeat } from '../components/HookBeat';
import { ValueBeat } from '../components/ValueBeat';
import { CtaBeat } from '../components/CtaBeat';

export const BrandPromo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/*
        Pour activer une piste audio :
        1. Dépose un MP3 dans video/public/audio/track.mp3
        2. Décommente l'import Audio + staticFile en haut
        3. Décommente la balise <Audio> ci-dessous
      */}
      {/* <Audio src={staticFile('audio/track.mp3')} /> */}

      <Sequence from={0} durationInFrames={90}>
        <HookBeat />
      </Sequence>
      <Sequence from={90} durationInFrames={240}>
        <ValueBeat />
      </Sequence>
      <Sequence from={330} durationInFrames={120}>
        <CtaBeat />
      </Sequence>
    </AbsoluteFill>
  );
};
