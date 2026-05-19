// ─────────────────────────────────────────────────────────────────────
// social/habs/discord-notify.js — Failure notifier vers canal admin
// ─────────────────────────────────────────────────────────────────────
// Thin wrapper autour de client.channels.fetch(...).send(...). Pas de
// retry — si Discord est down, on log et continue. Pas de bloquant.
// ─────────────────────────────────────────────────────────────────────

async function notifyAdmin(client, channelId, message) {
  if (!channelId) {
    console.error('[habs] admin notify (no channel configured):', message);
    return;
  }
  if (!client || typeof client.channels?.fetch !== 'function') {
    console.error('[habs] admin notify (no Discord client):', message);
    return;
  }
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && typeof ch.send === 'function') {
      await ch.send(message);
    }
  } catch (err) {
    console.error('[habs] admin notify failed:', err.message, '|', message);
  }
}

module.exports = { notifyAdmin };
