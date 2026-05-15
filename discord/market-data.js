// ─────────────────────────────────────────────────────────────────────
// discord/market-data.js — Orchestrator FMP-first, Yahoo-fallback
// ─────────────────────────────────────────────────────────────────────
// Wraps fmpClient (REST FMP) and yahooClient (yahoo-finance2) to provide
// a unified market-data interface for slash commands. Each method tries
// FMP first ; if FMP returns null or throws, falls back to Yahoo. The
// returned shape includes `source: 'fmp' | 'yahoo'` so the caller can
// display attribution in the embed footer.
//
// 5 methods have a Yahoo fallback path :
//   getQuote, getRatiosTtm, getPriceTargetSummary, getEarningsSurprises,
//   getInsiderTrades.
//
// 2 methods are FMP-only (Yahoo has no equivalent) :
//   getSenateTrades, getHouseTrades.
//
// Spec : docs/superpowers/specs/2026-05-15-fmp-slash-commands-design.md
// ─────────────────────────────────────────────────────────────────────

function num(x) { return Number.isFinite(x) ? x : null; }

function fromYahooRaw(node) {
  // yahoo-finance2 sometimes wraps values in { raw: <number>, fmt: <string> }
  if (node == null) return null;
  if (typeof node === 'number') return Number.isFinite(node) ? node : null;
  if (typeof node === 'object' && 'raw' in node) return num(node.raw);
  return null;
}

function fromYahooDate(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && 'fmt' in node) return node.fmt;
  return null;
}

