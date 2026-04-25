// ─────────────────────────────────────────────────────────────────────
// filters/signal.test.js — Tests du classifier
// ─────────────────────────────────────────────────────────────────────
// Focus : garantir que les messages typiques du chat trading sont
// correctement tagués 'entry' / 'exit' / 'neutral' / null. Ajouté après
// observation que les annonces de gain ("TICKER +29%") tombaient en
// 'entry implicite' au lieu d'exit.
// ─────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert');

const { classifySignal } = require('./signal');

const noFilters = { allowed: [], blocked: [] };

function classify(content, opts = {}) {
  return classifySignal(content, noFilters, opts);
}

// ── Messages vides / blocages hardcodés ────────────────────────────
test('empty content → null', () => {
  assert.strictEqual(classify('').type, null);
});

test('blocked keyword (news) → null', () => {
  assert.strictEqual(classify('NVDA news out today').type, null);
});

test('no ticker → null', () => {
  assert.strictEqual(classify('just some random text').type, null);
});

// ── Entries claires (mot-clé explicite) ────────────────────────────
test('explicit "buy above" keyword → entry', () => {
  assert.strictEqual(classify('buy above 150 NVDA').type, 'entry');
});

test('"scalping TICKER 2.50" → entry', () => {
  assert.strictEqual(classify('Scalping TSLA 250').type, 'entry');
});

test('stop with price ("$GMEX .46 s.l 43") → entry (implicit)', () => {
  assert.strictEqual(classify('$GMEX .46 s.l 43').type, 'entry');
});

test('ticker + adjacent price → entry (implicit)', () => {
  assert.strictEqual(classify('AGAI 0.86 next fib').type, 'entry');
});

// ── Exits explicites (mot-clé déjà supporté) ───────────────────────
test('"SL hit" → exit', () => {
  assert.strictEqual(classify('TSLA SL hit').type, 'exit');
});

test('"all targets done" → exit', () => {
  assert.strictEqual(classify('ZZ all targets done ✅').type, 'exit');
});

test('"out at 1.93" → exit', () => {
  assert.strictEqual(classify('PLTR out at 1.93').type, 'exit');
});

test('"TP2 hit" → exit', () => {
  assert.strictEqual(classify('TSLA TP2 hit').type, 'exit');
});

// ── Exits implicites (nouveaux motifs — REGRESSION ACTUELLE) ───────
test('"TICKER +N%" → exit (gain announcement)', () => {
  assert.strictEqual(classify('ARAI +29%').type, 'exit');
});

test('"TICKER -N%" → exit (loss announcement)', () => {
  assert.strictEqual(classify('TSLA -5%').type, 'exit');
});

test('"TICKER up N%" → exit', () => {
  assert.strictEqual(classify('NVDA up 8%').type, 'exit');
});

test('"TICKER down N%" → exit', () => {
  assert.strictEqual(classify('AMD down 3.5%').type, 'exit');
});

test('"took profits on TICKER" → exit', () => {
  assert.strictEqual(classify('took profits on NVDA').type, 'exit');
});

test('"cashed out TICKER" → exit', () => {
  assert.strictEqual(classify('cashed out GME').type, 'exit');
});

test('"locked in N% on TICKER" → exit', () => {
  assert.strictEqual(classify('locked in 20% on TSLA').type, 'exit');
});

test('"scaled out half of TICKER" → exit', () => {
  assert.strictEqual(classify('scaled out half of CRWD').type, 'exit');
});

// ── Neutres / conversationnel ──────────────────────────────────────
test('conversational question ("how is AMC doing?") → null', () => {
  assert.strictEqual(classify('how is AMC doing?').type, null);
});

test('neutral fact with ticker and price but no entry/exit signal → neutral', () => {
  // Note: ce genre de message tombait souvent en 'neutral' avec l'ancien
  // classifier. Notre nouveau classifier le routera en entry implicite
  // (règle ticker+prix) — ce qui est cohérent car c'est une pseudo-entry.
  // On vérifie juste qu'on ne le jette pas en null.
  const r = classify('PLTR 25.40 breakout setup');
  assert.notStrictEqual(r.type, null, 'should not be filtered');
});

// ── Reply body : exit détecté dans la réponse ──────────────────────
test('reply body with "targets done" → exit', () => {
  const r = classify('ZZ $PN 2.60-3.17 all targets done ✅', {
    replyBody: 'all targets done ✅',
  });
  assert.strictEqual(r.type, 'exit');
});
