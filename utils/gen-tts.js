// ─────────────────────────────────────────────────────────────────────
// utils/gen-tts.js — Client TTS (text-to-speech) multi-provider
// ─────────────────────────────────────────────────────────────────────
// API unifiée : generateTTS({ text, outputPath, voice })
// Provider sélectionné via env TTS_PROVIDER (sinon auto-detect) :
//   - 'elevenlabs'  Best quality. Auto-default si ELEVENLABS_API_KEY set.
//                   Free tier 10k chars/mois (≈50 renders brand-story).
//   - 'edge'        Microsoft Edge TTS via msedge-tts npm (gratuit,
//                   voix neural Azure). Cassé en 2025 → fallback Google.
//   - 'google'      Google Translate TTS (gratuit, voix robotique).
//                   Fallback ultime quand rien d'autre marche.
//   - 'openai'      OpenAI TTS direct (paid, $0.015/1k chars).
//
// Default auto-detect : ElevenLabs si clé set, sinon Edge (qui fallback
// Google). User n'a pas à set TTS_PROVIDER explicitement.
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

// ─── ElevenLabs TTS (free tier 10k chars/mois, top quality) ──────────
// Sign-up : https://elevenlabs.io → Profile → API Keys → Generate
// Add to video/.env.local : ELEVENLABS_API_KEY=sk_...
//
// Voices stable IDs (vérifiés en mai 2026, ne devraient pas changer) :
//   pNInz6obpgDQGcFmaJgB   Adam — mid-deep américain, default
//   VR6AewLTigWG4xSOukaG   Arnold — mature mature, intense
//   ErXwobaYiN019PkySvjV   Antoni — american warm
//   TxGEqnHWrfWFTfGW9XjX   Josh — young energetic
//   yoZ06aMxZJJ28mfd3POQ   Sam — mid male
//   flq6f7yk4E4fJM5XTYuZ   Michael — mature, slow
//   21m00Tcm4TlvDq8ikWAM   Rachel — féminin warm
//   MF3mGyEYCl7XYWbV9V6O   Elli — féminin jeune
//   AZnzlk1XvdvUeBnXmlld   Domi — féminin energetic
//
// L'utilisateur peut aussi passer un voice ID direct (string commençant
// par alphanumérique) au lieu d'un nom mappé.

const ELEVENLABS_VOICE_MAP = {
  // OpenAI-style names mapped to ElevenLabs voice IDs
  onyx:    'VR6AewLTigWG4xSOukaG',  // Arnold — mature, deep (fit struggle→triumph)
  alloy:   'pNInz6obpgDQGcFmaJgB',  // Adam
  echo:    'TxGEqnHWrfWFTfGW9XjX',  // Josh
  fable:   'ErXwobaYiN019PkySvjV',  // Antoni
  nova:    '21m00Tcm4TlvDq8ikWAM',  // Rachel
  shimmer: 'MF3mGyEYCl7XYWbV9V6O',  // Elli
  // Named ElevenLabs voices (case-insensitive convenience)
  adam:    'pNInz6obpgDQGcFmaJgB',
  arnold:  'VR6AewLTigWG4xSOukaG',
  antoni:  'ErXwobaYiN019PkySvjV',
  josh:    'TxGEqnHWrfWFTfGW9XjX',
  sam:     'yoZ06aMxZJJ28mfd3POQ',
  michael: 'flq6f7yk4E4fJM5XTYuZ',
  rachel:  '21m00Tcm4TlvDq8ikWAM',
  elli:    'MF3mGyEYCl7XYWbV9V6O',
  domi:    'AZnzlk1XvdvUeBnXmlld',
};

function resolveElevenLabsVoice(voice) {
  if (!voice) return ELEVENLABS_VOICE_MAP.onyx;  // Arnold default
  const lower = String(voice).toLowerCase();
  if (ELEVENLABS_VOICE_MAP[lower]) return ELEVENLABS_VOICE_MAP[lower];
  // Si pas dans la map, assume que c'est déjà un voice ID direct
  return voice;
}

async function generateViaElevenLabs({ text, outputPath, voice, apiKey, modelId, speed }) {
  const useKey = apiKey || process.env.ELEVENLABS_API_KEY;
  if (!useKey) {
    throw new Error('ELEVENLABS_API_KEY env var required. Sign up at elevenlabs.io → API Keys.');
  }

  const voiceId = resolveElevenLabsVoice(voice);
  // Turbo v2.5 : plus rapide à générer + plus naturel sur du dialogue court
  // que le multilingual classique. Supporte aussi le param `speed`.
  const model = modelId || process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
  const targetSpeed = speed || parseFloat(process.env.ELEVENLABS_SPEED || '1.15');

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': useKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: {
        // Stability bas (0.35) = plus de variation expressive, ton naturel.
        // 0.5+ = robotique/monotone. Pour pitch marketing, low stability gagne.
        stability: 0.35,
        // Similarity boost élevé pour rester fidèle au timbre de la voix.
        similarity_boost: 0.85,
        // Style >0 = plus expressif/dramatique (utile pour le narratif émotionnel).
        // ⚠️ Style >0 ralentit légèrement la génération, mais qualité ++.
        style: 0.4,
        use_speaker_boost: true,
        // Speed 1.0 = normal, 1.15 = +15% rapide (paraît plus naturel/punchy
        // pour des captions courtes, évite le ton "audiobook posé").
        speed: targetSpeed,
      },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    // 401 = clé invalide, 402 = quota dépassé (free tier 10k chars/mois)
    throw new Error(`ElevenLabs TTS ${res.status}: ${txt.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 200) {
    throw new Error(`ElevenLabs TTS: fichier trop petit (${buffer.length} bytes), probable failure`);
  }
  fs.writeFileSync(outputPath, buffer);

  // Cost tracking — ElevenLabs facture par caractère envoyé. Best-effort.
  try {
    const { recordElevenLabsCall } = require('./cost-tracker');
    recordElevenLabsCall({
      chars: (text || '').length,
      voiceId,
      notes: { model, speed: targetSpeed, bytes: buffer.length },
    });
  } catch (_) { /* swallow */ }

  return { outputPath, mimeType: 'audio/mpeg', bytes: buffer.length, provider: 'elevenlabs', voice: voiceId };
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
// Auto-detect le best provider disponible :
//   1. TTS_PROVIDER env var explicit → utilise celui-là
//   2. ELEVENLABS_API_KEY set → ElevenLabs (top quality)
//   3. OPENAI_API_KEY set → OpenAI (premium paid)
//   4. Default → Edge (qui fallback Google si Edge cassé)
function pickProvider(explicit) {
  if (explicit) return explicit;
  if (process.env.TTS_PROVIDER) return process.env.TTS_PROVIDER;
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'edge';
}

async function generateTTS(opts) {
  const provider = pickProvider(opts.provider);
  const args = { ...opts };

  if (!args.text || typeof args.text !== 'string') throw new Error('text (string) required');
  if (!args.outputPath) throw new Error('outputPath required');

  if (provider === 'elevenlabs') return generateViaElevenLabs(args);
  if (provider === 'edge') return generateViaEdge(args);
  if (provider === 'google') return generateViaGoogleTranslate(args);
  if (provider === 'openai') return generateViaOpenAI(args);

  throw new Error(`Unknown TTS_PROVIDER: '${provider}' (supported: elevenlabs, edge, google, openai)`);
}

module.exports = { generateTTS };
