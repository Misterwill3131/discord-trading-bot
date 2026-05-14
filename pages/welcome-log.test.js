const { test } = require('node:test');
const assert = require('node:assert');
const { renderWelcomeLogPage } = require('./welcome-log');

test('renderWelcomeLogPage with empty array includes empty-state text', () => {
  const html = renderWelcomeLogPage([]);
  assert.ok(html.includes('Aucun événement'), 'should mention empty state in French');
  assert.ok(html.includes('<table'), 'should still include the table skeleton');
});

test('renderWelcomeLogPage includes username and type for each entry', () => {
  const entries = [
    { ts: '2026-05-14T12:00:00.000Z', type: 'sent', userId: '111', username: 'Alice#0001', detail: null },
    { ts: '2026-05-14T12:01:00.000Z', type: 'error-send', userId: '222', username: 'Bob#0002', detail: 'Missing Permissions' },
  ];
  const html = renderWelcomeLogPage(entries);
  assert.ok(html.includes('Alice#0001'), 'should include first username');
  assert.ok(html.includes('Bob#0002'), 'should include second username');
  assert.ok(html.includes('sent'), 'should include "sent" type');
  assert.ok(html.includes('error-send'), 'should include "error-send" type');
  assert.ok(html.includes('Missing Permissions'), 'should include error detail');
});

test('renderWelcomeLogPage escapes HTML in user-controlled fields', () => {
  const entries = [
    { ts: '2026-05-14T12:00:00.000Z', type: 'error-send', userId: '1', username: '<script>x</script>', detail: '<img src=x>' },
  ];
  const html = renderWelcomeLogPage(entries);
  assert.ok(!html.includes('<script>x</script>'), 'should not emit raw <script>');
  assert.ok(!html.includes('<img src=x>'), 'should not emit raw <img>');
  assert.ok(html.includes('&lt;script&gt;'), 'should HTML-escape <script>');
});

test('renderWelcomeLogPage handles null username gracefully (config-missing entries)', () => {
  const entries = [
    { ts: '2026-05-14T12:00:00.000Z', type: 'config-missing', userId: null, username: null, detail: 'TOB_WELCOME_GUILD_ID' },
  ];
  const html = renderWelcomeLogPage(entries);
  assert.ok(html.includes('config-missing'));
  assert.ok(html.includes('TOB_WELCOME_GUILD_ID'));
  // Should not throw, should produce a valid row
  assert.ok(html.includes('<tr'));
});
