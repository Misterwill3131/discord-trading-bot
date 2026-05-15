const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildNarrationText,
  buildTobTradeRecapNarration,
  buildChartTemplateNarration,
  buildBoomEntryNarration,
  buildBoomRecapNarration,
} = require('./narration');

// ── TobTradeRecap ────────────────────────────────────────────────
test('buildTobTradeRecapNarration mentions count + green + top picks', () => {
  const text = buildTobTradeRecapNarration({
    dateLabel: 'TODAY',
    trades: [
      { ticker: '$AEHL', entryPrice: 1.44, hodPrice: 6.27 },
      { ticker: '$QUCY', entryPrice: 0.44, hodPrice: 2.11 },
      { ticker: '$DGXX', entryPrice: 9.16, hodPrice: 8.60 },
    ],
  });
  assert.ok(text);
  assert.match(text, /3 trades/);
  assert.match(text, /2 out of 3 green/);
  assert.match(text, /\$AEHL at \+379%|\$QUCY at \+380%|\$AEHL/);
  assert.match(text, /Top picks/);
});

test('buildTobTradeRecapNarration returns null with empty trades', () => {
  assert.strictEqual(buildTobTradeRecapNarration({ trades: [] }), null);
  assert.strictEqual(buildTobTradeRecapNarration({}), null);
});

test('buildTobTradeRecapNarration keeps non-TODAY dateLabel as-is', () => {
  const text = buildTobTradeRecapNarration({
    dateLabel: 'MAY 14',
    trades: [{ ticker: 'TSLA', entryPrice: 200, hodPrice: 210 }],
  });
  assert.match(text, /MAY 14 recap/);
});

// ── ChartTemplate ────────────────────────────────────────────────
test('buildChartTemplateNarration uses entry+exit prices when available', () => {
  const text = buildChartTemplateNarration({
    ticker: 'TDIC',
    pnl: '+160%',
    entryPrice: 1.43,
    exitPrice: 3.71,
  });
  assert.match(text, /\$TDIC/);
  assert.match(text, /1\.43/);
  assert.match(text, /3\.71/);
  assert.match(text, /\+160%/);
  assert.match(text, /Temple of Boom/);
});

test('buildChartTemplateNarration falls back when prices missing', () => {
  const text = buildChartTemplateNarration({ ticker: 'NVDA', pnl: '+8%' });
  assert.match(text, /\$NVDA/);
  assert.match(text, /\+8%/);
  assert.doesNotMatch(text, /Entered at/);
});

test('buildChartTemplateNarration null without ticker', () => {
  assert.strictEqual(buildChartTemplateNarration({}), null);
});

// ── BoomEntry ────────────────────────────────────────────────────
test('buildBoomEntryNarration mentions ticker + cleans message', () => {
  const text = buildBoomEntryNarration({
    ticker: 'WOK',
    message: '$WOK 2.00-2.40 <a:fire:123456> entry',
  });
  assert.match(text, /\$WOK/);
  assert.match(text, /2\.00-2\.40/);
  assert.doesNotMatch(text, /<a:/);
});

test('buildBoomEntryNarration null without ticker', () => {
  assert.strictEqual(buildBoomEntryNarration({}), null);
});

// ── BoomRecap ────────────────────────────────────────────────────
test('buildBoomRecapNarration mentions runners + top picks', () => {
  const text = buildBoomRecapNarration({
    tickers: [
      { ticker: '$RXT',  gainPct: 380 },
      { ticker: '$REPL', gainPct: 133 },
      { ticker: '$AIIO', gainPct: 71 },
    ],
    runnersHit: 5,
    runnersTotal: 6,
    totalGainPct: 700,
  });
  assert.match(text, /Daily recap/);
  assert.match(text, /5 out of 6 runners/);
  assert.match(text, /\+700%/);
  assert.match(text, /\$RXT at \+380%/);
});

// ── Dispatch ─────────────────────────────────────────────────────
test('buildNarrationText dispatches on composition string', () => {
  assert.ok(buildNarrationText('TobTradeRecap', {
    trades: [{ ticker: 'TSLA', entryPrice: 1, hodPrice: 2 }],
  }));
  assert.ok(buildNarrationText('ChartTemplate', { ticker: 'TSLA', pnl: '+5%' }));
  assert.strictEqual(buildNarrationText('UnknownComp', {}), null);
  assert.strictEqual(buildNarrationText('TobTradeRecap', null), null);
});
