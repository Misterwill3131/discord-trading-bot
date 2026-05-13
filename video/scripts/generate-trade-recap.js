#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// video/scripts/generate-trade-recap.js — Pipeline génération trade recap
// ─────────────────────────────────────────────────────────────────────
// 1. Charge template depuis video/templates/trade-recap-default.json
//    (contient les trades du jour à compléter manuellement)
// 2. Query DB getMessagesByDateKey(today) pour récupérer les alertes entry
//    (sauf --no-db). Génère un PNG par alerte via canvas/proof.js.
// 3. Pass tous les paths PNG comme alertImages dans Remotion props.
// 4. Render via Remotion CLI → MP4 dans video/out/
//
// CLI flags :
//   --no-db          : skip query DB. AlertsParade utilise les paths déjà
//                      listés dans template.props.alertImages (ou vide).
//   --date=YYYY-MM-DD: override la date de query (default : trading day NY).
//   --no-render      : skip Remotion render. Juste génère les PNG alertes.
//   --max-alerts=N   : limite à N alertes max (default: 12). Plus = scroll
//                      plus long en feed-style.
//   --from-image=PATH: OCR cette image (tableau récap TOB) pour remplir
//                      automatiquement trades + longTermInvestments dans
//                      le template avant render. Pratique pour le workflow
//                      "screenshot du tableau → vidéo automatique".
//
// Usage :
//   cd video && npm run generate:trade-recap
//   cd video && npm run generate:trade-recap -- --no-db
//   cd video && npm run generate:trade-recap -- --date=2026-05-12
//   cd video && npm run generate:trade-recap -- --from-image=../recap.png
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env.local'),
  override: true,
  quiet: true,
});

const VIDEO_DIR = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(VIDEO_DIR, 'templates', 'trade-recap-default.json');
const OUTPUT_ALERTS_DIR = path.join(VIDEO_DIR, 'public', 'recap-alerts');
const OUTPUT_MP4_DIR = path.join(VIDEO_DIR, 'out');

// ─── CLI args ───────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const noDb = args.includes('--no-db');
  const noRender = args.includes('--no-render');
  const dateArg = args.find(a => a.startsWith('--date='));
  // Trading day default = date courante en America/New_York (pas UTC),
  // sinon le script run après 00h UTC (= 19h ET) prend le jour suivant
  // alors qu'on veut encore le jour de trading qui vient de se terminer.
  // Override via --date=YYYY-MM-DD pour un récap rétroactif.
  const date = dateArg
    ? dateArg.slice('--date='.length)
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const maxArg = args.find(a => a.startsWith('--max-alerts='));
  // Default 12 alertes — feed-style : ~8 visibles + 4 qui scroll au-dessus.
  // À 1s entre 2 apparitions : phase = (12-1)*1s + ~3s hold = ~14s parade.
  const maxAlerts = maxArg ? parseInt(maxArg.slice('--max-alerts='.length), 10) : 12;
  const fromImageArg = args.find(a => a.startsWith('--from-image='));
  const fromImage = fromImageArg ? fromImageArg.slice('--from-image='.length) : null;
  return { noDb, noRender, date, maxAlerts, fromImage };
}

