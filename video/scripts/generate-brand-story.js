#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// video/scripts/generate-brand-story.js — Pipeline génération brand story
// ─────────────────────────────────────────────────────────────────────
// 1. Charge les 6 prompts depuis video/templates/brand-story-default.json
// 2. Appelle le provider d'images (default: Pollinations.ai gratuit, Flux model)
//    en parallèle pour chaque scène
// 3. Download les PNG/JPEG dans video/public/brand-story/scene{1..6}.png
// 4. Lance Remotion render → MP4 final dans video/out/
//
// Usage :
//   cd video && npm run generate:brand-story
//
// Variables d'env optionnelles (dans video/.env.local) :
//   IMAGE_PROVIDER  — 'pollinations' (default, gratuit) ou 'imagen' (paid)
//   GEMINI_API_KEY  — uniquement si IMAGE_PROVIDER=imagen
//
// Coût estimé :
//   - Pollinations (default) : GRATUIT, ~10-30s/image
//   - Imagen 4 (paid)        : ~$0.24 par génération (6×$0.04), ~5-10s/image
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Charge dotenv depuis video/.env.local (qui contient GEMINI_API_KEY,
// ANTHROPIC_API_KEY pour l'editor, etc.). override:true pour remplacer
// les vars existantes (dotenv 17.x default change).
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.local'),
  override: true,
  quiet: true,
});

const { generateImage } = require('../../utils/gen-image');
const { generateTTS } = require('../../utils/gen-tts');

const VIDEO_DIR = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(VIDEO_DIR, 'templates', 'brand-story-default.json');
const OUTPUT_IMG_DIR = path.join(VIDEO_DIR, 'public', 'brand-story');
const OUTPUT_MP4_DIR = path.join(VIDEO_DIR, 'out');

// ─── ffprobe helper (auto-measure MP3 duration) ──────────────────
// Remotion bundle ffprobe dans le package compositor-{platform}. Cherche le
// binaire pour la plateforme courante. Retourne null si introuvable
// (fallback : on garde les durationFrames du template tels quels).
function findFfprobe() {
  const key = `${process.platform}-${process.arch}`;
  const pkgMap = {
    'win32-x64': '@remotion/compositor-win32-x64-msvc',
    'linux-x64': '@remotion/compositor-linux-x64-gnu',
    'linux-arm64': '@remotion/compositor-linux-arm64-gnu',
    'darwin-x64': '@remotion/compositor-darwin-x64',
    'darwin-arm64': '@remotion/compositor-darwin-arm64',
  };
  const pkg = pkgMap[key];
  if (!pkg) return null;
  const ext = process.platform === 'win32' ? '.exe' : '';
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const ffprobePath = path.join(path.dirname(pkgJson), `ffprobe${ext}`);
    if (fs.existsSync(ffprobePath)) return ffprobePath;
  } catch { /* ignore */ }
  return null;
}

