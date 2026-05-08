const { test } = require('node:test');
const assert = require('node:assert');

const { parseRecap } = require('./parse-recap');

// ─── Cas réel : exemple ZZ du 2026-05-08 ────────────────────────────
const ZZ_RECAP = `RECAP:

$RXT 380% swing
$REPL 133% swing
$AIIO 71%
$TDIC 63% swing
$AIIO 63%
$INOD 53%
$FKNC 53% swing
$DBGI 48% swing
$GDC 42%
$RXT 39%
$PMAX 35%
$MASK 30%
$TRAW 29%
$GDC 23%

Plenty of chances to bank today even if you just stayed in this channel. Our WL gave us 5 out of 6 runners. @everyone`;

test('parseRecap extrait les 14 tickers du recap ZZ', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.ok(result, 'should not return null');
  assert.strictEqual(result.tickers.length, 14);
});

test('parseRecap sort tickers desc par gainPct', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.strictEqual(result.tickers[0].ticker, 'RXT');
  assert.strictEqual(result.tickers[0].gainPct, 380);
  assert.strictEqual(result.tickers[1].ticker, 'REPL');
  assert.strictEqual(result.tickers[1].gainPct, 133);
});

test('parseRecap mark isHero=true pour gainPct >= 100', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  const heros = result.tickers.filter(t => t.isHero);
  assert.strictEqual(heros.length, 2, 'RXT 380 + REPL 133 = 2 hero');
});

test('parseRecap détecte le flag swing', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  const rxt = result.tickers.find(t => t.ticker === 'RXT' && t.gainPct === 380);
  assert.strictEqual(rxt.swing, true);
  const aiio71 = result.tickers.find(t => t.ticker === 'AIIO' && t.gainPct === 71);
  assert.strictEqual(aiio71.swing, false);
});

test('parseRecap extrait runnersHit + runnersTotal', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.strictEqual(result.runnersHit, 5);
  assert.strictEqual(result.runnersTotal, 6);
});

test('parseRecap extrait tagline et strip @everyone', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.match(result.tagline, /Plenty of chances to bank today/);
  assert.doesNotMatch(result.tagline, /@everyone/);
});

test('parseRecap calcule totalGainPct (somme)', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  // 380+133+71+63+63+53+53+48+42+39+35+30+29+23 = 1062
  assert.strictEqual(result.totalGainPct, 1062);
});

test('parseRecap retourne date en TZ NY (YYYY-MM-DD)', () => {
  const result = parseRecap(ZZ_RECAP, new Date('2026-05-08T19:44:00Z'));
  assert.strictEqual(result.date, '2026-05-08');
});

// ─── Cas négatifs ────────────────────────────────────────────────
test('parseRecap retourne null si moins de 3 tickers', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%';
  assert.strictEqual(parseRecap(content, new Date()), null);
});

test('parseRecap retourne null si pas de RECAP: en début', () => {
  const content = '$RXT 380% swing\n$REPL 133% swing\n$AIIO 71%';
  assert.strictEqual(parseRecap(content, new Date()), null);
});

test('parseRecap accepte "RECAP :" avec espace', () => {
  const content = 'RECAP :\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.ok(result);
  assert.strictEqual(result.tickers.length, 3);
});

test('parseRecap accepte décimales dans gainPct', () => {
  const content = 'RECAP:\n$AAPL 12.5%\n$TSLA 5.1%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.tickers[0].gainPct, 12.5);
});

test('parseRecap fallback tagline défaut si non trouvé', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.tagline, 'Plenty of chances to bank today.');
});

test('parseRecap runnersHit/Total null si pas trouvés', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.runnersHit, null);
  assert.strictEqual(result.runnersTotal, null);
});

test('parseRecap matche "5/6 runners" comme alternative à "out of"', () => {
  const content = 'RECAP:\n$AAPL 10%\n$TSLA 5%\n$NVDA 8%\n\nGreat day, 4/5 runners hit.';
  const result = parseRecap(content, new Date());
  assert.strictEqual(result.runnersHit, 4);
  assert.strictEqual(result.runnersTotal, 5);
});
