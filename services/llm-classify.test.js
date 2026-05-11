// Tests pour services/llm-classify.js
// Pas d'appels API réels — on teste parser, hash, kill switch, et la
// route via le cache DB en memory.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Setup DB temp avant require
const tmpDir = fs.mkdtempSync('/tmp/llm-classify-test-');
process.env.DATA_DIR = tmpDir;

const { parseClassification, hashText, isEnabled, classify, VALID_TYPES, DEFAULT_MODEL, PROMPT_VERSION } = require('./llm-classify');
const db = require('../db/sqlite');

// ── parseClassification ─────────────────────────────────────────────

test('parseClassification: JSON exit valide', () => {
  const r = parseClassification('{"type":"exit","ticker":"DGNX","low":4.8,"high":5.59,"confidence":0.95}');
  assert.strictEqual(r.type, 'exit');
  assert.strictEqual(r.ticker, 'DGNX');
  assert.strictEqual(r.low, 4.8);
  assert.strictEqual(r.high, 5.59);
  assert.strictEqual(r.confidence, 0.95);
});

test('parseClassification: JSON entry valide', () => {
  const r = parseClassification('{"type":"entry","ticker":"AAPL","entry":150,"target":160,"stop":145,"confidence":0.9}');
  assert.strictEqual(r.type, 'entry');
  assert.strictEqual(r.entry, 150);
  assert.strictEqual(r.target, 160);
  assert.strictEqual(r.stop, 145);
});

test('parseClassification: strip code fence ```json', () => {
  const r = parseClassification('```json\n{"type":"ipo","ticker":"HAWK","confidence":0.97}\n```');
  assert.ok(r);
  assert.strictEqual(r.type, 'ipo');
  assert.strictEqual(r.ticker, 'HAWK');
});

test('parseClassification: type inconnu → null', () => {
  assert.strictEqual(parseClassification('{"type":"unknown","confidence":0.9}'), null);
});

test('parseClassification: garbage → null', () => {
  assert.strictEqual(parseClassification('not json'), null);
  assert.strictEqual(parseClassification(''), null);
  assert.strictEqual(parseClassification(null), null);
});

test('parseClassification: confidence clampée [0,1]', () => {
  assert.strictEqual(parseClassification('{"type":"exit","confidence":2.5}').confidence, 1);
  assert.strictEqual(parseClassification('{"type":"exit","confidence":-0.5}').confidence, 0);
  assert.strictEqual(parseClassification('{"type":"exit","confidence":"abc"}').confidence, 0.5);
});

test('parseClassification: ticker uppercased et tronqué', () => {
  assert.strictEqual(parseClassification('{"type":"exit","ticker":"aapl","confidence":0.9}').ticker, 'AAPL');
  assert.strictEqual(parseClassification('{"type":"exit","ticker":"longticker","confidence":0.9}').ticker, 'LONGTICK');
});

test('parseClassification: champs prix non-numériques → null', () => {
  const r = parseClassification('{"type":"exit","entry":"abc","low":"5.5","confidence":0.9}');
  assert.strictEqual(r.entry, null);
  assert.strictEqual(r.low, 5.5);
});

test('parseClassification: TOUS les types valides acceptés', () => {
  for (const t of ['entry', 'exit', 'ipo', 'passthrough', 'ignore']) {
    const r = parseClassification(`{"type":"${t}","confidence":0.8}`);
    assert.ok(r, `should accept type=${t}`);
    assert.strictEqual(r.type, t);
  }
});

// ── hashText ────────────────────────────────────────────────────────

test('hashText: déterministe + insensible aux espaces autour', () => {
  assert.strictEqual(hashText('CRE 2.80-3.91'), hashText('  CRE 2.80-3.91  '));
});

test('hashText: longueur 64 (SHA-256 hex)', () => {
  assert.strictEqual(hashText('foo').length, 64);
});

test('hashText: textes structurellement différents → hash différents', () => {
  // Templates différents : "CRE 2.80-3.91" vs "BUY $AAPL NOW" → hashes différents
  assert.notStrictEqual(hashText('CRE 2.80-3.91'), hashText('BUY $AAPL NOW'));
});

test('hashText: même template → même hash (template-based caching)', () => {
  // Tickers différents mais même structure prose → même hash
  assert.strictEqual(
    hashText('Added too! Best sympathy to HSPT with far lower float'),
    hashText('Added too! Best sympathy to AAPL with far lower float')
  );
});

test('hashText: prix différents mais même structure → même hash', () => {
  // Templates "$T entry N target N sl N" identiques → cache partagé
  assert.strictEqual(
    hashText('$AAPL entry 150 target 160 sl 145'),
    hashText('$TSLA entry 250 target 270 sl 245')
  );
});

test('hashText: input null/undefined safe', () => {
  assert.strictEqual(hashText(null).length, 64);
  assert.strictEqual(hashText(undefined).length, 64);
});

// ── isEnabled / kill switch ─────────────────────────────────────────

test('isEnabled: false par défaut (pas d\'env)', () => {
  delete process.env.LLM_CLASSIFY_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual(isEnabled(), false);
});

