// ─────────────────────────────────────────────────────────────────────
// trading/broker.js — PaperBroker (in-memory) + IBKRBroker (real)
// ─────────────────────────────────────────────────────────────────────
// Deux classes, un même contrat :
//
//   placeBracket({ticker, qty, orderType, entryPrice, tpPrice, trailPct})
//     → { parentId, tpId, slId }
//   closePosition(ticker) → close les positions ouvertes + cancel children
//   cancelOrder(orderId)
//   getAccount() → { equity, cash }
//   getOpenPositions() → [{ ticker, qty, parentId, status, ... }]
//
// Events via EventEmitter :
//   'orderStatus' { orderId, status, avgFillPrice?, kind?, ticker, qty }
//     status ∈ 'Filled'|'Cancelled'|'Rejected'
//     kind   ∈ 'parent'|'tp'|'sl'|'manual_exit'
//
// PaperBroker est autosuffisant — utilise `marketData` pour obtenir un
// prix de référence à la simulation des fills. Pas de persistance (state
// perdu au restart), OK : les vraies positions sont dans la DB.
// ─────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('events');

// ── PaperBroker ──────────────────────────────────────────────────────
class PaperBroker extends EventEmitter {
  constructor({ initialEquity = 100000, marketData }) {
    super();
    this.equity = initialEquity;
    this.cash = initialEquity;
    this.marketData = marketData;
    this.positions = new Map(); // parentId → position
    this.orders = new Map();    // orderId → order
    this._nextId = 1;
  }

  _id() { return 'P' + (this._nextId++); }

  async _lastPrice(ticker) {
    const bars = await this.marketData.fetchCandles(ticker, '5Min', 1);
    if (!bars || bars.length === 0) return null;
    return bars[bars.length - 1].c;
  }

  async getAccount() {
    return { equity: this.equity, cash: this.cash };
  }

  async placeBracket({ ticker, qty, orderType, entryPrice, tpPrice, trailPct }) {
    const parentId = this._id();
    const tpId = this._id();
    const slId = this._id();
    const current = await this._lastPrice(ticker);
    const fillPrice = orderType === 'market' ? current : entryPrice;

    const pos = {
      ticker, qty, entryPrice: fillPrice,
      parentId, tpId, slId, tpPrice, trailPct,
      status: 'pending',
      peakPrice: fillPrice,
    };
    this.positions.set(parentId, pos);
    this.orders.set(parentId, { parentId, kind: 'parent', ticker, qty, status: 'PendingSubmit' });
    this.orders.set(tpId,     { parentId, kind: 'tp',     ticker, qty, status: 'PendingSubmit' });
    this.orders.set(slId,     { parentId, kind: 'sl',     ticker, qty, status: 'PendingSubmit' });

    const shouldFill = orderType === 'market'
      || (orderType === 'limit' && current != null && current <= entryPrice);

    if (shouldFill) {
      pos.status = 'open';
      const ord = this.orders.get(parentId);
      ord.status = 'Filled';
      setImmediate(() => {
        this.emit('orderStatus', {
          orderId: parentId, status: 'Filled', kind: 'parent',
          ticker, qty, avgFillPrice: fillPrice,
        });
      });
    }
    return { parentId, tpId, slId };
  }

  async closePosition(ticker) {
    for (const [pid, pos] of this.positions.entries()) {
      if (pos.ticker !== ticker || pos.status === 'closed') continue;
      pos.status = 'closed';
      const exitPrice = await this._lastPrice(ticker);
      this.orders.get(pos.tpId).status = 'Cancelled';
      this.orders.get(pos.slId).status = 'Cancelled';
      setImmediate(() => {
        this.emit('orderStatus', {
          orderId: pid, status: 'Filled', kind: 'manual_exit',
          ticker, qty: pos.qty, avgFillPrice: exitPrice,
        });
      });
    }
  }

  async cancelOrder(orderId) {
    const ord = this.orders.get(orderId);
    if (!ord) return;
    ord.status = 'Cancelled';
    setImmediate(() => {
      this.emit('orderStatus', {
        orderId, status: 'Cancelled', kind: ord.kind,
        ticker: ord.ticker, qty: ord.qty,
      });
    });
  }

  getOpenPositions() {
    const out = [];
    for (const pos of this.positions.values()) {
      if (pos.status === 'pending' || pos.status === 'open') out.push(pos);
    }
    return out;
  }
}

// ── IBKRBroker — stub, implemented in Task 7 ─────────────────────────
class IBKRBroker extends EventEmitter {
  constructor() {
    super();
    throw new Error('IBKRBroker not yet implemented — see Task 7');
  }
}

function createBroker({ mode, marketData, initialEquity, ibkr }) {
  if (mode === 'paper') {
    return new PaperBroker({ initialEquity, marketData });
  }
  if (mode === 'live') {
    return new IBKRBroker(ibkr);
  }
  throw new Error('Unknown broker mode: ' + mode);
}

module.exports = { PaperBroker, IBKRBroker, createBroker };
