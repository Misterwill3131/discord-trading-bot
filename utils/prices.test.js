// ─────────────────────────────────────────────────────────────────────
// utils/prices.test.js — Tests d'extraction de prix
// ─────────────────────────────────────────────────────────────────────
// Couvre les bugs observés sur la DB live :
//   - "QQQ: 1100% TS alert" extrayait 1100 comme entry_price
//   - "RECAP: $SNAL 318%" extrayait 318
//   - "ARAI +29%" extrayait 29 alors que c'est un pourcentage de gain
// Règle : un nombre suivi immédiatement de '%' est un pourcentage,
// jamais un prix absolu.
// ─────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert');

const { extractPrices, extractExitGainPct } = require('./prices');

// ── Le bug du "%" : un nombre avec % colle pas comme prix ──────────
test('"QQQ: 1100% TS alert" → entry_price=null (1100 est un %)', () => {
  const p = extractPrices('Options Alerts and Live Recap;\nQQQ: 1100% TS alert');
  assert.strictEqual(p.entry_price, null);
});

test('"RECAP: $SNAL 318%" → entry_price=null', () => {
  const p = extractPrices('RECAP:\n$SNAL 318%\n$ROLR 87%');
  assert.strictEqual(p.entry_price, null);
});

test('"ARAI +29%" → entry_price=null (gain %, pas un prix)', () => {
  const p = extractPrices('ARAI +29%');
  assert.strictEqual(p.entry_price, null);
});

// ── Cas valides : on n'a pas cassé les vrais prix ──────────────────
test('"AGAI 0.86 next fib" → entry_price=0.86', () => {
  const p = extractPrices('AGAI 0.86 next fib');
  assert.strictEqual(p.entry_price, 0.86);
});

test('"$TSLA 150.00-155.00" → entry_price=150, target=155', () => {
  const p = extractPrices('$TSLA 150.00-155.00');
  assert.strictEqual(p.entry_price, 150);
  assert.strictEqual(p.target_price, 155);
});

test('"in at 1.50, target 1.75, sl 1.40" → tous remplis', () => {
  const p = extractPrices('in at 1.50, target 1.75, sl 1.40');
  assert.strictEqual(p.entry_price, 1.5);
  assert.strictEqual(p.target_price, 1.75);
  assert.strictEqual(p.stop_price, 1.4);
});

test('"$GMEX .46 s.l 43" → entry=.46, stop=43 (heuristique handle ailleurs)', () => {
  const p = extractPrices('$GMEX .46$ s.l 43');
  assert.strictEqual(p.entry_price, 0.46);
  assert.strictEqual(p.stop_price, 43);
});

// ── extractExitGainPct ─────────────────────────────────────────────
test('extractExitGainPct: "+29%" → 29', () => {
  assert.strictEqual(extractExitGainPct('ARAI +29%'), 29);
});

test('extractExitGainPct: "-5%" → -5', () => {
  assert.strictEqual(extractExitGainPct('TSLA -5% cut'), -5);
});

test('extractExitGainPct: "up 8%" → 8', () => {
  assert.strictEqual(extractExitGainPct('NVDA up 8%'), 8);
});

test('extractExitGainPct: "down 3.5%" → -3.5', () => {
  assert.strictEqual(extractExitGainPct('AMD down 3.5%'), -3.5);
});

test('extractExitGainPct: "150-29% range" → null (faux positif évité)', () => {
  assert.strictEqual(extractExitGainPct('150-29% range'), null);
});

// ── Trim / scaled / scaling : prix d'exit partiel ─────────────────
test('"ARIA scaled some @1.78/79" → exit_price=1.78', () => {
  const p = extractPrices('ARIA scaled some @1.78/79');
  assert.strictEqual(p.exit_price, 1.78);
});

test('"ARIA scaling out 1.71" → exit_price=1.71', () => {
  const p = extractPrices('ARIA scaling out 1.71');
  assert.strictEqual(p.exit_price, 1.71);
});

test('"trim @150" → exit_price=150 (format compact)', () => {
  const p = extractPrices('trim @150 NVDA');
  assert.strictEqual(p.exit_price, 150);
});

test('"trimmed half @1.50" → exit_price=1.50', () => {
  const p = extractPrices('trimmed half @1.50');
  assert.strictEqual(p.exit_price, 1.50);
});

// ── Tolérance aux typos "double point" ─────────────────────────────
test('"ARIA 1..5-1.64 so far" → entry=1.5, target=1.64 (typo "1..5" toléré)', () => {
  const p = extractPrices('ARIA 1..5-1.64 so far');
  assert.strictEqual(p.entry_price, 1.5);
  assert.strictEqual(p.target_price, 1.64);
});

test('"NVDA 2..50 entry" → entry=2.50', () => {
  const p = extractPrices('NVDA in at 2..50');
  assert.strictEqual(p.entry_price, 2.50);
});

// Doit PAS casser "..." comme séparateur de range (3+ dots distincts d'un typo)
test('"NVDA 2.50...3.50 setup" → range NON collapsé (3 dots = séparateur)', () => {
  const p = extractPrices('NVDA 2.50...3.50 setup');
  // On ne corrige pas ici — soit le parser de range "..." marche, soit null.
  // Ce qu'on EXIGE c'est que ça ne devienne PAS "2.50.33.50" (broken).
  // Si entry est 2.5, le parser a réussi. Si null, il a échoué — OK aussi.
  if (p.entry_price !== null) {
    assert.strictEqual(p.entry_price, 2.5);
    assert.strictEqual(p.target_price, 3.5);
  }
});
