// ─────────────────────────────────────────────────────────────────────
// pages/trading.js — Dashboard de trading (positions + history + config)
// ─────────────────────────────────────────────────────────────────────
// HTML rendu côté serveur, JS vanilla pour les fetches.
// 3 onglets sans routing client — affichage/masquage via CSS.
// ─────────────────────────────────────────────────────────────────────

function renderTradingPage() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Trading — dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; background: #0b0f14; color: #e6edf3; }
  header { padding: 16px 24px; border-bottom: 1px solid #1f2933; display: flex; justify-content: space-between; align-items: center; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  nav { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid #1f2933; }
  nav button { background: transparent; color: #8b9bac; border: 0; padding: 10px 16px; cursor: pointer; font-weight: 500; }
  nav button.active { color: #e6edf3; border-bottom: 2px solid #4493f8; }
  main { padding: 24px; }
  .tab { display: none; }
  .tab.active { display: block; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1f2933; font-size: 13px; }
  th { font-weight: 500; color: #8b9bac; text-transform: uppercase; font-size: 11px; }
  .pnl-pos { color: #3fb950; }
  .pnl-neg { color: #f85149; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .chip-open { background: #1f3a5f; color: #4493f8; }
  .chip-pending { background: #3a3a1f; color: #e3b341; }
  .chip-closed { background: #163a1f; color: #3fb950; }
  .chip-cancelled { background: #333; color: #8b9bac; }
  .chip-error { background: #3a1616; color: #f85149; }
  button.danger { background: #f85149; color: #fff; border: 0; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
  button.primary { background: #238636; color: #fff; border: 0; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
  button.ghost { background: transparent; color: #8b9bac; border: 1px solid #1f2933; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .form-grid { display: grid; grid-template-columns: 220px 1fr; gap: 12px 16px; max-width: 600px; align-items: center; }
  .form-grid label { color: #8b9bac; font-size: 13px; }
  .form-grid input, .form-grid select { background: #0f1620; color: #e6edf3; border: 1px solid #1f2933; padding: 8px 12px; border-radius: 6px; width: 100%; box-sizing: border-box; }
  .kill-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; padding: 12px 16px; background: #0f1620; border: 1px solid #1f2933; border-radius: 6px; }
</style>
</head>
<body>
<header>
  <h1>Trading</h1>
  <a href="/dashboard" style="color: #8b9bac; text-decoration: none; font-size: 13px;">&larr; Dashboard</a>
</header>
<nav>
  <button data-tab="positions" class="active">Positions</button>
  <button data-tab="history">History</button>
  <button data-tab="config">Config</button>
</nav>
<main>
  <section id="tab-positions" class="tab active">
    <div class="kill-bar">
      <div id="kill-state">Loading&hellip;</div>
      <button id="btn-kill" class="ghost">Toggle kill-switch</button>
      <button id="btn-panic" class="danger">Panic &mdash; close all</button>
    </div>
    <table id="tbl-positions">
      <thead><tr><th>Ticker</th><th>Author</th><th>Qty</th><th>Entry</th><th>TP</th><th>SL%</th><th>Status</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section id="tab-history" class="tab">
    <table id="tbl-history">
      <thead><tr><th>Closed</th><th>Ticker</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th>P&amp;L</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section id="tab-config" class="tab">
    <form id="form-config" class="form-grid">
      <label>Trading enabled</label><input type="checkbox" name="tradingEnabled" />
      <label>Mode</label><select name="mode"><option>paper</option><option>live</option></select>
      <label>Risk per trade (%)</label><input type="number" step="0.05" name="riskPerTradePct" />
      <label>Tolerance (%)</label><input type="number" step="0.1" name="tolerancePct" />
      <label>Trailing stop (%)</label><input type="number" step="0.1" name="trailingStopPct" />
      <label>Take profit mode</label><select name="takeProfitMode"><option value="trail-only">trail-only (let winners run)</option><option value="fixed">fixed (close at signal target)</option></select>
      <label>Max concurrent positions</label><input type="number" step="1" name="maxConcurrentPositions" />
      <label>Limit order timeout (min)</label><input type="number" step="1" name="limitOrderTimeoutMin" />
      <label>Timeframe (minutes)</label><input type="number" step="1" name="tfMinutes" />
      <label>Author whitelist (comma-separated)</label><input type="text" name="authorWhitelist" />
      <div></div><button class="primary" type="submit">Save</button>
    </form>
  </section>
</main>
<script>
  const tabs = document.querySelectorAll('nav button');
  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'config') loadConfig();
  }));

  async function loadPositions() {
    const r = await fetch('/api/trading/positions').then(r => r.json());
    const tb = document.querySelector('#tbl-positions tbody');
    tb.innerHTML = '';
    (r.positions || []).forEach(p => {
      const tr = document.createElement('tr');
      const slPct = p.sl_price && p.entry_price ? ((1 - p.sl_price/p.entry_price)*100).toFixed(1) + '%' : '';
      tr.innerHTML = '<td>' + p.ticker + '</td>'
        + '<td>' + (p.author || '') + '</td>'
        + '<td>' + p.quantity + '</td>'
        + '<td>' + p.entry_price + '</td>'
        + '<td>' + (p.tp_price || '') + '</td>'
        + '<td>' + slPct + '</td>'
        + '<td><span class="chip chip-' + p.status + '">' + p.status + '</span></td>'
        + '<td><button class="ghost" data-close="' + p.id + '">Close</button></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('button[data-close]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Close position?')) return;
      const res = await fetch('/api/trading/positions/' + btn.dataset.close + '/close', { method: 'POST' });
      if (res.ok) loadPositions();
      else alert('Failed: ' + (await res.text()));
    }));
  }

  async function loadKillState() {
    const r = await fetch('/api/trading/config').then(r => r.json());
    const enabled = r.config && r.config.tradingEnabled;
    document.getElementById('kill-state').innerHTML = enabled
      ? '<span style="color:#3fb950">Trading ENABLED</span>'
      : '<span style="color:#8b9bac">Trading disabled</span>';
  }

  document.getElementById('btn-kill').addEventListener('click', async () => {
    const r = await fetch('/api/trading/config').then(r => r.json());
    await fetch('/api/trading/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !r.config.tradingEnabled }),
    });
    loadKillState();
  });

  document.getElementById('btn-panic').addEventListener('click', async () => {
    if (!confirm('Close ALL positions at market and disable trading?')) return;
    const res = await fetch('/api/trading/panic', { method: 'POST' });
    const body = await res.json();
    alert('Closed tickers: ' + (body.tickersClosed || []).join(', '));
    loadPositions();
    loadKillState();
  });

  async function loadHistory() {
    const r = await fetch('/api/trading/history?limit=100').then(r => r.json());
    const tb = document.querySelector('#tbl-history tbody');
    tb.innerHTML = '';
    (r.history || []).forEach(p => {
      const tr = document.createElement('tr');
      const cls = p.pnl > 0 ? 'pnl-pos' : (p.pnl < 0 ? 'pnl-neg' : '');
      tr.innerHTML = '<td>' + (p.closed_at || '') + '</td>'
        + '<td>' + p.ticker + '</td>'
        + '<td>' + p.quantity + '</td>'
        + '<td>' + (p.fill_price || p.entry_price) + '</td>'
        + '<td>' + (p.exit_price || '') + '</td>'
        + '<td>' + (p.close_reason || '') + '</td>'
        + '<td class="' + cls + '">' + (p.pnl != null ? p.pnl.toFixed(2) : '') + '</td>';
      tb.appendChild(tr);
    });
  }

  async function loadConfig() {
    const r = await fetch('/api/trading/config').then(r => r.json());
    const cfg = r.config || {};
    const form = document.getElementById('form-config');
    form.tradingEnabled.checked = !!cfg.tradingEnabled;
    form.mode.value = cfg.mode || 'paper';
    form.riskPerTradePct.value = cfg.riskPerTradePct;
    form.tolerancePct.value = cfg.tolerancePct;
    form.trailingStopPct.value = cfg.trailingStopPct;
    form.takeProfitMode.value = cfg.takeProfitMode || 'trail-only';
    form.maxConcurrentPositions.value = cfg.maxConcurrentPositions;
    form.limitOrderTimeoutMin.value = cfg.limitOrderTimeoutMin;
    form.tfMinutes.value = cfg.tfMinutes;
    form.authorWhitelist.value = (cfg.authorWhitelist || []).join(', ');
  }

  document.getElementById('form-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      tradingEnabled: form.tradingEnabled.checked,
      mode: form.mode.value,
      riskPerTradePct: parseFloat(form.riskPerTradePct.value),
      tolerancePct: parseFloat(form.tolerancePct.value),
      trailingStopPct: parseFloat(form.trailingStopPct.value),
      takeProfitMode: form.takeProfitMode.value,
      maxConcurrentPositions: parseInt(form.maxConcurrentPositions.value, 10),
      limitOrderTimeoutMin: parseInt(form.limitOrderTimeoutMin.value, 10),
      tfMinutes: parseInt(form.tfMinutes.value, 10),
      authorWhitelist: form.authorWhitelist.value.split(',').map(s => s.trim()).filter(Boolean),
    };
    const res = await fetch('/api/trading/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) { alert('Config saved'); loadKillState(); }
    else alert('Save failed: ' + (await res.text()));
  });

  loadPositions();
  loadKillState();
  setInterval(loadPositions, 10000);
</script>
</body>
</html>`;
}

module.exports = { renderTradingPage };
