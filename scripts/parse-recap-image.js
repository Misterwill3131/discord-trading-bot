#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// scripts/parse-recap-image.js — CLI : OCR un tableau récap TOB en JSON
// ─────────────────────────────────────────────────────────────────────
// Usage :
//   node scripts/parse-recap-image.js <path/to/recap.png>
//   node scripts/parse-recap-image.js <path/to/recap.png> --out=trades.json
//   node scripts/parse-recap-image.js <path/to/recap.png> --apply-template
//
// Flags :
//   --out=path        Écrit le JSON dans ce fichier (default: print stdout)
//   --apply-template  Écrit directement dans video/templates/trade-recap-default.json
//                     (overrides props.trades + props.longTermInvestment).
//                     Pratique : run l'OCR puis lance generate:trade-recap.
//
// Coût : ~$0.01-0.03 par image Claude Sonnet 4.5 vision.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

require('dotenv').config({ override: true, quiet: true });

const { parseRecapImage } = require('../utils/parse-recap-image');

const TEMPLATE_PATH = path.join(__dirname, '..', 'video', 'templates', 'trade-recap-default.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const imagePath = args.find(a => !a.startsWith('--'));
  if (!imagePath) {
    console.error('Usage: node scripts/parse-recap-image.js <path/to/image.png> [--out=trades.json] [--apply-template]');
    process.exit(1);
  }
  const outArg = args.find(a => a.startsWith('--out='));
  const out = outArg ? outArg.slice('--out='.length) : null;
  const applyTemplate = args.includes('--apply-template');
  return { imagePath: path.resolve(imagePath), out, applyTemplate };
}

async function main() {
  const { imagePath, out, applyTemplate } = parseArgs();
  console.log(`[parse-recap-image] OCR sur ${imagePath}`);

  const result = await parseRecapImage(imagePath);

  const { _meta, ...clean } = result;
  console.log(`[parse-recap-image] ✅ ${_meta.tradesCount} trades extracted (${_meta.latencyMs}ms, ${_meta.model})`);
  console.log(`  longTermInvestment : ${clean.longTermInvestment ? clean.longTermInvestment.ticker : 'absent'}`);
  if (_meta.usage) {
    console.log(`  Tokens : ${_meta.usage.input_tokens} in / ${_meta.usage.output_tokens} out`);
  }

  // Preview des 3 premiers + 3 derniers trades pour sanity-check
  const trades = clean.trades;
  if (trades.length > 6) {
    console.log('\n  Sample preview (3 premiers + 3 derniers) :');
    [...trades.slice(0, 3), null, ...trades.slice(-3)].forEach(t => {
      if (t === null) {
        console.log(`    ... (${trades.length - 6} autres) ...`);
      } else {
        const gain = ((t.hodPrice - t.entryPrice) / t.entryPrice * 100).toFixed(1);
        console.log(`    ${t.ticker.padEnd(7)} entry ${t.entryPrice.toFixed(3).padStart(8)} → HOD ${t.hodPrice.toFixed(3).padStart(8)}  (${gain > 0 ? '+' : ''}${gain}%)`);
      }
    });
  } else {
    console.log('\n  All trades :');
    trades.forEach(t => {
      const gain = ((t.hodPrice - t.entryPrice) / t.entryPrice * 100).toFixed(1);
      console.log(`    ${t.ticker.padEnd(7)} entry ${t.entryPrice.toFixed(3).padStart(8)} → HOD ${t.hodPrice.toFixed(3).padStart(8)}  (${gain > 0 ? '+' : ''}${gain}%)`);
    });
  }

  // Output
  if (applyTemplate) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`Template introuvable : ${TEMPLATE_PATH}`);
    }
    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    template.props = template.props || {};
    template.props.trades = clean.trades;
    template.props.longTermInvestment = clean.longTermInvestment;
    template.props.dateLabel = clean.dateLabel;
    fs.writeFileSync(TEMPLATE_PATH, JSON.stringify(template, null, 2) + '\n');
    console.log(`\n[parse-recap-image] ✅ Template appliqué : ${TEMPLATE_PATH}`);
    console.log('  → Lance maintenant : npm run generate:trade-recap');
  } else if (out) {
    fs.writeFileSync(out, JSON.stringify(clean, null, 2) + '\n');
    console.log(`\n[parse-recap-image] ✅ JSON écrit : ${out}`);
  } else {
    console.log('\n[parse-recap-image] Full JSON :');
    console.log(JSON.stringify(clean, null, 2));
  }
}

main().catch(err => {
  console.error('[parse-recap-image] Fatal :', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
