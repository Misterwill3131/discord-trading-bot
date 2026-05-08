#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// render-template.js — Render une vidéo Remotion à partir d'un template
// ─────────────────────────────────────────────────────────────────────
// Lance via : npm run template:render -- <template-id> [overrides-json]
//   ex: npm run template:render -- aggressive-red
//   ex: npm run template:render -- aggressive-red '{"ticker":"NVDA"}'
//
// Le template est cherché dans video/templates/<id>.json. La sortie
// est écrite dans video/out/<id>.mp4.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const OUT_DIR = path.join(__dirname, '..', 'out');

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const templateId = args[0];
const overridesJson = args[1];

if (!templateId) {
  fail('Usage: render-template.js <template-id> [overrides-json]\nLister les templates : npm run templates:list');
}

const templatePath = path.join(TEMPLATES_DIR, templateId + '.json');
if (!fs.existsSync(templatePath)) {
  fail(`Template introuvable : ${templatePath}\nLister : npm run templates:list`);
}

let template;
try {
  template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
} catch (e) {
  fail(`Template invalid JSON : ${e.message}`);
}

if (!template.composition) fail('Template manque le champ "composition" (ex: "BoomEntry")');
if (!template.props) fail('Template manque le champ "props"');

// Merge overrides éventuels.
let mergedProps = template.props;
if (overridesJson) {
  let overrides;
  try {
    overrides = JSON.parse(overridesJson);
  } catch (e) {
    fail(`Overrides JSON invalid : ${e.message}`);
  }
  mergedProps = { ...template.props, ...overrides };
}

// Préparer la sortie.
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFilename = `${templateId}.mp4`;
const outPath = path.join(OUT_DIR, outFilename);

console.log(`📦 Template : ${templateId} (${template.name || ''})`);
console.log(`🎬 Composition : ${template.composition}`);
console.log(`📂 Sortie : ${outPath}`);
if (overridesJson) console.log(`🔧 Overrides : ${overridesJson}`);
console.log('');

// Écrit les props dans un fichier temporaire (plus robuste que CLI string).
const tmpPropsPath = path.join(OUT_DIR, `.tmp-props-${templateId}.json`);
fs.writeFileSync(tmpPropsPath, JSON.stringify(mergedProps));

// Lance npx remotion render
const result = spawnSync(
  'npx',
  ['remotion', 'render', template.composition, outPath, `--props=${tmpPropsPath}`],
  { stdio: 'inherit', shell: true, cwd: path.join(__dirname, '..') }
);

// Cleanup tmp file
try { fs.unlinkSync(tmpPropsPath); } catch (_) {}

if (result.status !== 0) {
  fail(`Render failed (exit ${result.status})`);
}

console.log(`\n✅ Done : ${outPath}`);
