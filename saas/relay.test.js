// ─────────────────────────────────────────────────────────────────────
// saas/relay.test.js — Tests des filtres de relais
// ─────────────────────────────────────────────────────────────────────
// Couvre :
//   - shouldRelay : passe sans bloquer l'auteur (humain ou bot)
//   - isAuthorBlocked : denylist par nom (case-insensitive substring)
//   - loadBlockedBotNames : env var override + fallback default
// ─────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert');

const {
  shouldRelay,
  isAuthorBlocked,
  isPassthroughBot,
  loadBlockedBotNames,
  loadPassthroughBotNames,
  DEFAULT_BLOCKED_BOT_NAMES,
  DEFAULT_PASSTHROUGH_BOT_NAMES,
} = require('./relay');

// ── shouldRelay ────────────────────────────────────────────────────────

test('shouldRelay: false si message null', () => {
  assert.strictEqual(shouldRelay(null, { entry_price: 1 }), false);
});

test('shouldRelay: false si dto null', () => {
  assert.strictEqual(shouldRelay({ id: '1' }, null), false);
});

test('shouldRelay: false si entry_price null', () => {
  assert.strictEqual(shouldRelay({ id: '1' }, { entry_price: null }), false);
});

test('shouldRelay: false si entry_price NaN', () => {
  assert.strictEqual(shouldRelay({ id: '1' }, { entry_price: NaN }), false);
});

test('shouldRelay: true si entry_price fini (humain)', () => {
  const msg = { id: '1', author: { bot: false, username: 'alice' } };
  assert.strictEqual(shouldRelay(msg, { entry_price: 10.45 }), true);
});

test('shouldRelay: true si entry_price fini (bot non-bloqué) — autorise les bots upstream', () => {
  const msg = { id: '1', author: { bot: true, username: 'alertbot' } };
  assert.strictEqual(shouldRelay(msg, { entry_price: 10.45 }), true);
});

// ── isAuthorBlocked ────────────────────────────────────────────────────

test('isAuthorBlocked: false pour humain (author.bot=false)', () => {
  const msg = { author: { bot: false, username: 'trendvision' } };
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision']), false);
});

test('isAuthorBlocked: true pour bot dont username = "trendvision"', () => {
  const msg = { author: { bot: true, username: 'trendvision' } };
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision', 'frogoracle']), true);
});

test('isAuthorBlocked: true pour bot "frogoracle"', () => {
  const msg = { author: { bot: true, username: 'frogoracle' } };
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision', 'frogoracle']), true);
});

test('isAuthorBlocked: case-insensitive — "TrendVision Bot" → true', () => {
  const msg = { author: { bot: true, username: 'TrendVision Bot' } };
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision']), true);
});

test('isAuthorBlocked: substring match — "FrogOracle#1234" → true', () => {
  const msg = { author: { bot: true, username: 'FrogOracle#1234' } };
  assert.strictEqual(isAuthorBlocked(msg, ['frogoracle']), true);
});

test('isAuthorBlocked: false pour bot non-listé ("alertbot")', () => {
  const msg = { author: { bot: true, username: 'alertbot' } };
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision', 'frogoracle']), false);
});

test('isAuthorBlocked: false si pas d\'auteur', () => {
  assert.strictEqual(isAuthorBlocked({}, ['trendvision']), false);
  assert.strictEqual(isAuthorBlocked(null, ['trendvision']), false);
});

test('isAuthorBlocked: false si username vide', () => {
  const msg = { author: { bot: true, username: '' } };
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision']), false);
});

test('isAuthorBlocked: utilise DEFAULT_BLOCKED_BOT_NAMES si liste non passée', () => {
  const msg = { author: { bot: true, username: 'FrogOracle' } };
  assert.strictEqual(isAuthorBlocked(msg), true);
});

test('DEFAULT_BLOCKED_BOT_NAMES contient frogoracle (trendvision est passthrough)', () => {
  assert.ok(DEFAULT_BLOCKED_BOT_NAMES.includes('frogoracle'));
  assert.ok(!DEFAULT_BLOCKED_BOT_NAMES.includes('trendvision'));
});

// ── loadBlockedBotNames ────────────────────────────────────────────────

test('loadBlockedBotNames: fallback aux defaults sans env', () => {
  const prev = process.env.SAAS_BLOCKED_BOT_NAMES;
  delete process.env.SAAS_BLOCKED_BOT_NAMES;
  try {
    const list = loadBlockedBotNames();
    assert.deepStrictEqual(list.sort(), [...DEFAULT_BLOCKED_BOT_NAMES].sort());
  } finally {
    if (prev !== undefined) process.env.SAAS_BLOCKED_BOT_NAMES = prev;
  }
});

test('loadBlockedBotNames: env override (csv) — lowercased + trimmed', () => {
  const prev = process.env.SAAS_BLOCKED_BOT_NAMES;
  process.env.SAAS_BLOCKED_BOT_NAMES = ' Foo , BAR ,baz';
  try {
    assert.deepStrictEqual(loadBlockedBotNames(), ['foo', 'bar', 'baz']);
  } finally {
    if (prev === undefined) delete process.env.SAAS_BLOCKED_BOT_NAMES;
    else process.env.SAAS_BLOCKED_BOT_NAMES = prev;
  }
});

test('loadBlockedBotNames: env vide → fallback aux defaults', () => {
  const prev = process.env.SAAS_BLOCKED_BOT_NAMES;
  process.env.SAAS_BLOCKED_BOT_NAMES = '';
  try {
    const list = loadBlockedBotNames();
    assert.deepStrictEqual(list.sort(), [...DEFAULT_BLOCKED_BOT_NAMES].sort());
  } finally {
    if (prev === undefined) delete process.env.SAAS_BLOCKED_BOT_NAMES;
    else process.env.SAAS_BLOCKED_BOT_NAMES = prev;
  }
});

