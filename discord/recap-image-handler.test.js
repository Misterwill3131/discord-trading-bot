const { test } = require('node:test');
const assert = require('node:assert');

const {
  handleRecapImageMessage,
  pickImageAttachment,
  buildRecapJobPayload,
  buildAlertImagesBase64,
  nyDateKeyToUtcRange,
  addDaysToDateKey,
} = require('./recap-image-handler');

// ── pickImageAttachment ────────────────────────────────────────────
test('pickImageAttachment returns null when no attachments', () => {
  const msg = { attachments: new Map() };
  assert.strictEqual(pickImageAttachment(msg), null);
});

test('pickImageAttachment picks first image by contentType', () => {
  const att1 = { name: 'doc.pdf', contentType: 'application/pdf' };
  const att2 = { name: 'pic.png', contentType: 'image/png' };
  const map = new Map([['a', att1], ['b', att2]]);
  const got = pickImageAttachment({ attachments: map });
  assert.strictEqual(got, att2);
});

test('pickImageAttachment falls back to extension when contentType missing', () => {
  const att = { name: 'screenshot.jpeg', contentType: null };
  const map = new Map([['a', att]]);
  assert.strictEqual(pickImageAttachment({ attachments: map }), att);
});

test('pickImageAttachment skips non-images entirely', () => {
  const att = { name: 'log.txt', contentType: 'text/plain' };
  const map = new Map([['a', att]]);
  assert.strictEqual(pickImageAttachment({ attachments: map }), null);
});

// ── buildRecapJobPayload ───────────────────────────────────────────
test('buildRecapJobPayload returns valid render_jobs payload', () => {
  const ocrResult = {
    dateLabel: 'TODAY',
    trades: [
      { ticker: '$TSLA', entryPrice: 200, hodPrice: 220 },
      { ticker: '$DXYZ', entryPrice: 30, hodPrice: 71 },
    ],
    longTermInvestments: [{ ticker: '$RVI', entryPrice: 0.5, currentPrice: 1.16 }],
  };
  const payload = buildRecapJobPayload({
    ocrResult,
    alertImagesBase64: [{ base64: 'AAAA', ticker: '$TSLA' }],
    authorName: 'someone',
    messageCreatedAt: new Date('2026-05-13T15:30:00-04:00'),
    outputChannelId: '1312793427515277332',
  });
  assert.strictEqual(payload.composition, 'TobTradeRecap');
  assert.strictEqual(payload.template_name, 'trade-recap-default');
  assert.strictEqual(payload.output_channel_id, '1312793427515277332');
  assert.strictEqual(payload.ticker, 'TOB-RECAP');
  // NOT NULL placeholders
  assert.ok(payload.entry_author);
  assert.ok(payload.entry_message);
  assert.ok(payload.entry_ts);
  assert.ok(payload.exit_ts);
  assert.ok(payload.pnl);
  // recap_data carries everything the worker needs
  const data = JSON.parse(payload.recap_data);
  assert.strictEqual(data.dateLabel, 'TODAY');
  assert.strictEqual(data.trades.length, 2);
  assert.strictEqual(data.longTermInvestments.length, 1);
  assert.strictEqual(data.longTermInvestments[0].ticker, '$RVI');
  assert.strictEqual(data.alertImagesBase64.length, 1);
  assert.strictEqual(data.alertImagesBase64[0].base64, 'AAAA');
});

test('buildRecapJobPayload defaults alertImagesBase64 to [] when missing', () => {
  const payload = buildRecapJobPayload({
    ocrResult: { dateLabel: 'TODAY', trades: [{ ticker: '$TSLA', entryPrice: 1, hodPrice: 2 }] },
    authorName: 'x',
    messageCreatedAt: new Date('2026-05-13T15:30:00-04:00'),
    outputChannelId: 'abc',
  });
  const data = JSON.parse(payload.recap_data);
  assert.deepStrictEqual(data.alertImagesBase64, []);
});

