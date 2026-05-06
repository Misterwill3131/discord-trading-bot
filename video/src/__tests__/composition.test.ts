import { describe, expect, test, beforeAll } from 'vitest';
import { bundle } from '@remotion/bundler';
import { selectComposition } from '@remotion/renderer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let bundleLocation: string;

beforeAll(async () => {
  bundleLocation = await bundle({
    entryPoint: path.join(__dirname, '..', 'index.ts'),
  });
});

describe('BrandPromo composition', () => {
  test('is registered with correct dimensions and duration', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'BrandPromo',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(30);
    expect(comp.durationInFrames).toBe(450);
  });
});
