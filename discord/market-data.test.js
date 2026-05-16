const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketData } = require('./market-data');

function makeFakeFmp({ overrides = {} } = {}) {
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

function makeFakeYahoo({ overrides = {} } = {}) {
  return {
    getQuote: async () => null,
    getQuoteSummary: async () => null,
    getEarningsHistory: async () => null,
    getInsiderTransactions: async () => null,
    getFinancialData: async () => null,
    ...overrides,
  };
}

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

// ── getRatiosTtm ─────────────────────────────────────────────────
test('getRatiosTtm uses FMP when FMP returns data', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getRatiosTtm: async () => ({ peRatioTTM: 32.4, netIncomePerShareTTM: 6.13, marketCapTTM: 3e12 }),
  }});
  const yahooClient = makeFakeYahoo();
  const md = createMarketData({ fmpClient, yahooClient, logger: SILENT_LOGGER });
  const r = await md.getRatiosTtm('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.peRatio, 32.4);
  assert.strictEqual(r.eps, 6.13);
  assert.strictEqual(r.marketCap, 3e12);
});

test('getRatiosTtm falls back to Yahoo when FMP returns null', async () => {
  const fmpClient = makeFakeFmp();  // all null
  const yahooClient = makeFakeYahoo({ overrides: {
    getQuoteSummary: async () => ({
      summaryDetail: { trailingPE: 28.0, marketCap: 2.5e12 },
      defaultKeyStatistics: { trailingEps: 5.50 },
    }),
  }});
  const md = createMarketData({ fmpClient, yahooClient, logger: SILENT_LOGGER });
  const r = await md.getRatiosTtm('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.peRatio, 28.0);
  assert.strictEqual(r.eps, 5.50);
  assert.strictEqual(r.marketCap, 2.5e12);
});

test('getRatiosTtm returns null when both FMP and Yahoo fail', async () => {
  const md = createMarketData({
    fmpClient: makeFakeFmp(),
    yahooClient: makeFakeYahoo(),
    logger: SILENT_LOGGER,
  });
  assert.strictEqual(await md.getRatiosTtm('NOPE'), null);
});

// ── getPriceTargetSummary ────────────────────────────────────────
test('getPriceTargetSummary uses FMP when present', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getPriceTargetSummary: async () => ({
      lastMonthAvgPriceTarget: 215, lastQuarterAvgPriceTarget: 210, allTimeAvgPriceTarget: 200,
    }),
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getPriceTargetSummary('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.targetMean, 215);
});

test('getPriceTargetSummary falls back to Yahoo financialData', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getFinancialData: async () => ({
      targetMeanPrice: { raw: 215 }, targetHighPrice: { raw: 250 }, targetLowPrice: { raw: 180 },
      numberOfAnalystOpinions: { raw: 12 },
    }),
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getPriceTargetSummary('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.targetMean, 215);
  assert.strictEqual(r.targetHigh, 250);
  assert.strictEqual(r.numberOfAnalysts, 12);
});

// ── getEarningsSurprises ─────────────────────────────────────────
test('getEarningsSurprises uses FMP first result (most recent)', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getEarningsSurprises: async () => [
      { date: '2026-04-30', eps: 1.53, estimatedEps: 1.50 },
      { date: '2026-01-30', eps: 2.10, estimatedEps: 2.05 },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getEarningsSurprises('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.mostRecent.date, '2026-04-30');
  assert.strictEqual(r.mostRecent.epsActual, 1.53);
  assert.strictEqual(r.mostRecent.epsEstimate, 1.50);
  assert.strictEqual(r.mostRecent.beat, true);
});

test('getEarningsSurprises falls back to Yahoo earningsHistory', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getEarningsHistory: async () => [
      { quarter: { fmt: '2026-04-30' }, epsActual: { raw: 1.53 }, epsEstimate: { raw: 1.50 } },
    ],
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getEarningsSurprises('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.mostRecent.date, '2026-04-30');
  assert.strictEqual(r.mostRecent.beat, true);
});

// ── getInsiderTrades ─────────────────────────────────────────────
test('getInsiderTrades uses FMP and unifies shape', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getInsiderTrades: async () => [
      { filingDate: '2026-05-12', transactionType: 'S-Sale', reportingName: 'COOK TIMOTHY', securitiesTransacted: 10000, price: 198.00 },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getInsiderTrades('AAPL', 5);
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].name, 'COOK TIMOTHY');
  assert.strictEqual(r.trades[0].shares, 10000);
});

