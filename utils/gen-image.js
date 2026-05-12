// ─────────────────────────────────────────────────────────────────────
// utils/gen-image.js — Client de génération d'images (multi-provider)
// ─────────────────────────────────────────────────────────────────────
// API unifiée : generateImage({ prompt, outputPath, aspectRatio })
// Le provider est choisi via la variable d'env IMAGE_PROVIDER :
//   - 'pollinations' (default) : gratuit, model Flux, no API key
//   - 'imagen'                  : Google Imagen 4 via Gemini API ($0.04/img)
//                                 nécessite GEMINI_API_KEY (paid tier)
//
// Pollinations est la default car gratuite et zéro setup. Si tu veux la
// qualité Imagen et que t'as payé pour Gemini API : IMAGE_PROVIDER=imagen
// dans video/.env.local.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');

// ─── Pollinations.ai (gratuit, Flux model, no auth) ──────────────────
// Endpoint REST simple : GET image.pollinations.ai/prompt/{encoded}?...
// Retourne directement le binaire image. Génération 10-30s typiquement.

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

const ASPECT_TO_DIMS = {
  '1:1':  { width: 1024, height: 1024 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '4:3':  { width: 1024, height: 768  },
  '3:4':  { width: 768,  height: 1024 },
};

async function generateViaPollinations({ prompt, outputPath, aspectRatio }) {
  const dims = ASPECT_TO_DIMS[aspectRatio] || ASPECT_TO_DIMS['9:16'];
  const encoded = encodeURIComponent(prompt);
  // model=flux pour qualité top, nologo=true pour pas de watermark
  // Pollinations, enhance=false pour garder le prompt exact.
  const url = `${POLLINATIONS_BASE}/${encoded}?width=${dims.width}&height=${dims.height}&model=flux&nologo=true&enhance=false`;

  // Pollinations peut prendre 10-60s, timeout généreux.
  const controller = new AbortController();
  const timeoutMs = 120_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Pollinations timeout après ${timeoutMs / 1000}s — réessaye ou check status.pollinations.ai`);
    }
    throw new Error(`Pollinations network error: ${err.message}`);
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Pollinations API ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Sanity check : Pollinations parfois retourne 200 avec un body HTML
  // d'erreur. Les PNG/JPEG commencent par signatures connues.
  const isPng  = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpg  = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!isPng && !isJpg) {
    throw new Error(`Pollinations: response non-image (${buffer.length} bytes, headers: ${res.headers.get('content-type')})`);
  }

  fs.writeFileSync(outputPath, buffer);
  return {
    outputPath,
    mimeType: res.headers.get('content-type') || (isPng ? 'image/png' : 'image/jpeg'),
    bytes: buffer.length,
    provider: 'pollinations',
  };
}

// ─── Google Imagen 4 via Gemini API ──────────────────────────────────
// Backup provider, nécessite GEMINI_API_KEY (paid tier obligatoire).

const IMAGEN_DEFAULT_MODEL = 'imagen-4.0-generate-001';

async function generateViaImagen({ prompt, outputPath, aspectRatio, model, apiKey }) {
  const useModel = model || IMAGEN_DEFAULT_MODEL;
  const useKey = apiKey || process.env.GEMINI_API_KEY;
  if (!useKey) {
    throw new Error('GEMINI_API_KEY env var required for Imagen. Set in video/.env.local.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:predict`;
  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio,
      personGeneration: 'allow_adult',
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': useKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Imagen API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const prediction = json.predictions && json.predictions[0];
  if (!prediction || !prediction.bytesBase64Encoded) {
    throw new Error(`Imagen response malformed: ${JSON.stringify(json).slice(0, 200)}`);
  }

  const buffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
  fs.writeFileSync(outputPath, buffer);

  return {
    outputPath,
    mimeType: prediction.mimeType || 'image/png',
    bytes: buffer.length,
    provider: 'imagen',
  };
}

// ─── API publique unifiée ────────────────────────────────────────────

/**
 * Génère une image et la sauve sur disque.
 *
 * @param {object} opts
 * @param {string} opts.prompt          - Description visuelle
 * @param {string} opts.outputPath      - Chemin absolu de sortie
 * @param {string} [opts.aspectRatio]   - "1:1", "3:4", "4:3", "9:16", "16:9" (default 9:16)
 * @param {string} [opts.provider]      - 'pollinations' | 'imagen' (default env IMAGE_PROVIDER || 'pollinations')
 * @returns {Promise<{outputPath, mimeType, bytes, provider}>}
 */
async function generateImage(opts) {
  const provider = opts.provider || process.env.IMAGE_PROVIDER || 'pollinations';
  const args = { aspectRatio: '9:16', ...opts };

  if (!args.prompt || typeof args.prompt !== 'string') {
    throw new Error('prompt (string) required');
  }
  if (!args.outputPath) {
    throw new Error('outputPath required');
  }

  if (provider === 'pollinations') return generateViaPollinations(args);
  if (provider === 'imagen' || provider === 'gemini') return generateViaImagen(args);

  throw new Error(`Unknown IMAGE_PROVIDER: '${provider}' (supported: pollinations, imagen)`);
}

module.exports = { generateImage };
