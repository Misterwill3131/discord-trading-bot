// ─────────────────────────────────────────────────────────────────────
// saas/anonymize.test.js — Tests d'étanchéité du module SaaS
// ─────────────────────────────────────────────────────────────────────
// Module sécurité critique : ces tests sont la garantie principale qu'aucun
// identifiant Discord ne fuit vers les serveurs clients. Tout signal qui
// passe doit produire un embed dont le JSON sérialisé ne contient AUCUNE
// des patterns interdites listées dans FORBIDDEN_SUBSTRINGS.
// ─────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert');

const {
  sanitizeText,
  roundToMinute,
  detectSide,
  buildSignalDTO,
  brandedEmbed,
  fmtPrice,
  parseScenarios,
  parseTargetForPattern,
} = require('./anonymize');

const SAMPLE_BRAND = {
  BRAND_NAME: 'TestBrand',
  BRAND_COLOR: 0x06b6d4,
  BRAND_THUMBNAIL_URL: null,
};

// Toute chaîne qui apparaît dans l'embed sérialisé final = fuite.
// Liste maintenue exhaustive — tout ajout futur de format Discord doit
// y être testé.
const FORBIDDEN_PATTERNS = [
  '<@',                  // mention user/role
  '<#',                  // mention channel
  '<:',                  // emoji custom statique
  '<a:',                 // emoji custom animé
  'discord.com/channels',
  'discordapp.com',
  'discord.gg/',
  '@everyone',
  '@here',
];

// ── sanitizeText : fondamentaux ──────────────────────────────────────

test('sanitizeText: strip <@id> mention user', () => {
  assert.strictEqual(sanitizeText('hi <@123456789> bye'), 'hi bye');
});

test('sanitizeText: strip <@!id> nick mention', () => {
  assert.strictEqual(sanitizeText('hi <@!123456789> bye'), 'hi bye');
});

test('sanitizeText: strip <@&id> role mention', () => {
  assert.strictEqual(sanitizeText('alert <@&987654321> now'), 'alert now');
});

test('sanitizeText: strip <#id> channel mention', () => {
  assert.strictEqual(sanitizeText('see <#111222333> for details'), 'see for details');
});

test('sanitizeText: strip <:name:id> static custom emoji', () => {
  assert.strictEqual(sanitizeText('rocket <:rocket:123> launch'), 'rocket launch');
});

test('sanitizeText: strip <a:name:id> animated custom emoji', () => {
  assert.strictEqual(sanitizeText('alert <a:siren:456> wake'), 'alert wake');
});

test('sanitizeText: strip discord.com/channels URL', () => {
  const s = 'context here https://discord.com/channels/111/222/333 read it';
  assert.strictEqual(sanitizeText(s), 'context here read it');
});

test('sanitizeText: strip discord.gg invite URL', () => {
  assert.strictEqual(sanitizeText('join https://discord.gg/abcdef now'), 'join now');
});

test('sanitizeText: strip discordapp.com legacy URL', () => {
  assert.strictEqual(
    sanitizeText('see https://discordapp.com/channels/1/2/3 here'),
    'see here'
  );
});

test('sanitizeText: strip cdn.discordapp.com attachment URL', () => {
  const s = 'image https://cdn.discordapp.com/attachments/111/222/file.png saved';
  assert.strictEqual(sanitizeText(s), 'image saved');
});

test('sanitizeText: strip media.discordapp.net URL', () => {
  const s = 'https://media.discordapp.net/attachments/x/y/z.jpg yes';
  assert.strictEqual(sanitizeText(s), 'yes');
});

test('sanitizeText: strip @everyone', () => {
  assert.strictEqual(sanitizeText('alert @everyone buy now'), 'alert buy now');
});

test('sanitizeText: strip @here', () => {
  assert.strictEqual(sanitizeText('@here check this'), 'check this');
});

test('sanitizeText: keep non-Discord URL', () => {
  const s = 'check https://yahoo.com/quote/TSLA out';
  assert.strictEqual(sanitizeText(s), 'check https://yahoo.com/quote/TSLA out');
});

test('sanitizeText: multi-mentions on one line', () => {
  const s = '<@123> tells <@&456> in <#789> to look at <:gem:111>';
  assert.strictEqual(sanitizeText(s), 'tells in to look at');
});

test('sanitizeText: empty input returns empty string', () => {
  assert.strictEqual(sanitizeText(''), '');
  assert.strictEqual(sanitizeText(null), '');
  assert.strictEqual(sanitizeText(undefined), '');
});

