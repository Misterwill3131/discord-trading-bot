#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// list-templates.js — Liste tous les templates dispos dans video/templates/
// ─────────────────────────────────────────────────────────────────────
// Lance via : npm run templates:list
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const files = fs.readdirSync(TEMPLATES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

if (files.length === 0) {
  console.log('Aucun template dans ' + TEMPLATES_DIR);
  console.log('Crée un fichier .json (voir templates/README.md).');
  process.exit(0);
}

console.log('\n📋 Templates disponibles dans video/templates/\n');
for (const f of files) {
  const id = f.replace(/\.json$/, '');
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
  } catch (e) {
    console.log(`  ❌ ${id}  (invalid JSON: ${e.message})`);
    continue;
  }
  const comp = entry.composition || '?';
  const name = entry.name || id;
  const desc = entry.description || '';
  console.log(`  📄 ${id}`);
  console.log(`     ${name}  [${comp}]`);
  if (desc) console.log(`     ${desc}`);
  console.log('');
}

console.log('Render avec : npm run template:render -- <id>');
console.log('Override props : npm run template:render -- <id> \'{"key":"value"}\'\n');