// ── nyDateKeyToUtcRange ────────────────────────────────────────────
test('nyDateKeyToUtcRange returns 24h window starting at NY midnight (EDT)', () => {
  // 2026-05-13 est en EDT (UTC-4). NY 00:00 = UTC 04:00.
  const [start, end] = nyDateKeyToUtcRange('2026-05-13');
  assert.strictEqual(start, '2026-05-13T04:00:00.000Z');
  assert.strictEqual(end, '2026-05-14T04:00:00.000Z');
});

test('nyDateKeyToUtcRange uses UTC-5 (EST) in winter', () => {
  // 2026-01-15 est en EST (UTC-5). NY 00:00 = UTC 05:00.
  const [start, end] = nyDateKeyToUtcRange('2026-01-15');
  assert.strictEqual(start, '2026-01-15T05:00:00.000Z');
  assert.strictEqual(end, '2026-01-16T05:00:00.000Z');
});

test('addDaysToDateKey shifts day correctly (incl. month boundary)', () => {
  assert.strictEqual(addDaysToDateKey('2026-05-14', -1), '2026-05-13');
  assert.strictEqual(addDaysToDateKey('2026-05-01', -1), '2026-04-30');
  assert.strictEqual(addDaysToDateKey('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(addDaysToDateKey('2026-05-14', +1), '2026-05-15');
});

// ── buildAlertImagesBase64 ─────────────────────────────────────────
test('buildAlertImagesBase64 returns [] when DB query throws', async () => {
  const result = await buildAlertImagesBase64({
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => { throw new Error('DB locked'); },
      generateImage: () => Promise.resolve(Buffer.from('')),
      dateKey: '2026-05-13',
    },
  });
  assert.deepStrictEqual(result, []);
});

test('buildAlertImagesBase64 queries DB with NY-tz UTC range, not raw date substring', async () => {
  let capturedFrom = null;
  let capturedTo = null;
  await buildAlertImagesBase64({
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: (from, to) => { capturedFrom = from; capturedTo = to; return []; },
      generateImage: () => Promise.resolve(Buffer.from('p')),
      dateKey: '2026-05-13',
    },
  });
  // Doit envoyer la fenêtre [04:00 UTC, +24h] pour 2026-05-13 (EDT).
  assert.strictEqual(capturedFrom, '2026-05-13T04:00:00.000Z');
  assert.strictEqual(capturedTo, '2026-05-14T04:00:00.000Z');
});

