const { test } = require('node:test');
const assert = require('node:assert');
const { buildPayloadSummary, generateCaption } = require('./caption-llm');

test('buildPayloadSummary recap : compute green/combined/top picks', () => {
  const s = buildPayloadSummary('TobTradeRecap', {
    dateLabel: 'TODAY',
    trades: [
      { ticker: '$AEHL', entryPrice: 1.44, hodPrice: 6.27 },
      { ticker: '$QUCY', entryPrice: 0.44, hodPrice: 2.11 },
      { ticker: '$DGXX', entryPrice: 9.16, hodPrice: 8.60 },
      { ticker: '$LNKS', entryPrice: 1.39, hodPrice: 2.47 },
    ],
    longTermInvestments: [{ ticker: '$POET', entryPrice: 7, currentPrice: 18.40 }],
  });
  assert.strictEqual(s.type, 'recap');
  assert.strictEqual(s.tradesCount, 4);
  assert.strictEqual(s.green, 3);  // AEHL, QUCY, LNKS positifs ; DGXX négatif
  assert.strictEqual(s.successRate, 75);
  assert.ok(s.combinedGainPct > 0);
  assert.strictEqual(s.topPicks.length, 4);  // sort by gain desc
  assert.match(s.topPicks[0], /\$QUCY/);  // QUCY +380% est le top
  assert.strictEqual(s.longTermCount, 1);
});

test('buildPayloadSummary single-trade : passthrough ticker + pnl', () => {
  const s = buildPayloadSummary('ChartTemplate', {
    ticker: 'TDIC',
    pnl: '+160%',
    entryPrice: 1.43,
    exitPrice: 3.71,
    entryAuthor: 'ZZ',
    exitAuthor: 'AR',
  });
  assert.strictEqual(s.type, 'single-trade');
  assert.strictEqual(s.ticker, 'TDIC');
  assert.strictEqual(s.pnl, '+160%');
});

test('buildPayloadSummary strips $ prefix from tickers', () => {
  const s = buildPayloadSummary('ChartTemplate', { ticker: '$$$NVDA' });
  assert.strictEqual(s.ticker, 'NVDA');
});

test('generateCaption returns null when ANTHROPIC_API_KEY missing', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await generateCaption('TobTradeRecap', { trades: [{ ticker: '$X', entryPrice: 1, hodPrice: 2 }] }, 'discord');
    assert.strictEqual(r, null);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('generateCaption throws on unsupported platform', async () => {
  await assert.rejects(
    () => generateCaption('TobTradeRecap', {}, 'snapchat', { apiKey: 'sk-test' }),
    /Unknown platform/,
  );
});

test('generateCaption calls Anthropic API and strips wrapping quotes', async () => {
  // Mock fetch-like : Anthropic SDK uses node-fetch internally. The
  // simpler mock path is to override the Anthropic client constructor.
  // Mais comme on instancie via `new Anthropic({apiKey})` à l'intérieur
  // de la fonction, on monkey-patch global fetch.
  const origFetch = global.fetch;
  let bodyText = null;
  global.fetch = async (url, opts) => {
    bodyText = opts && opts.body;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json', forEach: () => {}, entries: () => [][Symbol.iterator]() },
      json: async () => ({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '"4 trades, 3 winners, combined +400%. Boom."' }],
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20 },
      }),
    };
  };
  try {
    const r = await generateCaption(
      'TobTradeRecap',
      { trades: [{ ticker: '$A', entryPrice: 1, hodPrice: 2 }] },
      'discord',
      { apiKey: 'sk-test' },
    );
    // Wrapping quotes "..." stripped
    assert.strictEqual(r, '4 trades, 3 winners, combined +400%. Boom.');
    // Body should reference the platform prompt + the summary
    assert.ok(bodyText && bodyText.includes('Temple of Boom'));
  } finally {
    global.fetch = origFetch;
  }
});

test('generateCaption caches by composition + platform + payload', async () => {
  let callCount = 0;
  const origFetch = global.fetch;
  global.fetch = async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json', forEach: () => {}, entries: () => [][Symbol.iterator]() },
      json: async () => ({
        id: 'msg', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'cached caption' }],
        model: 'claude-haiku-4-5', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };
  try {
    const payload = { trades: [{ ticker: '$Z', entryPrice: 1, hodPrice: 2 }] };
    const r1 = await generateCaption('TobTradeRecap', payload, 'discord', { apiKey: 'sk' });
    const r2 = await generateCaption('TobTradeRecap', payload, 'discord', { apiKey: 'sk' });
    assert.strictEqual(r1, 'cached caption');
    assert.strictEqual(r2, 'cached caption');
    assert.strictEqual(callCount, 1);  // second call hits cache
  } finally {
    global.fetch = origFetch;
  }
});
