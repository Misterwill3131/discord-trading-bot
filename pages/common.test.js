const { test } = require('node:test');
const assert = require('node:assert');
const { sidebarHTML, SIDEBAR_LINKS, SIDEBAR_LINKS_FLAT } = require('./common');

test('SIDEBAR_LINKS is an array of 4 groups', () => {
  assert.ok(Array.isArray(SIDEBAR_LINKS), 'SIDEBAR_LINKS should be an array');
  assert.strictEqual(SIDEBAR_LINKS.length, 4, 'should have 4 groups');
  const sectionNames = SIDEBAR_LINKS.map(g => g.section);
  assert.deepStrictEqual(sectionNames, ['Overview', 'Content', 'Logs', 'Settings']);
});

test('SIDEBAR_LINKS_FLAT exposes the 15 items as a flat array', () => {
  assert.ok(Array.isArray(SIDEBAR_LINKS_FLAT));
  assert.strictEqual(SIDEBAR_LINKS_FLAT.length, 15);
  for (const item of SIDEBAR_LINKS_FLAT) {
    assert.strictEqual(typeof item.href, 'string');
    assert.strictEqual(typeof item.icon, 'string');
    assert.strictEqual(typeof item.label, 'string');
  }
});

test('SIDEBAR_LINKS_FLAT contains all the expected hrefs', () => {
  const expectedHrefs = [
    '/dashboard', '/stats', '/profits', '/leaderboard',
    '/news', '/image-generator', '/proof-generator', '/gallery', '/video-studio',
    '/raw-messages', '/db-viewer', '/backup-log', '/welcome-log', '/cost-dashboard',
    '/config',
  ];
  const actualHrefs = SIDEBAR_LINKS_FLAT.map(l => l.href);
  assert.deepStrictEqual(actualHrefs.sort(), expectedHrefs.sort());
});

test('sidebarHTML renders all 4 section headers', () => {
  const html = sidebarHTML('/dashboard');
  for (const section of ['Overview', 'Content', 'Logs', 'Settings']) {
    assert.ok(html.includes(section), 'should include section header "' + section + '"');
  }
});

test('sidebarHTML renders all 14 item hrefs', () => {
  const html = sidebarHTML('/dashboard');
  for (const href of ['/dashboard', '/stats', '/profits', '/leaderboard',
    '/news', '/image-generator', '/proof-generator', '/gallery', '/video-studio',
    '/raw-messages', '/db-viewer', '/backup-log', '/welcome-log',
    '/config']) {
    assert.ok(html.includes('href="' + href + '"'), 'should include href ' + href);
  }
});

test('sidebarHTML marks the active link with class="active"', () => {
  const html = sidebarHTML('/stats');
  assert.match(html, /href="\/stats" class="active"/);
  assert.doesNotMatch(html, /href="\/dashboard" class="active"/);
  assert.doesNotMatch(html, /href="\/profits" class="active"/);
});

test('sidebarHTML renders the section header CSS class .nav-sidebar-section', () => {
  const html = sidebarHTML('/dashboard');
  assert.ok(html.includes('class="nav-sidebar-section"'),
    'should render section headers with class="nav-sidebar-section"');
});

test('sidebarHTML renders the BOOM logo', () => {
  const html = sidebarHTML('/dashboard');
  assert.ok(html.includes('🔥 BOOM'), 'should include the BOOM logo');
  assert.ok(html.includes('nav-sidebar-logo'), 'should use .nav-sidebar-logo class');
});
