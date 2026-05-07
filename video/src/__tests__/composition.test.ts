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
    expect(comp.durationInFrames).toBe(540);
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
    expect(comp.durationInFrames).toBe(270);
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
      message: '$TSLA 150-155 entry long',
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

describe('SignalAlertProof composition', () => {
  test('is registered with correct dimensions and duration', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlertProof',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1920);
    expect(comp.fps).toBe(30);
    expect(comp.durationInFrames).toBe(518);
  });

  test('has default props with expected fields', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlertProof',
    });
    expect(comp.defaultProps).toMatchObject({
      ticker: 'TSLA',
      entryAuthor: 'Z',
      entryMessage: '$TSLA 150 entry long',
      exitAuthor: 'Z',
      exitMessage: '$TSLA out +20%',
      pnl: '+20%',
    });
  });

  test('accepts inputProps override without throwing', async () => {
    const comp = await selectComposition({
      serveUrl: bundleLocation,
      id: 'SignalAlertProof',
      inputProps: {
        ticker: 'NVDA',
        entryAuthor: 'Bora',
        entryMessage: '$NVDA 870 entry',
        entryTimestamp: '2026-04-25T13:30:00-04:00',
        exitAuthor: 'Bora',
        exitMessage: '$NVDA out +15%',
        exitTimestamp: '2026-04-25T15:00:00-04:00',
        pnl: '+15%',
      },
    });
    expect(comp.id).toBe('SignalAlertProof');
  });
});
