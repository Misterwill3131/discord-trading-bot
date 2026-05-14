const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_WELCOME_TEMPLATE,
  applyTemplate,
  validateTemplate,
} = require('./welcome-template');

test('DEFAULT_WELCOME_TEMPLATE contains both placeholders', () => {
  assert.ok(DEFAULT_WELCOME_TEMPLATE.includes('{user}'));
  assert.ok(DEFAULT_WELCOME_TEMPLATE.includes('{start_here}'));
});

test('applyTemplate substitutes both placeholders', () => {
  const out = applyTemplate('{user} hi, see {start_here}', { userId: '1', startHereId: '2' });
  assert.strictEqual(out, '<@1> hi, see <#2>');
});

test('applyTemplate substitutes multiple occurrences of {user}', () => {
  const out = applyTemplate('{user} {user} {user}', { userId: '9', startHereId: '0' });
  assert.strictEqual(out, '<@9> <@9> <@9>');
});

test('applyTemplate leaves unknown {foo} placeholders unchanged', () => {
  const out = applyTemplate('{user} {foo} {bar}', { userId: '1', startHereId: '2' });
  assert.strictEqual(out, '<@1> {foo} {bar}');
});

test('applyTemplate on the default template produces today\'s exact wire format', () => {
  const out = applyTemplate(DEFAULT_WELCOME_TEMPLATE, { userId: '111', startHereId: '222' });
  assert.strictEqual(
    out,
    '<@111> welcome to TOB! Please start with <#222> and watch us for a week or so to get familiar with the discord.'
  );
});

test('validateTemplate accepts the default template', () => {
  assert.deepStrictEqual(validateTemplate(DEFAULT_WELCOME_TEMPLATE), { ok: true });
});

test('validateTemplate rejects empty string', () => {
  const r = validateTemplate('');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /empty|vide/i);
});

test('validateTemplate rejects whitespace-only string', () => {
  const r = validateTemplate('   \n\t  ');
  assert.strictEqual(r.ok, false);
});

test('validateTemplate rejects template without {user}', () => {
  const r = validateTemplate('Hello and welcome! See {start_here} for more.');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /\{user\}/);
});

test('validateTemplate accepts template without {start_here}', () => {
  assert.deepStrictEqual(validateTemplate('{user} hi there!'), { ok: true });
});

test('validateTemplate rejects text > 2000 chars', () => {
  const long = '{user} ' + 'x'.repeat(2000);
  const r = validateTemplate(long);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /2000/);
});

test('validateTemplate rejects non-string input', () => {
  assert.strictEqual(validateTemplate(null).ok, false);
  assert.strictEqual(validateTemplate(undefined).ok, false);
  assert.strictEqual(validateTemplate(42).ok, false);
  assert.strictEqual(validateTemplate({}).ok, false);
});

// ─────────────────────────────────────────────────────────────────────
// DB-backed persistence tests (Task 2)
// ─────────────────────────────────────────────────────────────────────

const { getEffectiveTemplate, setTemplate, resetTemplate, SETTING_KEY } = require('./welcome-template');
const db = require('../db/sqlite');

// Helper: reset state before each persistence test.
function resetSetting() {
  db.setSetting(SETTING_KEY, null);
}

test('SETTING_KEY is "welcome_message_template"', () => {
  assert.strictEqual(SETTING_KEY, 'welcome_message_template');
});

test('getEffectiveTemplate returns the default when setting is absent', () => {
  resetSetting();
  const r = getEffectiveTemplate();
  assert.strictEqual(r.template, DEFAULT_WELCOME_TEMPLATE);
  assert.strictEqual(r.isDefault, true);
});

test('setTemplate writes and getEffectiveTemplate reads it back as override', () => {
  resetSetting();
  setTemplate('{user} hello world!');
  const r = getEffectiveTemplate();
  assert.strictEqual(r.template, '{user} hello world!');
  assert.strictEqual(r.isDefault, false);
});

test('setTemplate throws on invalid input (missing {user})', () => {
  resetSetting();
  assert.throws(() => setTemplate('Bonjour sans placeholder'), /\{user\}/);
});

test('setTemplate throws on empty input', () => {
  resetSetting();
  assert.throws(() => setTemplate(''), /vide/i);
});

test('resetTemplate clears the override and getEffectiveTemplate returns the default again', () => {
  resetSetting();
  setTemplate('{user} override here');
  assert.strictEqual(getEffectiveTemplate().isDefault, false);
  resetTemplate();
  const r = getEffectiveTemplate();
  assert.strictEqual(r.template, DEFAULT_WELCOME_TEMPLATE);
  assert.strictEqual(r.isDefault, true);
});

test('getEffectiveTemplate treats null/empty stored value as missing (fallback to default)', () => {
  resetSetting();
  // Direct DB write of null and empty to simulate edge cases
  db.setSetting(SETTING_KEY, null);
  assert.strictEqual(getEffectiveTemplate().isDefault, true);
  db.setSetting(SETTING_KEY, '');
  assert.strictEqual(getEffectiveTemplate().isDefault, true);
});

// Cleanup after this file's tests so we don't leave state for other test files.
test('cleanup: reset setting', () => {
  resetSetting();
});
