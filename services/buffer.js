// ─────────────────────────────────────────────────────────────────────
// services/buffer.js — Client API Buffer pour cross-poster les vidéos
// ─────────────────────────────────────────────────────────────────────
// Permet au bot de poster les MP4 rendus sur les comptes sociaux
// connectés à Buffer (Twitter/X, TikTok, IG, LinkedIn, etc.).
//
// Setup utilisateur :
//   1. Crée un compte Buffer (https://buffer.com), connecte les
//      comptes sociaux à publier dessus (Twitter, TikTok, etc.)
//   2. Va dans Settings → Apps → Create a token (Personal Access Token)
//   3. Set env BUFFER_ACCESS_TOKEN=<token>
//   4. Get les profile_ids via GET /1/profiles.json (helper exposé ici)
//   5. Set env BUFFER_PROFILE_IDS=id1,id2,id3 (comma-separated)
//
// Sans ces 2 env vars, postToBuffer() est un no-op silencieux.
//
// Coût : Buffer Essentials $15/mois pour 3 channels, suffisant pour
// Twitter + TikTok + Instagram.
// ─────────────────────────────────────────────────────────────────────

const BUFFER_API_BASE = 'https://api.bufferapp.com/1';

function getConfig() {
  return {
    token: process.env.BUFFER_ACCESS_TOKEN || null,
    profileIds: (process.env.BUFFER_PROFILE_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  };
}

function isConfigured() {
  const cfg = getConfig();
  return !!cfg.token && cfg.profileIds.length > 0;
}

// Liste les profiles connectés au compte Buffer (Twitter, TikTok, etc.).
// Utile pour récupérer les profile_ids à mettre dans BUFFER_PROFILE_IDS.
// Renvoie [{id, service, formatted_username}, ...] ou throw si pas configuré.
async function listProfiles() {
  const cfg = getConfig();
  if (!cfg.token) throw new Error('BUFFER_ACCESS_TOKEN not set');
  const res = await fetch(`${BUFFER_API_BASE}/profiles.json?access_token=${encodeURIComponent(cfg.token)}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Buffer /profiles ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data.map(p => ({
    id: p.id,
    service: p.service,
    username: p.formatted_username || p.service_username,
  })) : [];
}

// Crée une update (post à publier maintenant ou plus tard) sur les
// profiles configurés. Le MP4 doit être à une URL publique accessible
// (Discord CDN, S3, etc.).
//
// Options :
//   text          : caption à publier (max ~280 chars pour Twitter)
//   videoUrl      : URL publique du MP4 (Discord CDN attachment URL)
//   profileIds    : override les BUFFER_PROFILE_IDS env (ex: pour cross-post
//                   seulement à Twitter mais pas TikTok)
//   shareNow      : true = publie immédiatement (default) ; false = ajoute
//                   à la queue Buffer
//
// Retourne { ok: true, bufferUpdateIds: [...] } ou throw.
async function postToBuffer({ text, videoUrl, profileIds, shareNow = true }) {
  const cfg = getConfig();
  if (!cfg.token) throw new Error('BUFFER_ACCESS_TOKEN not set');
  const ids = (Array.isArray(profileIds) && profileIds.length > 0)
    ? profileIds
    : cfg.profileIds;
  if (ids.length === 0) throw new Error('BUFFER_PROFILE_IDS not set (no profiles to post to)');
  if (!text || typeof text !== 'string') throw new Error('text required');
  if (!videoUrl || typeof videoUrl !== 'string') throw new Error('videoUrl required');

  // Buffer attend application/x-www-form-urlencoded avec arrays comme
  // profile_ids[]=id1&profile_ids[]=id2.
  const params = new URLSearchParams();
  params.append('access_token', cfg.token);
  for (const id of ids) params.append('profile_ids[]', id);
  params.append('text', text);
  params.append('media[video]', videoUrl);
  params.append('shorten', 'false');
  params.append('now', shareNow ? 'true' : 'false');

  const res = await fetch(`${BUFFER_API_BASE}/updates/create.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Buffer /updates/create ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Buffer /updates/create returned success=false: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // Buffer renvoie { success: true, buffer_count, buffer_percentage, updates: [...] }
  const updateIds = Array.isArray(data.updates) ? data.updates.map(u => u.id) : [];
  return { ok: true, bufferUpdateIds: updateIds, profileIdsPosted: ids };
}

module.exports = {
  isConfigured,
  listProfiles,
  postToBuffer,
  getConfig,
};
