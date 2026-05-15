// Tests pour utils/cost-tracker.js
//
// Ces tests insèrent des events réels dans la table cost_events de la
// boom.db locale puis les nettoient à la fin. Ils ne mockent pas la DB
// (better-sqlite3 in-process est déjà rapide). Si tu lances la suite
// en CI sans DB, le `require('./cost-tracker')` va crash → c'est OK car
// la suite est censée tourner localement avec les autres tests SQLite.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const ct = require('./cost-tracker');
const { db } = require('../db/sqlite');

// Sentinel marker pour identifier les events insérés par ces tests.
// On filtre dessus dans les cleanup, sans toucher aux events réels du
// bot (ex: si un test runner cohabite avec un bot live).
const TEST_MARKER = '__cost_tracker_test_marker_' + Date.now();

beforeEach(() => {
  // Insère le marker dans les notes pour pouvoir cleanup ensuite.
  // On wrap recordCost via les helpers publics qui propagent toujours
  // notes vers meta_json.
});

afterEach(() => {
  // Cleanup : supprime les events insérés pendant les tests via le marker.
  db.prepare(
    'DELETE FROM cost_events WHERE meta_json LIKE ?'
  ).run('%' + TEST_MARKER + '%');
});

test('recordAnthropicCall calcule le coût haiku correctement', () => {
  // 1k input + 500 output sur haiku :
  // input  : 1000 × (0.80 / 1M) = 0.0008
  // output :  500 × (4.00 / 1M) = 0.002
  // total  : 0.0028
  const cost = ct.recordAnthropicCall({
    model: 'claude-haiku-4-5',
    inputTokens: 1000,
    outputTokens: 500,
    notes: { marker: TEST_MARKER },
  });
  assert.ok(Math.abs(cost - 0.0028) < 1e-9, 'haiku 1k/500 = $0.0028, got ' + cost);
});

test('recordAnthropicCall avec sonnet utilise les tarifs sonnet', () => {
  // 1k input + 500 output sur sonnet :
  // input  : 1000 × (3 / 1M)  = 0.003
  // output :  500 × (15 / 1M) = 0.0075
  // total  : 0.0105
  const cost = ct.recordAnthropicCall({
    model: 'claude-sonnet-4-5',
    inputTokens: 1000,
    outputTokens: 500,
    notes: { marker: TEST_MARKER },
  });
  assert.ok(Math.abs(cost - 0.0105) < 1e-9, 'sonnet 1k/500 = $0.0105, got ' + cost);
});

test('recordAnthropicCall default à haiku si model inconnu', () => {
  const cost = ct.recordAnthropicCall({
    model: 'gibberish-not-a-real-model',
    inputTokens: 1000,
    outputTokens: 0,
    notes: { marker: TEST_MARKER },
  });
  // 1000 × (0.80 / 1M) = 0.0008
  assert.ok(Math.abs(cost - 0.0008) < 1e-9);
});

test('recordElevenLabsCall = chars × tarif par char', () => {
  // 200 chars × (0.18 / 1000) = 0.036
  const cost = ct.recordElevenLabsCall({ chars: 200, notes: { marker: TEST_MARKER } });
  assert.ok(Math.abs(cost - 0.036) < 1e-9);
});

test('recordChartImgCall = montant fixe par requête', () => {
  // 25 / 10000 = 0.0025
  const cost = ct.recordChartImgCall({ symbol: 'TEST', notes: { marker: TEST_MARKER } });
  assert.strictEqual(cost, 0.0025);
});

test('recordRender = 0 USD (local) mais track durée', () => {
  const cost = ct.recordRender({ durationMs: 30000, composition: 'TestComp', notes: { marker: TEST_MARKER } });
  assert.strictEqual(cost, 0);
  // Vérifie que l'event a bien été inséré
  const rows = ct.recent({ limit: 5, service: 'render' });
  const match = rows.find(r => r.meta_json.includes(TEST_MARKER));
  assert.ok(match, 'render event should be persisted');
  assert.ok(match.meta_json.includes('TestComp'));
});

