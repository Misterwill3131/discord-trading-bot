const { test } = require('node:test');
const assert = require('node:assert');

const {
  handleRecapImageMessage,
  pickImageAttachment,
  buildRecapJobPayload,
  buildAlertImagesBase64,
  nyDateKeyToUtcRange,
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

// ── buildAlertImagesBase64 ─────────────────────────────────────────
test('buildAlertImagesBase64 returns [] when DB query throws', async () => {
  const result = await buildAlertImagesBase64({
    deps: {
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

test('buildAlertImagesBase64 honors maxAlerts cap', async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    type: 'entry', author: `A${i}`, content: `m${i}`, ts: '2026-05-13T13:00:00-04:00', ticker: 'X',
  }));
  const result = await buildAlertImagesBase64({
    maxAlerts: 4,
    deps: {
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

test('handleRecapImageMessage enqueues a render job with output channel set', async () => {
  let enqueuedPayload = null;
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
        trades: [{ ticker: '$TSLA', entryPrice: 1, hodPrice: 2 }],
        longTermInvestments: [{ ticker: '$DXYZ', entryPrice: 30, currentPrice: 71 }],
      }),
      enqueueRenderJob: (payload) => {
        enqueuedPayload = payload;
        return 999;
      },
      buildAlertImagesBase64: async () => [{ base64: 'XX', ticker: '$TSLA' }],
      unlink: () => {},
    },
  });

  assert.strictEqual(r.enqueued, true);
  assert.strictEqual(r.jobId, 999);
  assert.strictEqual(r.tradesCount, 1);
  assert.strictEqual(r.longTermCount, 1);
  assert.strictEqual(r.alertImagesCount, 1);

  assert.ok(enqueuedPayload);
  assert.strictEqual(enqueuedPayload.composition, 'TobTradeRecap');
  assert.strictEqual(enqueuedPayload.output_channel_id, 'C-RECAP');
  const data = JSON.parse(enqueuedPayload.recap_data);
  assert.strictEqual(data.trades.length, 1);
  assert.strictEqual(data.longTermInvestments[0].ticker, '$DXYZ');
  assert.strictEqual(data.alertImagesBase64[0].base64, 'XX');
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
