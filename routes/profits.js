// ─────────────────────────────────────────────────────────────────────
// routes/profits.js — Endpoints HTTP pour le compteur de profits
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/profits-history     — série 7/30/90 jours pour le bar chart
//   POST /api/add-profit          — +N profits (appelé par Make.com / webhook)
//   POST /api/set-profit-count    — override manuel du count du jour
//   GET  /api/profits-bot-silent  — lit le flag "bot silencieux"
//   POST /api/profits-bot-silent  — écrit le flag (toggle daily summary)
//   GET  /api/profit-messages     — messages review (paginé + filtrable)
//   POST /api/profit-feedback     — action sur un message (block/allow/unblock)
//   GET  /api/profit-filters      — snapshot des learned filters
//   POST /api/webhook/profits     — webhook Discord → addProfitMessage
//                                   (pas d'auth : c'est un webhook externe)
//
// Toute la logique métier vit dans profit/counter.js. Ce module fait
// uniquement le mapping HTTP ↔ counter.
// ─────────────────────────────────────────────────────────────────────

const {
  todayKey,
} = require('../utils/persistence');
const {
  loadProfitData,
  saveProfitData,
  loadProfitMessages,
  saveProfitMessages,
  saveProfitFilters,
  profitFilters,
  addProfitMessage,
  truncatePhrase,
  getBotSilent,
  setBotSilent,
} = require('../profit/counter');

const FEEDBACK_ACTIONS = ['block', 'allow', 'unblock-blocked', 'unblock-allowed'];
const PROFIT_MESSAGES_PAGE_SIZE = 50;

