const { test } = require('node:test');
const assert = require('node:assert');
const { formatAnalystEntryEmail } = require('./handler');

// ── formatAnalystEntryEmail ──────────────────────────────────────────
// L'email est essentiellement une image inline (cf. notifications/email.js).
// Le message texte renvoyé ici sert de subject ET de fallback texte —
// donc une seule ligne suffit, identique pour tous les analystes.

test('formatAnalystEntryEmail returns one-line subject with entry price', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'AIHS',
    entryPx: 1.27,
  });
  assert.strictEqual(msg, '📥 $AIHS entry 1.27 (ZZ)');
});

test('formatAnalystEntryEmail uses em-dash when entryPx is null', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'AIHS',
    entryPx: null,
  });
  assert.strictEqual(msg, '📥 $AIHS entry — (ZZ)');
});

test('formatAnalystEntryEmail uppercases ticker', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'ZZ',
    signalTicker: 'aihs',
    entryPx: 1.27,
  });
  assert.strictEqual(msg, '📥 $AIHS entry 1.27 (ZZ)');
});

test('formatAnalystEntryEmail always starts with 📥 (required by email filter)', () => {
  const msg = formatAnalystEntryEmail({
    authorName: 'anyone',
    signalTicker: 'ABC',
    entryPx: 1,
  });
  assert.ok(msg.startsWith('📥'));
});
