// ─────────────────────────────────────────────────────────────────────
// pages/video-manual-recap.js — /video-studio/manual-recap
// ─────────────────────────────────────────────────────────────────────
// Formulaire manuel pour déclencher un TobTradeRecap sans image OCR.
// L'utilisateur saisit les trades à la main (ticker, entry, HOD) +
// optionnellement long-term, puis click "Render" → POST manual-recap.
// ─────────────────────────────────────────────────────────────────────

const { COMMON_CSS, sidebarHTML } = require('./common');

const VIDEO_MANUAL_RECAP_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Manual Recap — BOOM</title>
<style>
${COMMON_CSS}
#wrap { padding: 24px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
.sub { color: #a0a0b0; font-size: 13px; margin-bottom: 24px; }
.section { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 18px; margin-bottom: 18px; }
.section h2 { font-size: 14px; font-weight: 700; margin: 0 0 14px 0; display: flex; align-items: center; justify-content: space-between; }
.section-actions { display: flex; gap: 8px; }
.btn-add { background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.35); color: #60a5fa; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; font-family: inherit; }
.btn-add:hover { background: rgba(59,130,246,0.25); }
.btn-remove { background: transparent; border: 1px solid rgba(239,68,68,0.3); color: #ef4444; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 700; }
.btn-remove:hover { background: rgba(239,68,68,0.1); }

.trade-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr 36px; gap: 10px; align-items: end; margin-bottom: 10px; }
.lt-row { display: grid; grid-template-columns: 1fr 1fr 1fr 36px; gap: 10px; align-items: end; margin-bottom: 10px; }
.trade-row label, .lt-row label { display: block; font-size: 10px; color: #80848e; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.trade-row input, .lt-row input { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 8px 10px; color: #fafafa; font-size: 13px; font-family: inherit; }
.trade-row input:focus, .lt-row input:focus { outline: none; border-color: #8b5cf6; }
.trade-gain { font-size: 11px; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.02); }
.trade-gain.pos { color: #10b981; }
.trade-gain.neg { color: #ef4444; }
.empty-row { color: #6b7280; font-style: italic; font-size: 12px; padding: 12px 0; }

.config-row { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 12px; margin-bottom: 12px; }
.field label { display: block; font-size: 11px; color: #a0a0b0; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.field input { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 9px 12px; color: #fafafa; font-size: 13px; font-family: inherit; }
.field input:focus { outline: none; border-color: #8b5cf6; }
.helper { font-size: 11px; color: #80848e; margin-top: 4px; }

.submit-row { display: flex; align-items: center; gap: 12px; justify-content: flex-end; }
.btn { padding: 10px 18px; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
.btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: white; }
.btn-primary:disabled { opacity: 0.4; cursor: wait; }
#status { margin-top: 14px; padding: 12px; border-radius: 6px; font-size: 13px; display: none; }
#status.success { display: block; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; }
#status.error { display: block; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; }

.stats-preview { display: flex; gap: 16px; font-size: 12px; color: #a0a0b0; padding: 12px 0; }
.stats-preview b { color: #fafafa; }
</style></head>
<body>
${sidebarHTML('/video-studio')}
<div class="page-content">
<div class="page-header">
  <div class="page-title">🎬 Manual Recap</div>
  <div style="margin-left:auto; padding-right:24px;">
    <a href="/video-studio" style="font-size:13px; color:#8b5cf6; text-decoration:none;">← Video Studio</a>
  </div>
</div>
<div id="wrap">
  <h1>Recap manuel (sans image OCR)</h1>
  <p class="sub">Saisis tes trades à la main et déclenche un render <code>TobTradeRecap</code>. Utile quand l'image récap n'est pas dispo ou que tu veux ajuster les valeurs.</p>

  <!-- Configuration -->
  <div class="section">
    <h2>⚙ Configuration</h2>
    <div class="config-row">
      <div class="field">
        <label for="cfg-date">Date label</label>
        <input type="text" id="cfg-date" value="TODAY" placeholder="ex: TODAY, MAY 13, etc.">
      </div>
      <div class="field">
        <label for="cfg-channel">Output channel ID</label>
        <input type="text" id="cfg-channel" placeholder="ex: 1312793427515277332 (vide = env default)">
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <div class="helper">Le MP4 sera posté dans ce canal (Discord ID). Vide → utilise RENDER_OUTPUT_CHANNEL_ID env.</div>
      </div>
    </div>
    <div style="margin-top: 10px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap;">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" id="cfg-narration" style="width:auto; cursor:pointer;">
        <span>🎙 Voice-over (TTS)</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" id="cfg-autopost" style="width:auto; cursor:pointer;" disabled>
        <span id="cfg-autopost-label">📢 Auto-post Buffer</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" id="cfg-llm-caption" style="width:auto; cursor:pointer;">
        <span>🤖 Caption AI</span>
      </label>
      <div style="display: flex; align-items: center; gap: 8px;">
        <label for="cfg-aspect" style="font-size: 11px; color: #a0a0b0; margin: 0;">Aspect:</label>
        <select id="cfg-aspect" style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:6px 10px; color:#fafafa; font-size:12px; font-family:inherit;">
          <option value="9x16">9:16 (TikTok/Reels)</option>
          <option value="1x1">1:1 (IG/Discord)</option>
          <option value="16x9">16:9 (YT/Twitter)</option>
        </select>
      </div>
    </div>
    <div class="helper" style="margin-top: 6px;">Narration AI ~$0.02/render. Auto-post nécessite BUFFER_ACCESS_TOKEN env. Aspect 1:1/16:9 best-effort.</div>
  </div>

  <!-- Trades table -->
  <div class="section">
    <h2>
      📊 Trades
      <span class="section-actions">
        <button class="btn-add" onclick="addTrade()">+ Add trade</button>
      </span>
    </h2>
    <div id="trades-list"></div>
    <div class="stats-preview" id="trades-stats"></div>
  </div>

  <!-- Long-term investments -->
  <div class="section">
    <h2>
      💎 Long-term investments (optionnel)
      <span class="section-actions">
        <button class="btn-add" onclick="addLt()">+ Add long-term</button>
      </span>
    </h2>
    <div id="lts-list"></div>
  </div>

  <!-- Submit -->
  <div class="section">
    <div class="submit-row">
      <button class="btn btn-primary" id="btn-submit" onclick="submitRecap()">🎬 Render recap</button>
    </div>
    <div id="status"></div>
  </div>
</div>
</div>

<script>
let trades = [];
let lts = [];

function newTrade() { return { ticker: '', entryPrice: '', hodPrice: '' }; }
function newLt() { return { ticker: '', entryPrice: '', currentPrice: '' }; }

function addTrade() { trades.push(newTrade()); renderTrades(); }
function addLt() { lts.push(newLt()); renderLts(); }
function removeTrade(idx) { trades.splice(idx, 1); renderTrades(); }
function removeLt(idx) { lts.splice(idx, 1); renderLts(); }

function calcGain(entry, hod) {
  const e = Number(entry), h = Number(hod);
  if (!Number.isFinite(e) || !Number.isFinite(h) || e === 0) return null;
  return ((h - e) / e) * 100;
}

function fmtGain(g) {
  if (g === null) return '—';
  return (g >= 0 ? '+' : '') + g.toFixed(2) + '%';
}

function renderTrades() {
  const list = document.getElementById('trades-list');
  if (trades.length === 0) {
    list.innerHTML = '<div class="empty-row">Aucun trade. Click "+ Add trade" pour commencer.</div>';
  } else {
    list.innerHTML = trades.map((t, i) => {
      const gain = calcGain(t.entryPrice, t.hodPrice);
      const gainCls = gain === null ? '' : (gain >= 0 ? 'pos' : 'neg');
      return '<div class="trade-row">' +
        '<div><label>Ticker</label><input type="text" maxlength="10" placeholder="TSLA" value="' + (t.ticker || '').replace(/"/g,'&quot;') + '" oninput="updateTrade(' + i + ', \\'ticker\\', this.value)"></div>' +
        '<div><label>Entry price</label><input type="number" step="any" placeholder="1.44" value="' + t.entryPrice + '" oninput="updateTrade(' + i + ', \\'entryPrice\\', this.value)"></div>' +
        '<div><label>HOD price</label><input type="number" step="any" placeholder="6.27" value="' + t.hodPrice + '" oninput="updateTrade(' + i + ', \\'hodPrice\\', this.value)"></div>' +
        '<div><label>Gain</label><div class="trade-gain ' + gainCls + '">' + fmtGain(gain) + '</div></div>' +
        '<div><label>&nbsp;</label><button class="btn-remove" onclick="removeTrade(' + i + ')" title="Supprimer">✕</button></div>' +
      '</div>';
    }).join('');
  }
  refreshStats();
}

function renderLts() {
  const list = document.getElementById('lts-list');
  if (lts.length === 0) {
    list.innerHTML = '<div class="empty-row">Aucun long-term. Optionnel — click "+ Add long-term" si t\\'en as.</div>';
    return;
  }
  list.innerHTML = lts.map((lt, i) => {
    return '<div class="lt-row">' +
      '<div><label>Ticker</label><input type="text" maxlength="10" placeholder="POET" value="' + (lt.ticker || '').replace(/"/g,'&quot;') + '" oninput="updateLt(' + i + ', \\'ticker\\', this.value)"></div>' +
      '<div><label>Entry price</label><input type="number" step="any" placeholder="7.00" value="' + lt.entryPrice + '" oninput="updateLt(' + i + ', \\'entryPrice\\', this.value)"></div>' +
      '<div><label>Current price (HOD)</label><input type="number" step="any" placeholder="18.40" value="' + lt.currentPrice + '" oninput="updateLt(' + i + ', \\'currentPrice\\', this.value)"></div>' +
      '<div><label>&nbsp;</label><button class="btn-remove" onclick="removeLt(' + i + ')" title="Supprimer">✕</button></div>' +
    '</div>';
  }).join('');
}

function updateTrade(i, key, val) {
  trades[i][key] = val;
  // Recompute gain affichage seul (pas de full re-render — éviterait la perte de focus input).
  if (key === 'entryPrice' || key === 'hodPrice') {
    const row = document.querySelectorAll('.trade-row')[i];
    if (row) {
      const gain = calcGain(trades[i].entryPrice, trades[i].hodPrice);
      const gainEl = row.querySelector('.trade-gain');
      gainEl.textContent = fmtGain(gain);
      gainEl.className = 'trade-gain ' + (gain === null ? '' : (gain >= 0 ? 'pos' : 'neg'));
    }
    refreshStats();
  }
}
function updateLt(i, key, val) { lts[i][key] = val; }

function refreshStats() {
  const valid = trades.filter(t => Number.isFinite(Number(t.entryPrice)) && Number.isFinite(Number(t.hodPrice)) && Number(t.entryPrice) > 0);
  if (valid.length === 0) {
    document.getElementById('trades-stats').textContent = '';
    return;
  }
  const gains = valid.map(t => calcGain(t.entryPrice, t.hodPrice));
  const green = gains.filter(g => g > 0).length;
  const combined = gains.reduce((s, g) => s + g, 0);
  const avg = combined / gains.length;
  document.getElementById('trades-stats').innerHTML =
    '<span><b>' + valid.length + '</b> trades</span>' +
    '<span><b>' + green + '/' + valid.length + '</b> green</span>' +
    '<span>Combined <b>' + fmtGain(combined) + '</b></span>' +
    '<span>Avg <b>' + fmtGain(avg) + '</b></span>';
}

async function submitRecap() {
  const status = document.getElementById('status');
  status.className = '';
  status.textContent = '';

  // Filtre les lignes vides (ticker manquant) avant submit — friendliness.
  const cleanTrades = trades
    .filter(t => t.ticker && t.ticker.trim() && t.entryPrice !== '' && t.hodPrice !== '')
    .map(t => ({
      ticker: t.ticker.trim(),
      entryPrice: Number(t.entryPrice),
      hodPrice: Number(t.hodPrice),
    }));
  const cleanLts = lts
    .filter(lt => lt.ticker && lt.ticker.trim() && lt.entryPrice !== '' && lt.currentPrice !== '')
    .map(lt => ({
      ticker: lt.ticker.trim(),
      entryPrice: Number(lt.entryPrice),
      currentPrice: Number(lt.currentPrice),
    }));

  if (cleanTrades.length === 0) {
    status.className = 'error';
    status.textContent = '❌ Ajoute au moins 1 trade (avec ticker + prix d\\'entrée + HOD) avant de render.';
    return;
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '⏳ Enqueuing…';

  try {
    const body = {
      dateLabel: document.getElementById('cfg-date').value || 'TODAY',
      outputChannelId: document.getElementById('cfg-channel').value || null,
      trades: cleanTrades,
      longTermInvestments: cleanLts,
      enableNarration: document.getElementById('cfg-narration').checked,
      aspectRatio: document.getElementById('cfg-aspect').value,
      autoPostSocial: document.getElementById('cfg-autopost').checked,
      useLlmCaption: document.getElementById('cfg-llm-caption').checked,
    };
    const r = await fetch('/api/video-studio/manual-recap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    status.className = 'success';
    status.textContent = '✅ Job #' + data.jobId + ' enqueued — ' + data.tradesCount + ' trades, ' +
      data.longTermCount + ' long-term, ' + data.alertImagesCount + ' alerts. Le MP4 arrive bientôt sur Discord.';
  } catch (e) {
    status.className = 'error';
    status.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🎬 Render recap';
  }
}

// Initial : 1 trade row vide pour démarrer
addTrade();
renderLts();

// Fetch Buffer config pour activer/griser la checkbox autopost.
fetch('/api/video-studio/buffer-status').then(r => r.json()).then(buf => {
  const cb = document.getElementById('cfg-autopost');
  const lbl = document.getElementById('cfg-autopost-label');
  if (buf && buf.configured) {
    cb.disabled = false;
    lbl.textContent = '📢 Auto-post Buffer (' + buf.profileCount + ' profile' + (buf.profileCount > 1 ? 's' : '') + ')';
  } else {
    cb.disabled = true;
    lbl.textContent = '📢 Auto-post Buffer (non configuré)';
    lbl.style.color = '#6b7280';
  }
}).catch(() => {});
</script>
</body></html>`;

module.exports = { VIDEO_MANUAL_RECAP_HTML };
