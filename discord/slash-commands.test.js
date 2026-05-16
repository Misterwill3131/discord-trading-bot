const { test } = require('node:test');
const assert = require('node:assert');
const { createSlashCommands } = require('./slash-commands');

function makeFakeMarketData(overrides = {}) {
  return {
    getQuote: async () => null,
    getRatiosTtm: async () => null,
    getPriceTargetSummary: async () => null,
    getEarningsSurprises: async () => null,
    getInsiderTrades: async () => null,
    getSenateTrades: async () => null,
    getHouseTrades: async () => null,
    ...overrides,
  };
}

function makeFakeInteraction({ commandName, ticker = 'AAPL' } = {}) {
  const calls = { defer: [], edit: [] };
  return {
    commandName,
    isChatInputCommand: () => true,
    options: {
      getString: (key) => (key === 'ticker' ? ticker : null),
    },
    deferReply: async (opts) => { calls.defer.push(opts); },
    editReply: async (payload) => { calls.edit.push(payload); },
    _calls: calls,
  };
}

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

test('register() with SLASH_COMMAND_GUILD_ID set targets the guild', async () => {
  delete process.env.SLASH_COMMAND_GUILD_ID;
  process.env.SLASH_COMMAND_GUILD_ID = 'guild-123';
  try {
    let guildSetCalled = null;
    let globalSetCalled = null;
    const fakeClient = {
      application: { commands: { set: async (defs) => { globalSetCalled = defs; } } },
      guilds: { fetch: async (id) => ({ commands: { set: async (defs) => { guildSetCalled = { id, defs }; } } }) },
    };
    const sc = createSlashCommands({ marketData: makeFakeMarketData(), logger: SILENT_LOGGER });
    await sc.register(fakeClient);
    assert.ok(guildSetCalled, 'guild.commands.set should have been called');
    assert.strictEqual(guildSetCalled.id, 'guild-123');
    assert.strictEqual(guildSetCalled.defs.length, 3);
    assert.strictEqual(globalSetCalled, null, 'global registration should NOT happen when guild is set');
  } finally {
    delete process.env.SLASH_COMMAND_GUILD_ID;
  }
});

test('register() without SLASH_COMMAND_GUILD_ID falls back to global', async () => {
  delete process.env.SLASH_COMMAND_GUILD_ID;
  let globalSetCalled = null;
  const fakeClient = {
    application: { commands: { set: async (defs) => { globalSetCalled = defs; } } },
    guilds: { fetch: async () => { throw new Error('should not be called'); } },
  };
  const sc = createSlashCommands({ marketData: makeFakeMarketData(), logger: SILENT_LOGGER });
  await sc.register(fakeClient);
  assert.ok(globalSetCalled, 'global commands.set should have been called');
  assert.strictEqual(globalSetCalled.length, 3);
  const names = globalSetCalled.map(d => d.name).sort();
  assert.deepStrictEqual(names, ['analyze', 'insider', 'politicians']);
});

test('handleAnalyze posts ephemeral embed with all sections when data is complete', async () => {
  const marketData = makeFakeMarketData({
    getQuote: async () => ({ source: 'fmp', price: 198.42, changePct: 1.23, dayHigh: 199.85, dayLow: 195.10, name: 'Apple Inc.' }),
    getRatiosTtm: async () => ({ source: 'fmp', peRatio: 32.4, eps: 6.13, marketCap: 3e12 }),
    getPriceTargetSummary: async () => ({ source: 'fmp', targetMean: 215, targetHigh: 250, targetLow: 180, numberOfAnalysts: 12 }),
    getEarningsSurprises: async () => ({ source: 'fmp', mostRecent: { date: '2026-04-30', epsActual: 1.53, epsEstimate: 1.50, beat: true, surprisePct: 2.0 } }),
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'analyze', ticker: 'AAPL' });
  await sc.handleAnalyze(interaction);
  assert.strictEqual(interaction._calls.defer.length, 1);
  assert.strictEqual(interaction._calls.defer[0].ephemeral, true);
  assert.strictEqual(interaction._calls.edit.length, 1);
  const payload = interaction._calls.edit[0];
  assert.ok(Array.isArray(payload.embeds));
  assert.strictEqual(payload.embeds.length, 1);
  const embedJson = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data;
  const text = JSON.stringify(embedJson);
  assert.ok(text.includes('AAPL'));
  assert.ok(text.includes('198.42'));
  assert.ok(text.includes('32.4'));
  assert.ok(text.includes('215'));
  assert.ok(text.includes('1.53'));
});

test('handleAnalyze replies with no-data message when all sources return null', async () => {
  const sc = createSlashCommands({ marketData: makeFakeMarketData(), logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'analyze', ticker: 'XYZ' });
  await sc.handleAnalyze(interaction);
  assert.strictEqual(interaction._calls.edit.length, 1);
  const payload = interaction._calls.edit[0];
  assert.ok(payload.content && payload.content.includes('not found'));
});

test('handleInsider posts ephemeral embed with 5 transactions', async () => {
  const marketData = makeFakeMarketData({
    getInsiderTrades: async () => ({
      source: 'fmp',
      trades: [
        { date: '2026-05-12', name: 'COOK TIMOTHY', type: 'S-Sale', shares: 10000, price: 198.00, value: 1980000 },
        { date: '2026-05-08', name: 'ADAMS KATHERINE', type: 'P-Purchase', shares: 2500, price: 195.50, value: 488750 },
      ],
    }),
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'insider', ticker: 'AAPL' });
  await sc.handleInsider(interaction);
  const payload = interaction._calls.edit[0];
  const text = JSON.stringify(payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data);
  assert.ok(text.includes('COOK TIMOTHY'));
  assert.ok(text.includes('ADAMS KATHERINE'));
});

test('handlePoliticians combines senate + house and posts embed', async () => {
  const marketData = makeFakeMarketData({
    getSenateTrades: async () => ({
      source: 'fmp',
      trades: [{ date: '2026-05-10', name: 'Pelosi', type: 'Purchase', amount: '$15,001 - $50,000' }],
    }),
    getHouseTrades: async () => ({
      source: 'fmp',
      trades: [{ date: '2026-05-05', name: 'McCaul', type: 'Sale', amount: '$1,001 - $15,000' }],
    }),
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'politicians', ticker: 'AAPL' });
  await sc.handlePoliticians(interaction);
  const payload = interaction._calls.edit[0];
  const text = JSON.stringify(payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0].data);
  assert.ok(text.includes('Pelosi'));
  assert.ok(text.includes('McCaul'));
});

test('handler error path posts ephemeral error message instead of throwing', async () => {
  const marketData = makeFakeMarketData({
    getQuote: async () => { throw new Error('FMP unavailable'); },
  });
  const sc = createSlashCommands({ marketData, logger: SILENT_LOGGER });
  const interaction = makeFakeInteraction({ commandName: 'analyze', ticker: 'AAPL' });
  await sc.handleAnalyze(interaction);
  assert.strictEqual(interaction._calls.edit.length, 1);
  const payload = interaction._calls.edit[0];
  assert.ok(payload.content && payload.content.includes('unavailable'));
});
