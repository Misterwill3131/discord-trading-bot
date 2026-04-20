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
    const tpId = tpPrice != null ? this._id() : null;
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
    if (tpId) this.orders.set(tpId, { parentId, kind: 'tp', ticker, qty, status: 'PendingSubmit' });
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
      if (pos.tpId) this.orders.get(pos.tpId).status = 'Cancelled';
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

// ── IBKRBroker — via @stoqey/ib ──────────────────────────────────────
// Nécessite un IB Gateway (ou TWS) qui tourne et écoute sur `port`.
// Paper (Gateway) : 4002. Live (Gateway) : 4001.
//
// Pas de tests unitaires ici : logique fine (composer les objets du SDK).
// Validation en paper manuel.
//
// @stoqey/ib spécifiques :
//   • `new Stock(ticker, 'SMART', 'USD')` → contrat actions US
//   • `Order` est un *plain object* (pas un constructeur)
//   • `OrderAction.BUY/SELL`, `OrderType.MKT/LMT/TRAIL` sont des string enums
//   • `orderStatus` event: (orderId, status, filled, remaining, avgFillPrice, ...)
class IBKRBroker extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 4002, clientId = 1 } = {}) {
    super();
    const ib = require('@stoqey/ib');
    this._ib = ib;
    this._host = host;
    this._port = port;
    this.api = new ib.IBApi({ host, port, clientId });
    this._nextId = 1000;
    this._account = { equity: 0, cash: 0 };
    this._ordersByParent = new Map();
    this._connected = false;
  }

  async connect() {
    if (this._connected) return;
    const { EventName } = this._ib;
    const host = this._host;
    const port = this._port;
    console.log('[ibkr] connecting to ' + host + ':' + port + ' ...');
    await new Promise((resolve, reject) => {
      let timeoutHandle;
      const cleanup = () => {
        this.api.off(EventName.connected, onConnected);
        this.api.off(EventName.error, onError);
        clearTimeout(timeoutHandle);
      };
      const onConnected = () => { cleanup(); console.log('[ibkr] connected'); resolve(); };
      const onError = (err) => {
        cleanup();
        reject(new Error('IBKR connect error: ' + (err && err.message ? err.message : err)));
      };
      this.api.once(EventName.connected, onConnected);
      this.api.once(EventName.error, onError);
      this.api.connect();
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('IBKR connect timeout after 10s — gateway unreachable at ' + host + ':' + port));
      }, 10000);
      timeoutHandle.unref && timeoutHandle.unref();
    });
    this._connected = true;

    this.api.on(EventName.orderStatus, (orderId, status, _filled, _remaining, avgFillPrice) => {
      let kind = null, ticker = null, qty = null;
      for (const [pid, info] of this._ordersByParent.entries()) {
        if (pid === orderId) { kind = 'parent'; ticker = info.ticker; qty = info.qty; break; }
        if (info.tpId === orderId) { kind = 'tp'; ticker = info.ticker; qty = info.qty; break; }
        if (info.slId === orderId) { kind = 'sl'; ticker = info.ticker; qty = info.qty; break; }
      }
      this.emit('orderStatus', { orderId: String(orderId), status, kind, ticker, qty, avgFillPrice });
    });

    this.api.on(EventName.accountSummary, (_reqId, _account, tag, value) => {
      if (tag === 'NetLiquidation') this._account.equity = parseFloat(value);
      if (tag === 'TotalCashValue') this._account.cash = parseFloat(value);
    });
    this.api.reqAccountSummary(1, 'All', 'NetLiquidation,TotalCashValue');
  }

  _id() { return this._nextId++; }

  _stockContract(ticker) {
    return new this._ib.Stock(ticker, 'SMART', 'USD');
  }

  async placeBracket({ ticker, qty, orderType, entryPrice, tpPrice, trailPct }) {
    await this.connect();
    const { OrderAction, OrderType } = this._ib;
    const contract = this._stockContract(ticker);
    const parentId = this._id();
    const tpId = tpPrice != null ? this._id() : null;
    const slId = this._id();

    const parent = {
      action: OrderAction.BUY,
      totalQuantity: qty,
      orderType: orderType === 'market' ? OrderType.MKT : OrderType.LMT,
      orderId: parentId,
      transmit: false,
    };
    if (orderType !== 'market') parent.lmtPrice = entryPrice;

    // trailing stop — dernier child, transmit:true pour trigger le bracket.
    const sl = {
      action: OrderAction.SELL,
      totalQuantity: qty,
      orderType: OrderType.TRAIL,
      trailingPercent: trailPct,
      parentId,
      orderId: slId,
      transmit: true,
    };

    this._ordersByParent.set(parentId, { ticker, qty, tpId, slId });

    this.api.placeOrder(parentId, contract, parent);

    // TP optionnel : si tpPrice fourni, place l'ordre limit entre parent et SL.
    if (tpId) {
      const tp = {
        action: OrderAction.SELL,
        totalQuantity: qty,
        orderType: OrderType.LMT,
        lmtPrice: tpPrice,
        parentId,
        orderId: tpId,
        transmit: false,
      };
      this.api.placeOrder(tpId, contract, tp);
    }

    this.api.placeOrder(slId, contract, sl);

    return {
      parentId: String(parentId),
      tpId: tpId != null ? String(tpId) : null,
      slId: String(slId),
    };
  }

  async closePosition(ticker, qty) {
    await this.connect();
    const { OrderAction, OrderType } = this._ib;
    // 1. Cancel bracket enfants du ticker.
    for (const [, info] of this._ordersByParent.entries()) {
      if (info.ticker !== ticker) continue;
      try { this.api.cancelOrder(info.tpId); } catch (_) {}
      try { this.api.cancelOrder(info.slId); } catch (_) {}
    }
    // 2. Market SELL pour fermer — qty fournie par le caller (engine.onExit).
    if (!qty || qty <= 0) return { exitId: null };
    const contract = this._stockContract(ticker);
    const exitId = this._id();
    this.api.placeOrder(exitId, contract, {
      action: OrderAction.SELL,
      totalQuantity: qty,
      orderType: OrderType.MKT,
      orderId: exitId,
      transmit: true,
    });
    return { exitId: String(exitId) };
  }

  async cancelOrder(orderId) {
    await this.connect();
    this.api.cancelOrder(Number(orderId));
  }

  async getAccount() {
    return { equity: this._account.equity, cash: this._account.cash };
  }

  async getOpenPositions() {
    const { EventName } = this._ib;
    return new Promise((resolve) => {
      const positions = [];
      const handler = (_account, contract, pos, avgCost) => {
        positions.push({ ticker: contract.symbol, qty: pos, avgCost });
      };
      const done = () => {
        this.api.off(EventName.position, handler);
        this.api.off(EventName.positionEnd, done);
        resolve(positions);
      };
      this.api.on(EventName.position, handler);
      this.api.once(EventName.positionEnd, done);
      this.api.reqPositions();
    });
  }

  // Récupère les bougies historiques via IBKR (remplace la fetch Alpaca).
  // `timeframe` accepte le format IBKR direct ('5 mins', '1 hour') ou Alpaca-style
  // ('5Min', '1Hour') qu'on traduit.
  // Retourne un array `[{t, o, h, l, c, v}]` compatible avec indicators.js.
  async getHistoricalBars(ticker, timeframe = '5 mins', limit = 50) {
    await this.connect();
    const { EventName } = this._ib;
    const contract = this._stockContract(ticker);
    const reqId = this._id();

    // Traduction Alpaca → IBKR si besoin.
    const barSize = _normalizeTimeframe(timeframe);
    // 1 D couvre 78 bars de 5min en RTH, largement suffisant pour 50 bars.
    const duration = '1 D';

    return new Promise((resolve, reject) => {
      const bars = [];
      let timeoutHandle;

      const cleanup = () => {
        this.api.off(EventName.historicalData, onData);
        this.api.off(EventName.historicalDataEnd, onEnd);
        this.api.off(EventName.error, onError);
        clearTimeout(timeoutHandle);
      };

      const onData = (id, time, open, high, low, close, volume) => {
        if (id !== reqId) return;
        // Filtre les lignes "finished" (event.time === 'finished') qu'IBKR emet parfois.
        if (typeof time === 'string' && time.startsWith('finished')) return;
        bars.push({ t: time, o: open, h: high, l: low, c: close, v: volume });
      };

      const onEnd = (id) => {
        if (id !== reqId) return;
        cleanup();
        resolve(bars.slice(-limit));
      };

      const onError = (err, code, errReqId) => {
        if (errReqId !== reqId) return;
        cleanup();
        reject(new Error('IBKR historicalData error (code ' + code + '): ' + (err && err.message ? err.message : err)));
      };

      this.api.on(EventName.historicalData, onData);
      this.api.on(EventName.historicalDataEnd, onEnd);
      this.api.on(EventName.error, onError);

      this.api.reqHistoricalData(
        reqId,
        contract,
        '',             // endDateTime = maintenant
        duration,       // '1 D'
        barSize,        // '5 mins'
        'TRADES',       // whatToShow
        1,              // useRTH (1 = régulier seulement)
        1,              // formatDate
        false,          // keepUpToDate
        []              // chartOptions
      );

      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('IBKR historicalData timeout after 15s'));
      }, 15000);
      timeoutHandle.unref && timeoutHandle.unref();
    });
  }

  async disconnect() {
    if (this._connected) {
      this.api.disconnect();
      this._connected = false;
    }
  }
}

// Traduit un timeframe style Alpaca ('5Min') vers le format IBKR ('5 mins').
// Accepte aussi le format IBKR direct ('5 mins', '1 hour').
function _normalizeTimeframe(tf) {
  if (!tf) return '5 mins';
  // Déjà en format IBKR ?
  if (/\s(mins?|hours?|day|week|month)\b/i.test(tf)) return tf;
  const m = /^(\d+)(Min|Hour|Day)s?$/i.exec(tf);
  if (!m) return '5 mins';
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'min')  return n + ' ' + (n === 1 ? 'min' : 'mins');
  if (unit === 'hour') return n + ' ' + (n === 1 ? 'hour' : 'hours');
  if (unit === 'day')  return n + ' day';
  return '5 mins';
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