test('sanitizeText: collapses whitespace and trims', () => {
  assert.strictEqual(sanitizeText('  hello   world  '), 'hello world');
});

// ── roundToMinute ────────────────────────────────────────────────────

test('roundToMinute: secondes/ms truncated to 0', () => {
  const d = new Date('2025-01-15T12:34:56.789Z');
  const r = roundToMinute(d);
  assert.strictEqual(r.getUTCSeconds(), 0);
  assert.strictEqual(r.getUTCMilliseconds(), 0);
  assert.strictEqual(r.getUTCMinutes(), 34);
});

test('roundToMinute: floors (does not round up)', () => {
  const d = new Date('2025-01-15T12:34:59.999Z');
  const r = roundToMinute(d);
  assert.strictEqual(r.getUTCMinutes(), 34); // 59.999s → minute 34, pas 35
});

test('roundToMinute: accepts ms number input', () => {
  const ms = Date.UTC(2025, 0, 15, 12, 34, 56, 789);
  const r = roundToMinute(ms);
  assert.strictEqual(r.getTime() % 60000, 0);
});

// ── detectSide ───────────────────────────────────────────────────────

test('detectSide: default long', () => {
  assert.strictEqual(detectSide('TSLA in at 250 target 270'), 'long');
});

test('detectSide: short keyword', () => {
  assert.strictEqual(detectSide('TSLA short at 250'), 'short');
});

test('detectSide: puts triggers short', () => {
  assert.strictEqual(detectSide('grabbing TSLA puts'), 'short');
});

test('detectSide: bearish triggers short', () => {
  assert.strictEqual(detectSide('bearish setup on TSLA'), 'short');
});

test('detectSide: empty/null defaults long', () => {
  assert.strictEqual(detectSide(''), 'long');
  assert.strictEqual(detectSide(null), 'long');
});

// ── buildSignalDTO : structure et étanchéité ─────────────────────────

test('buildSignalDTO: extrait ticker, entry, target, stop d\'un message Discord typique', () => {
  const msg = {
    id: '1234567890',
    content: '<@&123456> $TSLA in at 250 target 270 sl 245',
    createdAt: new Date('2025-01-15T12:34:56.789Z'),
  };
  const dto = buildSignalDTO(msg);
  assert.strictEqual(dto.ticker, 'TSLA');
  assert.strictEqual(dto.entry_price, 250);
  assert.strictEqual(dto.target_price, 270);
  assert.strictEqual(dto.stop_price, 245);
  assert.strictEqual(dto.side, 'long');
  assert.strictEqual(dto.source_message_id, '1234567890');
});

test('buildSignalDTO: note nettoyée, max 300 chars', () => {
  const longNote = 'x'.repeat(500);
  const msg = { id: '1', content: longNote, createdAt: new Date() };
  const dto = buildSignalDTO(msg);
  assert.ok(dto.note.length <= 300);
});

test('buildSignalDTO: note=null si texte vide après sanitize', () => {
  const msg = { id: '1', content: '<@123> <@&456> <#789>', createdAt: new Date() };
  const dto = buildSignalDTO(msg);
  assert.strictEqual(dto.note, null);
});

test('buildSignalDTO: ts_minute arrondi à la minute', () => {
  const msg = {
    id: '1', content: 'TSLA',
    createdAt: new Date('2025-01-15T12:34:56.789Z'),
  };
  const dto = buildSignalDTO(msg);
  assert.strictEqual(dto.ts_minute.getTime() % 60000, 0);
});

test('buildSignalDTO: ne contient AUCUN champ identifiant la source', () => {
  const msg = {
    id: '999', content: '$TSLA at 250',
    createdAt: new Date(),
    author: { username: 'AnalystName', id: '777' },
    guild: { id: '666', name: 'SecretSourceServer' },
    channel: { id: '555', name: 'private-signals' },
  };
  const dto = buildSignalDTO(msg);
  // Whitelist stricte des champs autorisés.
  const allowed = new Set([
    'ticker', 'side', 'entry_price', 'target_price', 'stop_price',
    'gain_pct', 'note', 'ts_minute', 'source_message_id',
    // Champs ajoutés pour les layouts conditionnel et structuré — tous
    // dérivés du texte sanitisé (ticker, prix, condition d'entrée, note du trader).
    'scenarios', 'is_conditional',
    'targets', 'buy_condition', 'add_entry_price', 'signal_note', 'is_structured',
    'is_exit_update',
  ]);
  for (const key of Object.keys(dto)) {
    assert.ok(allowed.has(key), `DTO contient le champ interdit: ${key}`);
  }
  // Pas de leak indirect via les valeurs.
  const json = JSON.stringify(dto);
  assert.ok(!json.includes('AnalystName'));
  assert.ok(!json.includes('SecretSourceServer'));
  assert.ok(!json.includes('private-signals'));
  assert.ok(!json.includes('"666"'));
});