async function main() {
  const { noDb, noRender, date, maxAlerts, fromImage } = parseArgs();

  console.log('[gen-trade-recap] Pipeline démarré');
  console.log(`  Date : ${date}`);
  console.log(`  Mode : ${noDb ? 'no-db (utilise template.props.alertImages)' : 'DB query (genère PNG live)'}`);
  console.log(`  Max alerts : ${maxAlerts}`);
  if (fromImage) console.log(`  OCR source : ${fromImage}`);

  // ── 0. (Optionnel) OCR depuis image avant de charger le template ──
  if (fromImage) {
    const { parseRecapImage } = require('../../utils/parse-recap-image');
    const imageAbs = path.resolve(fromImage);
    console.log(`[gen-trade-recap] OCR Claude Vision sur ${imageAbs}…`);
    const ocrResult = await parseRecapImage(imageAbs);
    const { _meta } = ocrResult;
    console.log(`[gen-trade-recap]   ✓ ${_meta.tradesCount} trades extracted (${_meta.latencyMs}ms)`);

    // Override template props.trades + longTermInvestments + dateLabel
    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    template.props = template.props || {};
    template.props.trades = ocrResult.trades;
    template.props.longTermInvestments = ocrResult.longTermInvestments || [];
    template.props.dateLabel = ocrResult.dateLabel;
    fs.writeFileSync(TEMPLATE_PATH, JSON.stringify(template, null, 2) + '\n');
    const ltSummary = (ocrResult.longTermInvestments || []).map(lt => lt.ticker).join(', ') || 'aucun';
    console.log(`[gen-trade-recap]   ✓ Template mis à jour avec ${ocrResult.trades.length} trades + longTerm=${ltSummary}`);
  }

  // ── 1. Charge template ────────────────────────────────────────────
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`[gen-trade-recap] Template introuvable : ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const trades = template.props?.trades || [];
  const ltLoaded = (template.props?.longTermInvestments || []).map(lt => lt.ticker).join(', ') || 'aucun';
  console.log(`[gen-trade-recap] Template chargé : ${trades.length} trades, longTerm=${ltLoaded}`);

  // ── 2. Génère PNG alertes (sauf --no-db) ─────────────────────────
  let alertImagesProp = template.props?.alertImages || [];

  if (!noDb) {
    if (!fs.existsSync(OUTPUT_ALERTS_DIR)) fs.mkdirSync(OUTPUT_ALERTS_DIR, { recursive: true });

    // Clean PNG existants (sinon vieilles alertes du jour précédent restent)
    const existing = fs.readdirSync(OUTPUT_ALERTS_DIR).filter(f => f.startsWith('alert-') && f.endsWith('.png'));
    existing.forEach(f => fs.unlinkSync(path.join(OUTPUT_ALERTS_DIR, f)));
    if (existing.length > 0) console.log(`  Cleaned ${existing.length} old alert PNGs`);

    try {
      const { getMessagesByDateKey } = require('../../db/sqlite');
      const { generateImage } = require('../../canvas/proof');
      const messages = getMessagesByDateKey(date);
      const entryAlerts = messages.filter(m => m.type === 'entry').slice(0, maxAlerts);
      console.log(`[gen-trade-recap] DB → ${messages.length} messages, ${entryAlerts.length} entry alerts`);

      alertImagesProp = [];
      let okCount = 0;
      let failCount = 0;
      for (let i = 0; i < entryAlerts.length; i++) {
        const alert = entryAlerts[i];
        try {
          const buf = await generateImage(
            alert.author || 'Unknown',
            alert.content || '',
            alert.ts,
            { scale: 2 }  // 2x = ~1500px wide, sharp pour rendu vidéo
          );
          const fileName = `alert-${i + 1}.png`;
          fs.writeFileSync(path.join(OUTPUT_ALERTS_DIR, fileName), buf);
          alertImagesProp.push({
            imagePath: `recap-alerts/${fileName}`,
            ticker: alert.ticker || null,
          });
          okCount++;
        } catch (err) {
          console.warn(`  ⚠ Alert ${i + 1} (${alert.ticker}): ${err.message}`);
          failCount++;
        }
      }
      console.log(`[gen-trade-recap] PNG alertes : ${okCount} OK, ${failCount} failed`);
    } catch (err) {
      console.warn(`[gen-trade-recap] DB indisponible (${err.message}) — fallback sur template.alertImages`);
    }
  } else {
    console.log(`[gen-trade-recap] --no-db : utilise ${alertImagesProp.length} alertImages du template`);
  }

  // ── 3. Build Remotion inputProps ──────────────────────────────────
  const inputProps = {
    ...(template.props || {}),
    alertImages: alertImagesProp,
  };

  // Write inputProps to temp JSON file
  if (!fs.existsSync(OUTPUT_MP4_DIR)) fs.mkdirSync(OUTPUT_MP4_DIR, { recursive: true });
  const propsPath = path.join(OUTPUT_MP4_DIR, '.trade-recap-props.json');
  fs.writeFileSync(propsPath, JSON.stringify(inputProps, null, 2));

  // ── 4. Render via Remotion CLI ────────────────────────────────────
  if (noRender) {
    console.log(`[gen-trade-recap] --no-render : skip Remotion. PNG alertes dans ${OUTPUT_ALERTS_DIR}`);
    console.log(`[gen-trade-recap] inputProps écrit dans ${propsPath}`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outMp4 = path.join(OUTPUT_MP4_DIR, `tob-trade-recap-${timestamp}.mp4`);
  console.log(`[gen-trade-recap] Rendering Remotion → ${outMp4}`);

  const cmd = `npx remotion render TobTradeRecap "${outMp4}" --props="${propsPath}"`;
  try {
    execSync(cmd, { stdio: 'inherit', cwd: VIDEO_DIR });
  } catch (err) {
    console.error('[gen-trade-recap] Remotion render failed.');
    process.exit(1);
  }

  const mp4Size = (fs.statSync(outMp4).size / 1024 / 1024).toFixed(2);
  console.log(`\n[gen-trade-recap] ✅ Done! MP4: ${outMp4} (${mp4Size} MB)`);
}

main().catch(err => {
  console.error('[gen-trade-recap] Fatal:', err);
  process.exit(1);
});