test('statsByService aggrège correctement', () => {
  ct.recordAnthropicCall({ model: 'haiku', inputTokens: 1000, outputTokens: 0, notes: { marker: TEST_MARKER } });
  ct.recordAnthropicCall({ model: 'haiku', inputTokens: 2000, outputTokens: 0, notes: { marker: TEST_MARKER } });
  ct.recordElevenLabsCall({ chars: 100, notes: { marker: TEST_MARKER } });

  const stats = ct.statsByService({ startMs: Date.now() - 60000, endMs: Date.now() + 1000 });
  // On ne peut pas asserter exactement les totals si d'autres tests/le bot
  // tournent en parallèle — mais on peut vérifier que les services attendus
  // sont là.
  const services = stats.rows.map(r => r.service);
  assert.ok(services.includes('anthropic'), 'anthropic in stats');
  assert.ok(services.includes('elevenlabs'), 'elevenlabs in stats');
  assert.ok(stats.callCount >= 3, 'callCount >= 3, got ' + stats.callCount);
  assert.ok(stats.total > 0);
});

test('recent retourne les events les plus récents en premier', () => {
  ct.recordChartImgCall({ symbol: 'TICKER_OLD', notes: { marker: TEST_MARKER } });
  // Petite pause artificielle via setTimeout sync (1ms suffit avec Date.now ms)
  const tickStart = Date.now();
  while (Date.now() === tickStart) { /* spin until ms changes */ }
  ct.recordChartImgCall({ symbol: 'TICKER_NEW', notes: { marker: TEST_MARKER } });

  const rows = ct.recent({ limit: 50, service: 'chart-img' });
  const marked = rows.filter(r => r.meta_json.includes(TEST_MARKER));
  assert.ok(marked.length >= 2, 'should have ≥2 marker rows');
  // Le plus récent (NEW) doit apparaître avant l'ancien (OLD)
  const newIdx = marked.findIndex(r => r.meta_json.includes('TICKER_NEW'));
  const oldIdx = marked.findIndex(r => r.meta_json.includes('TICKER_OLD'));
  assert.ok(newIdx < oldIdx, 'TICKER_NEW (idx ' + newIdx + ') should come before TICKER_OLD (idx ' + oldIdx + ')');
});

test('summary retourne 4 clés avec valeurs numériques', () => {
  ct.recordAnthropicCall({ model: 'haiku', inputTokens: 100, outputTokens: 50, notes: { marker: TEST_MARKER } });
  const s = ct.summary();
  assert.ok(typeof s.today === 'number');
  assert.ok(typeof s.last7d === 'number');
  assert.ok(typeof s.last30d === 'number');
  assert.ok(typeof s.total === 'number');
  // last7d >= today (today fait partie de last7d)
  assert.ok(s.last7d >= s.today - 1e-9, 'last7d (' + s.last7d + ') >= today (' + s.today + ')');
});

test('dailyTotals retourne N jours fillés (incluant les jours vides)', () => {
  const d = ct.dailyTotals({ days: 7 });
  assert.strictEqual(d.days.length, 7);
  // Chaque jour doit avoir { day, total, byService }
  for (const day of d.days) {
    assert.ok(typeof day.day === 'string' && day.day.length === 10, 'day = YYYY-MM-DD');
    assert.ok(typeof day.total === 'number');
    assert.ok(typeof day.byService === 'object');
  }
});

test('PRICING expose les constantes attendues', () => {
  assert.ok(ct.PRICING.anthropic);
  assert.ok(ct.PRICING.anthropic.haiku);
  assert.ok(ct.PRICING.anthropic.haiku.input > 0);
  assert.ok(ct.PRICING.anthropic.sonnet.input > ct.PRICING.anthropic.haiku.input);
  assert.ok(ct.PRICING.elevenlabs_per_char > 0);
  assert.ok(ct.PRICING.chart_img_per_request > 0);
});