function registerProfitRoutes(app, requireAuth) {
  // ── /api/profits-history ─────────────────────────────────────────
  // Série daily counts, utilisée par le bar chart de la page /profits.
  // Fuseau NY car les journées trading sont calées sur l'ouverture US.
  app.get('/api/profits-history', requireAuth, (req, res) => {
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const data = loadProfitData(dateKey);
      result.push({ date: dateKey, count: data.count || 0 });
    }
    res.json(result);
  });

  // ── /api/add-profit ──────────────────────────────────────────────
  // Appelé par Make.com ou tout orchestrateur externe pour incrémenter
  // le compteur en parsant du texte (ex. "TSLA 150-155").
  app.post('/api/add-profit', requireAuth, async (req, res) => {
    try {
      const count = await addProfitMessage(req.body?.content || '');
      res.json({ ok: true, count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── /api/set-profit-count ────────────────────────────────────────
  // Override manuel : permet de corriger depuis le dashboard si le
  // parser a sur/sous-compté. On écrit juste data.count sans toucher
  // aux milestones (qui sont historiques).
  app.post('/api/set-profit-count', requireAuth, (req, res) => {
    try {
      const newCount = parseInt(req.body?.count, 10);
      if (isNaN(newCount) || newCount < 0) {
        return res.status(400).json({ error: 'Valeur invalide' });
      }
      const dateKey = todayKey();
      const data = loadProfitData(dateKey);
      data.count = newCount;
      saveProfitData(dateKey, data);
      console.log('[profits] Count manually set to ' + newCount);
      res.json({ ok: true, count: newCount });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── /api/profits-bot-silent ─────────────────────────────────────
  // Toggle pour désactiver l'envoi automatique du daily summary à 20:00 EDT.
  app.get('/api/profits-bot-silent', requireAuth, (req, res) => {
    res.json({ silent: getBotSilent() });
  });

  app.post('/api/profits-bot-silent', requireAuth, (req, res) => {
    setBotSilent(req.body?.silent);
    console.log('[profits] Bot messages in #profits: ' + (getBotSilent() ? 'DISABLED' : 'ENABLED'));
    res.json({ ok: true, silent: getBotSilent() });
  });

  // ── /api/profit-messages ─────────────────────────────────────────
  // Page /profits affiche une review paginée des messages du canal #profits.
  // Filtres : all / counted / ignored / flagged (= ceux ayant du feedback).
  app.get('/api/profit-messages', requireAuth, (req, res) => {
    const date = String(req.query.date || todayKey());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'invalid date' });
    }
    const filter = String(req.query.filter || 'all');
    const rawPage = parseInt(req.query.page || '1', 10);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

    let msgs = loadProfitMessages(date);
    if (filter === 'counted')       msgs = msgs.filter(m => m.counted === true);
    else if (filter === 'ignored')  msgs = msgs.filter(m => m.counted === false);
    else if (filter === 'flagged')  msgs = msgs.filter(m => m.feedback != null);

    // Plus récent d'abord (sort DESC sur ts ISO).
    msgs.sort((a, b) => (a.ts || '') < (b.ts || '') ? 1 : -1);

    const total = msgs.length;
    const start = (page - 1) * PROFIT_MESSAGES_PAGE_SIZE;
    const pageMsgs = msgs.slice(start, start + PROFIT_MESSAGES_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PROFIT_MESSAGES_PAGE_SIZE));

    res.json({ date, total, page, pageSize: PROFIT_MESSAGES_PAGE_SIZE, totalPages, messages: pageMsgs });
  });

  // ── /api/profit-feedback ─────────────────────────────────────────
  // 4 actions sur une phrase :
  //   block   → ajout à profitFilters.blocked (retire d'allowed)
  //   allow   → inverse
  //   unblock-blocked / unblock-allowed → retrait direct
  //
  // Si un `id` est fourni, on met aussi à jour le champ `feedback` sur
  // le message stocké (utilisé par la UI pour l'affichage coloré).
  app.post('/api/profit-feedback', requireAuth, (req, res) => {
    const id = String(req.body?.id || '');
    const content = String(req.body?.content || '');
    const action = String(req.body?.action || '');

    if (!FEEDBACK_ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'invalid action' });
    }

    // Les actions "unblock-*" n'exigent pas de content non-vide : elles
    // ne font que retirer de la liste.
    if (action === 'unblock-blocked') {
      const phrase = truncatePhrase(content);
      profitFilters.blocked = (profitFilters.blocked || []).filter(p => p !== phrase);
      saveProfitFilters();
      return res.json({ ok: true, profitFilters });
    }
    if (action === 'unblock-allowed') {
      const phrase = truncatePhrase(content);
      profitFilters.allowed = (profitFilters.allowed || []).filter(p => p !== phrase);
      saveProfitFilters();
      return res.json({ ok: true, profitFilters });
    }

    // block/allow : content est requis.
    const phrase = truncatePhrase(content);
    if (!phrase) return res.status(400).json({ error: 'empty content' });

    if (action === 'block') {
      profitFilters.allowed = profitFilters.allowed.filter(p => p !== phrase);
      if (!profitFilters.blocked.includes(phrase)) profitFilters.blocked.push(phrase);
    } else if (action === 'allow') {
      profitFilters.blocked = profitFilters.blocked.filter(p => p !== phrase);
      if (!profitFilters.allowed.includes(phrase)) profitFilters.allowed.push(phrase);
    }
    saveProfitFilters();
    console.log('[profit-feedback] action=' + action + ' phrase=' + phrase.substring(0, 60) + (id ? ' id=' + id : ''));

    // Met à jour le champ feedback sur le message stocké (si id fourni).
    // On parcourt les 30 derniers jours — utile si l'UI affiche un
    // historique au-delà du jour courant.
    if (id) {
      const targetFeedback = action === 'block' ? 'bad' : 'good';
      for (let i = 0; i < 30; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dk = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const msgs = loadProfitMessages(dk);
        let changed = false;
        for (const m of msgs) {
          if (m.id === id) { m.feedback = targetFeedback; changed = true; break; }
        }
        if (changed) { saveProfitMessages(dk, msgs); break; }
      }
    }

    res.json({ ok: true, profitFilters });
  });

  // ── /api/profit-filters ──────────────────────────────────────────
  app.get('/api/profit-filters', requireAuth, (req, res) => {
    res.json(profitFilters);
  });

  // ── /api/webhook/profits ─────────────────────────────────────────
  // Webhook appelé par Discord (via integration app.make.com) quand un
  // message arrive dans #profits. Pas d'auth car Discord ne peut pas
  // envoyer de cookies — c'est la config côté Make qui sert de filtre.
  //
  // Ignoré si pas d'image (évite de compter les messages texte pur).
  app.post('/api/webhook/profits', async (req, res) => {
    try {
      const body = req.body || {};
      const content = body.content || '';
      const attachments = body.attachments || body.embeds || [];
      const hasImage = Array.isArray(attachments) && attachments.some(a =>
        (a.content_type && a.content_type.startsWith('image/')) ||
        (a.url && /\.(png|jpg|jpeg|gif|webp)/i.test(a.url)) ||
        a.image
      );
      const embeds = body.embeds || [];
      const hasEmbedImage = Array.isArray(embeds) && embeds.some(e => e.image || e.thumbnail);

      if (!hasImage && !hasEmbedImage && attachments.length === 0) {
        console.log('[webhook/profits] Message sans image — ignoré');
        return res.json({ ok: true, skipped: true, reason: 'no image' });
      }

      const count = await addProfitMessage(content);
      console.log('[webhook/profits] Profit enregistré — total: ' + count);
      res.json({ ok: true, count });
    } catch (e) {
      console.error('[webhook/profits] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerProfitRoutes };
