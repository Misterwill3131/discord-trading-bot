#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// video/scripts/test-tts-voice.js — Diagnostic ElevenLabs voice access
// ─────────────────────────────────────────────────────────────────────
// Tente un appel TTS sur le voice configuré dans le template et affiche
// l'erreur exacte si ça échoue.
//
// Usage :
//   cd video && node scripts/test-tts-voice.js
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.local'),
  override: true,
  quiet: true,
});

const fs = require('fs');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'brand-story-default.json'), 'utf8'));
const voiceId = process.env.TTS_VOICE || TEMPLATE.props?.voice || 'VR6AewLTigWG4xSOukaG';
const apiKey = process.env.ELEVENLABS_API_KEY;

console.log('─── ElevenLabs TTS diagnostic ───');
console.log('Voice ID:', voiceId);
console.log('API key set:', !!apiKey, apiKey ? `(${apiKey.slice(0, 8)}…${apiKey.slice(-4)})` : '');

if (!apiKey) {
  console.error('❌ ELEVENLABS_API_KEY manquant dans video/.env.local');
  process.exit(1);
}

(async () => {
  // 1. Liste les voices accessibles via API (non-fatal si permission manquante)
  console.log('\n[1] Fetching /v1/voices to see what your account has access to…');
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`  ⚠ /v1/voices ${res.status}: ${txt.slice(0, 200)}`);
      console.warn('  (non-fatal — on continue avec le test TTS direct)');
      throw new Error('skip-list');
    }
    const data = await res.json();
    const voices = data.voices || [];
    console.log(`  → ${voices.length} voices accessible`);
    const match = voices.find(v => v.voice_id === voiceId);
    if (match) {
      console.log(`  ✓ Voice ${voiceId} EST dans ton compte : "${match.name}"`);
    } else {
      console.warn(`  ⚠ Voice ${voiceId} N'EST PAS dans ton compte.`);
      console.log('  Voices disponibles :');
      voices.slice(0, 10).forEach(v => console.log(`     - ${v.voice_id}  ${v.name}`));
    }
  } catch (err) {
    if (err.message !== 'skip-list') {
      console.error(`❌ /v1/voices failed: ${err.message}`);
    }
  }

  // 2. Tente un mini TTS avec le voice ID
  console.log('\n[2] Trying TTS call with voice ' + voiceId + '…');
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: 'Test audio.',
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.35, similarity_boost: 0.85, style: 0.4 },
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`❌ TTS ${res.status}: ${txt.slice(0, 500)}`);
      console.log('\n→ Solution :');
      if (res.status === 401) console.log('   Clé API invalide ou révoquée.');
      else if (res.status === 402) console.log('   Quota dépassé (free tier 10k chars/mois).');
      else if (res.status === 400 || res.status === 404) {
        console.log('   Ce voice ID n\'est pas accessible. Soit :');
        console.log('   - Va sur https://elevenlabs.io/app/voice-library, clique sur la voix,');
        console.log('     puis "Add to my voices" pour l\'ajouter à ton compte');
        console.log('   - OU utilise un voice ID déjà dans ton compte (cf liste ci-dessus)');
      }
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`  ✓ TTS OK — ${(buf.length / 1024).toFixed(1)} KB audio généré`);
    console.log('\n→ Voice fonctionne. Si la vidéo est encore silencieuse, vérifie autre chose.');
  } catch (err) {
    console.error(`❌ TTS request failed: ${err.message}`);
  }
})();
