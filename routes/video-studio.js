// ─────────────────────────────────────────────────────────────────────
// routes/video-studio.js — API endpoints pour /video-studio
// ─────────────────────────────────────────────────────────────────────
//   GET  /api/video-studio/templates  — liste les templates Remotion
//   POST /api/video-studio/render     — enqueue un render_job depuis
//                                       une image gallery + template
//
// Le payload de render :
//   { galleryId, templateId, ctaUrl? }
//
// On lit l'image PNG depuis imageState.imageGallery, on encode en base64,
// on récupère le composition + props par défaut depuis le template JSON,
// et on insère un render_job avec ces infos. Le worker local pull et
// render normalement.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { enqueueRenderJob, getMessagesByTicker, getAllRenderJobs, getAbGroupedJobs } = require('../db/sqlite');
const crypto = require('crypto');
const { computePnlString, extractPrices } = require('../utils/prices');
const { pickTease, parsePnlNumeric } = require('../utils/pick-tease');
const { getDisplayName } = require('../utils/authors');

const TEMPLATES_DIR = path.join(__dirname, '..', 'video', 'templates');

// Floor en % en-dessous duquel on rejette les renders proof (manuels).
// Même valeur que le auto-render dans handler.js (PROOF_PCT_FLOOR env).
const PROOF_PCT_FLOOR = parseFloat(process.env.PROOF_PCT_FLOOR || '20');

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const id = f.replace(/\.json$/, '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
        return {
          id,
          name: data.name || id,
          composition: data.composition || 'ChartTemplate',
          description: data.description || '',
          props: data.props || {},
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

function registerVideoStudioRoutes(app, requireAuth, imageState) {
  // ── GET /api/video-studio/jobs ────────────────────────────────────
  // Liste des derniers render jobs (tous statuts) pour l'historique +
  // suivi live. Filtres optionnels : ?status=pending|done|failed, ?limit=N.
  app.get('/api/video-studio/jobs', requireAuth, (req, res) => {
    const status = req.query.status || null;
    const limit = req.query.limit || 50;
    try {
      const jobs = getAllRenderJobs(limit, status);
      // Shape minimaliste pour le front : pas besoin du content complet,
      // juste ce qui sert à afficher la ligne + status badge.
      res.json({
        jobs: jobs.map(j => ({
          id: j.id,
          ticker: j.ticker,
          composition: j.composition,
          templateName: j.template_name,
          status: j.status,
          pnl: j.pnl,
          entryAuthor: j.entry_author,
          exitAuthor: j.exit_author,
          createdAt: j.created_at,
          doneAt: j.done_at,
          error: j.error,
          discordMsgId: j.discord_msg_id,
          outputChannelId: j.output_channel_id,
          abGroup: j.ab_group || null,
          abVariant: j.ab_variant || null,
        })),
      });
    } catch (err) {
      console.error('[video-studio] GET /jobs failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/video-studio/templates ───────────────────────────────
  app.get('/api/video-studio/templates', requireAuth, (_req, res) => {
    const templates = loadTemplates();
    // Inclut props pour le swatch preview du modal et l'éditeur templates.
    res.json({
      templates: templates.map(t => ({
        id: t.id, name: t.name, composition: t.composition, description: t.description,
        props: t.props || {},
      })),
    });
  });

  // ── GET /api/video-studio/templates/:id ───────────────────────────
  // Renvoie le JSON complet d'un template pour l'éditeur (id + raw file).
  app.get('/api/video-studio/templates/:id', requireAuth, (req, res) => {
    const safeId = String(req.params.id || '').replace(/[^a-z0-9-]/gi, '');
    if (!safeId) return res.status(400).json({ error: 'Invalid template id' });
    const file = path.join(TEMPLATES_DIR, safeId + '.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Template not found' });
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      res.json({ id: safeId, ...parsed });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read template: ' + e.message });
    }
  });

  // ── PUT /api/video-studio/templates/:id ───────────────────────────
  // Sauvegarde un template existant. Body = JSON complet { composition,
  // name, description, props }. Validation : composition obligatoire,
  // props doit être objet. Pas de création new file ici (cf POST).
  app.put('/api/video-studio/templates/:id', requireAuth, (req, res) => {
    const safeId = String(req.params.id || '').replace(/[^a-z0-9-]/gi, '');
    if (!safeId) return res.status(400).json({ error: 'Invalid template id' });
    const body = req.body || {};
    if (!body.composition || typeof body.composition !== 'string') {
      return res.status(400).json({ error: 'composition is required' });
    }
    if (body.props && (typeof body.props !== 'object' || Array.isArray(body.props))) {
      return res.status(400).json({ error: 'props must be an object' });
    }
    const file = path.join(TEMPLATES_DIR, safeId + '.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Template not found' });
    const out = {
      composition: body.composition,
      name: body.name || safeId,
      description: body.description || '',
      props: body.props || {},
    };
    try {
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
      res.json({ saved: true, id: safeId });
    } catch (e) {
      res.status(500).json({ error: 'Failed to write template: ' + e.message });
    }
  });

  // ── POST /api/video-studio/render ─────────────────────────────────
  app.post('/api/video-studio/render', requireAuth, (req, res) => {
    const { galleryId, templateId, ctaUrl, tickerOverride, accentColor, enableNarration, aspectRatio } = req.body || {};
    if (!galleryId) return res.status(400).json({ error: 'Missing galleryId' });
    if (!templateId) return res.status(400).json({ error: 'Missing templateId' });

    // Trouve l'image dans la gallery
    const item = imageState.imageGallery.find(e => e.id === galleryId);
    if (!item) return res.status(404).json({ error: 'Gallery item not found' });

    // Trouve le template
    const templates = loadTemplates();
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    // Détecte la composition à utiliser
    // - 'proof' image → ChartTemplate (a entry+exit)
    // - 'signal' image → BoomEntry (single message)
    // Mais si le template force une composition spécifique, on la respecte.
    const composition = tpl.composition || (item.type === 'proof' ? 'ChartTemplate' : 'BoomEntry');

    // Construit les props du job. Pour BoomEntry on n'utilise que author/message/timestamp,
    // mais render_jobs schema exige tous les champs entry_/exit_ — on duplique.
    const author = item.author || 'Z';
    const ts = item.ts || new Date().toISOString();
    const ticker = (item.ticker || 'BOOM').toUpperCase();

    // Lookup du message original (= celui qui a généré le gallery item)
    // pour extraire le contenu, le PnL, et — pour les proof — l'entry
    // d'origine afin de passer entry_price + entry_ts + exit_price au
    // worker. Sans ces fields, fetchChartForJob ne place aucune flèche
    // sur le chart TradingView et la vidéo perd son point de pédagogie
    // visuel ("voici où on est entré / où on est sorti").
    let messageStr = `$${ticker} signal`;
    let computedPnl = '+0%';
    let entryTsIso = ts;
    let entryAuthor = author;
    let entryMessageStr = messageStr;
    let exitTsIso = ts;
    let entryPriceNum = null;
    let exitPriceNum = null;
    try {
      const galleryTime = new Date(ts).getTime();

      // ① Match le message qui a généré le gallery item.
      //    Pour 'proof' c'est le message d'exit ; pour 'signal' c'est l'entry.
      const sinceForCurrent = new Date(galleryTime - 60_000).toISOString();
      const currentRows = getMessagesByTicker(ticker, sinceForCurrent);
      const currentMatch = currentRows.find(r => {
        const t = new Date(r.ts).getTime();
        return Math.abs(t - galleryTime) < 60_000
          && (r.author || '').toLowerCase() === author.toLowerCase();
      });

      if (currentMatch && currentMatch.content) {
        messageStr = currentMatch.content;
        const pnl = computePnlString(currentMatch.content);
        if (pnl) computedPnl = pnl;
      }

      // ② Selon le type, extraire entry/exit prices + timestamps.
      if (item.type === 'proof' && currentMatch) {
        // Le currentMatch = exit. Parse exit_price depuis son content.
        exitTsIso = currentMatch.ts;
        try {
          const exitPrices = extractPrices(currentMatch.content);
          if (exitPrices && Number.isFinite(exitPrices.entry_price)) {
            exitPriceNum = exitPrices.entry_price;
          }
        } catch { /* skip — non bloquant */ }

        // Cherche l'entry d'origine en DB : 30 jours en arrière, type=entry,
        // entry_price présent, ts < ts de l'exit. Mêmes critères que
        // findOriginalAlert dans discord/handler.js (cohérence des 2 flows).
        const sinceForEntry = new Date(galleryTime - 30 * 86400000).toISOString();
        const entryRows = getMessagesByTicker(ticker, sinceForEntry);
        const entryMatch = entryRows.find(m =>
          m.passed && m.id !== undefined &&
          m.type === 'entry' &&
          m.entry_price != null && Number.isFinite(m.entry_price) &&
          new Date(m.ts) < new Date(currentMatch.ts)
        );
        if (entryMatch) {
          entryTsIso = entryMatch.ts;
          entryAuthor = entryMatch.author || author;
          entryMessageStr = entryMatch.content || messageStr;
          entryPriceNum = entryMatch.entry_price;
        }
      } else if (item.type === 'signal' && currentMatch) {
        // Pour 'signal' (BoomEntry), pas de proof video chart-img — mais on
        // remplit quand même entry_price pour les compositions futures.
        entryTsIso = currentMatch.ts;
        if (currentMatch.entry_price != null && Number.isFinite(currentMatch.entry_price)) {
          entryPriceNum = currentMatch.entry_price;
        }
      }
    } catch (err) {
      console.warn('[video-studio] DB lookup failed, using defaults:', err.message);
    }

    // Floor PnL pour proof renders : on rejette les vidéos < PROOF_PCT_FLOOR%
    // pour préserver l'impact (mêmes raisons business que côté auto-render).
    // Signal renders (entry) ne sont pas filtrés car n'ont pas de PnL pertinent.
    if (item.type === 'proof') {
      const pnlNum = parsePnlNumeric(computedPnl);
      if (pnlNum !== null && pnlNum < PROOF_PCT_FLOOR) {
        return res.status(400).json({
          error: `PnL trop faible (${computedPnl} < ${PROOF_PCT_FLOOR}%). Vidéo non générée.`,
        });
      }
    }

    // Picker contextuel pour le tease text. Pool dans video/messages/contexts.json.
    // Seedé sur galleryId pour que re-render du même item produise la même
    // phrase (cohérence visuelle, évite la roulette aléatoire).
    const tease = pickTease({
      type: item.type,        // 'proof' → exit-win-*, 'signal' → entry
      pnl: computedPnl,
      seed: galleryId,
    });

    // Construit props_override : merge des champs surchargeables depuis
    // le body. Le worker mergera ce JSON sur les template props.
    const propsOverride = {};
    if (typeof ctaUrl === 'string' && ctaUrl.trim()) {
      propsOverride.ctaUrl = ctaUrl.trim();
    }
    if (typeof accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(accentColor)) {
      propsOverride.accentColor = accentColor;
    }
    // Toggle TTS narration per-job (le worker check ce field dans
    // props_override.enableNarration avant d'appeler generateTTS).
    if (enableNarration === true || enableNarration === 'true') {
      propsOverride.enableNarration = true;
    }
    // Aspect ratio variant : '9x16' (default, TikTok/Reels) | '1x1' (IG feed)
    // | '16x9' (YouTube/Twitter). Le worker suffix l'id de composition.
    if (aspectRatio === '1x1' || aspectRatio === '16x9' || aspectRatio === '9x16') {
      propsOverride.aspectRatio = aspectRatio;
    }
    const propsOverrideJson = Object.keys(propsOverride).length > 0
      ? JSON.stringify(propsOverride)
      : null;

    // Ticker override : remplace le ticker stocké (utilisé partout dans
    // le pipeline). Si non fourni, on garde celui dérivé de l'image.
    const finalTicker = (typeof tickerOverride === 'string' && tickerOverride.trim())
      ? tickerOverride.trim().toUpperCase().replace(/^\$+/, '')
      : ticker;

    try {
      const jobId = enqueueRenderJob({
        ticker: finalTicker,
        // Display names (ex: 'traderzz1m' → 'ZZ') pour cohérence avec
        // le flow auto-render (maybeEnqueueProofRender).
        entry_author: getDisplayName(entryAuthor),
        entry_message: entryMessageStr,
        entry_ts: entryTsIso,
        exit_author: getDisplayName(author),
        exit_message: messageStr,
        exit_ts: exitTsIso,
        pnl: computedPnl,
        proof_image_base64: item.buffer.toString('base64'),
        template_name: templateId,
        composition,
        tease_action: tease ? tease.teaseAction : null,
        tease_subtext: tease ? tease.teaseSubtext : null,
        // Sans ces 2 fields, fetchChartForJob skip les flèches sur le chart.
        // Avec : entry arrow ↑ "When alerted" + exit arrow ↓ "$prix".
        entry_price: entryPriceNum,
        exit_price: exitPriceNum,
        // Props override (accentColor, ctaUrl, etc.) — surchargent les
        // template props côté worker via jobPropsToRemotion.
        props_override: propsOverrideJson,
      });
      console.log(`[video-studio] enqueue render_job #${jobId} from gallery ${galleryId} (${item.type}) → composition ${composition}, template ${templateId}, pnl ${computedPnl}, entry=${entryPriceNum ?? 'n/a'}, exit=${exitPriceNum ?? 'n/a'}, tease ctx '${tease ? tease.context : 'none'}'`);
      res.json({
        jobId, composition, templateId, pnl: computedPnl,
        teaseContext: tease ? tease.context : null,
        entryPrice: entryPriceNum, exitPrice: exitPriceNum,
      });
    } catch (err) {
      console.error('[video-studio] enqueue failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/video-studio/manual-recap ───────────────────────────
  // Enqueue un TobTradeRecap depuis un payload manuel (trades + long-term
  // saisis dans le formulaire UI). Pas d'OCR, pas d'image — l'utilisateur
  // fournit le tableau directement. Re-utilise le même render_jobs flow
  // que l'auto-trigger sur image dans discord/recap-image-handler.js.
  //
  // Body : {
  //   dateLabel: string,
  //   trades: [{ ticker, entryPrice, hodPrice }, ...],
  //   longTermInvestments: [{ ticker, entryPrice, currentPrice }, ...] (optionnel),
  //   outputChannelId: string (optionnel — défaut env),
  // }
  app.post('/api/video-studio/manual-recap', requireAuth, async (req, res) => {
    const body = req.body || {};
    const trades = Array.isArray(body.trades) ? body.trades : [];
    if (trades.length === 0) {
      return res.status(400).json({ error: 'trades is required and must be non-empty' });
    }
    // Validation minimale par trade.
    for (const t of trades) {
      if (!t || typeof t.ticker !== 'string' || !t.ticker.trim()) {
        return res.status(400).json({ error: 'Each trade needs a ticker' });
      }
      if (!Number.isFinite(Number(t.entryPrice)) || !Number.isFinite(Number(t.hodPrice))) {
        return res.status(400).json({ error: `${t.ticker}: entryPrice and hodPrice must be numbers` });
      }
    }
    const lts = Array.isArray(body.longTermInvestments) ? body.longTermInvestments : [];
    for (const lt of lts) {
      if (!lt || typeof lt.ticker !== 'string' || !lt.ticker.trim()) {
        return res.status(400).json({ error: 'Each long-term entry needs a ticker' });
      }
      if (!Number.isFinite(Number(lt.entryPrice)) || !Number.isFinite(Number(lt.currentPrice))) {
        return res.status(400).json({ error: `${lt.ticker}: entryPrice and currentPrice must be numbers` });
      }
    }

    // Normalise les prix en Number (le front les envoie souvent en string).
    const normalizedTrades = trades.map(t => ({
      ticker: String(t.ticker).trim().toUpperCase().replace(/^\$+/, ''),
      entryPrice: Number(t.entryPrice),
      hodPrice: Number(t.hodPrice),
    }));
    const normalizedLts = lts.map(lt => ({
      ticker: String(lt.ticker).trim().toUpperCase().replace(/^\$+/, ''),
      entryPrice: Number(lt.entryPrice),
      currentPrice: Number(lt.currentPrice),
    }));

    // Pour les alert images de la parade, on essaie de générer comme le
    // flow image — mais best-effort (DB peut être vide pour ces tickers).
    // Lazy require pour éviter circular deps.
    const { buildAlertImagesBase64 } = require('../discord/recap-image-handler');
    let alertImagesBase64 = [];
    try {
      alertImagesBase64 = await buildAlertImagesBase64({ trades: normalizedTrades });
    } catch (err) {
      console.warn('[video-studio/manual-recap] alert images failed:', err.message);
    }

    const dateLabel = (typeof body.dateLabel === 'string' && body.dateLabel.trim()) ? body.dateLabel.trim() : 'TODAY';
    const tsIso = new Date().toISOString();
    const outputChannelId = (typeof body.outputChannelId === 'string' && body.outputChannelId.trim()) ? body.outputChannelId.trim() : null;

    const recapData = {
      dateLabel,
      trades: normalizedTrades,
      longTermInvestments: normalizedLts,
      alertImagesBase64,
    };

    const enableNarrationManual = body.enableNarration === true || body.enableNarration === 'true';
    const aspectRatioManual = (body.aspectRatio === '1x1' || body.aspectRatio === '16x9' || body.aspectRatio === '9x16')
      ? body.aspectRatio : null;
    const overrideObj = {};
    if (enableNarrationManual) overrideObj.enableNarration = true;
    if (aspectRatioManual && aspectRatioManual !== '9x16') overrideObj.aspectRatio = aspectRatioManual;
    const propsOverrideManual = Object.keys(overrideObj).length > 0
      ? JSON.stringify(overrideObj)
      : null;

    try {
      const jobId = enqueueRenderJob({
        ticker: 'TOB-RECAP',
        entry_author: 'manual',
        entry_message: `Manual recap (${normalizedTrades.length} trades, ${dateLabel})`,
        entry_ts: tsIso,
        exit_author: 'manual',
        exit_message: 'Manual recap from video studio',
        exit_ts: tsIso,
        pnl: dateLabel,
        composition: 'TobTradeRecap',
        template_name: 'trade-recap-default',
        recap_data: JSON.stringify(recapData),
        output_channel_id: outputChannelId,
        props_override: propsOverrideManual,
      });
      console.log(`[video-studio/manual-recap] enqueue render_job #${jobId} (${normalizedTrades.length} trades + ${normalizedLts.length} long-term, ${alertImagesBase64.length} alerts)`);
      res.json({
        jobId,
        tradesCount: normalizedTrades.length,
        longTermCount: normalizedLts.length,
        alertImagesCount: alertImagesBase64.length,
      });
    } catch (err) {
      console.error('[video-studio/manual-recap] enqueue failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/video-studio/ab-render ──────────────────────────────
  // Enqueue 2 render jobs depuis la même image avec 2 templates
  // différents (variants A + B). Les jobs partagent le même ab_group
  // (UUID). Après render, les MP4 sont postés dans Discord avec un
  // libellé A/B et l'audience vote avec les reactions — l'engagement
  // est analysable via getAbGroupedJobs() côté analytics.
  app.post('/api/video-studio/ab-render', requireAuth, (req, res) => {
    const { galleryId, templateIdA, templateIdB } = req.body || {};
    if (!galleryId) return res.status(400).json({ error: 'Missing galleryId' });
    if (!templateIdA || !templateIdB) return res.status(400).json({ error: 'Both templateIdA and templateIdB required' });
    if (templateIdA === templateIdB) return res.status(400).json({ error: 'A and B templates must differ' });

    const item = imageState.imageGallery.find(e => e.id === galleryId);
    if (!item) return res.status(404).json({ error: 'Gallery item not found' });

    const templates = loadTemplates();
    const tplA = templates.find(t => t.id === templateIdA);
    const tplB = templates.find(t => t.id === templateIdB);
    if (!tplA) return res.status(404).json({ error: `Template A not found: ${templateIdA}` });
    if (!tplB) return res.status(404).json({ error: `Template B not found: ${templateIdB}` });

    // Génère un ab_group ID unique (uuid v4).
    const abGroup = crypto.randomUUID();

    // Helper pour enqueuer une variante (réplique la logique de /render).
    const author = item.author || 'Z';
    const ts = item.ts || new Date().toISOString();
    const ticker = (item.ticker || 'BOOM').toUpperCase();

    let messageStr = `$${ticker} signal`;
    let computedPnl = '+0%';
    let entryTsIso = ts;
    let entryAuthor = author;
    let entryMessageStr = messageStr;
    let exitTsIso = ts;
    let entryPriceNum = null;
    let exitPriceNum = null;
    try {
      const galleryTime = new Date(ts).getTime();
      const sinceForCurrent = new Date(galleryTime - 60_000).toISOString();
      const currentRows = getMessagesByTicker(ticker, sinceForCurrent);
      const currentMatch = currentRows.find(r => {
        const t = new Date(r.ts).getTime();
        return Math.abs(t - galleryTime) < 60_000
          && (r.author || '').toLowerCase() === author.toLowerCase();
      });
      if (currentMatch && currentMatch.content) {
        messageStr = currentMatch.content;
        const pnl = computePnlString(currentMatch.content);
        if (pnl) computedPnl = pnl;
        exitTsIso = currentMatch.ts;
        try {
          const exitPrices = extractPrices(currentMatch.content);
          if (exitPrices && Number.isFinite(exitPrices.entry_price)) exitPriceNum = exitPrices.entry_price;
        } catch { /* skip */ }
        if (item.type === 'proof') {
          const sinceForEntry = new Date(galleryTime - 30 * 86400000).toISOString();
          const entryRows = getMessagesByTicker(ticker, sinceForEntry);
          const entryMatch = entryRows.find(m =>
            m.passed && m.type === 'entry' && m.entry_price != null &&
            Number.isFinite(m.entry_price) && new Date(m.ts) < new Date(currentMatch.ts)
          );
          if (entryMatch) {
            entryTsIso = entryMatch.ts;
            entryAuthor = entryMatch.author || author;
            entryMessageStr = entryMatch.content || messageStr;
            entryPriceNum = entryMatch.entry_price;
          }
        }
      }
    } catch { /* swallow, defaults will apply */ }

    function enqueueVariant(tpl, variant) {
      const composition = tpl.composition || (item.type === 'proof' ? 'ChartTemplate' : 'BoomEntry');
      const tease = pickTease({ type: item.type, pnl: computedPnl, seed: `${galleryId}-${variant}` });
      return enqueueRenderJob({
        ticker,
        entry_author: getDisplayName(entryAuthor),
        entry_message: entryMessageStr,
        entry_ts: entryTsIso,
        exit_author: getDisplayName(author),
        exit_message: messageStr,
        exit_ts: exitTsIso,
        pnl: computedPnl,
        proof_image_base64: item.buffer.toString('base64'),
        template_name: tpl.id,
        composition,
        tease_action: tease ? tease.teaseAction : null,
        tease_subtext: tease ? tease.teaseSubtext : null,
        entry_price: entryPriceNum,
        exit_price: exitPriceNum,
        ab_group: abGroup,
        ab_variant: variant,
      });
    }

    try {
      const jobIdA = enqueueVariant(tplA, 'A');
      const jobIdB = enqueueVariant(tplB, 'B');
      console.log(`[video-studio] A/B group ${abGroup}: A=#${jobIdA} (${templateIdA}) + B=#${jobIdB} (${templateIdB})`);
      res.json({ abGroup, jobIdA, jobIdB, templateIdA, templateIdB });
    } catch (err) {
      console.error('[video-studio/ab-render] enqueue failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/video-studio/ab-groups ──────────────────────────────
  // Liste les paires A/B groupées avec leur statut courant pour le
  // dashboard A/B.
  app.get('/api/video-studio/ab-groups', requireAuth, (_req, res) => {
    try {
      const groups = getAbGroupedJobs(100);
      res.json({ groups });
    } catch (err) {
      console.error('[video-studio] GET /ab-groups failed:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerVideoStudioRoutes };
