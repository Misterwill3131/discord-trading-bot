import { afterAll, describe, expect, test } from 'vitest';
import { jobPropsToRemotion, buildCaption, formatTimeNY, loadTemplateProps, prepareRecapAlertImages } from './render-worker';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sampleJob = {
  id: 42,
  ticker: 'TSLA',
  entryAuthor: 'Z',
  entryMessage: '$TSLA 150 entry long',
  entryTimestamp: '2026-04-25T13:32:00-04:00',
  exitAuthor: 'Z',
  exitMessage: '$TSLA out +20%',
  exitTimestamp: '2026-04-25T16:30:00-04:00',
  pnl: '+20%',
};

describe('jobPropsToRemotion', () => {
  test('passes all 8 fields through', () => {
    const props = jobPropsToRemotion(sampleJob);
    expect(props.ticker).toBe('TSLA');
    expect(props.entryAuthor).toBe('Z');
    expect(props.entryMessage).toBe('$TSLA 150 entry long');
    expect(props.entryTimestamp).toBe('2026-04-25T13:32:00-04:00');
    expect(props.exitAuthor).toBe('Z');
    expect(props.exitMessage).toBe('$TSLA out +20%');
    expect(props.exitTimestamp).toBe('2026-04-25T16:30:00-04:00');
    expect(props.pnl).toBe('+20%');
  });

  test('does not include id', () => {
    const props = jobPropsToRemotion(sampleJob) as Record<string, unknown>;
    expect(props.id).toBeUndefined();
  });

  test('proofImageDataUrl is null when proofImageBase64 absent', () => {
    const props = jobPropsToRemotion(sampleJob);
    expect(props.proofImageDataUrl).toBeNull();
  });

  test('proofImageDataUrl is data URL when proofImageBase64 present', () => {
    const props = jobPropsToRemotion({
      ...sampleJob,
      proofImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });
    expect(props.proofImageDataUrl).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    );
  });
});

describe('buildCaption', () => {
  test('formats with ticker, author, pnl, and time range (ChartTemplate default)', () => {
    const cap = buildCaption(sampleJob);
    expect(cap).toContain('$TSLA');
    expect(cap).toContain('Z');
    expect(cap).toContain('+20%');
    expect(cap).toContain('chart template');
    expect(cap).toContain('Entry');
    expect(cap).toContain('Exit');
  });

  test('TobTradeRecap caption mentions trade + long-term counts', () => {
    const job = {
      ...sampleJob,
      composition: 'TobTradeRecap',
      pnl: 'TODAY',
      recap_data: JSON.stringify({
        dateLabel: 'TODAY',
        trades: Array.from({ length: 7 }, () => ({ ticker: '$X', entryPrice: 1, hodPrice: 2 })),
        longTermInvestments: [{ ticker: '$DXYZ', entryPrice: 30, currentPrice: 71 }],
      }),
    };
    const cap = buildCaption(job);
    expect(cap).toContain('TOB Trade Recap');
    expect(cap).toContain('TODAY');
    expect(cap).toContain('7 trades');
    expect(cap).toContain('1 long-term');
  });

  test('TobTradeRecap caption stays usable when recap_data missing', () => {
    const job = { ...sampleJob, composition: 'TobTradeRecap', pnl: 'TODAY' };
    const cap = buildCaption(job);
    expect(cap).toContain('TOB Trade Recap');
    expect(cap).toContain('0 trades');
  });
});

describe('formatTimeNY', () => {
  test('returns NY 24h time from ISO string', () => {
    // 2026-04-25T13:32:00-04:00 = 13:32 NY
    const t = formatTimeNY('2026-04-25T13:32:00-04:00');
    expect(t).toBe('13:32');
  });
});

describe('loadTemplateProps', () => {
  test('null/undefined name → null', () => {
    expect(loadTemplateProps(null)).toBeNull();
    expect(loadTemplateProps(undefined)).toBeNull();
    expect(loadTemplateProps('')).toBeNull();
  });

  test('charge classic-green template', () => {
    const props = loadTemplateProps('classic-green');
    expect(props).not.toBeNull();
    expect(props?.accentColor).toBe('#10b981');
    expect(props?.musicVolume).toBe(0.55);
  });

  test('charge gold-celebration template', () => {
    const props = loadTemplateProps('gold-celebration');
    expect(props).not.toBeNull();
    expect(props?.accentColor).toBe('#fbbf24');
  });

  test('template inexistant → null + warn', () => {
    expect(loadTemplateProps('nonexistent-template')).toBeNull();
  });
});