// ── brandedEmbed : pas de fuite dans le JSON sérialisé ───────────────

test('brandedEmbed: type EmbedBuilder, color/title/footer corrects', () => {
  const dto = buildSignalDTO({
    id: '1', content: '$TSLA in at 250 target 270',
    createdAt: new Date('2025-01-15T12:34:56.789Z'),
  });
  const eb = brandedEmbed(dto, SAMPLE_BRAND);
  const json = eb.toJSON();
  assert.strictEqual(json.color, 0x06b6d4);
  assert.strictEqual(json.title, '$TSLA');
  assert.strictEqual(json.footer.text, 'via TestBrand');
  assert.ok(typeof json.timestamp === 'string');
});

test('brandedEmbed: title=Signal si pas de ticker détecté', () => {
  const dto = buildSignalDTO({ id: '1', content: 'random note', createdAt: new Date() });
  const eb = brandedEmbed(dto, SAMPLE_BRAND);
  assert.strictEqual(eb.toJSON().title, 'Signal');
});

test('brandedEmbed: titre identique long/short (pas de side dans le titre)', () => {
  const dtoLong = buildSignalDTO({
    id: '1', content: 'TSLA in at 250 target 270', createdAt: new Date(),
  });
  const dtoShort = buildSignalDTO({
    id: '2', content: 'TSLA short at 250 target 230', createdAt: new Date(),
  });
  assert.strictEqual(brandedEmbed(dtoLong, SAMPLE_BRAND).toJSON().title, '$TSLA');
  assert.strictEqual(brandedEmbed(dtoShort, SAMPLE_BRAND).toJSON().title, '$TSLA');
});

test('brandedEmbed: BRAND_IMAGE_URL rendu en bannière bas si défini', () => {
  const dto = buildSignalDTO({ id: '1', content: 'TSLA at 1', createdAt: new Date() });
  const without = brandedEmbed(dto, SAMPLE_BRAND).toJSON();
  assert.strictEqual(without.image, undefined);

  const withImg = brandedEmbed(dto, {
    ...SAMPLE_BRAND,
    BRAND_IMAGE_URL: 'https://example.com/banner.png',
  }).toJSON();
  assert.strictEqual(withImg.image.url, 'https://example.com/banner.png');
});

test('brandedEmbed: thumbnail SEULEMENT si BRAND_THUMBNAIL_URL défini', () => {
  const dto = buildSignalDTO({ id: '1', content: 'TSLA at 1', createdAt: new Date() });
  const without = brandedEmbed(dto, SAMPLE_BRAND).toJSON();
  assert.strictEqual(without.thumbnail, undefined);

  const withThumb = brandedEmbed(dto, {
    ...SAMPLE_BRAND,
    BRAND_THUMBNAIL_URL: 'https://example.com/logo.png',
  }).toJSON();
  assert.strictEqual(withThumb.thumbnail.url, 'https://example.com/logo.png');
});

test('brandedEmbed: SNAPSHOT — JSON ne contient AUCUN pattern interdit', () => {
  // Cas adverse : message bourré de toutes les fuites possibles.
  const adversarial = [
    'ANALYST mentioning <@123456789012345678> and <@!987654321098765432>',
    'role <@&111111111111111111> in <#222222222222222222>',
    'emojis <:custom:333333333333333333> and <a:anim:444444444444444444>',
    'check https://discord.com/channels/555/666/777',
    'invite https://discord.gg/SECRETCODE',
    'cdn https://cdn.discordapp.com/attachments/A/B/screenshot.png',
    'broadcast @everyone @here urgent',
    '$TSLA in at 250.50 target 275.00 sl 240.00',
  ].join(' ');

  const msg = {
    id: '999888777',
    content: adversarial,
    createdAt: new Date('2025-01-15T12:34:56.789Z'),
    // Champs source — buildSignalDTO doit les ignorer
    author: { username: 'SecretAnalystName', id: '12345' },
    guild: { id: '67890', name: 'PrivateBoom' },
  };
  const dto = buildSignalDTO(msg);
  const embed = brandedEmbed(dto, SAMPLE_BRAND);
  const json = JSON.stringify(embed.toJSON());

  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(
      !json.includes(pattern),
      `LEAK: l'embed JSON contient "${pattern}" — ${json}`
    );
  }
  // Pas de leak via les noms d'auteur/serveur/channel.
  assert.ok(!json.includes('SecretAnalystName'));
  assert.ok(!json.includes('PrivateBoom'));
  // Le ticker, lui, doit bien arriver — c'est le but du relais.
  assert.ok(json.includes('TSLA'));
});

