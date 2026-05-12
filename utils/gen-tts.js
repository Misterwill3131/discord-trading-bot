// ─────────────────────────────────────────────────────────────────────
// utils/gen-tts.js — Client TTS (text-to-speech) multi-provider
// ─────────────────────────────────────────────────────────────────────
// API unifiée : generateTTS({ text, outputPath, voice })
// Provider sélectionné via env TTS_PROVIDER :
//   - 'edge'    (default)  Microsoft Edge TTS via msedge-tts npm (gratuit,
//                          voix neural Azure haute qualité)
//   - 'google'             Google Translate TTS (gratuit, voix robotique)
//                          Fallback automatique si msedge-tts manque.
//   - 'openai'             OpenAI TTS direct (paid, $0.015/1k chars)
//
// Voices (Edge — high quality, recommandé) :
//   en-US-DavisNeural        warm, intelligent (default)
//   en-US-RogerNeural        mature, authoritative
//   en-US-TonyNeural         smooth, mid-deep
//   en-US-GuyNeural          newscaster, clean
//   en-US-ChristopherNeural  deep, professional
//   en-US-AriaNeural         feminine clear
//   en-US-JennyNeural        feminine warm
//
// Voices (Google Translate — basique fallback) : tl=en, en-US, en-GB, fr...
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');

// Mapping OpenAI voice names → Edge equivalent (pour cohérence config UX).
// Permet à l'utilisateur de specifier 'onyx' qui mappe vers DavisNeural.
const OPENAI_TO_EDGE_VOICE = {
  alloy:   'en-US-DavisNeural',
  echo:    'en-US-GuyNeural',
  fable:   'en-US-RyanNeural',     // UK accent
  onyx:    'en-US-RogerNeural',    // deep masculin
  nova:    'en-US-JennyNeural',
  shimmer: 'en-US-AriaNeural',
};

function resolveEdgeVoice(voice) {
  if (!voice) return 'en-US-RogerNeural';
  // If already an Edge voice (contains 'Neural'), use as-is
  if (/Neural$/.test(voice)) return voice;
  // Map OpenAI names
  if (OPENAI_TO_EDGE_VOICE[voice]) return OPENAI_TO_EDGE_VOICE[voice];
  // Otherwise assume it's already a valid Edge voice
  return voice;
}

// ─── Microsoft Edge TTS (haute qualité, gratuit) ─────────────────────
// ⚠️ Microsoft a ajouté un Sec-MS-GEC token en 2025 qui breaks msedge-tts
// 1.3.4 (Connect Error sur le WebSocket). On essaie Edge en premier, mais
// si ÇA FAIL pour n'importe quelle raison, on fallback automatiquement
// vers Google Translate TTS (robotique mais reliable).
async function generateViaEdge({ text, outputPath, voice }) {
  let MsEdgeTTS, OUTPUT_FORMAT;
  try {
    ({ MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts'));
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      console.warn('[gen-tts] msedge-tts non installé → fallback Google Translate TTS.');
      return generateViaGoogleTranslate({ text, outputPath });
    }
    console.warn('[gen-tts] msedge-tts require error → fallback Google Translate TTS.');
    return generateViaGoogleTranslate({ text, outputPath });
  }

  // Wrappe tout dans un try/catch large car msedge-tts peut throw des
  // strings au lieu d'Errors (cas observé: "Connect Error: [object Object]").
  try {
    const edgeVoice = resolveEdgeVoice(voice);
    const tts = new MsEdgeTTS();
    await tts.setMetadata(edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    if (typeof tts.toFile === 'function') {
      const result = await tts.toFile(outputPath, text);
      if (result && result.audioFilePath && result.audioFilePath !== outputPath) {
        try { fs.renameSync(result.audioFilePath, outputPath); } catch { /* ignore */ }
      }
    } else if (typeof tts.toStream === 'function') {
      const stream = tts.toStream(text);
      const chunks = [];
      await new Promise((resolve, reject) => {
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      fs.writeFileSync(outputPath, Buffer.concat(chunks));
    } else {
      throw new Error('msedge-tts: ni toFile() ni toStream() disponible');
    }

    if (!fs.existsSync(outputPath)) throw new Error('Edge TTS: fichier non créé');
    const bytes = fs.statSync(outputPath).size;
    if (bytes < 100) throw new Error(`Edge TTS: fichier trop petit (${bytes} bytes)`);

    return { outputPath, mimeType: 'audio/mpeg', bytes, provider: 'edge', voice: edgeVoice };
  } catch (err) {
    // msedge-tts peut throw des strings, des objects, ou des Errors.
    // On extrait une message string lisible peu importe.
    const errMsg = typeof err === 'string'
      ? err
      : (err && err.message) || JSON.stringify(err) || 'unknown';
    console.warn(`[gen-tts] Edge TTS failed (${errMsg.slice(0, 100)}) → fallback Google Translate.`);
    return generateViaGoogleTranslate({ text, outputPath });
  }
}

// ─── Google Translate TTS (fallback gratuit, voix robotique) ─────────
async function generateViaGoogleTranslate({ text, outputPath, lang = 'en' }) {
  // Limite ~200 chars par requête. Pour les captions courtes, OK.
  if (text.length > 200) {
    throw new Error(`Google Translate TTS: text trop long (${text.length} chars, max 200). Découpe ou utilise Edge.`);
  }
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tts-client/1.0)' },
  });
  if (!res.ok) {
    throw new Error(`Google Translate TTS ${res.status}: ${res.statusText}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('audio')) {
    throw new Error(`Google Translate TTS: content-type non-audio (${ct})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return { outputPath, mimeType: 'audio/mpeg', bytes: buffer.length, provider: 'google' };
}

// ─── OpenAI TTS (paid, premium quality) ──────────────────────────────
async function generateViaOpenAI({ text, outputPath, voice = 'onyx', model = 'tts-1', apiKey }) {
  const useKey = apiKey || process.env.OPENAI_API_KEY;
  if (!useKey) throw new Error('OPENAI_API_KEY env var required for OpenAI TTS.');

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${useKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${txt.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return { outputPath, mimeType: 'audio/mpeg', bytes: buffer.length, provider: 'openai' };
}

// ─── API publique unifiée ────────────────────────────────────────────

/**
 * Génère un audio TTS et le sauve sur disque.
 *
 * @param {object} opts
 * @param {string} opts.text         - Texte à lire
 * @param {string} opts.outputPath   - Chemin absolu de sortie (.mp3)
 * @param {string} [opts.voice]      - Nom de voix (Edge ou OpenAI mapping)
 * @param {string} [opts.provider]   - 'edge' | 'google' | 'openai' (default env TTS_PROVIDER || 'edge')
 * @returns {Promise<{outputPath, mimeType, bytes, provider, voice?}>}
 */
async function generateTTS(opts) {
  const provider = opts.provider || process.env.TTS_PROVIDER || 'edge';
  const args = { ...opts };

  if (!args.text || typeof args.text !== 'string') throw new Error('text (string) required');
  if (!args.outputPath) throw new Error('outputPath required');

  if (provider === 'edge') return generateViaEdge(args);
  if (provider === 'google') return generateViaGoogleTranslate(args);
  if (provider === 'openai') return generateViaOpenAI(args);

  throw new Error(`Unknown TTS_PROVIDER: '${provider}' (supported: edge, google, openai)`);
}

module.exports = { generateTTS };
