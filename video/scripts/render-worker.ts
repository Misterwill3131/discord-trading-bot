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
  return {
    ...templateProps,
    ...rest,
    proofImageDataUrl: dataUrl,
    entryImageDataUrl: dataUrl,
  };
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
  });

  console.log(`[worker] rendered ${outPath}`);

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