test('buildAlertImagesBase64 filters to type=entry, reverses order (chronological), and limits', async () => {
  // getMessagesByTsRange retourne DESC — la fonction doit re-inverser
  // pour ordre chronologique (alerte 1 = plus ancienne).
  const messages = [
    { type: 'entry', author: 'C', content: '$NVDA 2', ts: '2026-05-13T15:00:00-04:00', ticker: 'NVDA' },
    { type: 'exit',  author: 'B', content: '$TSLA out', ts: '2026-05-13T14:00:00-04:00', ticker: 'TSLA' },
    { type: 'entry', author: 'A', content: '$TSLA 1', ts: '2026-05-13T13:00:00-04:00', ticker: 'TSLA' },
  ];
  const result = await buildAlertImagesBase64({
    maxAlerts: 5,
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${author}-${content}`)),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 2);
  // Première alerte chronologique = TSLA (13:00) avant NVDA (15:00).
  assert.strictEqual(result[0].ticker, 'TSLA');
  assert.strictEqual(result[1].ticker, 'NVDA');
  assert.strictEqual(Buffer.from(result[0].base64, 'base64').toString(), 'PNG-A-$TSLA 1');
});

test('buildAlertImagesBase64 picks the entry whose content contains the trade price', async () => {
  // 3 messages TDIC : un call original (1.43) puis 2 target hits.
  // Le récap a entryPrice=1.43, donc on doit choisir le call original.
  // DB retourne DESC (plus récent en premier).
  const messages = [
    { type: 'entry', author: 'ZZ', content: 'TDIC 25 nailed', ts: '2026-05-13T19:33:00Z', ticker: 'TDIC' },
    { type: 'entry', author: 'ZZ', content: 'TDIC 25 above', ts: '2026-05-13T19:21:00Z', ticker: 'TDIC' },
    { type: 'entry', author: 'ZZ', content: 'TDIC 1.43-3.19 entry', ts: '2026-05-13T13:32:00Z', ticker: 'TDIC' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [{ ticker: '$TDIC', entryPrice: 1.43, hodPrice: 3.71 }],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(Buffer.from(result[0].base64, 'base64').toString(), 'PNG-TDIC 1.43-3.19 entry');
});

test('buildAlertImagesBase64 falls back to earliest entry when price is not in any content', async () => {
  // Aucun content ne contient "1.43" exactement → fallback = la + ancienne TDIC.
  const messages = [
    { type: 'entry', author: 'ZZ', content: 'TDIC 25 nailed', ts: '2026-05-13T19:33:00Z', ticker: 'TDIC' },
    { type: 'entry', author: 'ZZ', content: 'TDIC bouncing off 9ema', ts: '2026-05-13T13:32:00Z', ticker: 'TDIC' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [{ ticker: '$TDIC', entryPrice: 1.43, hodPrice: 3.71 }],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 1);
  // Fallback = la + ancienne (13:32 = "bouncing off 9ema"), pas le 19:33 nailed
  assert.strictEqual(Buffer.from(result[0].base64, 'base64').toString(), 'PNG-TDIC bouncing off 9ema');
});

test('buildAlertImagesBase64 with leading-zero price variants (".046" matches 0.046)', async () => {
  const messages = [
    { type: 'entry', author: 'ZZ', content: 'HAO .046 Lotto', ts: '2026-05-13T14:00:00Z', ticker: 'HAO' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [{ ticker: '$HAO', entryPrice: 0.046, hodPrice: 0.071 }],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(Buffer.from(result[0].base64, 'base64').toString(), 'PNG-HAO .046 Lotto');
});

test('buildAlertImagesBase64 only includes tickers from trades (drops $AAPL not in recap)', async () => {
  const messages = [
    { type: 'entry', author: 'ZZ', content: 'AAPL 150 entry', ts: '2026-05-13T13:00:00Z', ticker: 'AAPL' },
    { type: 'entry', author: 'ZZ', content: 'TDIC 1.43 entry', ts: '2026-05-13T13:30:00Z', ticker: 'TDIC' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [{ ticker: '$TDIC', entryPrice: 1.43, hodPrice: 3.71 }],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].ticker, 'TDIC');
});

test('buildAlertImagesBase64 prefers different messages for duplicate-ticker trades', async () => {
  // ZZ a posté 2 calls LNKS distincts (1.39 puis 1.66). Le récap a aussi
  // 2 lignes LNKS. → Chaque ligne doit obtenir son propre message.
  const messages = [
    { id: 1, type: 'entry', author: 'ZZ', content: 'LNKS 1.66 re-entry', ts: '2026-05-13T15:00:00Z', ticker: 'LNKS' },
    { id: 2, type: 'entry', author: 'ZZ', content: 'LNKS 1.39 entry', ts: '2026-05-13T13:00:00Z', ticker: 'LNKS' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$LNKS', entryPrice: 1.39, hodPrice: 2.47 },
      { ticker: '$LNKS', entryPrice: 1.66, hodPrice: 2.47 },
    ],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 2);
  const contents = result.map(r => Buffer.from(r.base64, 'base64').toString());
  assert.ok(contents.includes('PNG-LNKS 1.39 entry'));
  assert.ok(contents.includes('PNG-LNKS 1.66 re-entry'));
});

test('buildAlertImagesBase64 reuses same message when ZZ posted only one multi-price call', async () => {
  // ZZ a posté UN SEUL call multi-prix → on accepte de réutiliser ce
  // message pour les 2 trades du récap (mieux qu'un trou).
  const messages = [
    { id: 1, type: 'entry', author: 'ZZ', content: 'OCG 2.10 and re-entry at 2.25', ts: '2026-05-13T13:00:00Z', ticker: 'OCG' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$OCG', entryPrice: 2.10, hodPrice: 2.98 },
      { ticker: '$OCG', entryPrice: 2.25, hodPrice: 2.60 },
    ],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: () => Promise.resolve(Buffer.from('p')),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 2);
});

test('buildAlertImagesBase64 returns 16 alerts when recap has 16 trades (cap auto-scales)', async () => {
  // 16 tickers uniques, un message chacun. Default maxAlerts=12 ne doit
  // PAS couper la parade — l'utilisateur veut une carte par ligne.
  const tickers = ['AIIO','AEHL','DGXX','LNKS','QUCY','SNAL','RUBI','YOOV','OCG','EDBL','MOBX','WOK','POET','TSLA','NVDA','META'];
  const messages = tickers.map((t, i) => ({
    id: i + 1, type: 'entry', author: 'ZZ',
    content: `${t} entry`, ts: `2026-05-13T${String(13 + i % 6).padStart(2, '0')}:${String(i * 3 % 60).padStart(2, '0')}:00Z`,
    ticker: t,
  }));
  const trades = tickers.map(t => ({ ticker: '$' + t, entryPrice: 1.0, hodPrice: 2.0 }));
  const result = await buildAlertImagesBase64({
    trades,
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: () => Promise.resolve(Buffer.from('p')),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 16);
});

test('buildAlertImagesBase64 with empty trades keeps all entries (legacy)', async () => {
  const messages = [
    { type: 'entry', author: 'ZZ', content: '$AAPL 150', ts: '2026-05-13T13:00:00Z', ticker: 'AAPL' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: () => Promise.resolve(Buffer.from('p')),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 1);
});

test('buildAlertImagesBase64 falls back to yesterday when today has 0 matches', async () => {
  // Scénario : on est le 14 mai 09:22 ET. Aucun ticker du récap n'a
  // d'entry aujourd'hui (vide), mais ils sont tous présents le 13.
  // → Le code doit basculer sur le 13.
  const todayRange = ['2026-05-14T04:00:00.000Z', '2026-05-15T04:00:00.000Z'];
  const yesterdayRange = ['2026-05-13T04:00:00.000Z', '2026-05-14T04:00:00.000Z'];
  const todayMsgs = []; // aucune entry pour le récap aujourd'hui
  const yesterdayMsgs = [
    { type: 'entry', author: 'ZZ', content: 'AEHL 1.44 entry', ts: '2026-05-13T17:30:00Z', ticker: 'AEHL' },
    { type: 'entry', author: 'ZZ', content: 'QUCY 0.44 entry', ts: '2026-05-13T16:00:00Z', ticker: 'QUCY' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$AEHL', entryPrice: 1.44, hodPrice: 6.27 },
      { ticker: '$QUCY', entryPrice: 0.44, hodPrice: 2.11 },
    ],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: (from, to) => {
        if (from === todayRange[0] && to === todayRange[1]) return todayMsgs;
        if (from === yesterdayRange[0] && to === yesterdayRange[1]) return yesterdayMsgs;
        return [];
      },
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-14',
    },
  });
  assert.strictEqual(result.length, 2);
  const contents = result.map(r => Buffer.from(r.base64, 'base64').toString());
  assert.ok(contents.some(c => c.includes('AEHL 1.44')));
  assert.ok(contents.some(c => c.includes('QUCY 0.44')));
});

test('buildAlertImagesBase64 prefers today when both days have matches', async () => {
  // Égalité ou today gagne (today posté en premier dans dateKeys).
  const todayMsgs = [
    { type: 'entry', author: 'ZZ', content: 'WOK 2.00-2.40', ts: '2026-05-14T13:08:00Z', ticker: 'WOK' },
  ];
  const yesterdayMsgs = [
    { type: 'entry', author: 'ZZ', content: 'WOK 1 to 3', ts: '2026-05-13T14:27:00Z', ticker: 'WOK' },
  ];
  const result = await buildAlertImagesBase64({
    trades: [{ ticker: '$WOK', entryPrice: 2.00, hodPrice: 2.40 }],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: (from) => from.startsWith('2026-05-14') ? todayMsgs : yesterdayMsgs,
      generateImage: (author, content) => Promise.resolve(Buffer.from(`PNG-${content}`)),
      dateKey: '2026-05-14',
    },
  });
  assert.strictEqual(result.length, 1);
  // Today gagne → on doit avoir le call du 14 (WOK 2.00-2.40), pas celui du 13
  assert.strictEqual(Buffer.from(result[0].base64, 'base64').toString(), 'PNG-WOK 2.00-2.40');
});

test('buildAlertImagesBase64 returns [] when neither day has any match', async () => {
  const result = await buildAlertImagesBase64({
    trades: [{ ticker: '$TDIC', entryPrice: 1.43, hodPrice: 3.71 }],
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => [], // aucune entry nulle part
      generateImage: () => Promise.resolve(Buffer.from('p')),
      dateKey: '2026-05-14',
    },
  });
  assert.deepStrictEqual(result, []);
});

test('buildAlertImagesBase64 honors maxAlerts cap', async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    type: 'entry', author: `A${i}`, content: `m${i}`, ts: '2026-05-13T13:00:00-04:00', ticker: 'X',
  }));
  const result = await buildAlertImagesBase64({
    maxAlerts: 4,
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: () => Promise.resolve(Buffer.from('p')),
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 4);
});

test('buildAlertImagesBase64 skips alerts whose render fails', async () => {
  const messages = [
    { type: 'entry', author: 'A', content: 'a', ts: 't', ticker: 'A' },
    { type: 'entry', author: 'B', content: 'b', ts: 't', ticker: 'B' },
    { type: 'entry', author: 'C', content: 'c', ts: 't', ticker: 'C' },
  ];
  let i = 0;
  const result = await buildAlertImagesBase64({
    deps: {
      mode: 'db-lookup',
      getMessagesByTsRange: () => messages,
      generateImage: () => {
        i++;
        if (i === 2) throw new Error('canvas oops');
        return Promise.resolve(Buffer.from('ok'));
      },
      dateKey: '2026-05-13',
    },
  });
  assert.strictEqual(result.length, 2);
  // Après filtre+reverse, les 3 entries originales deviennent [C, B, A].
  // L'item 2 (B) fail, donc on garde [C, A].
  assert.strictEqual(result[0].ticker, 'C');
  assert.strictEqual(result[1].ticker, 'A');
});

// ── buildAlertImagesBase64 — synthetic mode (default) ───────────────
test('buildAlertImagesBase64 (synthetic, default) generates 1 card per trade row', async () => {
  // Mode synthétique = default. Génère une carte par trade, contenu
  // "$TICKER ENTRY_PRICE🔥" rendu via le canvas habituel.
  const generated = [];
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$AEHL', entryPrice: 1.44, hodPrice: 6.27 },
      { ticker: '$QUCY', entryPrice: 0.44, hodPrice: 2.11 },
      { ticker: '$HAO', entryPrice: 0.046, hodPrice: 0.071 },
    ],
    deps: {
      mode: 'synthetic',
      getMessagesByTsRange: () => [], // évite la lookup DB en test
      generateImage: (author, content, ts) => {
        generated.push({ author, content, ts });
        return Promise.resolve(Buffer.from(`PNG-${content}`));
      },
      now: '2026-05-14T13:22:00Z',
    },
  });
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].ticker, 'AEHL');
  assert.strictEqual(result[1].ticker, 'QUCY');
  assert.strictEqual(result[2].ticker, 'HAO');
  // Author "ZZ" par défaut
  assert.strictEqual(generated[0].author, 'ZZ');
  // Content avec $ prefix, prix formaté
  assert.strictEqual(generated[0].content, '$AEHL 1.44🔥');
  assert.strictEqual(generated[1].content, '$QUCY 0.44🔥'); // 2 décimales sous 1
  assert.strictEqual(generated[2].content, '$HAO 0.046🔥'); // 3 décimales sous 0.01
});

test('buildAlertImagesBase64 (synthetic) staggers timestamps chronologically', async () => {
  const generated = [];
  await buildAlertImagesBase64({
    trades: [
      { ticker: '$A', entryPrice: 1, hodPrice: 2 },
      { ticker: '$B', entryPrice: 1, hodPrice: 2 },
      { ticker: '$C', entryPrice: 1, hodPrice: 2 },
    ],
    deps: {
      generateImage: (author, content, ts) => {
        generated.push(ts);
        return Promise.resolve(Buffer.from('p'));
      },
      now: '2026-05-14T13:22:00Z',
    },
  });
  // Premier (A) = now - 3min, dernier (C) = now - 1min, ordre chrono.
  assert.strictEqual(generated[0], '2026-05-14T13:19:00.000Z');
  assert.strictEqual(generated[1], '2026-05-14T13:20:00.000Z');
  assert.strictEqual(generated[2], '2026-05-14T13:21:00.000Z');
});

test('buildAlertImagesBase64 (synthetic) supports duplicate tickers (LNKS×2)', async () => {
  // Le récap a 2 lignes $LNKS avec prix différents → 2 cartes différentes.
  const generated = [];
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$LNKS', entryPrice: 1.39, hodPrice: 2.47 },
      { ticker: '$LNKS', entryPrice: 1.66, hodPrice: 2.47 },
    ],
    deps: {
      generateImage: (author, content) => {
        generated.push(content);
        return Promise.resolve(Buffer.from(`PNG-${content}`));
      },
      now: '2026-05-14T13:22:00Z',
    },
  });
  assert.strictEqual(result.length, 2);
  assert.strictEqual(generated[0], '$LNKS 1.39🔥');
  assert.strictEqual(generated[1], '$LNKS 1.66🔥');
});

test('buildAlertImagesBase64 (synthetic) returns [] with empty trades', async () => {
  const result = await buildAlertImagesBase64({
    trades: [],
    deps: { generateImage: () => Promise.resolve(Buffer.from('p')) },
  });
  assert.deepStrictEqual(result, []);
});

test('buildAlertImagesBase64 (synthetic) auto-scales beyond default max (16 trades)', async () => {
  const trades = Array.from({ length: 16 }, (_, i) => ({
    ticker: '$T' + i, entryPrice: 1, hodPrice: 2,
  }));
  const result = await buildAlertImagesBase64({
    trades,
    deps: { generateImage: () => Promise.resolve(Buffer.from('p')) },
  });
  assert.strictEqual(result.length, 16);
});

// ── buildAlertImagesBase64 — hybrid mode (default) ──────────────────
test('buildAlertImagesBase64 (hybrid, default) reuses real Discord messages when prices match', async () => {
  // Setup : 3 trades, 2 ont un vrai message en DB matchant le prix exact.
  // Le 3e n'a aucun match → fallback synthétique.
  const messages = [
    { id: 1, type: 'entry', author: 'ZZ', content: 'AEHL 1.44 entry 🔥', ts: '2026-05-13T17:30:00Z', ticker: 'AEHL' },
    { id: 2, type: 'entry', author: 'ZZ', content: 'QUCY 0.44 lotto', ts: '2026-05-13T16:00:00Z', ticker: 'QUCY' },
    // Pas de MOBX en DB → MOBX trade → synthétique
  ];
  const generated = [];
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$AEHL', entryPrice: 1.44, hodPrice: 6.27 },
      { ticker: '$QUCY', entryPrice: 0.44, hodPrice: 2.11 },
      { ticker: '$MOBX', entryPrice: 2.62, hodPrice: 3.08 },
    ],
    deps: {
      mode: 'hybrid',
      getMessagesByTsRange: () => messages,
      generateImage: (author, content, ts) => {
        generated.push({ author, content });
        return Promise.resolve(Buffer.from(`PNG-${content}`));
      },
      now: '2026-05-14T13:22:00Z',
      dateKey: '2026-05-14',
    },
  });
  assert.strictEqual(result.length, 3);
  // AEHL et QUCY = vrais messages (contenu authentique de ZZ)
  assert.strictEqual(generated[0].content, 'AEHL 1.44 entry 🔥');
  assert.strictEqual(generated[1].content, 'QUCY 0.44 lotto');
  // MOBX = synthétique (pas en DB) avec content $TICKER PRICE🔥
  assert.strictEqual(generated[2].content, '$MOBX 2.62🔥');
  assert.strictEqual(generated[2].author, 'ZZ');
});

test('buildAlertImagesBase64 (synthetic) skips trades whose render fails but continues', async () => {
  let i = 0;
  const result = await buildAlertImagesBase64({
    trades: [
      { ticker: '$A', entryPrice: 1, hodPrice: 2 },
      { ticker: '$B', entryPrice: 1, hodPrice: 2 },
      { ticker: '$C', entryPrice: 1, hodPrice: 2 },
    ],
    deps: {
      generateImage: () => {
        i++;
        if (i === 2) throw new Error('canvas oops');
        return Promise.resolve(Buffer.from('ok'));
      },
    },
  });
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].ticker, 'A');
  assert.strictEqual(result[1].ticker, 'C');
});

// ── handleRecapImageMessage ────────────────────────────────────────
test('handleRecapImageMessage skips when channel not configured', async () => {
  const r = await handleRecapImageMessage({
    message: { author: { bot: false }, channel: { id: 'foo' }, attachments: new Map() },
    channelId: null,
    deps: {},
  });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'channel_not_configured');
});

test('handleRecapImageMessage skips bot messages', async () => {
  const r = await handleRecapImageMessage({
    message: { author: { bot: true }, channel: { id: 'C1' }, attachments: new Map() },
    channelId: 'C1',
    deps: {},
  });
  assert.strictEqual(r.reason, 'author_is_bot');
});

test('handleRecapImageMessage skips wrong channel', async () => {
  const r = await handleRecapImageMessage({
    message: { author: { bot: false }, channel: { id: 'C2' }, attachments: new Map() },
    channelId: 'C1',
    deps: {},
  });
  assert.strictEqual(r.reason, 'wrong_channel');
});

test('handleRecapImageMessage skips messages with no image attachment', async () => {
  const att = { name: 'doc.pdf', contentType: 'application/pdf', url: 'http://x' };
  const r = await handleRecapImageMessage({
    message: {
      author: { bot: false, username: 'u' },
      channel: { id: 'C1' },
      attachments: new Map([['a', att]]),
      createdAt: new Date('2026-05-13T15:30:00-04:00'),
    },
    channelId: 'C1',
    deps: {},
  });
  assert.strictEqual(r.reason, 'no_image_attachment');
});

test('handleRecapImageMessage enqueues a render job with output channel set and forwards tradeTickers', async () => {
  let enqueuedPayload = null;
  let alertOpts = null;
  const att = { name: 'recap.png', contentType: 'image/png', url: 'http://discord/img.png' };

  const r = await handleRecapImageMessage({
    message: {
      author: { bot: false, username: 'tester' },
      channel: { id: 'C-RECAP' },
      attachments: new Map([['a', att]]),
      createdAt: new Date('2026-05-13T15:30:00-04:00'),
    },
    channelId: 'C-RECAP',
    deps: {
      downloadToTemp: async () => '/tmp/fake.png',
      parseRecapImage: async () => ({
        dateLabel: 'TODAY',
        trades: [
          { ticker: '$TSLA', entryPrice: 1, hodPrice: 2 },
          { ticker: '$TDIC', entryPrice: 1.43, hodPrice: 3.71 },
        ],
        longTermInvestments: [{ ticker: '$DXYZ', entryPrice: 30, currentPrice: 71 }],
      }),
      enqueueRenderJob: (payload) => {
        enqueuedPayload = payload;
        return 999;
      },
      buildAlertImagesBase64: async (opts) => {
        alertOpts = opts;
        return [{ base64: 'XX', ticker: '$TSLA' }];
      },
      unlink: () => {},
    },
  });

  assert.strictEqual(r.enqueued, true);
  assert.strictEqual(r.jobId, 999);
  assert.strictEqual(r.tradesCount, 2);
  assert.strictEqual(r.longTermCount, 1);
  assert.strictEqual(r.alertImagesCount, 1);

  assert.ok(enqueuedPayload);
  assert.strictEqual(enqueuedPayload.composition, 'TobTradeRecap');
  assert.strictEqual(enqueuedPayload.output_channel_id, 'C-RECAP');
  const data = JSON.parse(enqueuedPayload.recap_data);
  assert.strictEqual(data.trades.length, 2);
  assert.strictEqual(data.longTermInvestments[0].ticker, '$DXYZ');
  assert.strictEqual(data.alertImagesBase64[0].base64, 'XX');

  // Les trades du récap doivent être propagés à buildAlertImagesBase64
  // (pour le per-trade matching prix → alerte).
  assert.ok(alertOpts);
  assert.ok(Array.isArray(alertOpts.trades));
  assert.strictEqual(alertOpts.trades.length, 2);
  assert.strictEqual(alertOpts.trades[0].ticker, '$TSLA');
  assert.strictEqual(alertOpts.trades[1].ticker, '$TDIC');
});

test('handleRecapImageMessage skips when OCR returns no trades', async () => {
  const att = { name: 'recap.png', contentType: 'image/png', url: 'http://x' };
  const r = await handleRecapImageMessage({
    message: {
      author: { bot: false, username: 'tester' },
      channel: { id: 'C1' },
      attachments: new Map([['a', att]]),
      createdAt: new Date('2026-05-13T15:30:00-04:00'),
    },
    channelId: 'C1',
    deps: {
      downloadToTemp: async () => '/tmp/fake.png',
      parseRecapImage: async () => ({ dateLabel: 'TODAY', trades: [], longTermInvestments: [] }),
      enqueueRenderJob: () => { throw new Error('should not be called'); },
      buildAlertImagesBase64: async () => [],
      unlink: () => {},
    },
  });
  assert.strictEqual(r.reason, 'ocr_no_trades');
});

test('handleRecapImageMessage enqueues even if alert images fail (alertImagesCount=0)', async () => {
  let enqueuedPayload = null;
  const att = { name: 'recap.png', contentType: 'image/png', url: 'http://x' };
  const r = await handleRecapImageMessage({
    message: {
      author: { bot: false, username: 'tester' },
      channel: { id: 'C1' },
      attachments: new Map([['a', att]]),
      createdAt: new Date('2026-05-13T15:30:00-04:00'),
    },
    channelId: 'C1',
    deps: {
      downloadToTemp: async () => '/tmp/fake.png',
      parseRecapImage: async () => ({
        dateLabel: 'TODAY',
        trades: [{ ticker: '$T', entryPrice: 1, hodPrice: 2 }],
        longTermInvestments: [],
      }),
      enqueueRenderJob: (payload) => { enqueuedPayload = payload; return 1; },
      buildAlertImagesBase64: async () => { throw new Error('canvas crashed'); },
      unlink: () => {},
    },
  });
  assert.strictEqual(r.enqueued, true);
  assert.strictEqual(r.alertImagesCount, 0);
  const data = JSON.parse(enqueuedPayload.recap_data);
  assert.deepStrictEqual(data.alertImagesBase64, []);
});
