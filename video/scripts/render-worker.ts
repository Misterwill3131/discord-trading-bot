// ─────────────────────────────────────────────────────────────────────
// video/scripts/render-worker.ts — Long-running worker pour Phase 3
// ─────────────────────────────────────────────────────────────────────
// Poll le bot (GET /api/render-queue), render chaque job via Remotion
// (renderMedia programmatique), POST le MP4 multipart au bot pour
// upload Discord (POST /api/render-queue/:id/done).
//
// Lance avec : cd video && npm run worker
// Env vars requises : BOT_URL, RENDER_WORKER_TOKEN
// ─────────────────────────────────────────────────────────────────────

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Job tel que renvoyé par le bot (camelCase déjà fait par jobToApiShape).
export type RenderJob = {
  id: number;
  ticker: string;
  entryAuthor: string;
  entryMessage: string;
  entryTimestamp: string;
  exitAuthor: string;
  exitMessage: string;
  exitTimestamp: string;
  pnl: string;
  // Optionnel : base64 PNG de l'image canvas-rendered (entry+exit
  // Discord conversation). Si null, la composition fallback sur les
  // Discord cards Remotion natives.
  proofImageBase64?: string | null;
  // Optionnel : base64 PNG du chart TradingView intraday du jour du trade,
  // avec callouts (flèches + labels) sur entry/exit. Fetché par le worker
  // via chart-img.com avant le render. Si null (API down ou pas de clé),
  // la composition skip la phase chart.
  chartImageBase64?: string | null;
  // Prix entry/exit extraits du message ou DB — requis pour positionner
  // les callouts sur le chart. Si manquants, le chart est fetché sans.
  entryPrice?: number | null;
  exitPrice?: number | null;
  // Optionnel : nom du template Remotion à utiliser (ex: "gold-celebration").
  // Si présent, le worker charge templates/<name>.json et merge ses props
  // comme base avant les props dynamiques du job.
  templateName?: string | null;
  // Composition Remotion à rendre (ex: 'BoomProof', 'BoomEntry'). Default
  // 'BoomProof' (rétro-compat).
  composition?: string;
  // JSON sérialisé contenant les props du récap (tickers, runnersHit, etc.).
  // Uniquement peuplé pour composition === 'BoomRecap'.
  recap_data?: string | null;
  // Tease text override (camelCase via jobToApiShape) — picker contextuel
  // décide ces valeurs au moment de l'enqueue. Si null, le worker utilise
  // les valeurs du template/defaultProps.
  teaseAction?: string | null;
  teaseSubtext?: string | null;
};