test('isEnabled: false si flag mais pas d\'API key', () => {
  process.env.LLM_CLASSIFY_ENABLED = 'true';
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual(isEnabled(), false);
});

test('isEnabled: false si API key mais flag != true', () => {
  process.env.LLM_CLASSIFY_ENABLED = 'false';
  process.env.ANTHROPIC_API_KEY = 'fake';
  assert.strictEqual(isEnabled(), false);
});

test('isEnabled: true si flag=true ET API key présente', () => {
  process.env.LLM_CLASSIFY_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'fake';
  assert.strictEqual(isEnabled(), true);
});

// ── classify (cache hit + disabled) ─────────────────────────────────

test('classify: disabled → null sans appel', async () => {
  delete process.env.LLM_CLASSIFY_ENABLED;
  const r = await classify('DGNX 4.80-5.59');
  assert.strictEqual(r, null);
});

test('classify: cache hit court-circuite l\'API', async () => {
  process.env.LLM_CLASSIFY_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'fake-not-real';
  const text = 'CACHED TEST 1.0-2.0';
  const hash = hashText(text);
  // Pre-populate avec le model versionné (sinon mismatch → cache miss)
  db.llmClassifyPut(hash, text, 'exit',
    { type: 'exit', ticker: 'CACHED', low: 1, high: 2, confidence: 0.9 },
    `${DEFAULT_MODEL}#${PROMPT_VERSION}`);
  const r = await classify(text);
  assert.ok(r);
  assert.strictEqual(r.cached, true);
  assert.strictEqual(r.type, 'exit');
  assert.strictEqual(r.entities.ticker, 'CACHED');
});

test('classify: cache miss si PROMPT_VERSION ne match pas (= ré-classifie)', async () => {
  process.env.LLM_CLASSIFY_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'fake-not-real';
  const text = 'STALE TEST 5.0-6.0';
  const hash = hashText(text);
  // Pre-populate avec une ancienne version du prompt
  db.llmClassifyPut(hash, text, 'exit',
    { type: 'exit', ticker: 'STALE', low: 5, high: 6, confidence: 0.9 },
    `${DEFAULT_MODEL}#v0`);
  // Avec la version courante différente, le cache hit doit être ignoré.
  // L'API call va échouer (clé fake) → null. Mais l'important : on n'a
  // PAS retourné le cache stale.
  const r = await classify(text);
  // r === null car l'API call a échoué (fake key), MAIS critique : on ne
  // doit PAS avoir cached:true (sinon on aurait retourné le stale).
  if (r !== null) {
    assert.notStrictEqual(r.cached, true,
      'cache hit non-versionné aurait dû être ignoré');
  }
});

test('classify: texte vide → null sans appel', async () => {
  const r = await classify('');
  assert.strictEqual(r, null);
});

test('VALID_TYPES contient les 5 catégories', () => {
  assert.strictEqual(VALID_TYPES.size, 5);
  for (const t of ['entry', 'exit', 'ipo', 'passthrough', 'ignore']) {
    assert.ok(VALID_TYPES.has(t));
  }
});

// Cleanup
test('cleanup tmpDir', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── parseExtraction (mode multi-signal) ─────────────────────────────

const { parseExtraction, hashExtractText } = require('./llm-classify');

test('parseExtraction: array de signaux valides', () => {
  const r = parseExtraction('[{"ticker":"HPAI","side":"long","entry":1.5,"target":1.57,"confidence":0.9}]');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ticker, 'HPAI');
  assert.strictEqual(r[0].entry, 1.5);
  assert.strictEqual(r[0].target, 1.57);
  assert.strictEqual(r[0].side, 'long');
  assert.strictEqual(r[0].stop, null);
});

test('parseExtraction: array vide accepté', () => {
  assert.deepStrictEqual(parseExtraction('[]'), []);
});

test('parseExtraction: filtre signaux sans entry+target+ticker', () => {
  const r = parseExtraction('[{"ticker":"X","entry":5,"target":6,"confidence":0.8},{"ticker":"Y","entry":5,"confidence":0.8},{"entry":5,"target":6,"confidence":0.8}]');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ticker, 'X');
});

test('parseExtraction: code fence stripped', () => {
  const r = parseExtraction('```json\n[{"ticker":"X","entry":5,"target":6,"confidence":0.8}]\n```');
  assert.strictEqual(r.length, 1);
});

test('parseExtraction: garbage → null', () => {
  assert.strictEqual(parseExtraction('not json'), null);
  assert.strictEqual(parseExtraction(''), null);
  assert.strictEqual(parseExtraction(null), null);
});

test('parseExtraction: non-array (objet) → null', () => {
  assert.strictEqual(parseExtraction('{"ticker":"X"}'), null);
});

test('parseExtraction: side normalisé (long par défaut, short reconnu)', () => {
  const r = parseExtraction('[{"ticker":"X","side":"short","entry":5,"target":3,"confidence":0.9},{"ticker":"Y","side":"unknown","entry":5,"target":6,"confidence":0.9}]');
  assert.strictEqual(r[0].side, 'short');
  assert.strictEqual(r[1].side, 'long');  // unknown → long default
});

