// ─────────────────────────────────────────────────────────────────────
// utils/gen-image.js — Client Imagen 4 via Gemini API (REST)
// ─────────────────────────────────────────────────────────────────────
// Wraps l'API REST de Gemini pour générer des images via Imagen 4.
// Pas de SDK installé pour minimiser les deps — fetch natif Node 18+.
//
// Modèles supportés (Mai 2026) :
//   - imagen-4.0-generate-001       Standard ($0.04 / image 1080p)
//   - imagen-4.0-fast-generate-001  Fast (moins cher, moins de détail)
//   - imagen-4.0-ultra-generate-001 Ultra ($0.06 / image, meilleur texte)
//
// Variables d'env requises :
//   GEMINI_API_KEY  — créée sur https://aistudio.google.com/apikey
//
// Note : pas en free tier, paid tier Gemini API obligatoire.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');

const DEFAULT_MODEL = 'imagen-4.0-generate-001';
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;

/**
 * Génère une image via Imagen 4 et la sauve sur disque.
 *
 * @param {object} opts
 * @param {string} opts.prompt          - Description visuelle
 * @param {string} opts.outputPath      - Chemin absolu où sauver le PNG
 * @param {string} [opts.aspectRatio]   - "1:1", "3:4", "4:3", "9:16", "16:9" (default 9:16)
 * @param {string} [opts.model]         - imagen-4.0-* (default Standard)
 * @param {string} [opts.apiKey]        - Override env var (default process.env.GEMINI_API_KEY)
 * @returns {Promise<{outputPath: string, mimeType: string, bytes: number}>}
 */
async function generateImage({
  prompt,
  outputPath,
  aspectRatio = '9:16',
  model = DEFAULT_MODEL,
  apiKey = process.env.GEMINI_API_KEY,
}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY env var required. Set in video/.env.local or environment.');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt (string) required');
  }
  if (!outputPath) {
    throw new Error('outputPath required');
  }

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio,
      // Permet la génération de personnes adultes (par défaut bloquée
      // dans certaines régions). On garde les enfants bloqués via la
      // valeur 'allow_adult' qui exclut les mineurs.
      personGeneration: 'allow_adult',
    },
  };

  const res = await fetch(ENDPOINT(model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Imagen API ${res.status}: ${text}`);
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
  };
}

module.exports = { generateImage };
