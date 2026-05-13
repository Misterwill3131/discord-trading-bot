#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// create-template.js — Generator interactif pour créer un nouveau template
// ─────────────────────────────────────────────────────────────────────
// Lance via : npm run template:create
//
// Workflow :
//   1. Choisis l'ID du template (slug)
//   2. Choisis la composition (BoomEntry / ChartTemplate / SignalAlert / BrandPromo)
//   3. Donne un nom lisible + description
//   4. Optionnel : clone les props d'un template existant comme base
//   5. Écrit le fichier templates/<id>.json
//   6. Le user peut éditer ensuite à la main pour ajuster
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// Defaults par composition (synced avec Root.tsx defaultProps).
const COMPOSITION_DEFAULTS = {
  BoomEntry: {
    ticker: 'TSLA',
    author: 'Z',
    message: '$TSLA 150-155 entry long',
    timestamp: '2026-04-25T13:32:00-04:00',
    stingerText: '🚨 LIVE',
    teaseAction: 'just called this.',
    teaseSubtext: 'Watch live →',
    cardLabel: '🚨 LIVE SIGNAL',
    ctaTitle: 'JOIN',
    ctaUrl: 'discord.gg/boom',
    ctaSubtitle: 'Get every signal live',
    accentColor: '#ef4444',
    musicVolume: 0.55,
    sfxEnabled: true,
    stingerFontSize: 220,
    tickerFontSize: 280,
    ctaTitleFontSize: 200,
    transitionType: 'fade',
  },
  ChartTemplate: {
    ticker: 'TSLA',
    entryAuthor: 'Z',
    entryMessage: '$TSLA 150 entry long',
    entryTimestamp: '2026-04-25T13:32:00-04:00',
    exitAuthor: 'Z',
    exitMessage: '$TSLA out +20%',
    exitTimestamp: '2026-04-25T16:30:00-04:00',
    pnl: '+20%',
    ctaUrl: 'discord.gg/boom',
    accentColor: '#10b981',
    musicVolume: 0.55,
    sfxEnabled: true,
  },
  SignalAlert: {
    ticker: 'TSLA',
    type: 'entry',
    direction: 'long',
    entry: '150-155',
    target: '165',
    stop: '148',
    author: 'Z',
    message: '$TSLA 150-155 entry long',
    timestamp: '2026-04-25T13:32:00-04:00',
  },
  BrandPromo: {},
};

const COMPOSITIONS = Object.keys(COMPOSITION_DEFAULTS);

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n📝 Création d\'un nouveau template Remotion\n');

  // 1. ID du template
  let id = '';
  while (!id) {
    id = await ask(rl, 'ID du template (slug, ex: "viral-purple") : ');
    if (!id) {
      console.log('  → Vide, réessaye.');
      continue;
    }
    if (!/^[a-z0-9-]+$/i.test(id)) {
      console.log('  → ID doit être alphanumérique + tirets seulement. Réessaye.');
      id = '';
      continue;
    }
    const target = path.join(TEMPLATES_DIR, id + '.json');
    if (fs.existsSync(target)) {
      console.log(`  → ${id}.json existe déjà. Choisis un autre ID.`);
      id = '';
    }
  }

  // 2. Composition
  console.log('\nCompositions disponibles :');
  COMPOSITIONS.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
  let compIdx = -1;
  while (compIdx < 0 || compIdx >= COMPOSITIONS.length) {
    const ans = await ask(rl, `Choisis la composition (1-${COMPOSITIONS.length}) : `);
    compIdx = parseInt(ans, 10) - 1;
  }
  const composition = COMPOSITIONS[compIdx];

  // 3. Nom + description
  const name = await ask(rl, 'Nom lisible du template (affiché par list) : ');
  const description = await ask(rl, 'Courte description (optionnelle) : ');

  // 4. Clone d'un template existant ?
  const existing = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
  let baseProps = COMPOSITION_DEFAULTS[composition];
  if (existing.length > 0) {
    console.log('\nTemplates existants à cloner (ou laisse vide pour partir des defaults) :');
    existing.forEach((e, i) => console.log(`  ${i + 1}) ${e}`));
    const ans = await ask(rl, 'Clone depuis (numéro ou vide) : ');
    const idx = parseInt(ans, 10) - 1;
    if (idx >= 0 && idx < existing.length) {
      const cloneFrom = existing[idx];
      try {
        const cloned = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, cloneFrom + '.json'), 'utf-8'));
        if (cloned.composition === composition) {
          baseProps = cloned.props;
          console.log(`  → Cloné depuis ${cloneFrom}`);
        } else {
          console.log(`  → ${cloneFrom} est pour ${cloned.composition}, pas ${composition}. On garde les defaults.`);
        }
      } catch (e) {
        console.log(`  → Erreur lecture ${cloneFrom} : ${e.message}. On garde les defaults.`);
      }
    }
  }

  // 5. Écrit le fichier
  const template = {
    composition,
    name: name || id,
    description: description || '',
    props: baseProps,
  };

  const target = path.join(TEMPLATES_DIR, id + '.json');
  fs.writeFileSync(target, JSON.stringify(template, null, 2) + '\n');

  console.log(`\n✅ Template créé : ${target}`);
  console.log(`\nProchaines étapes :`);
  console.log(`  1. Édite ${id}.json à la main si tu veux ajuster les props`);
  console.log(`  2. npm run template:render -- ${id}`);
  console.log(`  3. npm run templates:list (le verra automatiquement)\n`);

  rl.close();
})();
