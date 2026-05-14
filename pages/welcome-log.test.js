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

test('renderWelcomeLogPage pre-fills textarea with the provided template', () => {
  const tpl = { template: '{user} bonjour, voir {start_here}', isDefault: false };
  const html = renderWelcomeLogPage([], tpl);
  // Textarea content (between <textarea ...> and </textarea>)
  assert.ok(html.includes('{user} bonjour, voir {start_here}'),
    'should render the override template inside the textarea');
});

test('renderWelcomeLogPage renders a preview substituting @newuser and #🚩│start-here', () => {
  const tpl = { template: '{user} welcome! Read {start_here}.', isDefault: false };
  const html = renderWelcomeLogPage([], tpl);
  assert.ok(html.includes('@newuser welcome! Read #🚩│start-here.'),
    'preview should substitute both placeholders with example values');
});

test('renderWelcomeLogPage shows "default" badge when isDefault is true', () => {
  const tpl = { template: 'whatever', isDefault: true };
  const html = renderWelcomeLogPage([], tpl);
  assert.ok(html.toLowerCase().includes('default'),
    'should indicate the template is the default');
});

test('renderWelcomeLogPage HTML-escapes the template before injecting into textarea', () => {
  const tpl = { template: '{user} <script>alert(1)</script>', isDefault: false };
  const html = renderWelcomeLogPage([], tpl);
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'should not emit raw <script>');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'should HTML-escape the script tag in both textarea and preview');
});

test('renderWelcomeLogPage uses default template when called with no second arg (backward compat)', () => {
  // The existing 4 tests call renderWelcomeLogPage(entries) with one arg.
  // This case must not throw.
  const html = renderWelcomeLogPage([]);
  assert.ok(html.includes('<textarea'), 'textarea should still render');
});

test('renderWelcomeLogPage renders entries in input order (caller is responsible for ordering)', () => {
  // The DB layer now returns rows newest-first via ORDER BY id DESC.
  // The page must NOT re-reverse — it should iterate the input directly.
  // Pass entries in the order the DB would return them (newest first).
  const entries = [
    { ts: '2026-05-14T12:02:00Z', type: 'sent', userId: '3', username: 'newest', detail: null },
    { ts: '2026-05-14T12:01:00Z', type: 'sent', userId: '2', username: 'middle', detail: null },
    { ts: '2026-05-14T12:00:00Z', type: 'sent', userId: '1', username: 'oldest', detail: null },
  ];
  const html = renderWelcomeLogPage(entries);
  const newestIdx = html.indexOf('newest');
  const middleIdx = html.indexOf('middle');
  const oldestIdx = html.indexOf('oldest');
  assert.ok(newestIdx !== -1 && middleIdx !== -1 && oldestIdx !== -1, 'all three usernames should be present');
  assert.ok(newestIdx < middleIdx, 'newest should appear before middle in the HTML');
  assert.ok(middleIdx < oldestIdx, 'middle should appear before oldest in the HTML');
});
