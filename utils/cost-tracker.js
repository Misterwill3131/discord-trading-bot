// ─────────────────────────────────────────────────────────────────────
// utils/cost-tracker.js — Tracking des coûts API + render
// ─────────────────────────────────────────────────────────────────────
// Persiste chaque appel facturé (Anthropic, ElevenLabs, chart-img, render)
// dans la table cost_events (cf db/sqlite.js). Permet :
//   • dashboard "Cost & Analytics" → daily/weekly/monthly totals
//   • alerte si dépassement de budget (TBD)
//   • debug "pourquoi mon API key a explosé en quotas ?"
//
// Granularité : 1 ligne / appel API. Pour 1000 alertes/jour ce serait
// ~3-5K lignes/jour → en 1 an, 1-2M lignes (= ~200 MB SQLite). Acceptable
// pour un usage local. Si ça devient trop volumineux, ajouter une
// retention policy (purge des events > 90 jours) — TODO.
//
// Snapshot pricing : on stocke le coût calculé au moment de l'appel, pas
// les tokens/chars bruts. Avantage : si Anthropic baisse ses prix demain,
// l'historique reste fidèle à ce qu'on a réellement payé.
//
// Throw-safe : toutes les fonctions sont try/catch silencieuses — un échec
// de DB ne doit JAMAIS faire échouer un appel API qui a déjà été facturé
// à l'externe. Au pire on perd la trace d'1 event, mais le bot continue.
// ─────────────────────────────────────────────────────────────────────

const { db } = require('../db/sqlite');

