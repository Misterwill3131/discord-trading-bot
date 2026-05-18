// ─────────────────────────────────────────────────────────────────────
// social/habs/index.js — Habs entry point
// ─────────────────────────────────────────────────────────────────────
// Module public. Deux APIs :
//   start(client)           — boot prod : wire db sqlite + adapter zapier,
//                             démarre le worker tick.
//   enqueueRecap(opts)      — appelé par discord/recap-image-handler.js
//                             après OCR success.
//
// Plus une factory `createForTest({db, webhookUrls, fetchImpl, ...})`
// utilisée par les tests d'intégration pour injecter des fakes.
//
// Cf docs/superpowers/specs/2026-05-18-habs-design.md.
// ─────────────────────────────────────────────────────────────────────

const { enqueueRecap } = require('./queue');
const { tickOnce, createWorker } = require('./worker');
const zapierAdapter = require('./platforms/zapier-webhook');
const { notifyAdmin: realNotifyAdmin } = require('./discord-notify');
const { generateCaption } = require('../../utils/caption-llm');

let _workerHandle = null;

function buildAdapters(fetchImpl) {
  return {
    stocktwits: ({ webhookUrl, payload }) =>
      zapierAdapter.publish({ webhookUrl, payload, fetchImpl }),
  };
}

// LLM-backed caption function bound to generateCaption with platform=stocktwits.
function llmCaptionFn(ocrResult) {
  return generateCaption('TobTradeRecap', ocrResult, 'stocktwits');
}

// Production boot. Wires real DB + real Zapier adapter + real Discord notify.
async function start(client) {
  if (_workerHandle) {
    console.warn('[habs] start() called but worker already running — ignoring');
    return;
  }
  const db = require('../../db/sqlite');
  const webhookUrls = {
    stocktwits: process.env.HABS_ZAPIER_STOCKTWITS_WEBHOOK_URL || null,
  };
  const intervalMs = parseInt(process.env.HABS_WORKER_INTERVAL_MS || '5000', 10);
  const adminChannelId = process.env.HABS_ADMIN_CHANNEL_ID || null;

  const adapters = buildAdapters(null);
  const notifyAdmin = (msg) => realNotifyAdmin(client, adminChannelId, msg);

  _workerHandle = createWorker({ db, adapters, webhookUrls, notifyAdmin, intervalMs });
  _workerHandle.start();
  console.log('[habs] started');
}

function stop() {
  if (_workerHandle) _workerHandle.stop();
  _workerHandle = null;
}

// Public enqueue. Imported by discord/recap-image-handler.js.
async function enqueue({ ocrResult, messageId }) {
  const db = require('../../db/sqlite');
  return enqueueRecap({
    db,
    ocrResult,
    messageId,
    llmFn: llmCaptionFn,
  });
}

// Test-only factory. Injects fake db, fake fetch, fake notifyAdmin.
function createForTest({ db, webhookUrls, fetchImpl, notifyAdmin, captionFn }) {
  const adapters = buildAdapters(fetchImpl);
  return {
    enqueue: ({ ocrResult, messageId }) =>
      enqueueRecap({ db, ocrResult, messageId, captionFn }),
    tick: () => tickOnce({ db, adapters, webhookUrls, notifyAdmin }),
  };
}

module.exports = { start, stop, enqueue, createForTest };
