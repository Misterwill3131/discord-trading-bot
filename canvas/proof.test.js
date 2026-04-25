const { test } = require('node:test');
const assert = require('node:assert');

const { parseRichSegments } = require('./proof');

test('parseRichSegments reconnaît un role mention isolé', () => {
  const segs = parseRichSegments('<@&12345>');
  assert.deepStrictEqual(segs, [
    { type: 'roleMention', id: '12345' },
  ]);
});

test('parseRichSegments mixe text + roleMention + text + emoji', () => {
  const segs = parseRichSegments('hi <@&12345> bye <:emo:67>');
  assert.deepStrictEqual(segs, [
    { type: 'text', value: 'hi ' },
    { type: 'roleMention', id: '12345' },
    { type: 'text', value: ' bye ' },
    { type: 'emoji', name: 'emo', id: '67', animated: false },
  ]);
});

const { hexToRgba, getRoleStyle, generateImage } = require('./proof');

test('hexToRgba convertit #3498db avec opacity 0.18', () => {
  assert.strictEqual(hexToRgba('#3498db', 0.18), 'rgba(52, 152, 219, 0.18)');
});

test('getRoleStyle retourne le rôle pour un id connu', () => {
  const r = getRoleStyle('1497256488274624565');
  assert.deepStrictEqual(r, { name: 'Swing', color: '#3498db' });
});

test('getRoleStyle retourne null pour un id inconnu', () => {
  assert.strictEqual(getRoleStyle('999999999999999999'), null);
});

test('generateImage produit un Buffer PNG quand le contenu inclut une role mention', async () => {
  const buf = await generateImage('Bora', 'check this <@&1497256488274624565> setup', new Date().toISOString());
  assert.ok(Buffer.isBuffer(buf), 'expected a Buffer');
  assert.ok(buf.length > 100, 'expected non-trivial PNG, got ' + buf.length + ' bytes');
});
