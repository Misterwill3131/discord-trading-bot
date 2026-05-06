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

describe('SignalAlert composition', () => {
  test('is registered with correct dimensions and duration', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlert',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(30);
    expect(comp.durationInFrames).toBe(180);
  });

  test('has default props with expected fields', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlert',
    });
    expect(comp.defaultProps).toMatchObject({
      ticker: 'TSLA',
      type: 'entry',
      direction: 'long',
      entry: '150-155',
      target: '165',
      stop: '148',
      author: 'Z',
    });
  });

  test('accepts inputProps override without throwing', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlert',
      inputProps: {
        ticker: 'NVDA',
        author: 'Bora',
        type: 'entry',
        direction: 'long',
        entry: '870',
      },
    });
    expect(comp.id).toBe('SignalAlert');
  });
});
