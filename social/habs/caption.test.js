const { test } = require('node:test');
const assert = require('node:assert');
const { buildCaption, renderTemplate, validateCaption } = require('./caption');

const FIXTURE_OCR = {
  dateLabel: '2026-05-18',
  trades: [
    { ticker: 'AAPL', entryPrice: 100, hodPrice: 150 },  // +50%
    { ticker: 'TSLA', entryPrice: 50,  hodPrice: 60 },   // +20%
    { ticker: 'NVDA', entryPrice: 200, hodPrice: 220 },  // +10%
    { ticker: 'GME',  entryPrice: 20,  hodPrice: 19 },   // -5%
  ],
};

test('renderTemplate produces compliant caption with top 3 winners', () => {
  const out = renderTemplate(FIXTURE_OCR);
  assert.match(out, /Trade journal — 2026-05-18/);
  assert.match(out, /4 closes today · 3W \/ 1L/);
  assert.match(out, /\$AAPL \+50/);
  assert.match(out, /\$TSLA \+20/);
  assert.match(out, /\$NVDA \+10/);
  assert.match(out, /What's everyone watching into tomorrow\?/);
  // Compliance: no URLs, no brand mention
  assert.doesNotMatch(out, /http|https|temple of boom|discord/i);
});

test('renderTemplate handles 1-trade edge case', () => {
  const ocr = { dateLabel: '2026-05-18', trades: [
    { ticker: 'AAPL', entryPrice: 100, hodPrice: 110 },
  ]};
  const out = renderTemplate(ocr);
  assert.match(out, /1 closes today · 1W \/ 0L/);
  assert.match(out, /\$AAPL \+10/);
  // Only 1 line in Top moves, no extra blank lines
  const topSection = out.split('Top moves:')[1].split("What's")[0];
  assert.strictEqual(topSection.trim().split('\n').length, 1);
});

test('renderTemplate fallbacks dateLabel to today NY if missing', () => {
  const ocr = { trades: [{ ticker: 'AAPL', entryPrice: 100, hodPrice: 110 }] };
  const out = renderTemplate(ocr);
  // Pattern YYYY-MM-DD
  assert.match(out, /Trade journal — \d{4}-\d{2}-\d{2}/);
});

test('renderTemplate handles all-losing day honestly', () => {
  const ocr = { dateLabel: '2026-05-18', trades: [
    { ticker: 'A', entryPrice: 100, hodPrice: 95 },   // -5%
    { ticker: 'B', entryPrice: 100, hodPrice: 50 },   // -50%
  ]};
  const out = renderTemplate(ocr);
  assert.match(out, /2 closes today · 0W \/ 2L/);
  // -5 should come before -50 (least bad first)
  const aIdx = out.indexOf('$A ');
  const bIdx = out.indexOf('$B ');
  assert(aIdx > 0 && bIdx > aIdx);
});

test('validateCaption rejects URLs', () => {
  assert.strictEqual(validateCaption('check out https://temple-of-boom.com'), false);
  assert.strictEqual(validateCaption('visit http://example.com'), false);
});

test('validateCaption rejects brand mentions', () => {
  assert.strictEqual(validateCaption('join Temple of Boom'), false);
  assert.strictEqual(validateCaption('come to our Discord'), false);
  assert.strictEqual(validateCaption('TEMPLE OF BOOM live calls'), false);
});

test('validateCaption accepts clean trader journal text', () => {
  const ok = `Trade journal — 2026-05-18

3 closes today · 2W / 1L

Top moves:
$AAPL +50%
$TSLA +20%

What's everyone watching into tomorrow?`;
  assert.strictEqual(validateCaption(ok), true);
});

test('buildCaption returns template output when no LLM available', async () => {
  // Forced fallback: pass llmFn that returns null.
  const out = await buildCaption(FIXTURE_OCR, { llmFn: async () => null });
  assert.match(out, /Trade journal —/);
  assert.match(out, /\$AAPL/);
});

test('buildCaption uses LLM output when valid', async () => {
  const llmFn = async () => 'Trade journal — 2026-05-18\n\n3W/1L\n$AAPL +50%\n\nWatching what?';
  const out = await buildCaption(FIXTURE_OCR, { llmFn });
  assert.match(out, /^Trade journal/);
  // It returned our LLM text, not the template
  assert.match(out, /Watching what\?/);
});

test('buildCaption falls back to template when LLM output fails validation', async () => {
  const llmFn = async () => 'Great trades! Join temple-of-boom.com for more 🚀';
  const out = await buildCaption(FIXTURE_OCR, { llmFn });
  // Must have fallen back to template
  assert.match(out, /What's everyone watching into tomorrow\?/);
  assert.doesNotMatch(out, /temple-of-boom/i);
});

test('buildCaption falls back to template when LLM throws', async () => {
  const llmFn = async () => { throw new Error('API down'); };
  const out = await buildCaption(FIXTURE_OCR, { llmFn });
  assert.match(out, /Trade journal —/);
});
