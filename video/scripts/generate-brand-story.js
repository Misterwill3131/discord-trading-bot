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

const VIDEO_DIR = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(VIDEO_DIR, 'templates', 'brand-story-default.json');
const OUTPUT_IMG_DIR = path.join(VIDEO_DIR, 'public', 'brand-story');
const OUTPUT_MP4_DIR = path.join(VIDEO_DIR, 'out');

async function main() {
  // ── 1. Load template ────────────────────────────────────────────
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  const scenes = template.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Template scenes array missing or empty');
  }
  console.log(`[gen-brand-story] Loaded ${scenes.length} scenes from ${TEMPLATE_PATH}`);

  // ── 2. Prepare output dirs ──────────────────────────────────────
  fs.mkdirSync(OUTPUT_IMG_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_MP4_DIR, { recursive: true });

  // ── 3. Generate all scenes in parallel via image provider ─────
  const provider = process.env.IMAGE_PROVIDER || 'pollinations';
  console.log(`[gen-brand-story] Generating ${scenes.length} images via ${provider} (parallel)...`);
  if (provider === 'pollinations') {
    console.log('[gen-brand-story]   Pollinations (Flux, gratuit) — peut prendre 10-30s par image.');
  }
  const startedAt = Date.now();

  const results = await Promise.all(
    scenes.map(async (scene, i) => {
      const sceneNum = i + 1;
      const outputPath = path.join(OUTPUT_IMG_DIR, `scene${sceneNum}.png`);
      try {
        const r = await generateImage({
          prompt: scene.prompt,
          outputPath,
          aspectRatio: '9:16',
        });
        console.log(`  ✓ Scene ${sceneNum}: ${(r.bytes / 1024).toFixed(0)} KB saved to ${outputPath}`);
        return { ok: true, sceneNum, outputPath };
      } catch (err) {
        console.error(`  ✗ Scene ${sceneNum} failed: ${err.message}`);
        return { ok: false, sceneNum, error: err.message };
      }
    })
  );

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`[gen-brand-story] ${failed.length}/${scenes.length} scenes failed. Aborting render.`);
    process.exit(1);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[gen-brand-story] All ${scenes.length} scenes generated in ${elapsedSec}s`);

  // ── 4. Build Remotion input props (scenes with imagePath) ──────
  // Le Remotion bundler résoudra les paths via staticFile() au render time.
  // On passe juste les paths relatifs au public dir.
  const inputProps = {
    scenes: scenes.map((scene, i) => ({
      imagePath: `brand-story/scene${i + 1}.png`,
      caption: scene.caption,
    })),
    sceneDurationFrames: template.props?.sceneDurationFrames || 150,
    accentColor: template.props?.accentColor || '#fbbf24',
    captionStyle: template.props?.captionStyle || 'bold',
    outroSeed: `brand-story-${Date.now()}`,  // outro picker varie à chaque render
  };

  // Write inputProps to temp JSON file for Remotion render (cleaner than --props)
  const propsPath = path.join(OUTPUT_MP4_DIR, '.brand-story-props.json');
  fs.writeFileSync(propsPath, JSON.stringify(inputProps, null, 2));

  // ── 5. Render via Remotion CLI ─────────────────────────────────
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
