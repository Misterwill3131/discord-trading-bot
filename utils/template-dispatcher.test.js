const { test } = require('node:test');
const assert = require('node:assert');
const { pickTemplate, parsePnlToNumber } = require('./template-dispatcher');

test('parsePnlToNumber: positifs', () => {
  assert.strictEqual(parsePnlToNumber('+20%'), 20);
  assert.strictEqual(parsePnlToNumber('+85%'), 85);
  assert.strictEqual(parsePnlToNumber('+85.5%'), 85.5);
  assert.strictEqual(parsePnlToNumber('20%'), 20);
});

test('parsePnlToNumber: négatifs', () => {
  assert.strictEqual(parsePnlToNumber('-5%'), -5);
  assert.strictEqual(parsePnlToNumber('-12.3%'), -12.3);
});

test('parsePnlToNumber: invalid', () => {
  assert.ok(Number.isNaN(parsePnlToNumber('')));
  assert.ok(Number.isNaN(parsePnlToNumber(null)));
  assert.ok(Number.isNaN(parsePnlToNumber('invalid')));
  assert.ok(Number.isNaN(parsePnlToNumber('20'))); // pas de %
});

test('pickTemplate: <50% → classic-green', () => {
  assert.strictEqual(pickTemplate({ pnl: '+20%' }), 'classic-green');
  assert.strictEqual(pickTemplate({ pnl: '+49.9%' }), 'classic-green');
  assert.strictEqual(pickTemplate({ pnl: '+5%' }), 'classic-green');
});

test('pickTemplate: >=50% → gold-celebration', () => {
  assert.strictEqual(pickTemplate({ pnl: '+50%' }), 'gold-celebration');
  assert.strictEqual(pickTemplate({ pnl: '+85%' }), 'gold-celebration');
  assert.strictEqual(pickTemplate({ pnl: '+115%' }), 'gold-celebration');
});

test('pickTemplate: pnl invalid → fallback classic-green', () => {
  assert.strictEqual(pickTemplate({ pnl: '' }), 'classic-green');
  assert.strictEqual(pickTemplate({ pnl: null }), 'classic-green');
  assert.strictEqual(pickTemplate({}), 'classic-green');
});