function probeAudioDurationSeconds(ffprobePath, filePath) {
  try {
    const out = execSync(
      `"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const dur = parseFloat(out.trim());
    return isFinite(dur) && dur > 0 ? dur : null;
  } catch { return null; }
}

// ─── CLI args ───────────────────────────────────────────────────
// --force          : regénère toutes les scènes même si les PNG existent
// --scenes=1,3,5   : ne génère/render QUE ces scènes (skip les autres)
// --no-render      : génère les images mais skip le Remotion render
function parseArgs() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const noRender = args.includes('--no-render');
  const scenesArg = args.find(a => a.startsWith('--scenes='));
  const specificScenes = scenesArg
    ? scenesArg.replace('--scenes=', '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0)
    : null;
  return { force, noRender, specificScenes };
}

async function main() {
  const { force, noRender, specificScenes } = parseArgs();

  // ── 1. Load template ────────────────────────────────────────────
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  const scenes = template.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Template scenes array missing or empty');
  }
  console.log(`[gen-brand-story] Loaded ${scenes.length} scenes from ${TEMPLATE_PATH}`);
  if (force) console.log('[gen-brand-story] --force : re-génère toutes les scènes (ignore cache disque).');
  if (specificScenes) console.log(`[gen-brand-story] --scenes=${specificScenes.join(',')} : génère uniquement ces scènes.`);
  if (noRender) console.log('[gen-brand-story] --no-render : skip Remotion render à la fin.');

  // ── 2. Prepare output dirs ──────────────────────────────────────
  fs.mkdirSync(OUTPUT_IMG_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_MP4_DIR, { recursive: true });

  // ── 3. Generate all scenes via image provider ─────────────────
  // Pollinations free tier limite à 1 request en parallèle par IP (429
  // sinon). On fait donc SÉQUENTIEL — 1 image à la fois, retry sur 429
  // avec backoff. Total ~1-2 min pour 6 images (vs ~30s parallel idéal).
  // Pour Imagen (paid) le parallel marcherait mais on fait pareil ici
  // pour simplicité du code.
  const provider = process.env.IMAGE_PROVIDER || 'pollinations';
  console.log(`[gen-brand-story] Generating ${scenes.length} images via ${provider} (sequential)...`);
  if (provider === 'pollinations') {
    console.log('[gen-brand-story]   Pollinations (Flux, gratuit) — séquentiel à cause du rate-limit free tier.');
    console.log('[gen-brand-story]   ~10-30s par image, total ~1-3 min pour 6 images.');
  }
  const startedAt = Date.now();

  // Helper retry sur 429 avec backoff exponentiel (5s, 15s, 30s).
  async function generateWithRetry(scene, sceneNum) {
    const outputPath = path.join(OUTPUT_IMG_DIR, `scene${sceneNum}.png`);
    const delays = [5000, 15000, 30000];  // 3 retries max
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const r = await generateImage({
          prompt: scene.prompt,
          outputPath,
          aspectRatio: '9:16',
        });
        return { ok: true, sceneNum, outputPath, bytes: r.bytes };
      } catch (err) {
        lastErr = err;
        const is429 = /429/.test(err.message) || /too many requests/i.test(err.message);
        if (attempt < delays.length && is429) {
          const wait = delays[attempt];
          console.log(`  ⏳ Scene ${sceneNum} rate-limited, retry in ${wait / 1000}s (attempt ${attempt + 1}/${delays.length + 1})...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return { ok: false, sceneNum, error: err.message };
      }
    }
    return { ok: false, sceneNum, error: lastErr.message };
  }

  const results = [];
  let actuallyGenerated = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sceneNum = i + 1;
    const outputPath = path.join(OUTPUT_IMG_DIR, `scene${sceneNum}.png`);

    // Skip si --scenes=X,Y,Z filter set et cette scène pas dedans.
    if (specificScenes && !specificScenes.includes(sceneNum)) {
      // Vérifie quand même que le fichier existe pour le render final.
      if (fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size;
        console.log(`  ⊘ Scene ${sceneNum}: skipped (--scenes filter), reusing ${(size / 1024).toFixed(0)} KB on disk`);
        results.push({ ok: true, sceneNum, outputPath, bytes: size, cached: true });
      } else {
        console.warn(`  ⚠ Scene ${sceneNum}: skipped (--scenes filter) MAIS pas de PNG sur disque — render va fail`);
        results.push({ ok: false, sceneNum, error: 'skipped and no cached file' });
      }
      continue;
    }

    // Skip si le fichier existe déjà (sauf --force).
    if (!force && fs.existsSync(outputPath)) {
      const size = fs.statSync(outputPath).size;
      console.log(`  ⊘ Scene ${sceneNum}: déjà sur disque (${(size / 1024).toFixed(0)} KB), use --force pour regen`);
      results.push({ ok: true, sceneNum, outputPath, bytes: size, cached: true });
      continue;
    }

    // Génère
    const sceneStart = Date.now();
    const r = await generateWithRetry(scenes[i], sceneNum);
    const elapsed = ((Date.now() - sceneStart) / 1000).toFixed(1);
    if (r.ok) {
      console.log(`  ✓ Scene ${sceneNum}: ${(r.bytes / 1024).toFixed(0)} KB in ${elapsed}s`);
      actuallyGenerated++;
    } else {
      console.error(`  ✗ Scene ${sceneNum} failed (${elapsed}s): ${r.error}`);
    }
    results.push(r);
    // Petite pause entre les requêtes pour pas saturer (Pollinations only).
    if (provider === 'pollinations' && i < scenes.length - 1 && actuallyGenerated > 0) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`[gen-brand-story] ${failed.length}/${scenes.length} scenes failed. Aborting render.`);
    process.exit(1);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[gen-brand-story] All ${scenes.length} scenes generated in ${elapsedSec}s`);

  // ── 3.5. Generate TTS audio per scene ──────────────────────────
  // Une voix lit chaque narration (ou caption+subCaption) pendant la scène.
  // Voice default : 'onyx' (= Arnold sur ElevenLabs, pre-made, free tier OK).
  // Library voices marchent que sur paid plan ElevenLabs.
  // Override via template.props.voice (alias ou raw ID) ou env TTS_VOICE.
  const voice = process.env.TTS_VOICE || template.props?.voice || 'onyx';
  const ttsProvider = process.env.TTS_PROVIDER || 'pollinations';
  console.log(`[gen-brand-story] Generating ${scenes.length} TTS clips via ${ttsProvider} (voice=${voice}, sequential)...`);
  const ttsStartedAt = Date.now();

  const ttsResults = [];
  for (let i = 0; i < scenes.length; i++) {
    const sceneNum = i + 1;
    const audioPath = path.join(OUTPUT_IMG_DIR, `scene${sceneNum}.mp3`);

    // Same skip-logic que pour les images
    if (specificScenes && !specificScenes.includes(sceneNum)) {
      if (fs.existsSync(audioPath)) {
        console.log(`  ⊘ Scene ${sceneNum} TTS: skipped (--scenes filter), reusing audio on disk`);
        ttsResults.push({ ok: true, sceneNum, audioPath, cached: true });
      } else {
        console.warn(`  ⚠ Scene ${sceneNum} TTS: skipped + pas de MP3 sur disque — audio manquant dans la vidéo`);
        ttsResults.push({ ok: false, sceneNum, error: 'skipped and no cached file' });
      }
      continue;
    }
    if (!force && fs.existsSync(audioPath)) {
      const size = fs.statSync(audioPath).size;
      console.log(`  ⊘ Scene ${sceneNum} TTS: déjà sur disque (${(size / 1024).toFixed(0)} KB)`);
      ttsResults.push({ ok: true, sceneNum, audioPath, bytes: size, cached: true });
      continue;
    }

    const ttsSceneStart = Date.now();
    try {
      // TTS texte priorité : scene.narration (body paragraph long, dédié au
      // voice-over) > caption + subCaption combiné > caption seule.
      // La narration permet d'avoir un texte TTS plus long et dramatique
      // que la caption visuelle courte ("The Downward Spiral.").
      const ttsText = scenes[i].narration
        || (scenes[i].subCaption ? `${scenes[i].caption} ${scenes[i].subCaption}` : scenes[i].caption);
      const r = await generateTTS({
        text: ttsText,
        outputPath: audioPath,
        voice,
      });
      const elapsed = ((Date.now() - ttsSceneStart) / 1000).toFixed(1);
      console.log(`  ✓ Scene ${sceneNum} TTS: ${(r.bytes / 1024).toFixed(0)} KB in ${elapsed}s`);
      ttsResults.push({ ok: true, sceneNum, audioPath, bytes: r.bytes });
    } catch (err) {
      const elapsed = ((Date.now() - ttsSceneStart) / 1000).toFixed(1);
      console.error(`  ✗ Scene ${sceneNum} TTS failed (${elapsed}s): ${err.message}`);
      ttsResults.push({ ok: false, sceneNum, error: err.message });
    }

    // Pause entre les requêtes (Pollinations 1-concurrent-req limit)
    if (ttsProvider === 'pollinations' && i < scenes.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const ttsFailed = ttsResults.filter(r => !r.ok);
  if (ttsFailed.length > 0) {
    console.warn(`[gen-brand-story] ${ttsFailed.length}/${scenes.length} TTS failed — vidéo aura des scènes silencieuses sur ces clips.`);
  }
  const ttsElapsed = ((Date.now() - ttsStartedAt) / 1000).toFixed(1);
  console.log(`[gen-brand-story] TTS generation done in ${ttsElapsed}s`);

  // ── 3.7. Mesure auto des durées MP3 (cale chaque scène sur son audio) ──
  // Sans ça, si une narration dure 5s mais que durationFrames=300 (10s),
  // on a 5s de silence entre les scènes. ffprobe lit la vraie durée des
  // MP3s générés et override durationFrames pour avoir audio + 0.6s buffer.
  const ffprobePath = findFfprobe();
  const measuredDurations = {};
  if (ffprobePath) {
    console.log('[gen-brand-story] Probing MP3 durations to auto-fit scene length…');
    for (let i = 0; i < scenes.length; i++) {
      const sceneNum = i + 1;
      const mp3Path = path.join(OUTPUT_IMG_DIR, `scene${sceneNum}.mp3`);
      if (!fs.existsSync(mp3Path)) continue;
      const dur = probeAudioDurationSeconds(ffprobePath, mp3Path);
      if (dur) {
        measuredDurations[sceneNum] = dur;
        console.log(`  📏 Scene ${sceneNum}: audio = ${dur.toFixed(2)}s`);
      } else {
        console.warn(`  ⚠ Scene ${sceneNum}: probe failed, fallback to template duration`);
      }
    }
  } else {
    console.warn('[gen-brand-story] ffprobe introuvable — using template durationFrames as-is (espace entre scènes possible).');
  }

  // ── 4. Build Remotion input props (scenes with imagePath + audioPath) ──
  // Le Remotion bundler résoudra les paths via staticFile() au render time.
  // On passe juste les paths relatifs au public dir.
  const FPS = 30;
  const AUDIO_TAIL_FRAMES = 18;  // 0.6s post-audio buffer (couvre fade-out 12f + petit blanc)
  const inputProps = {
    scenes: scenes.map((scene, i) => {
      const sceneNum = i + 1;
      const audioRel = `brand-story/scene${sceneNum}.mp3`;
      const audioExists = fs.existsSync(path.join(OUTPUT_IMG_DIR, `scene${sceneNum}.mp3`));
      // Priorité durationFrames :
      //   1. Mesure ffprobe (audio_sec × 30 + 18 frames) — match parfait
      //   2. Template scene.durationFrames — fallback si pas de mesure
      //   3. null → composition utilise sceneDurationFrames global
      const measured = measuredDurations[sceneNum];
      // Clamp [60, 600] pour rester dans le range Zod schema. Short MP3 cache
      // (<2s) → bump à 60 (2s min visible). Long narration (>20s) → cap à 600.
      const dynamicDuration = measured
        ? Math.max(60, Math.min(600, Math.ceil(measured * FPS) + AUDIO_TAIL_FRAMES))
        : null;
      const finalDuration = dynamicDuration || scene.durationFrames || null;
      return {
        imagePath: `brand-story/scene${sceneNum}.png`,
        caption: scene.caption,
        subCaption: scene.subCaption || null,
        // narration n'est pas utilisé par la composition Remotion (TTS-only),
        // mais on le passe quand même pour debug / future extension.
        narration: scene.narration || null,
        durationFrames: finalDuration,
        // audioPath optionnel : null si le TTS a fail pour cette scène,
        // composition skip l'Audio dans ce cas.
        audioPath: audioExists ? audioRel : null,
      };
    }),
    sceneDurationFrames: template.props?.sceneDurationFrames || 180,
    accentColor: template.props?.accentColor || '#fbbf24',
    captionStyle: template.props?.captionStyle || 'bold',
    outroSeed: `brand-story-${Date.now()}`,  // outro picker varie à chaque render
  };

  // Affiche le récap des durées finales pour debug
  const totalFrames = inputProps.scenes.reduce(
    (sum, s) => sum + (s.durationFrames || inputProps.sceneDurationFrames),
    0
  );
  console.log(`[gen-brand-story] Total video: ${(totalFrames / FPS).toFixed(1)}s (+ 3s outro) = ${((totalFrames + 90) / FPS).toFixed(1)}s`);

  // Write inputProps to temp JSON file for Remotion render (cleaner than --props)
  const propsPath = path.join(OUTPUT_MP4_DIR, '.brand-story-props.json');
  fs.writeFileSync(propsPath, JSON.stringify(inputProps, null, 2));

  // ── 5. Render via Remotion CLI ─────────────────────────────────
  if (noRender) {
    console.log('[gen-brand-story] --no-render set : skip Remotion render. Images dispo dans video/public/brand-story/');
    console.log('[gen-brand-story] Re-run sans --no-render pour rendre le MP4.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outMp4 = path.join(OUTPUT_MP4_DIR, `tob-brand-story-${timestamp}.mp4`);

  console.log(`[gen-brand-story] Rendering Remotion composition → ${outMp4}`);

  // Use staticFile-style paths. Remotion bundler will resolve them.
  // --props takes a JSON file path or inline JSON.
  const cmd = `npx remotion render TobBrandStory "${outMp4}" --props="${propsPath}"`;
  try {
    execSync(cmd, { stdio: 'inherit', cwd: VIDEO_DIR });
  } catch (err) {
    console.error('[gen-brand-story] Remotion render failed.');
    process.exit(1);
  }

  const mp4Size = (fs.statSync(outMp4).size / 1024 / 1024).toFixed(2);
  console.log(`\n[gen-brand-story] ✅ Done! MP4: ${outMp4} (${mp4Size} MB)`);
  console.log('[gen-brand-story] Tu peux maintenant uploader manuellement sur tes socials.');

  // Cleanup temp props file
  try { fs.unlinkSync(propsPath); } catch { /* ignore */ }
}

main().catch(err => {
  console.error('[gen-brand-story] FATAL:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
