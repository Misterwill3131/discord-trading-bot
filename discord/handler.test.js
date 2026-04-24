const { test } = require('node:test');
const assert = require('node:assert');
const {
  cleanContentForEmail,
  formatAnalystEntryEmail,
  RF_USERNAME,
} = require('./handler');

// ── cleanContentForEmail ─────────────────────────────────────────────

test('cleanContentForEmail strips custom Discord emojis', () => {
  const out = cleanContentForEmail('AIHS 1.27-1.68<a:4743_pink_flame:1154098186831536248>');
  assert.strictEqual(out, 'AIHS 1.27-1.68');
});

test('cleanContentForEmail strips user/role/channel mentions', () => {
  const out = cleanContentForEmail('Entry <@123> role <@&456> channel <#789>');
  assert.strictEqual(out, 'Entry role channel');
});

test('cleanContentForEmail strips the "Replying to" quote line', () => {
  const input = '> *Replying to simba [message](https://discord.com/channels/1/2/3)*\nAIHS 1.27-1.68';
  assert.strictEqual(cleanContentForEmail(input), 'AIHS 1.27-1.68');
});

test('cleanContentForEmail replaces markdown links [text](url) with just text', () => {
  const out = cleanContentForEmail('see [the chart](https://example.com) here');
  assert.strictEqual(out, 'see the chart here');
});

test('cleanContentForEmail strips raw discord.com URLs', () => {
  const out = cleanContentForEmail('look https://discord.com/channels/1/2/3 now');
  assert.strictEqual(out, 'look now');
});

test('cleanContentForEmail preserves newlines (critical for RF messages)', () => {
  const input = '$AUUD\n\nbuy only above $7.12\n\nSL $5.74';
  assert.strictEqual(cleanContentForEmail(input), '$AUUD\n\nbuy only above $7.12\n\nSL $5.74');
});

test('cleanContentForEmail collapses 3+ consecutive newlines to 2', () => {
  const input = 'line1\n\n\n\nline2';
  assert.strictEqual(cleanContentForEmail(input), 'line1\n\nline2');
});

test('cleanContentForEmail returns empty string for empty/null input', () => {
  assert.strictEqual(cleanContentForEmail(''), '');
  assert.strictEqual(cleanContentForEmail(null), '');
  assert.strictEqual(cleanContentForEmail(undefined), '');
});

// ── formatAnalystEntryEmail ───────────────────────────────────────────

test('formatAnalystEntryEmail default format is a single line with entry price', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'AIHS',
    entryPx: 1.27,
    content: 'AIHS 1.27-1.68',
  });
  assert.strictEqual(msg, '📥 $AIHS entry 1.27 (ZZ)');
});

test('formatAnalystEntryEmail default format uses em-dash when entryPx is null', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'AIHS',
    entryPx: null,
    content: 'AIHS',
  });
  assert.strictEqual(msg, '📥 $AIHS entry — (ZZ)');
});

test('formatAnalystEntryEmail uppercases ticker', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'aihs',
    entryPx: 1.27,
    content: '',
  });
  assert.strictEqual(msg, '📥 $AIHS entry 1.27 (ZZ)');
});

test('formatAnalystEntryEmail for RF includes header + full cleaned message', () => {
  const content = '$AUUD\n\nbuy only above $7.12\n\nif down after bought, add @$6.46\n\nTargets $7.82/8.64/9.54\n\nSL $5.74';
  const msg = formatAnalystEntryEmail({
    authorName: RF_USERNAME,
    signalTicker: 'AUUD',
    entryPx: 7.12,
    content,
  });
  const expected = '📥 $AUUD (' + RF_USERNAME + ')\n\n'
    + '$AUUD\n\nbuy only above $7.12\n\nif down after bought, add @$6.46\n\nTargets $7.82/8.64/9.54\n\nSL $5.74';
  assert.strictEqual(msg, expected);
});

test('formatAnalystEntryEmail for RF strips Discord metadata from content', () => {
  const content = '$XYZ\n<a:flame:123456>\nentry above 5\n<@&789>\nSL 4';
  const msg = formatAnalystEntryEmail({
    authorName: RF_USERNAME,
    signalTicker: 'XYZ',
    entryPx: 5,
    content,
  });
  // Header + cleaned content (emojis/mentions stripped, structure kept)
  assert.ok(msg.startsWith('📥 $XYZ (' + RF_USERNAME + ')\n\n'));
  assert.ok(!msg.includes('<a:flame'));
  assert.ok(!msg.includes('<@&789>'));
  assert.ok(msg.includes('entry above 5'));
  assert.ok(msg.includes('SL 4'));
});

test('formatAnalystEntryEmail always starts with 📥 (required by email filter)', () => {
  const defaultMsg = formatAnalystEntryEmail({
    authorName: 'anyone',
    signalTicker: 'ABC',
    entryPx: 1,
    content: 'x',
  });
  assert.ok(defaultMsg.startsWith('📥'));

  const rfMsg = formatAnalystEntryEmail({
    authorName: RF_USERNAME,
    signalTicker: 'ABC',
    entryPx: 1,
    content: 'x',
  });
  assert.ok(rfMsg.startsWith('📥'));
});
