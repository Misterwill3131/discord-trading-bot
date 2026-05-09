const { test } = require('node:test');
const assert = require('node:assert');

const { pickTease, pickContext, parsePnlNumeric, hashSeed } = require('./pick-tease');

// ─── parsePnlNumeric ──────────────────────────────────────────────
test('parsePnlNumeric extracts +30 from "+30%"', () => {
  assert.strictEqual(parsePnlNumeric('+30%'), 30);
});

test('parsePnlNumeric extracts -5 from "-5%"', () => {
  assert.strictEqual(parsePnlNumeric('-5%'), -5);
});

test('parsePnlNumeric handles decimals', () => {
  assert.strictEqual(parsePnlNumeric('+12.5%'), 12.5);
});

test('parsePnlNumeric returns null for null/undefined/empty', () => {
  assert.strictEqual(parsePnlNumeric(null), null);
  assert.strictEqual(parsePnlNumeric(undefined), null);
  assert.strictEqual(parsePnlNumeric(''), null);
});

test('parsePnlNumeric returns null for unparsable string', () => {
  assert.strictEqual(parsePnlNumeric('garbage'), null);
});

// ─── pickContext ──────────────────────────────────────────────────
test('pickContext returns "entry" for type=signal', () => {
  assert.strictEqual(pickContext({ type: 'signal' }), 'entry');
});

test('pickContext returns "entry" for type=entry', () => {
  assert.strictEqual(pickContext({ type: 'entry' }), 'entry');
});

test('pickContext returns "exit-win-small" for type=proof, pnl=+30%', () => {
  assert.strictEqual(pickContext({ type: 'proof', pnl: '+30%' }), 'exit-win-small');
});

test('pickContext returns "exit-win-big" for type=proof, pnl=+50% (boundary)', () => {
  assert.strictEqual(pickContext({ type: 'proof', pnl: '+50%' }), 'exit-win-big');
});

test('pickContext returns "exit-win-big" for type=proof, pnl=+200%', () => {
  assert.strictEqual(pickContext({ type: 'proof', pnl: '+200%' }), 'exit-win-big');
});

test('pickContext returns null for type=recap', () => {
  assert.strictEqual(pickContext({ type: 'recap' }), null);
});

// ─── hashSeed ────────────────────────────────────────────────────
test('hashSeed produces deterministic non-negative integers', () => {
  const a = hashSeed('foo');
  const b = hashSeed('foo');
  assert.strictEqual(a, b);
  assert.ok(a >= 0);
});

test('hashSeed produces different hashes for different strings', () => {
  assert.notStrictEqual(hashSeed('foo'), hashSeed('bar'));
});

// ─── pickTease ────────────────────────────────────────────────────
test('pickTease returns object with teaseAction/teaseSubtext/context', () => {
  const result = pickTease({ type: 'proof', pnl: '+30%', seed: 'TSLA-1' });
  assert.ok(result);
  assert.ok(typeof result.teaseAction === 'string' && result.teaseAction.length > 0);
  assert.ok(typeof result.teaseSubtext === 'string' && result.teaseSubtext.length > 0);
  assert.strictEqual(result.context, 'exit-win-small');
});

test('pickTease seed determinism : same seed → same tease', () => {
  const a = pickTease({ type: 'proof', pnl: '+30%', seed: 'TSLA-1' });
  const b = pickTease({ type: 'proof', pnl: '+30%', seed: 'TSLA-1' });
  assert.deepStrictEqual(a, b);
});

test('pickTease big win uses exit-win-big context', () => {
  const result = pickTease({ type: 'proof', pnl: '+150%', seed: 'TSLA-1' });
  assert.strictEqual(result.context, 'exit-win-big');
});

test('pickTease entry context for signal type', () => {
  const result = pickTease({ type: 'signal', pnl: '+0%', seed: 'TSLA-1' });
  assert.strictEqual(result.context, 'entry');
});

test('pickTease returns null for recap type', () => {
  const result = pickTease({ type: 'recap', pnl: '+1000%', seed: 'recap-1' });
  assert.strictEqual(result, null);
});