// Charge un template JSON depuis video/templates/<name>.json.
// Retourne les props (objet) ou null si le template n'existe pas / invalide.
export function loadTemplateProps(name: string | null | undefined): Record<string, unknown> | null {
  if (!name) return null;
  const tplPath = path.join(__dirname, '..', 'templates', `${name}.json`);
  try {
    const raw = fs.readFileSync(tplPath, 'utf-8');
    const json = JSON.parse(raw);
    return (json && typeof json === 'object' && json.props) ? json.props : null;
  } catch (err) {
    console.warn(`[worker] template '${name}' load failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// Props passées à la composition (sans le id, composition, et template
// côté DB qui ne sont pas des props Remotion).
// Ordre du merge : template props (base) ← job props (override) ← image data URL.
export function jobPropsToRemotion(job: RenderJob) {
  const { id: _id, composition: _comp, proofImageBase64, templateName, recap_data, ...rest } = job;
  const templateProps = loadTemplateProps(templateName) || {};

  // Pour BoomRecap : parse recap_data JSON et remplace les props.
  // Le worker ignore les entry_*/exit_* fields qui sont des placeholders
  // pour BoomRecap (la table render_jobs les exige NOT NULL pour rétrocompat).
  if (job.composition === 'BoomRecap' && recap_data) {
    try {
      const parsed = JSON.parse(recap_data);
      return {
        ...templateProps,
        ...parsed,  // overrides avec date, tickers, runners, tagline, totalGainPct
      };
    } catch (err) {
      console.error('[worker] Failed to parse recap_data:', (err as Error).message);
      // Continue avec template-only props (defaults sortiront depuis le schema Zod)
      return { ...templateProps };
    }
  }

  // Else : flow existant (BoomProof, BoomEntry, etc.)
  // BoomEntry utilise entryImageDataUrl au lieu de proofImageDataUrl.
  // On expose les 2 keys pour que les 2 compositions puissent l'utiliser.
  const dataUrl = proofImageBase64
    ? `data:image/png;base64,${proofImageBase64}`
    : null;
  // Chart dataUrl séparé — fetched par fetchChartForJob avant processJob.
  // Reste null si chart-img KO, BoomProof skip la phase chart dans ce cas.
  const chartDataUrl = job.chartImageBase64
    ? `data:image/png;base64,${job.chartImageBase64}`
    : null;
  return {
    ...templateProps,
    ...rest,
    proofImageDataUrl: dataUrl,
    entryImageDataUrl: dataUrl,
    chartImageDataUrl: chartDataUrl,
  };
}

// ─── Chart fetch ──────────────────────────────────────────────────
// Pre-fetch le chart TradingView pour le job (BoomProof uniquement).
// Skip si :
//   - composition !== 'BoomProof'
//   - CHART_IMG_API_KEY absent
//   - chart-img API échoue (timeout, 4xx, 5xx)
// Renvoie un base64 PNG ou null. Le worker ne FAIL PAS si chart-img KO,
// la composition est conçue pour skip la phase chart proprement.
//
// Symbol resolution : on essaie NASDAQ:TICKER en default (couvre la
// majorité des micro/small caps US). Si chart-img répond 404, on essaie
// AMEX. Pas de cache yahoo-finance ici pour rester rapide et autonome.
export async function fetchChartForJob(job: RenderJob): Promise<string | null> {
  if ((job.composition || 'BoomProof') !== 'BoomProof') return null;
  const apiKey = process.env.CHART_IMG_API_KEY;
  if (!apiKey) {
    console.warn(`[worker] job #${job.id}: CHART_IMG_API_KEY absent, skip chart`);
    return null;
  }

  // Import dynamique du client (JS depuis TS via require).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createChartImgClient, resolveSymbol } = require('../../discord/chart-img-client');

  const client = createChartImgClient({
    apiKey,
    width: 1080,    // matche le canvas vidéo 9:16
    height: 720,    // garde un ratio lisible (3:2)
    theme: 'dark',
  });

  // Format helper pour le label callout exit price (ex: "$0.202").
  const fmtPrice = (n: number): string => {
    if (n >= 100) return '$' + n.toFixed(2);
    if (n >= 1)   return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(4);
  };

  // Construit les arrows (Arrow Mark Up / Down) si on a les prix.
  // Entry : flèche up + label 'When alerted' (pointe depuis le bas vers
  // le prix d'entrée). Exit : flèche down + label = exit price formaté
  // (pointe depuis le haut vers le prix de sortie).
  //
  // Offset 1% — gap clair entre la flèche et la candle (~$4 sur TSLA $400).
  // Sous 1% la flèche tombe encore dans le range high/low de la candle.
  const arrows: Array<{
    datetime: string;
    price: number;
    text?: string;
    direction?: 'up' | 'down';
    fontBold?: boolean;
  }> = [];
  const ARROW_OFFSET = 0.01;

  if (Number.isFinite(job.entryPrice)) {
    arrows.push({
      datetime: job.entryTimestamp,
      price: (job.entryPrice as number) * (1 - ARROW_OFFSET),
      text: 'When alerted',
      direction: 'up',
      fontBold: true,
    });
  }
  if (Number.isFinite(job.exitPrice)) {
    arrows.push({
      datetime: job.exitTimestamp,
      price: (job.exitPrice as number) * (1 + ARROW_OFFSET),
      text: fmtPrice(job.exitPrice as number),
      direction: 'down',
      fontBold: true,
    });
  }

  const symbol = resolveSymbol(job.ticker, '');  // fallback NASDAQ
  try {
    const buf = await client.getChart(symbol, '1D', {
      studies: [],          // pas d'indicateurs (clean look)
      arrows,               // Arrow Mark Up/Down avec text labels
      // 'regular' (9:30-16:00 ET) plutôt que 'extended' — évite l'ombrage
      // darker visuellement bruyant sur les vidéos BoomProof. Trade-off :
      // trades pre-market (rares) ne seront pas visibles sur le chart.
      session: 'regular',
      timezone: 'America/New_York',
    });
    return buf.toString('base64');
  } catch (err) {
    console.warn(`[worker] job #${job.id}: chart-img failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

// Format heure NY 24h "HH:MM" depuis ISO timestamp.
export function formatTimeNY(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}

// Caption Discord (multi-line). Exemple :
//   📈 $TSLA · Z · +20% — proof video
//   Entry 13:32 · Exit 16:30
//
// Utilise exitAuthor (l'analyste qui clôt le trade) plutôt que entryAuthor
// car ce dernier peut être un raw Discord username (ex "traderzz1m") moins
// joli que le display name relayé sur l'exit.
export function buildCaption(job: RenderJob): string {
  return [
    `📈 $${job.ticker} · ${job.exitAuthor} · ${job.pnl} — proof video`,
    `Entry ${formatTimeNY(job.entryTimestamp)} · Exit ${formatTimeNY(job.exitTimestamp)}`,
  ].join('\n');
}

// Filename : YYYY-MM-DD_HHMM_TICKER_boomproof.mp4 (NY tz).
function buildLocalFilename(job: RenderJob): string {
  const d = new Date(job.exitTimestamp);
  const fmt = d.toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [datePart, timePart] = fmt.split(', ');
  const timeNoColon = timePart.replace(':', '');
  return `${datePart}_${timeNoColon}_${job.ticker.toUpperCase()}_boomproof.mp4`;
}

// ─── Fonctions HTTP côté bot ─────────────────────────────────────────

async function fetchPendingJobs(botUrl: string, token: string): Promise<RenderJob[]> {
  const res = await fetch(`${botUrl}/api/render-queue`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/render-queue failed: ${res.status}`);
  const body = await res.json() as { jobs?: unknown };
  if (!body || !Array.isArray(body.jobs)) {
    throw new Error('GET /api/render-queue returned malformed body (missing jobs array)');
  }
  return body.jobs as RenderJob[];
}

async function ackJobSuccess(
  botUrl: string, token: string, jobId: number,
  mp4Path: string, caption: string, ticker: string, exitTs: string,
) {
  const form = new FormData();
  const buf = fs.readFileSync(mp4Path);
  form.append('mp4', new Blob([buf], { type: 'video/mp4' }), path.basename(mp4Path));
  form.append('caption', caption);
  form.append('ticker', ticker);
  form.append('exitTs', exitTs);

  const res = await fetch(`${botUrl}/api/render-queue/${jobId}/done`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`POST /done failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ackJobFailed(
  botUrl: string, token: string, jobId: number, errorMessage: string,
) {
  const res = await fetch(`${botUrl}/api/render-queue/${jobId}/done`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ error: errorMessage }),
  });
  if (!res.ok) {
    console.error(`[worker] failed to ACK error for job ${jobId}: ${res.status}`);
  }
}

// ─── Loop principal ─────────────────────────────────────────────────

async function processJob(
  job: RenderJob, bundleLocation: string, outDir: string,
  botUrl: string, token: string,
) {
  console.log(`[worker] processing job ${job.id} (${job.ticker} ${job.pnl})`);

  // Pre-fetch chart image (BoomProof uniquement, skip gracieusement si fail).
  // Augmente le job in-place pour que jobPropsToRemotion(job) le voie.
  const chartBase64 = await fetchChartForJob(job);
  if (chartBase64) {
    job.chartImageBase64 = chartBase64;
    console.log(`[worker] job #${job.id}: chart fetched (${(chartBase64.length * 0.75 / 1024).toFixed(0)} KB)`);
  }

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: job.composition || 'BoomProof',
    inputProps: jobPropsToRemotion(job),
  });
  const filename = buildLocalFilename(job);
  const outPath = path.join(outDir, filename);

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: jobPropsToRemotion(job),
    // Cap bitrate pour rester sous la limite Discord (25 MB par défaut sur
    // serveur non-boosté). 3 Mbps × 20s ~= 7.5 MB, ample marge. La qualité
    // visuelle reste très bonne pour socials 1080×1920 (TikTok/Reels).
    // Sans cap, Remotion default (crf 18 = visually lossless) produit des
    // fichiers de 30-50 MB qui dépassent la limite Discord.
    videoBitrate: '3M',
  });

  // Log file size pour debug. Discord accepte 25 MB par défaut (free),
  // 50 MB si Nitro Basic, 100 MB si Boost Level 3.
  const fileSizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`[worker] rendered ${outPath} (${fileSizeMb} MB)`);

  try {
    await ackJobSuccess(
      botUrl, token, job.id, outPath,
      buildCaption(job), job.ticker, job.exitTimestamp,
    );
    console.log(`[worker] job ${job.id} ACKed (Discord uploaded)`);
  } catch (err) {
    // Render succeeded but upload failed — the MP4 is on disk and recoverable.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`upload failed (MP4 saved at ${outPath}): ${msg}`);
  }
}