// ── Régression : "HCAI 10.45 <@&id>" depuis un bot non-listé doit passer ──

test('régression: signal "HCAI 10.45" d\'un bot non-listé → shouldRelay true', () => {
  const { buildSignalDTO } = require('./anonymize');
  const msg = {
    id: '1',
    content: 'HCAI 10.45 <@&1330929339134640179>',
    author: { bot: true, username: 'alertbot' },
    createdAt: new Date(),
  };
  const dto = buildSignalDTO(msg);
  assert.strictEqual(dto.entry_price, 10.45);
  assert.strictEqual(dto.ticker, 'HCAI');
  assert.strictEqual(shouldRelay(msg, dto), true);
  assert.strictEqual(isAuthorBlocked(msg, ['trendvision', 'frogoracle']), false);
});

test('régression: même signal depuis "frogoracle" → bloqué par denylist', () => {
  const { buildSignalDTO } = require('./anonymize');
  const msg = {
    id: '2',
    content: 'HCAI 10.45 <@&1330929339134640179>',
    author: { bot: true, username: 'FrogOracle' },
    createdAt: new Date(),
  };
  const dto = buildSignalDTO(msg);
  // shouldRelay reste true (signal valide), mais isAuthorBlocked le filtre
  assert.strictEqual(shouldRelay(msg, dto), true);
  assert.strictEqual(isAuthorBlocked(msg), true);
});

// ── Passthrough bots (relay raw text, no embed) ────────────────────────

test('isPassthroughBot: true pour bot "trendvision"', () => {
  const msg = { author: { bot: true, username: 'trendvision' } };
  assert.strictEqual(isPassthroughBot(msg, ['trendvision']), true);
});

test('isPassthroughBot: case-insensitive — "TrendVision Bot" → true', () => {
  const msg = { author: { bot: true, username: 'TrendVision Bot' } };
  assert.strictEqual(isPassthroughBot(msg, ['trendvision']), true);
});

test('isPassthroughBot: false pour humain', () => {
  const msg = { author: { bot: false, username: 'trendvision' } };
  assert.strictEqual(isPassthroughBot(msg, ['trendvision']), false);
});

test('isPassthroughBot: false pour bot non-listé', () => {
  const msg = { author: { bot: true, username: 'alertbot' } };
  assert.strictEqual(isPassthroughBot(msg, ['trendvision']), false);
});

test('isPassthroughBot: utilise DEFAULT_PASSTHROUGH_BOT_NAMES si liste non passée', () => {
  const msg = { author: { bot: true, username: 'TrendVision' } };
  assert.strictEqual(isPassthroughBot(msg), true);
});

test('DEFAULT_PASSTHROUGH_BOT_NAMES contient trendvision', () => {
  assert.ok(DEFAULT_PASSTHROUGH_BOT_NAMES.includes('trendvision'));
});

test('loadPassthroughBotNames: fallback aux defaults sans env', () => {
  const prev = process.env.SAAS_PASSTHROUGH_BOT_NAMES;
  delete process.env.SAAS_PASSTHROUGH_BOT_NAMES;
  try {
    const list = loadPassthroughBotNames();
    assert.deepStrictEqual(list.sort(), [...DEFAULT_PASSTHROUGH_BOT_NAMES].sort());
  } finally {
    if (prev !== undefined) process.env.SAAS_PASSTHROUGH_BOT_NAMES = prev;
  }
});

test('loadPassthroughBotNames: env override (csv) — lowercased + trimmed', () => {
  const prev = process.env.SAAS_PASSTHROUGH_BOT_NAMES;
  process.env.SAAS_PASSTHROUGH_BOT_NAMES = ' TrendVision , OtherBot ';
  try {
    assert.deepStrictEqual(loadPassthroughBotNames(), ['trendvision', 'otherbot']);
  } finally {
    if (prev === undefined) delete process.env.SAAS_PASSTHROUGH_BOT_NAMES;
    else process.env.SAAS_PASSTHROUGH_BOT_NAMES = prev;
  }
});

test('passthrough et blocked sont disjoints — un bot ne peut pas être les deux par défaut', () => {
  for (const passthrough of DEFAULT_PASSTHROUGH_BOT_NAMES) {
    assert.ok(!DEFAULT_BLOCKED_BOT_NAMES.includes(passthrough),
      `${passthrough} ne doit pas être à la fois passthrough et blocked`);
  }
});

// ── Régression : status updates (PT hit, etc.) rejetés par shouldRelay ──

test('régression: "UONE first PT hit 6.30-7.50" → shouldRelay=false (status update)', () => {
  const { buildSignalDTO } = require('./anonymize');
  const msg = {
    id: '3',
    content: 'UONE first PT hit 6.30-7.50',
    author: { bot: false, username: 'trader' },
    createdAt: new Date(),
  };
  const dto = buildSignalDTO(msg);
  // Le parser extrait un range, MAIS is_exit_update=true le filtre
  assert.strictEqual(dto.entry_price, 6.30);
  assert.strictEqual(dto.is_exit_update, true);
  assert.strictEqual(shouldRelay(msg, dto), false);
});

test('régression: "$FATN buy only above $3.81" → shouldRelay=true (signal valide)', () => {
  const { buildSignalDTO } = require('./anonymize');
  const msg = {
    id: '4',
    content: '$FATN buy only above $3.81 Targets $4.18/4.64/5.24 SL $3.04',
    author: { bot: false, username: 'trader' },
    createdAt: new Date(),
  };
  const dto = buildSignalDTO(msg);
  assert.strictEqual(dto.is_exit_update, false);
  assert.strictEqual(shouldRelay(msg, dto), true);
});
