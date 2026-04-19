// Minimal IBKR connection spike. Delete after Task 0 passes.
// Connects → reads NetLiquidation → disconnects. No orders.
const { IBApi, EventName } = require('@stoqey/ib');

const HOST = process.env.IBKR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.IBKR_PORT || '7497', 10);
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '1', 10);

const api = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });

let gotSummary = false;
const timeout = setTimeout(() => {
  console.error('TIMEOUT - no response after 10s. Check Gateway is running and API is enabled.');
  try { api.disconnect(); } catch (_) {}
  process.exit(2);
}, 10_000);

api.on(EventName.error, (err, code, reqId) => {
  console.log('[ibkr event] error:', { code, reqId, msg: (err && err.message) || err });
});

api.on(EventName.connected, () => {
  console.log('[ibkr] connected to', HOST + ':' + PORT);
  api.reqAccountSummary(9001, 'All', 'NetLiquidation,TotalCashValue');
});

api.on(EventName.accountSummary, (_reqId, account, tag, value, currency) => {
  console.log('[ibkr] accountSummary:', { account, tag, value, currency });
  if (tag === 'NetLiquidation') gotSummary = true;
});

api.on(EventName.accountSummaryEnd, () => {
  clearTimeout(timeout);
  console.log('[ibkr] accountSummaryEnd - success:', gotSummary);
  api.disconnect();
  process.exit(gotSummary ? 0 : 1);
});

api.connect();
