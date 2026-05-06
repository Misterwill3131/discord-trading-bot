import { describe, expect, test } from 'vitest';
import { jobPropsToRemotion, buildCaption, formatTimeNY } from './render-worker';

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
});

describe('buildCaption', () => {
  test('formats with ticker, author, pnl, and time range', () => {
    const cap = buildCaption(sampleJob);
    expect(cap).toContain('$TSLA');
    expect(cap).toContain('Z');
    expect(cap).toContain('+20%');
    expect(cap).toContain('proof video');
    expect(cap).toContain('Entry');
    expect(cap).toContain('Exit');
  });
});

describe('formatTimeNY', () => {
  test('returns NY 24h time from ISO string', () => {
    // 2026-04-25T13:32:00-04:00 = 13:32 NY
    const t = formatTimeNY('2026-04-25T13:32:00-04:00');
    expect(t).toBe('13:32');
  });
});