describe('jobPropsToRemotion TobTradeRecap', () => {
  test('parses recap_data into trades + longTermInvestments + alertImages', () => {
    const job = {
      ...sampleJob,
      composition: 'TobTradeRecap',
      recap_data: JSON.stringify({
        dateLabel: 'TODAY',
        trades: [{ ticker: '$RVI', entryPrice: 1, hodPrice: 1.5 }],
        longTermInvestments: [
          { ticker: '$DXYZ', entryPrice: 30, currentPrice: 71 },
          { ticker: '$REA',  entryPrice: 1.21, currentPrice: 1.91 },
        ],
      }),
      preparedAlertImages: [{ imagePath: 'recap-alerts/alert-1.png', ticker: '$RVI' }],
    } as any;
    const props = jobPropsToRemotion(job) as Record<string, any>;
    expect(props.dateLabel).toBe('TODAY');
    expect(props.trades).toHaveLength(1);
    expect(props.longTermInvestments).toHaveLength(2);
    expect(props.longTermInvestments[0].ticker).toBe('$DXYZ');
    expect(props.alertImages).toHaveLength(1);
    expect(props.alertImages[0].imagePath).toBe('recap-alerts/alert-1.png');
  });

  test('handles missing longTermInvestments by defaulting to []', () => {
    const job = {
      ...sampleJob,
      composition: 'TobTradeRecap',
      recap_data: JSON.stringify({
        dateLabel: 'TODAY',
        trades: [{ ticker: '$X', entryPrice: 1, hodPrice: 2 }],
      }),
    } as any;
    const props = jobPropsToRemotion(job) as Record<string, any>;
    expect(props.longTermInvestments).toEqual([]);
    expect(props.alertImages).toEqual([]);
  });

  test('falls back to template-only props if recap_data is invalid JSON', () => {
    const job = {
      ...sampleJob,
      composition: 'TobTradeRecap',
      recap_data: 'not-json',
    } as any;
    const props = jobPropsToRemotion(job) as Record<string, any>;
    // No throw — we get an object back
    expect(props).toBeDefined();
  });
});

describe('prepareRecapAlertImages', () => {
  // Tmp dir isolé pour éviter de polluer video/public/recap-alerts/ (les
  // fixtures dev y vivent et sont check-in dans git).
  const tmpDir = path.join(__dirname, '..', '..', 'tmp', `recap-alerts-test-${process.pid}`);

  test('returns [] for null/empty/invalid recap_data', () => {
    expect(prepareRecapAlertImages(null, { publicDir: tmpDir })).toEqual([]);
    expect(prepareRecapAlertImages(undefined, { publicDir: tmpDir })).toEqual([]);
    expect(prepareRecapAlertImages('', { publicDir: tmpDir })).toEqual([]);
    expect(prepareRecapAlertImages('not-json', { publicDir: tmpDir })).toEqual([]);
    expect(prepareRecapAlertImages(JSON.stringify({}), { publicDir: tmpDir })).toEqual([]);
    expect(prepareRecapAlertImages(JSON.stringify({ alertImagesBase64: [] }), { publicDir: tmpDir })).toEqual([]);
  });

  test('writes PNGs and returns staticFile paths', () => {
    const png = Buffer.from('FAKE_PNG_BYTES').toString('base64');
    const result = prepareRecapAlertImages(JSON.stringify({
      alertImagesBase64: [
        { base64: png, ticker: '$RVI' },
        { base64: png, ticker: '$REA' },
      ],
    }), { publicDir: tmpDir });
    expect(result).toHaveLength(2);
    expect(result[0].imagePath).toBe('recap-alerts/alert-1.png');
    expect(result[1].imagePath).toBe('recap-alerts/alert-2.png');
    expect(result[0].ticker).toBe('$RVI');
    // Verify file exists and decodes correctly
    const onDisk = fs.readFileSync(path.join(tmpDir, 'alert-1.png'));
    expect(onDisk.toString()).toBe('FAKE_PNG_BYTES');
  });

  test('skips entries with missing/invalid base64', () => {
    const result = prepareRecapAlertImages(JSON.stringify({
      alertImagesBase64: [
        { base64: '', ticker: '$A' },
        { base64: Buffer.from('OK').toString('base64'), ticker: '$B' },
        { ticker: '$C' },
      ],
    }), { publicDir: tmpDir });
    expect(result).toHaveLength(1);
    expect(result[0].ticker).toBe('$B');
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});

describe('jobPropsToRemotion template merging', () => {
  test('templateName=null → comportement comme avant', () => {
    const props = jobPropsToRemotion({ ...sampleJob, templateName: null });
    expect(props.ticker).toBe('TSLA');
    expect((props as Record<string, unknown>).accentColor).toBeUndefined();
  });

  test('templateName=classic-green → merge avec template props', () => {
    const props = jobPropsToRemotion({ ...sampleJob, templateName: 'classic-green' });
    // Job props (override)
    expect(props.ticker).toBe('TSLA');
    expect(props.pnl).toBe('+20%');
    // Template props (base)
    expect((props as Record<string, unknown>).accentColor).toBe('#10b981');
    expect((props as Record<string, unknown>).musicVolume).toBe(0.55);
  });

  test('job props override template props pour les champs partagés', () => {
    // ticker dans le template (TSLA) et job (TSLA) — même valeur, OK.
    // Mais entryAuthor dans le template ('Z') vs job ('Z') — job gagne quoi qu'il en soit.
    const props = jobPropsToRemotion({
      ...sampleJob,
      ticker: 'NVDA',
      templateName: 'classic-green',
    });
    expect(props.ticker).toBe('NVDA'); // job wins over template's TSLA
  });
});