test('parseExtraction: confidence clampée [0,1]', () => {
  const r = parseExtraction('[{"ticker":"X","entry":5,"target":6,"confidence":2.5}]');
  assert.strictEqual(r[0].confidence, 1);
});

test('parseExtraction: ticker uppercased', () => {
  const r = parseExtraction('[{"ticker":"hpai","entry":1.5,"target":1.57,"confidence":0.9}]');
  assert.strictEqual(r[0].ticker, 'HPAI');
});

test('hashExtractText: différent de hashText pour le même texte', () => {
  const text = 'WL for 11.05 $HPAI break';
  assert.notStrictEqual(hashText(text), hashExtractText(text));
});

test('hashExtractText: déterministe + insensible aux espaces', () => {
  assert.strictEqual(hashExtractText('  $HPAI  '), hashExtractText('$HPAI'));
});

// ── Isolation guarantee (no tools / no web / no external access) ─────

const { assertNoExternalAccess, FORBIDDEN_API_PARAMS } = require('./llm-classify');

test('assertNoExternalAccess: payload propre passe', () => {
  assert.doesNotThrow(() => {
    assertNoExternalAccess({
      model: 'foo', max_tokens: 100, temperature: 0,
      system: [{ type: 'text', text: 'system' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});

test('assertNoExternalAccess: throw si tools présent', () => {
  assert.throws(() => assertNoExternalAccess({ model: 'foo', tools: [{ name: 'web' }] }),
    /LLM_ISOLATION_VIOLATED.*tools/);
});

test('assertNoExternalAccess: throw si tool_choice présent', () => {
  assert.throws(() => assertNoExternalAccess({ model: 'foo', tool_choice: 'auto' }),
    /LLM_ISOLATION_VIOLATED.*tool_choice/);
});

test('assertNoExternalAccess: throw si mcp_servers présent', () => {
  assert.throws(() => assertNoExternalAccess({ model: 'foo', mcp_servers: [{ url: 'x' }] }),
    /LLM_ISOLATION_VIOLATED.*mcp_servers/);
});

test('assertNoExternalAccess: throw si thinking présent', () => {
  assert.throws(() => assertNoExternalAccess({ model: 'foo', thinking: { type: 'enabled' } }),
    /LLM_ISOLATION_VIOLATED.*thinking/);
});

test('assertNoExternalAccess: throw si documents présent', () => {
  assert.throws(() => assertNoExternalAccess({ model: 'foo', documents: [] }),
    /LLM_ISOLATION_VIOLATED.*documents/);
});

test('FORBIDDEN_API_PARAMS contient les vecteurs d\'accès externe connus', () => {
  for (const param of ['tools', 'tool_choice', 'mcp_servers', 'thinking', 'documents', 'attachments']) {
    assert.ok(FORBIDDEN_API_PARAMS.includes(param), `should forbid ${param}`);
  }
});

// ── abstractTemplate (cache template-based) ─────────────────────────

const { abstractTemplate } = require('./llm-classify');

test('abstractTemplate: prose avec ticker all-caps → ticker abstrait en T', () => {
  assert.strictEqual(
    abstractTemplate('Added too! Best sympathy to HSPT with far lower float'),
    'added too! best sympathy to t with far lower float'
  );
});

test('abstractTemplate: $TICKER toujours abstrait en $T (même en all-caps)', () => {
  assert.strictEqual(abstractTemplate('BUY $AAPL NOW'), 'buy $t now');
});

test('abstractTemplate: message all-caps ne perd pas ses tickers standalone', () => {
  // En mode shouty (all caps), on n'abstrait QUE les $TICKER pour
  // préserver le sens des mots ("DGNX" reste "dgnx", pas "t").
  assert.strictEqual(abstractTemplate('DGNX 4.80-5.59'), 'dgnx p-p');
});

test('abstractTemplate: décimaux → P, entiers → N (ordre important)', () => {
  assert.strictEqual(abstractTemplate('$X 4.80 to 5'), '$t p to n');
});

test('abstractTemplate: empty/null safe', () => {
  assert.strictEqual(abstractTemplate(''), '');
  assert.strictEqual(abstractTemplate(null), '');
  assert.strictEqual(abstractTemplate(undefined), '');
});

test('abstractTemplate: variations de coaching → même template', () => {
  const a = abstractTemplate('Added too! Best sympathy to HSPT with far lower float');
  const b = abstractTemplate('Added too! Best sympathy to AAPL with far lower float');
  const c = abstractTemplate('Added too! Best sympathy to XYZ with far lower float');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

test('abstractTemplate: structures distinctes restent distinctes', () => {
  const coaching = abstractTemplate('Added too! Best sympathy to HSPT with far lower float');
  const signal = abstractTemplate('$AAPL entry 150 target 160 sl 145');
  assert.notStrictEqual(coaching, signal);
});

test('abstractTemplate: case mixed normalisé en lowercase', () => {
  const out = abstractTemplate('Mixed CASE prose with $XYZ');
  assert.ok(/^[a-z\s\$\d\-\.\!\?]+$/i.test(out));
  assert.ok(out.includes('$t'));
});