async function main() {
  const botUrl = process.env.BOT_URL;
  const token = process.env.RENDER_WORKER_TOKEN;
  if (!botUrl || !token) {
    console.error('[worker] FATAL: BOT_URL and RENDER_WORKER_TOKEN env vars required');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'out', 'auto');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[worker] bundling Remotion project...');
  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, '..', 'src', 'index.ts'),
  });
  console.log(`[worker] ready, polling ${botUrl}/api/render-queue every 30s`);

  while (true) {
    try {
      const jobs = await fetchPendingJobs(botUrl, token);
      if (jobs.length === 0) {
        await sleep(30_000);
        continue;
      }
      console.log(`[worker] ${jobs.length} pending job(s)`);
      for (const job of jobs) {
        try {
          await processJob(job, bundleLocation, outDir, botUrl, token);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[worker] job ${job.id} failed: ${msg}`);
          await ackJobFailed(botUrl, token, job.id, msg);
        }
      }
    } catch (err) {
      console.error('[worker] poll failed:', err instanceof Error ? err.message : err);
      await sleep(30_000);
    }
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Entrée du script (uniquement si exécuté directement, pas en test).
// Utilise pathToFileURL pour gérer les chemins Windows (backslashes) correctement.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[worker] FATAL:', err);
    process.exit(1);
  });
}
