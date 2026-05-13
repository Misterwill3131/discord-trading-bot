#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// scripts/export-alerts.js — Export bulk des PNG d'alertes
// ─────────────────────────────────────────────────────────────────────
// Regénère sur disque les PNG d'alertes d'une journée (ou range) en
// queryant la table SQLite `messages` puis appelant generateImage()
// de canvas/proof.js. Utile pour :
//   - Constituer un dataset historique de PNG (au-delà des 100 stockés
//     dans gallery_items)
//   - Préparer des assets pour les vidéos recap quotidiennes
//   - Audit visuel d'une journée passée
//
// Flags CLI :
//   --date=YYYY-MM-DD       Une seule journée (default: aujourd'hui UTC)
//   --from=YYYY-MM-DD       Range : début (inclusif)
//   --to=YYYY-MM-DD         Range : fin (inclusif)
//   --type=entry|exit|all   Filtre alert_type (default: entry)
//   --tickers=TSLA,SPY,...  Whitelist de tickers (optionnel)
//   --out=./path            Output dir (default: ./exports/alerts/{date})
//   --scale=N               Multiplicateur de résolution PNG (default: 2)
//   --max=N                 Limite N alertes (default: aucune)
//   --dry-run               Affiche ce qui serait exporté, n'écrit rien
//
// Naming des fichiers : {seq}-{ticker}-{author}-{HHMM}.png
//   ex: 003-TSLA-Z-1432.png  → 3e alerte de la journée, $TSLA par Z à 14:32
//
// Usage :
//   node scripts/export-alerts.js                           # Aujourd'hui
//   node scripts/export-alerts.js --date=2026-05-12
//   node scripts/export-alerts.js --from=2026-05-01 --to=2026-05-12
//   node scripts/export-alerts.js --type=all --tickers=TSLA,SPY
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

require('dotenv').config({ override: true, quiet: true });

const { getMessagesByDateKey, getMessagesByTsRange } = require('../db/sqlite');
const { generateImage } = require('../canvas/proof');

function parseArgs() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : null;
  };
  // Trading day default = date courante America/New_York (pas UTC).
  // À 00h UTC = 19h ET, on veut encore le jour de trading actuel.
  const todayUTC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const date = getFlag('date');
  const from = getFlag('from');
  const to = getFlag('to');
  const type = getFlag('type') || 'entry';
  const tickersStr = getFlag('tickers');
  const tickers = tickersStr ? tickersStr.split(',').map(t => t.trim().toUpperCase().replace(/^\$/, '')) : null;
  const out = getFlag('out');
  const scale = parseInt(getFlag('scale') || '2', 10);
  const max = getFlag('max') ? parseInt(getFlag('max'), 10) : null;
  const dryRun = args.includes('--dry-run');

  // Résout la range effective.
  let effectiveDate = null, effectiveFrom = null, effectiveTo = null;
  if (from || to) {
    if (!from || !to) throw new Error('Both --from et --to sont requis pour une range, ou utilise --date seul.');
    effectiveFrom = from;
    effectiveTo = to;
  } else {
    effectiveDate = date || todayUTC;
  }

  return { date: effectiveDate, from: effectiveFrom, to: effectiveTo, type, tickers, out, scale, max, dryRun };
}

function loadMessages({ date, from, to }) {
  if (date) {
    return getMessagesByDateKey(date);
  }
  // Range : convert YYYY-MM-DD en ISO bornes (start of day → end of day UTC)
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  return getMessagesByTsRange(fromIso, toIso);
}

function applyFilters(messages, { type, tickers, max }) {
  let filtered = messages;
  if (type !== 'all') {
    filtered = filtered.filter(m => m.type === type);
  }
  if (tickers && tickers.length > 0) {
    filtered = filtered.filter(m => {
      if (!m.ticker) return false;
      const tickerClean = m.ticker.toUpperCase().replace(/^\$/, '');
      return tickers.includes(tickerClean);
    });
  }
  if (max !== null && filtered.length > max) {
    filtered = filtered.slice(0, max);
  }
  return filtered;
}

function buildFileName(seq, msg) {
  const ticker = (msg.ticker || 'NOTKR').toUpperCase().replace(/^\$/, '').replace(/[^A-Z0-9]/g, '');
  const author = (msg.author || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  let hhmm = '0000';
  try {
    const d = new Date(msg.ts);
    hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');
  } catch { /* ignore */ }
  const seqStr = String(seq).padStart(3, '0');
  return `${seqStr}-${ticker}-${author}-${hhmm}.png`;
}

function resolveOutputDir(args) {
  if (args.out) return path.resolve(args.out);
  // Default : ./exports/alerts/{date_or_range}
  const label = args.date || `${args.from}_to_${args.to}`;
  return path.resolve('./exports/alerts/' + label);
}

async function main() {
  const args = parseArgs();
  console.log('─── Export alerts ───');
  console.log('Mode  :', args.date ? `date=${args.date}` : `range ${args.from} → ${args.to}`);
  console.log('Type  :', args.type, '| Tickers:', args.tickers ? args.tickers.join(',') : 'all');
  console.log('Scale :', args.scale + 'x', '| Max :', args.max || 'none', '| Dry-run :', args.dryRun);

  // ── 1. Query DB ──
  const all = loadMessages(args);
  console.log(`\n[1] DB query → ${all.length} messages chargés`);

  // ── 2. Filter ──
  const filtered = applyFilters(all, args);
  console.log(`[2] After filters → ${filtered.length} alertes à exporter`);

  if (filtered.length === 0) {
    console.log('Aucune alerte à exporter. Vérifie tes flags ou la DB.');
    process.exit(0);
  }

  // Output dir
  const outDir = resolveOutputDir(args);
  if (!args.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  console.log(`[3] Output : ${outDir}`);

  // ── 3. Generate PNG ──
  let okCount = 0, failCount = 0;
  const startedAt = Date.now();

  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i];
    const fileName = buildFileName(i + 1, msg);
    const filePath = path.join(outDir, fileName);

    if (args.dryRun) {
      console.log(`  [DRY] ${fileName}  ← ${(msg.content || '').slice(0, 50)}`);
      okCount++;
      continue;
    }

    try {
      const buf = await generateImage(
        msg.author || 'Unknown',
        msg.content || '',
        msg.ts,
        { scale: args.scale }
      );
      fs.writeFileSync(filePath, buf);
      console.log(`  ✓ ${fileName} (${(buf.length / 1024).toFixed(0)} KB)`);
      okCount++;
    } catch (err) {
      console.error(`  ✗ ${fileName} : ${err.message}`);
      failCount++;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[4] ✅ ${okCount} OK, ${failCount} failed, ${elapsed}s`);
  if (!args.dryRun) {
    console.log(`    Images dans : ${outDir}`);
  }
}

main().catch(err => {
  console.error('[export-alerts] Fatal:', err);
  process.exit(1);
});
