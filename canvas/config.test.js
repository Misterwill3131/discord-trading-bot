const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { CUSTOM_AVATARS } = require('./config');

test('CUSTOM_AVATARS["Protrader Alerts"] points to an existing PNG', () => {
  const p = CUSTOM_AVATARS['Protrader Alerts'];
  assert.ok(p, 'CUSTOM_AVATARS["Protrader Alerts"] is undefined — mapping is missing');
  assert.ok(p.endsWith('Protrader Alerts_avatar.png'),
    'Mapping should point to Protrader Alerts_avatar.png, got: ' + p);
  assert.ok(fs.existsSync(p),
    'Avatar file does not exist on disk: ' + p);
});
