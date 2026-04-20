const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketData } = require('./marketdata');

const sampleBars = [
  { t: '2026-04-19T13:30:00Z', o: 200, h: 201, l: 199.5, c: 200.7, v: 10000 },
  { t: '2026-04-19T13:35:00Z', o: 200.7, h: 201.2, l: 200.3, c: 201.0, v: 12000 },
];

function makeFakeBroker(bars = sampleBars, opts = {}) {
  let callCount = 0;
  const broker = {
    async getHistoricalBars(_ticker, _timeframe, _limit) {
      callCount++;
      if (opts.throwErr) throw opts.throwErr;
      return bars;
    },
  };
  broker.getCallCount = () => callCount;
  return broker;
}

test('fetchCandles calls broker.getHistoricalBars with forwarded args', async () => {
  let captured = null;
  const broker = {
    async getHistoricalBars(ticker, timeframe, limit) {
      captured = { ticker, timeframe, limit };
      return sampleBars;
    },
  };
  const md = createMarketData({ broker });
  const bars = await md.fetchCandles('TSLA', '5 mins', 50);
  assert.deepStrictEqual(captured, { ticker: 'TSLA', timeframe: '5 mins', limit: 50 });
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[1].c, 201.0);
});

test('fetchCandles caches identical requests for 30s', async () => {
  const broker = makeFakeBroker();
  const md = createMarketData({
    broker,
    cacheTtlMs: 30000,
    now: () => 1000,
  });
  await md.fetchCandles('TSLA', '5 mins', 50);
  await md.fetchCandles('TSLA', '5 mins', 50);
  assert.strictEqual(broker.getCallCount(), 1, 'second call should hit cache');
});

test('fetchCandles refetches after TTL expires', async () => {
  const broker = makeFakeBroker();
  let t = 1000;
  const md = createMarketData({
    broker,
    cacheTtlMs: 30000,
    now: () => t,
  });
  await md.fetchCandles('TSLA', '5 mins', 50);
  t = 1000 + 30001;
  await md.fetchCandles('TSLA', '5 mins', 50);
  assert.strictEqual(broker.getCallCount(), 2);
});

test('fetchCandles throws when broker has no getHistoricalBars', async () => {
  const md = createMarketData({ broker: {} });
  await assert.rejects(
    md.fetchCandles('TSLA', '5 mins', 50),
    /no broker with getHistoricalBars/
  );
});

test('fetchCandles propagates broker errors', async () => {
  const broker = makeFakeBroker([], { throwErr: new Error('IBKR disconnect') });
  const md = createMarketData({ broker });
  await assert.rejects(
    md.fetchCandles('TSLA', '5 mins', 50),
    /IBKR disconnect/
  );
});

test('fetchBars override takes precedence over broker', async () => {
  const broker = makeFakeBroker();
  let fetchBarsCalled = false;
  const md = createMarketData({
    broker,
    fetchBars: async () => { fetchBarsCalled = true; return sampleBars; },
  });
  await md.fetchCandles('TSLA', '5 mins', 50);
  assert.strictEqual(fetchBarsCalled, true);
  assert.strictEqual(broker.getCallCount(), 0);
});
