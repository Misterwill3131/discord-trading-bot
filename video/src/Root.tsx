import { Composition } from 'remotion';
import { BrandPromo } from './compositions/BrandPromo';

export const Root = () => {
  return (
    <>
      <Composition
        id="BrandPromo"
        component={BrandPromo}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