// ── parseScenarios / parseTargetForPattern ──────────────────────────

test('parseScenarios: 2 scénarios break + bounce', () => {
  const sc = parseScenarios('SAGT will enter 2.49 break or 1.88 bounce for 2.97');
  assert.strictEqual(sc.length, 2);
  assert.strictEqual(sc[0].type, 'break');
  assert.strictEqual(sc[0].price, 2.49);
  assert.strictEqual(sc[1].type, 'bounce');
  assert.strictEqual(sc[1].price, 1.88);
});

test('parseScenarios: vide si aucun keyword', () => {
  assert.deepStrictEqual(parseScenarios('TSLA in at 250'), []);
  assert.deepStrictEqual(parseScenarios('BIYA 1.38'), []);
});

test('parseScenarios: tolère pluriel/conjugaison', () => {
  const a = parseScenarios('2.49 breaks or 1.88 bouncing');
  assert.strictEqual(a.length, 2);
  const b = parseScenarios('2.49 breakout or 1.88 reclaim');
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].type, 'break');
  assert.strictEqual(b[1].type, 'reclaim');
});

test('parseTargetForPattern: capture "for X" en fin', () => {
  assert.strictEqual(parseTargetForPattern('SAGT 2.49 break for 2.97'), 2.97);
  assert.strictEqual(parseTargetForPattern('break 1.5 for 2'), 2);
});

test('parseTargetForPattern: ignore les % (gain pct, pas un prix)', () => {
  assert.strictEqual(parseTargetForPattern('locked in for 30%'), null);
});

test('parseTargetForPattern: rejette nombres improbables (>10000)', () => {
  assert.strictEqual(parseTargetForPattern('thanks for 99999'), null);
});

// ── brandedEmbed conditional layout ─────────────────────────────────

test('buildSignalDTO: SAGT conditional → is_conditional=true, target via "for"', () => {
  const dto = buildSignalDTO({
    id: '1', content: 'SAGT will enter 2.49 break or 1.88 bounce for 2.97',
    createdAt: new Date(),
  });
  assert.strictEqual(dto.ticker, 'SAGT');
  assert.strictEqual(dto.is_conditional, true);
  assert.strictEqual(dto.scenarios.length, 2);
  assert.strictEqual(dto.target_price, 2.97);
});

test('brandedEmbed: layout conditionnel utilisé pour signal multi-scénarios', () => {
  const dto = buildSignalDTO({
    id: '1', content: 'SAGT 2.49 break or 1.88 bounce for 2.97',
    createdAt: new Date(),
  });
  const json = brandedEmbed(dto, SAMPLE_BRAND).toJSON();
  assert.strictEqual(json.title, '$SAGT — Only if');
  // Les 2 scénarios + OR IF + target doivent apparaître dans la description
  assert.ok(json.description.includes('Break entry'));
  assert.ok(json.description.includes('Bounce entry'));
  assert.ok(json.description.includes('OR IF'));
  assert.ok(json.description.includes('Target'));
  assert.ok(json.description.includes('2.97'));
  // Pas de fields inline sur le layout conditionnel
  assert.ok(!json.fields || json.fields.length === 0);
});

test('brandedEmbed: layout simple pour signal mono-scénario même avec break', () => {
  const dto = buildSignalDTO({
    id: '1', content: 'TSLA 2.49 break for 2.97',
    createdAt: new Date(),
  });
  // Un seul scénario → pas conditional
  assert.strictEqual(dto.is_conditional, false);
  const json = brandedEmbed(dto, SAMPLE_BRAND).toJSON();
  assert.strictEqual(json.title, '$TSLA');
  // Layout classique avec fields
  assert.ok(json.fields && json.fields.length >= 3);
});

// ── fmtPrice ─────────────────────────────────────────────────────────

test('fmtPrice: null/undefined → tiret cadratin', () => {
  assert.strictEqual(fmtPrice(null), '—');
  assert.strictEqual(fmtPrice(undefined), '—');
  assert.strictEqual(fmtPrice(NaN), '—');
});

test('fmtPrice: sub-dollar → 4 décimales', () => {
  assert.strictEqual(fmtPrice(0.46), '0.4600');
});