// ─── Pricing constants (USD) ─────────────────────────────────────────
// Source : pricing officiel des providers au 2026-05. À update si les
// providers changent leurs tarifs (rare mais ça arrive).
const PRICING = {
  // Anthropic Claude — facturé par MTok (million de tokens)
  // https://www.anthropic.com/pricing
  anthropic: {
    'haiku':  { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
    'sonnet': { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
    'opus':   { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
  },
  // ElevenLabs TTS — par caractère (Creator plan = $0.18 / 1k chars)
  // https://elevenlabs.io/pricing
  elevenlabs_per_char: 0.18 / 1000,
  // chart-img.com — par requête (estimated, plan Pro $25/mo ≈ 10K req)
  // https://chart-img.com/pricing
  chart_img_per_request: 25 / 10000,
  // Remotion render local — pas de coût direct mais on track le temps
  // pour les graphs "rendu wall time"
  render_per_minute: 0,
};

function modelTier(modelName) {
  if (!modelName) return 'haiku';
  const m = String(modelName).toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return 'haiku'; // default le moins cher
}

// ─── Insertion bas niveau ────────────────────────────────────────────
const INSERT_STMT = db.prepare(
  'INSERT INTO cost_events (ts_ms, service, cost_usd, meta_json) VALUES (?, ?, ?, ?)'
);

function recordCost(service, costUsd, meta = {}) {
  try {
    INSERT_STMT.run(
      Date.now(),
      String(service),
      Number(costUsd) || 0,
      JSON.stringify(meta || {})
    );
  } catch (err) {
    // Ne JAMAIS throw — on a déjà payé l'API à l'externe, on ne bloque
    // pas le bot pour une erreur d'enregistrement. Log seulement.
    if (process.env.COST_TRACKER_DEBUG === '1') {
      console.warn('[cost-tracker] recordCost failed:', err.message);
    }
  }
}

// ─── Recorders publics : 1 par service ───────────────────────────────
function recordAnthropicCall({ model, inputTokens = 0, outputTokens = 0, jobId, notes } = {}) {
  const tier = modelTier(model);
  const rates = PRICING.anthropic[tier] || PRICING.anthropic.haiku;
  const cost = (Number(inputTokens) || 0) * rates.input + (Number(outputTokens) || 0) * rates.output;
  recordCost('anthropic', cost, { model: model || null, tier, inputTokens, outputTokens, jobId, notes });
  return cost;
}

function recordElevenLabsCall({ chars = 0, jobId, voiceId, notes } = {}) {
  const cost = (Number(chars) || 0) * PRICING.elevenlabs_per_char;
  recordCost('elevenlabs', cost, { chars, jobId, voiceId, notes });
  return cost;
}

function recordChartImgCall({ jobId, symbol, notes } = {}) {
  const cost = PRICING.chart_img_per_request;
  recordCost('chart-img', cost, { jobId, symbol, notes });
  return cost;
}

function recordRender({ durationMs = 0, composition, jobId, notes } = {}) {
  const minutes = (Number(durationMs) || 0) / 60000;
  const cost = minutes * PRICING.render_per_minute;
  recordCost('render', cost, { durationMs, minutes: Number(minutes.toFixed(3)), composition, jobId, notes });
  return cost;
}

// Pour les coûts non-catégorisés (ex: webhook, autre LLM provider, etc.)
function recordOther({ service = 'other', costUsd = 0, notes = {} } = {}) {
  recordCost(service, costUsd, notes);
  return costUsd;
}

// ─── Lecture / agrégation ────────────────────────────────────────────
// Tous les helpers prennent un range [startMs, endMs] (inclusif/exclusif).
// Default = depuis l'epoch jusqu'à maintenant.

function statsByService({ startMs = 0, endMs = Date.now() } = {}) {
  try {
    const rows = db.prepare(
      'SELECT service, SUM(cost_usd) AS total_cost, COUNT(*) AS call_count FROM cost_events WHERE ts_ms BETWEEN ? AND ? GROUP BY service ORDER BY total_cost DESC'
    ).all(startMs, endMs);
    const total = rows.reduce((s, r) => s + (r.total_cost || 0), 0);
    const callCount = rows.reduce((s, r) => s + (r.call_count || 0), 0);
    return { rows, total, callCount };
  } catch (err) {
    return { rows: [], total: 0, callCount: 0 };
  }
}

// Daily totals : group par jour calendaire en NY tz (cohérent avec le
// reste du bot). On rapatrie les rows raw et on agrège en JS pour
// éviter les casse-têtes de strftime avec offsets DST.
function dailyTotals({ days = 30, tz = 'America/New_York' } = {}) {
  const endMs = Date.now();
  const startMs = endMs - days * 86_400_000;
  let rows = [];
  try {
    rows = db.prepare(
      'SELECT ts_ms, service, cost_usd FROM cost_events WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC'
    ).all(startMs, endMs);
  } catch (err) {
    return { days: [], total: 0 };
  }

  // Agrège par YYYY-MM-DD en tz NY
  const byDay = new Map(); // day → { total, byService: { service → cost } }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const r of rows) {
    const day = fmt.format(new Date(r.ts_ms));
    if (!byDay.has(day)) byDay.set(day, { day, total: 0, byService: {} });
    const e = byDay.get(day);
    e.total += r.cost_usd || 0;
    e.byService[r.service] = (e.byService[r.service] || 0) + (r.cost_usd || 0);
  }

  // Fill missing days with 0 pour que le graph soit continu
  const filled = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = fmt.format(new Date(endMs - i * 86_400_000));
    filled.push(byDay.get(day) || { day, total: 0, byService: {} });
  }
  const total = filled.reduce((s, d) => s + d.total, 0);
  return { days: filled, total };
}

// Convenience pour le dashboard : retourne today / 7d / 30d / total
function summary({ tz = 'America/New_York' } = {}) {
  const now = Date.now();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = fmt.format(new Date(now));

  // Today : on cherche le minuit local et on prend tout depuis
  // — heuristique simple : on rapatrie les events de la dernière 36h et
  // on filtre côté JS (couvre tous les fuseaux possibles sans drame).
  const last36h = now - 36 * 3_600_000;
  let recentRows = [];
  try {
    recentRows = db.prepare(
      'SELECT ts_ms, cost_usd, service FROM cost_events WHERE ts_ms >= ?'
    ).all(last36h);
  } catch (err) {
    return { today: 0, last7d: 0, last30d: 0, total: 0 };
  }
  const todayTotal = recentRows
    .filter(r => fmt.format(new Date(r.ts_ms)) === today)
    .reduce((s, r) => s + (r.cost_usd || 0), 0);

  // last7d / last30d : sommes sur fenêtres glissantes en ms (simple)
  const last7dStart = now - 7 * 86_400_000;
  const last30dStart = now - 30 * 86_400_000;
  let totals = { last7d: 0, last30d: 0, total: 0 };
  try {
    const r7 = db.prepare(
      'SELECT SUM(cost_usd) AS total FROM cost_events WHERE ts_ms >= ?'
    ).get(last7dStart);
    const r30 = db.prepare(
      'SELECT SUM(cost_usd) AS total FROM cost_events WHERE ts_ms >= ?'
    ).get(last30dStart);
    const rAll = db.prepare('SELECT SUM(cost_usd) AS total FROM cost_events').get();
    totals.last7d = r7?.total || 0;
    totals.last30d = r30?.total || 0;
    totals.total = rAll?.total || 0;
  } catch (err) { /* swallow */ }

  return { today: todayTotal, ...totals };
}

// Liste les N derniers events pour debug / "live tail" sur le dashboard
function recent({ limit = 50, service } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  try {
    if (service) {
      return db.prepare(
        'SELECT id, ts_ms, service, cost_usd, meta_json FROM cost_events WHERE service = ? ORDER BY ts_ms DESC LIMIT ?'
      ).all(String(service), cap);
    }
    return db.prepare(
      'SELECT id, ts_ms, service, cost_usd, meta_json FROM cost_events ORDER BY ts_ms DESC LIMIT ?'
    ).all(cap);
  } catch (err) {
    return [];
  }
}

module.exports = {
  PRICING,
  recordAnthropicCall,
  recordElevenLabsCall,
  recordChartImgCall,
  recordRender,
  recordOther,
  statsByService,
  dailyTotals,
  summary,
  recent,
};
