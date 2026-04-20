// ─────────────────────────────────────────────────────────────────────
// trading/engine.js — Orchestrateur du cycle de vie d'un trade
// ─────────────────────────────────────────────────────────────────────
// Expose :
//   onEntry(signal)    — filtres + sizing + placeBracket
//   onExit(signal)     — match auteur+ticker, close position
//   reconcile()        — check DB vs IBKR au boot
//   handleOrderEvent() — hook sur broker 'orderStatus'
//
// `config` est une *fonction* qui renvoie le config courant — permet
// au dashboard de modifier un param et qu'il soit pris en compte au
// prochain signal sans redémarrer.
// ─────────────────────────────────────────────────────────────────────

const { computeIndicators } = require('./indicators');

const {
  insertPosition,
  updatePositionOrderIds,
  countOpenPositions,
  getPositionByTickerAndAuthor,
  getOpenPositions,
  markPositionOpen,
  markPositionClosed,
  markPositionCancelled,
  markPositionError,
  getPositionByIbkrParentId,
} = require('../db/sqlite');

const EXIT_KEYWORDS = ['exit', 'sortie', 'stop', 'cut'];

function createEngine({ config, marketData, broker, now = () => new Date(), logger = console, notifier = null }) {
  const cfg = () => (typeof config === 'function' ? config() : config);

  // Notifier : fonction optionnelle `(message: string) => void` qui envoie
  // une alerte (ex : Discord channel). No-op silencieux si absent.
  function notify(message) {
    if (!notifier) return;
    try { notifier(message); } catch (err) { logger.error('[trading] notifier error:', err.message); }
  }

  async function onEntry(signal) {
    const c = cfg();

    if (!c.tradingEnabled) {
      logger.log('[trading] skip disabled', signal.ticker);
      return { skipped: 'disabled' };
    }

    if (c.authorWhitelist && c.authorWhitelist.length > 0) {
      if (!c.authorWhitelist.includes(signal.author)) {
        return { skipped: 'not_whitelisted' };
      }
    }

    // Per-(ticker, author) dedup first — re-entry on an existing position
    // would otherwise mislabel as max_positions if many positions exist.
    const existing = getPositionByTickerAndAuthor(signal.ticker, signal.author);
    if (existing) {
      return { skipped: 'already_held' };
    }

    const openCount = countOpenPositions();
    if (openCount >= c.maxConcurrentPositions) {
      return { skipped: 'max_positions' };
    }

    const tf = (c.tfMinutes || 5) + 'Min';
    const bars = await marketData.fetchCandles(signal.ticker, tf, 50);
    const { rsi, ema20, ema9, lastPrice } = computeIndicators(bars);
    if (rsi == null || ema20 == null || ema9 == null || lastPrice == null) {
      return { skipped: 'not_enough_data' };
    }
    if (rsi <= 50 || lastPrice <= ema20 || lastPrice <= ema9) {
      return { skipped: 'technical', detail: { rsi, ema20, ema9, lastPrice } };
    }

    const toleranceMult = 1 + (c.tolerancePct / 100);
    const orderType = lastPrice <= signal.entry_price * toleranceMult ? 'market' : 'limit';

    const account = await broker.getAccount();
    const riskDollars = account.equity * (c.riskPerTradePct / 100);
    const slDistancePerShare = signal.entry_price * (c.trailingStopPct / 100);
    const qty = Math.floor(riskDollars / slDistancePerShare);
    if (qty < 1) {
      return { skipped: 'qty_too_small', detail: { riskDollars, slDistancePerShare } };
    }

    const slPrice = signal.entry_price * (1 - c.trailingStopPct / 100);

    const positionId = insertPosition({
      ticker: signal.ticker,
      author: signal.author,
      entry_price: signal.entry_price,
      quantity: qty,
      sl_price: slPrice,
      tp_price: signal.target_price,
      raw_signal: JSON.stringify(signal),
    });

    let orderResult;
    try {
      orderResult = await broker.placeBracket({
        ticker: signal.ticker,
        qty,
        orderType,
        entryPrice: signal.entry_price,
        tpPrice: signal.target_price,
        trailPct: c.trailingStopPct,
      });
    } catch (err) {
      markPositionError(positionId, err.message);
      return { skipped: 'broker_error', detail: err.message };
    }

    updatePositionOrderIds(positionId, {
      ibkr_parent_id: orderResult.parentId,
      ibkr_tp_id:     orderResult.tpId,
      ibkr_sl_id:     orderResult.slId,
    });

    if (orderType === 'limit') {
      const timeoutMs = (c.limitOrderTimeoutMin || 30) * 60 * 1000;
      setTimeout(() => {
        const row = getPositionByIbkrParentId(orderResult.parentId);
        if (row && row.status === 'pending') {
          broker.cancelOrder(orderResult.parentId).catch(() => {});
          markPositionCancelled(row.id, { closed_at: now().toISOString() });
          notify('❌ **CANCEL** $' + signal.ticker + ' (limit timeout ' + (c.limitOrderTimeoutMin || 30) + 'min)');
        }
      }, timeoutMs).unref();
    }

    notify(
      '📥 **' + orderType.toUpperCase() + ' ENTRY** $' + signal.ticker + '\n'
      + '• Author: ' + signal.author + '\n'
      + '• Qty: ' + qty + ' @ entry ' + signal.entry_price + '\n'
      + '• TP: ' + signal.target_price + ' (+' + ((signal.target_price/signal.entry_price - 1) * 100).toFixed(2) + '%)\n'
      + '• SL: trailing ' + c.trailingStopPct + '% (' + slPrice.toFixed(2) + ' initial)\n'
      + '• Risk: ' + (account.equity * c.riskPerTradePct / 100).toFixed(2)
    );

    return { placed: true, positionId, qty, orderType };
  }

  async function onExit(signal) {
    const c = cfg();
    if (!c.tradingEnabled) return { skipped: 'disabled' };
    const row = getPositionByTickerAndAuthor(signal.ticker, signal.author);
    if (!row) return { skipped: 'no_matching_position' };

    try {
      if (row.ibkr_tp_id) await broker.cancelOrder(row.ibkr_tp_id).catch(() => {});
      if (row.ibkr_sl_id) await broker.cancelOrder(row.ibkr_sl_id).catch(() => {});
      await broker.closePosition(signal.ticker, row.quantity);
    } catch (err) {
      logger.error('[trading] closePosition failed:', err.message);
      return { skipped: 'broker_error', detail: err.message };
    }

    return { closed: true, positionId: row.id };
  }

  async function reconcile() {
    const dbOpen = getOpenPositions();
    let ibkrPositions = [];
    try {
      ibkrPositions = await broker.getOpenPositions();
    } catch (err) {
      logger.error('[trading] reconcile: broker getOpenPositions failed:', err.message);
      return { ok: false, reason: 'broker_unavailable' };
    }
    const ibkrByTicker = new Map();
    for (const p of ibkrPositions) {
      ibkrByTicker.set(p.ticker, (ibkrByTicker.get(p.ticker) || 0) + (p.qty || 0));
    }

    const mismatches = [];
    for (const row of dbOpen) {
      const ibkrQty = ibkrByTicker.get(row.ticker) || 0;
      if (row.status === 'open' && ibkrQty !== row.quantity) {
        mismatches.push({ id: row.id, ticker: row.ticker, db: row.quantity, ibkr: ibkrQty });
        markPositionError(row.id, 'reconcile mismatch ibkr=' + ibkrQty + ' db=' + row.quantity);
      }
    }
    if (mismatches.length > 0) {
      logger.error('[trading] reconcile MISMATCH — trading will remain disabled until resolved', mismatches);
      return { ok: false, mismatches };
    }
    return { ok: true };
  }

  function handleOrderEvent(event) {
    if (!event || !event.orderId) return;

    if (event.kind === 'parent') {
      if (event.status === 'Filled') {
        const row = getPositionByIbkrParentId(String(event.orderId));
        if (row && row.status === 'pending') {
          markPositionOpen(row.id, {
            fill_price: event.avgFillPrice,
            opened_at: now().toISOString(),
          });
          notify('✅ **FILLED** $' + row.ticker + ' ' + row.quantity + ' @ ' + event.avgFillPrice);
        }
      } else if (event.status === 'Cancelled' || event.status === 'Rejected') {
        const row = getPositionByIbkrParentId(String(event.orderId));
        if (row && row.status === 'pending') {
          markPositionCancelled(row.id, { closed_at: now().toISOString() });
          notify('❌ **' + event.status.toUpperCase() + '** $' + row.ticker + ' (parent order)');
        }
      }
      return;
    }

    if (event.kind === 'tp' || event.kind === 'sl' || event.kind === 'manual_exit') {
      if (event.status !== 'Filled') return;
      const open = getOpenPositions().filter(r => r.ticker === event.ticker && r.status === 'open');
      for (const row of open) {
        const exit = event.avgFillPrice;
        const entry = row.fill_price != null ? row.fill_price : row.entry_price;
        const pnl = (exit - entry) * row.quantity;
        const reason = event.kind === 'tp' ? 'tp' :
                       event.kind === 'sl' ? 'sl' : 'manual_exit';
        markPositionClosed(row.id, {
          close_reason: reason,
          exit_price: exit,
          closed_at: now().toISOString(),
          pnl,
        });
        const emoji = pnl > 0 ? '💰' : (pnl < 0 ? '🛑' : '⏹️');
        const pctLabel = entry ? ((exit / entry - 1) * 100).toFixed(2) + '%' : '';
        notify(
          emoji + ' **' + reason.toUpperCase() + '** $' + row.ticker + '\n'
          + '• Exit ' + exit + ' (entry ' + entry + ', ' + pctLabel + ')\n'
          + '• P&L: ' + pnl.toFixed(2)
        );
      }
      return;
    }
  }

  return { onEntry, onExit, reconcile, handleOrderEvent, EXIT_KEYWORDS };
}

module.exports = { createEngine, EXIT_KEYWORDS };