test('fmtPrice: gros nombre → 2 décimales', () => {
  assert.strictEqual(fmtPrice(150), '150.00');
  assert.strictEqual(fmtPrice(1234.5678), '1234.57');
});

// ── parseExitStatus : rejette les status updates / exits ──────────────

const { parseExitStatus } = require('./anonymize');

test('parseExitStatus: "first PT hit 6.30-7.50" → true', () => {
  assert.strictEqual(parseExitStatus('UONE first PT hit 6.30-7.50'), true);
});

test('parseExitStatus: "PT hit" → true', () => {
  assert.strictEqual(parseExitStatus('UONE PT hit'), true);
});

test('parseExitStatus: "TP hit @1.78" → true', () => {
  assert.strictEqual(parseExitStatus('AMC TP hit @1.78'), true);
});

test('parseExitStatus: "target reached" → true', () => {
  assert.strictEqual(parseExitStatus('NVDA target reached at 180'), true);
});

test('parseExitStatus: "target tagged" → true', () => {
  assert.strictEqual(parseExitStatus('NVDA target tagged'), true);
});

test('parseExitStatus: "stopped out" → true', () => {
  assert.strictEqual(parseExitStatus('AAPL stopped out'), true);
});

test('parseExitStatus: "stop hit" → true', () => {
  assert.strictEqual(parseExitStatus('TSLA stop hit'), true);
});

test('parseExitStatus: "stop loss hit" → true', () => {
  assert.strictEqual(parseExitStatus('TSLA stop loss hit at 145'), true);
});

test('parseExitStatus: "scaled out @1.78" → true', () => {
  assert.strictEqual(parseExitStatus('AMC scaled out @1.78'), true);
});

test('parseExitStatus: "scaling out" → true', () => {
  assert.strictEqual(parseExitStatus('AMC scaling out half'), true);
});

test('parseExitStatus: "trimmed half" → true', () => {
  assert.strictEqual(parseExitStatus('SPY trimmed half'), true);
});

test('parseExitStatus: "sold UONE" → true', () => {
  assert.strictEqual(parseExitStatus('sold UONE @5.20'), true);
});

test('parseExitStatus: "exited" → true', () => {
  assert.strictEqual(parseExitStatus('AAPL exited at breakeven'), true);
});

test('parseExitStatus: "took profits" → true', () => {
  assert.strictEqual(parseExitStatus('NVDA took profits'), true);
});

test('parseExitStatus: "locked in 25%" → true', () => {
  assert.strictEqual(parseExitStatus('locked in 25% on AAPL'), true);
});

test('parseExitStatus: "closed position" → true', () => {
  assert.strictEqual(parseExitStatus('AMD closed position at 180'), true);
});

// ── parseExitStatus : faux positifs à éviter ──────────────────────────

test('parseExitStatus: signal d\'entrée standard "$AAPL 150-155" → false', () => {
  assert.strictEqual(parseExitStatus('$AAPL 150-155 buy zone'), false);
});

test('parseExitStatus: "buy only above $3.81 Targets $4.18/4.64" → false', () => {
  assert.strictEqual(parseExitStatus('$FATN buy only above $3.81 Targets $4.18/4.64/5.24 SL $3.04'), false);
});

test('parseExitStatus: "in at 1.50, target 1.75" → false', () => {
  assert.strictEqual(parseExitStatus('AAPL in at 1.50, target 1.75, sl 1.40'), false);
});

test('parseExitStatus: "HCAI 10.45" → false (signal nu)', () => {
  assert.strictEqual(parseExitStatus('HCAI 10.45'), false);
});

test('parseExitStatus: bare "trim" sans modifier (intent futur) → false', () => {
  // "will trim @180" est ambigu — on ne reject pas ; "trimmed" en past tense le serait
  assert.strictEqual(parseExitStatus('NVDA buy 150 will trim @180'), false);
});

test('parseExitStatus: "PT 180" sans verbe d\'action → false', () => {
  assert.strictEqual(parseExitStatus('AAPL 150 PT 180'), false);
});

// ── DTO : is_exit_update propagé correctement ─────────────────────────

test('DTO: "UONE first PT hit 6.30-7.50" → is_exit_update=true', () => {
  const dto = buildSignalDTO({ id: '1', content: 'UONE first PT hit 6.30-7.50', createdAt: new Date() });
  assert.strictEqual(dto.is_exit_update, true);
});

test('DTO: "$FATN buy only above $3.81" → is_exit_update=false', () => {
  const dto = buildSignalDTO({ id: '1', content: '$FATN buy only above $3.81', createdAt: new Date() });
  assert.strictEqual(dto.is_exit_update, false);
});
