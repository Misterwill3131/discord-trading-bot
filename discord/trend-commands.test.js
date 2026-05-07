const { test } = require('node:test');
const assert = require('node:assert');
const { parseTrustedUsers } = require('./trend-commands');

test('parseTrustedUsers returns empty Set for undefined / null / empty', () => {
  assert.strictEqual(parseTrustedUsers(undefined).size, 0);
  assert.strictEqual(parseTrustedUsers(null).size, 0);
  assert.strictEqual(parseTrustedUsers('').size, 0);
});

test('parseTrustedUsers parses one valid pair', () => {
  const set = parseTrustedUsers('1105966537648652310:955585699250331698');
  assert.strictEqual(set.size, 1);
  assert.ok(set.has('1105966537648652310:955585699250331698'));
});

test('parseTrustedUsers parses multiple pairs separated by comma', () => {
  const set = parseTrustedUsers('1105966537648652310:955585699250331698, 999999999999999999:111111111111111111');
  assert.strictEqual(set.size, 2);
  assert.ok(set.has('1105966537648652310:955585699250331698'));
  assert.ok(set.has('999999999999999999:111111111111111111'));
});

test('parseTrustedUsers ignores malformed entries (non-snowflakes, missing colon, etc.)', () => {
  const set = parseTrustedUsers('valid:111,not-a-pair,123:abc,456:789,extra:trail');
  // Only `123:abc` (alpha userId) gets rejected; `valid:111` (alpha guild) too;
  // `not-a-pair` no colon; `extra:trail` alpha. Only `456:789` survives.
  assert.strictEqual(set.size, 1);
  assert.ok(set.has('456:789'));
});

test('parseTrustedUsers trims whitespace around entries', () => {
  const set = parseTrustedUsers('  111:222  ,  333:444  ');
  assert.strictEqual(set.size, 2);
  assert.ok(set.has('111:222'));
  assert.ok(set.has('333:444'));
});

test('parseTrustedUsers handles trailing comma gracefully', () => {
  const set = parseTrustedUsers('111:222,');
  assert.strictEqual(set.size, 1);
  assert.ok(set.has('111:222'));
});