function createMarketData({ fmpClient, yahooClient, logger = console } = {}) {
  if (!fmpClient)   throw new Error('fmpClient required');
  if (!yahooClient) throw new Error('yahooClient required');

  async function getQuote(ticker) {
    try {
      const f = await fmpClient.getQuote(ticker);
      if (f && Number.isFinite(f.price)) {
        return { source: 'fmp', price: f.price, volume: num(f.volume), change: null, changePct: null, dayHigh: null, dayLow: null, name: null };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getQuote failed for ' + ticker + ': ' + err.message);
    }
    try {
      const y = await yahooClient.getQuote(ticker);
      if (y && Number.isFinite(y.regularMarketPrice)) {
        return {
          source: 'yahoo',
          price: y.regularMarketPrice,
          volume: num(y.regularMarketVolume),
          change: num(y.regularMarketChange),
          changePct: num(y.regularMarketChangePercent),
          dayHigh: num(y.regularMarketDayHigh),
          dayLow: num(y.regularMarketDayLow),
          name: y.longName || y.shortName || null,
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getQuote failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getRatiosTtm(ticker) {
    try {
      const f = await fmpClient.getRatiosTtm(ticker);
      if (f && f.peRatioTTM != null) {
        return {
          source: 'fmp',
          peRatio: num(f.peRatioTTM),
          eps: num(f.netIncomePerShareTTM),
          marketCap: num(f.marketCapTTM),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getRatiosTtm failed for ' + ticker + ': ' + err.message);
    }
    try {
      const y = await yahooClient.getQuoteSummary(ticker, ['summaryDetail', 'defaultKeyStatistics']);
      if (y) {
        const pe = y.summaryDetail && (typeof y.summaryDetail.trailingPE === 'number' ? y.summaryDetail.trailingPE : fromYahooRaw(y.summaryDetail.trailingPE));
        const eps = y.defaultKeyStatistics && (typeof y.defaultKeyStatistics.trailingEps === 'number' ? y.defaultKeyStatistics.trailingEps : fromYahooRaw(y.defaultKeyStatistics.trailingEps));
        const mc = y.summaryDetail && (typeof y.summaryDetail.marketCap === 'number' ? y.summaryDetail.marketCap : fromYahooRaw(y.summaryDetail.marketCap));
        if (pe != null || eps != null || mc != null) {
          return { source: 'yahoo', peRatio: pe, eps: eps, marketCap: mc };
        }
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getRatiosTtm failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getPriceTargetSummary(ticker) {
    try {
      const f = await fmpClient.getPriceTargetSummary(ticker);
      if (f && (f.lastMonthAvgPriceTarget != null || f.lastQuarterAvgPriceTarget != null || f.allTimeAvgPriceTarget != null)) {
        const targetMean = num(f.lastMonthAvgPriceTarget) || num(f.lastQuarterAvgPriceTarget) || num(f.allTimeAvgPriceTarget);
        return {
          source: 'fmp',
          targetMean,
          targetHigh: null,
          targetLow: null,
          numberOfAnalysts: num(f.lastMonth) || num(f.lastQuarter) || null,
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getPriceTargetSummary failed for ' + ticker + ': ' + err.message);
    }
    try {
      const fin = await yahooClient.getFinancialData(ticker);
      if (fin) {
        return {
          source: 'yahoo',
          targetMean: fromYahooRaw(fin.targetMeanPrice),
          targetHigh: fromYahooRaw(fin.targetHighPrice),
          targetLow:  fromYahooRaw(fin.targetLowPrice),
          numberOfAnalysts: fromYahooRaw(fin.numberOfAnalystOpinions),
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getPriceTargetSummary failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getEarningsSurprises(ticker) {
    try {
      const f = await fmpClient.getEarningsSurprises(ticker);
      if (Array.isArray(f) && f.length > 0) {
        const row = f[0];
        const actual = num(row.eps);
        const est = num(row.estimatedEps);
        return {
          source: 'fmp',
          mostRecent: {
            date: row.date || null,
            epsActual: actual,
            epsEstimate: est,
            beat: (actual != null && est != null) ? actual >= est : null,
            surprisePct: (actual != null && est != null && est !== 0) ? ((actual - est) / Math.abs(est)) * 100 : null,
          },
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getEarningsSurprises failed for ' + ticker + ': ' + err.message);
    }
    try {
      const hist = await yahooClient.getEarningsHistory(ticker);
      if (Array.isArray(hist) && hist.length > 0) {
        const latest = hist[hist.length - 1];   // Yahoo returns oldest-first
        const actual = fromYahooRaw(latest.epsActual);
        const est = fromYahooRaw(latest.epsEstimate);
        return {
          source: 'yahoo',
          mostRecent: {
            date: fromYahooDate(latest.quarter),
            epsActual: actual,
            epsEstimate: est,
            beat: (actual != null && est != null) ? actual >= est : null,
            surprisePct: (actual != null && est != null && est !== 0) ? ((actual - est) / Math.abs(est)) * 100 : null,
          },
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getEarningsSurprises failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getInsiderTrades(ticker, limit = 5) {
    try {
      const f = await fmpClient.getInsiderTrades(ticker, limit);
      if (Array.isArray(f) && f.length > 0) {
        return {
          source: 'fmp',
          trades: f.slice(0, limit).map(t => ({
            date: t.filingDate || null,
            name: t.reportingName || null,
            type: t.transactionType || null,
            shares: num(t.securitiesTransacted),
            price: num(t.price),
            value: (num(t.securitiesTransacted) != null && num(t.price) != null) ? t.securitiesTransacted * t.price : null,
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getInsiderTrades failed for ' + ticker + ': ' + err.message);
    }
    try {
      const y = await yahooClient.getInsiderTransactions(ticker);
      if (Array.isArray(y) && y.length > 0) {
        return {
          source: 'yahoo',
          trades: y.slice(0, limit).map(t => ({
            date: fromYahooDate(t.startDate),
            name: t.filerName || null,
            type: t.transactionText || null,
            shares: fromYahooRaw(t.shares),
            price: null,
            value: fromYahooRaw(t.value),
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] Yahoo getInsiderTrades failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getSenateTrades(ticker, limit = 5) {
    try {
      const f = await fmpClient.getSenateTrades(ticker, limit);
      if (Array.isArray(f) && f.length > 0) {
        return {
          source: 'fmp',
          trades: f.slice(0, limit).map(t => ({
            date: t.transactionDate || null,
            name: t.senator || null,
            type: t.type || null,
            amount: t.amount || null,
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getSenateTrades failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  async function getHouseTrades(ticker, limit = 5) {
    try {
      const f = await fmpClient.getHouseTrades(ticker, limit);
      if (Array.isArray(f) && f.length > 0) {
        return {
          source: 'fmp',
          trades: f.slice(0, limit).map(t => ({
            date: t.disclosureDate || null,
            name: t.representative || null,
            type: t.type || null,
            amount: t.amount || null,
          })),
        };
      }
    } catch (err) {
      logger.warn('[market-data] FMP getHouseTrades failed for ' + ticker + ': ' + err.message);
    }
    return null;
  }

  return {
    getQuote,
    getRatiosTtm,
    getPriceTargetSummary,
    getEarningsSurprises,
    getInsiderTrades,
    getSenateTrades,
    getHouseTrades,
  };
}

module.exports = { createMarketData };
