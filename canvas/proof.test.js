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