test('getInsiderTrades falls back to Yahoo insiderTransactions', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getInsiderTransactions: async () => [
      { filerName: 'COOK TIMOTHY', transactionText: 'Sale', shares: { raw: 10000 }, value: { raw: 1980000 }, startDate: { fmt: '2026-05-12' } },
    ],
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getInsiderTrades('AAPL', 5);
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.trades[0].name, 'COOK TIMOTHY');
});

// ── getSenateTrades / getHouseTrades (FMP-only) ──────────────────
test('getSenateTrades returns FMP data (no Yahoo fallback)', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getSenateTrades: async () => [
      { transactionDate: '2026-05-10', senator: 'Pelosi', type: 'Purchase', amount: '$15,001 - $50,000' },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getSenateTrades('AAPL', 5);
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.trades.length, 1);
  assert.strictEqual(r.trades[0].name, 'Pelosi');
});

test('getSenateTrades returns null when FMP returns null (no Yahoo fallback)', async () => {
  const md = createMarketData({
    fmpClient: makeFakeFmp(),
    yahooClient: makeFakeYahoo(),
    logger: SILENT_LOGGER,
  });
  assert.strictEqual(await md.getSenateTrades('NOPE', 5), null);
});

test('getHouseTrades returns FMP data with unified shape', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getHouseTrades: async () => [
      { disclosureDate: '2026-05-05', representative: 'McCaul', type: 'Sale', amount: '$1,001 - $15,000' },
    ],
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getHouseTrades('AAPL', 5);
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.trades[0].name, 'McCaul');
});

// ── getQuote (FMP first, Yahoo fallback) ─────────────────────────
test('getQuote uses FMP when present', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getQuote: async () => ({ price: 198.42, volume: 12345678 }),
  }});
  const md = createMarketData({ fmpClient, yahooClient: makeFakeYahoo(), logger: SILENT_LOGGER });
  const r = await md.getQuote('AAPL');
  assert.strictEqual(r.source, 'fmp');
  assert.strictEqual(r.price, 198.42);
});

test('getQuote falls back to Yahoo when FMP returns null', async () => {
  const yahooClient = makeFakeYahoo({ overrides: {
    getQuote: async () => ({
      regularMarketPrice: 198.42, regularMarketVolume: 12345678,
      regularMarketDayHigh: 199.85, regularMarketDayLow: 195.10,
      regularMarketChangePercent: 1.23, longName: 'Apple Inc.',
    }),
  }});
  const md = createMarketData({ fmpClient: makeFakeFmp(), yahooClient, logger: SILENT_LOGGER });
  const r = await md.getQuote('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.price, 198.42);
  assert.strictEqual(r.name, 'Apple Inc.');
});

// ── FMP throws → fallback to Yahoo ───────────────────────────────
test('FMP throwing an error triggers Yahoo fallback (does not propagate)', async () => {
  const fmpClient = makeFakeFmp({ overrides: {
    getRatiosTtm: async () => { throw new Error('FMP unavailable'); },
  }});
  const yahooClient = makeFakeYahoo({ overrides: {
    getQuoteSummary: async () => ({
      summaryDetail: { trailingPE: 28.0 }, defaultKeyStatistics: { trailingEps: 5.50 },
    }),
  }});
  const md = createMarketData({ fmpClient, yahooClient, logger: SILENT_LOGGER });
  const r = await md.getRatiosTtm('AAPL');
  assert.strictEqual(r.source, 'yahoo');
  assert.strictEqual(r.peRatio, 28.0);
});
