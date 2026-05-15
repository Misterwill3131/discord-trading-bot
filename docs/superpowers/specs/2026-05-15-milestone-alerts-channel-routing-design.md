# Milestone Alerts — Channel Routing — Design

**Date** : 2026-05-15
**Statut** : Draft — en attente de validation utilisateur

## Problème

La feature analyst-watchlist + milestone alerts (PR #65, mergée) poste les alertes de palier `+20/50/100…%` en **reply** sous le message d'origine dans `TRADING_CHANNEL` (= `#trading-floor`).

Pour valider la feature sans polluer le canal de production, l'opérateur veut pouvoir **router les alertes vers un canal de test dédié** pendant la phase de validation, puis revenir au mode reply en production (ou rester en mode canal dédié si préféré).

## Objectif

Ajouter un override **opt-in via une env var** qui, si elle est définie, route les milestone alerts vers un canal Discord dédié (post normal, pas reply) au lieu de reply sous le message source. Si l'env var est absente/vide, le comportement actuel (reply dans trading-floor) est préservé.

## Non-objectifs

- Pas de double-routing (canal dédié ET reply) — un seul des deux modes par tick
- Pas de migration DB — pas de nouveau champ `source_guild_id` à stocker (on récupère le guildId via un fetch supplémentaire en mode dédié)
- Pas de configuration par-ticker — le routage est global au bot
- Pas de slash command pour switcher à chaud — on switche via env var + redeploy

## Architecture

Le seul fichier touché côté logique est `discord/milestone-checker.js`. La branche `tick` qui aujourd'hui fait :

```js
const channel   = await client.channels.fetch(entry.source_channel_id);
const sourceMsg = await channel.messages.fetch(entry.source_message_id);
const reply     = await sourceMsg.reply({ content: text, allowedMentions: { parse: [] } });
db.setMilestoneAlertDiscordId(...);
db.updateWatchlistAfterAlert(...);
```

devient un `if`/`else` :

```text
                       ┌─ MILESTONE_ALERTS_CHANNEL_ID set?
                       │
              ┌────────┴────────┐
              ▼                 ▼
       Mode canal dédié   Mode reply (actuel)
       channel.send()    sourceMsg.reply()
       + lien source     (rien à changer)
              │                 │
              ▼                 ▼
       setMilestoneAlertDiscordId + updateWatchlistAfterAlert
```

Les patterns existants (mark-then-send atomique avant le post, `allowedMentions: { parse: [] }`, capture du `reply.id` pour `discord_message_id`, swallow d'erreur Discord) sont préservés à l'identique dans les deux branches.

## Configuration

### Nouvelle env var

```env
# Channel ID Discord (snowflake, 18-20 chiffres) où poster les milestone
# alerts. OPTIONNEL — si vide ou absent, comportement actuel : reply
# sous le message d'origine dans TRADING_CHANNEL.
#
# Utile pour tester la feature dans un canal séparé sans polluer
# trading-floor en prod. Le bot doit avoir la permission "Send Messages"
# dans ce canal.
MILESTONE_ALERTS_CHANNEL_ID=
```

À ajouter dans la section `# === ANALYST WATCHLIST + MILESTONE ALERTS ===` de `.env.example`.

### Comportement

| Configuration | Comportement |
|---------------|--------------|
| `MILESTONE_ALERTS_CHANNEL_ID` vide/absent | `sourceMsg.reply(text)` dans le canal source (comportement actuel — fallback) |
| `MILESTONE_ALERTS_CHANNEL_ID=<id>` | `channel.send(text + sourceLink)` dans le canal dédié — pas de reply |

## Format du message

### Mode reply (fallback, inchangé)

```
🚀 **$AAPL** hit **+20%** milestone — now $240.00 (entry $200.00, gain +20.00%) — first flagged by @alice
```

### Mode canal dédié (nouveau)

Identique au mode reply, plus une 2e ligne avec un **lien vers le message d'origine** :

```
🚀 **$AAPL** hit **+20%** milestone — now $240.00 (entry $200.00, gain +20.00%) — first flagged by @alice
📎 https://discord.com/channels/<sourceGuildId>/<sourceChannelId>/<sourceMessageId>
```

Le lien permet de cliquer pour voir le message original dans son contexte — utile pour debug en mode test et toujours utile en prod si l'opérateur reste en mode dédié.

**Récupération du `sourceGuildId`** : on fetch le source message en mode dédié aussi (même call qu'en mode reply), uniquement pour extraire `sourceMsg.guildId` (ou `sourceMsg.guild.id`). Coût : 1 appel Discord supplémentaire par milestone, négligeable (un milestone tire ~quelques fois par jour en prod). Évite de migrer la table `analyst_watchlist` pour stocker `source_guild_id`.

Si le fetch source message échoue, on **fallback gracieusement** : on poste sans le lien. C'est mieux que de rater l'alerte entièrement.

## Implémentation

Branche complète à substituer dans la fonction `tick` de `discord/milestone-checker.js`, après le `if (!fired) continue;` (mark-then-send) :

```js
const dedicatedChannelId = process.env.MILESTONE_ALERTS_CHANNEL_ID || '';

try {
  const text = buildAlertMessage({
    ticker:              entry.ticker,
    milestonePct:        target,
    initialPrice:        entry.initial_price,
    currentPrice:        quote.price,
    gainPct,
    mentionedByUsername: entry.mentioned_by_username,
  });

  let reply;
  if (dedicatedChannelId) {
    // Mode canal dédié — post normal + lien vers la source si fetch OK.
    let sourceLink = '';
    try {
      const sourceChannel = await client.channels.fetch(entry.source_channel_id);
      const sourceMsg     = await sourceChannel.messages.fetch(entry.source_message_id);
      const guildId       = sourceMsg.guildId || (sourceMsg.guild && sourceMsg.guild.id) || '';
      if (guildId) {
        sourceLink = '\n📎 https://discord.com/channels/'
          + guildId + '/' + entry.source_channel_id + '/' + entry.source_message_id;
      }
    } catch (err) {
      // Source message gone / no access — post without link, don't fail.
      console.warn('[milestone-checker] source link unavailable for '
        + entry.ticker + ': ' + err.message);
    }

    const ch = await client.channels.fetch(dedicatedChannelId);
    reply = await ch.send({
      content: text + sourceLink,
      allowedMentions: { parse: [] },
    });
  } else {
    // Mode reply — comportement actuel.
    const channel   = await client.channels.fetch(entry.source_channel_id);
    const sourceMsg = await channel.messages.fetch(entry.source_message_id);
    reply = await sourceMsg.reply({
      content: text,
      allowedMentions: { parse: [] },
    });
  }

  if (reply && reply.id && typeof db.setMilestoneAlertDiscordId === 'function') {
    try {
      db.setMilestoneAlertDiscordId({
        ticker:           entry.ticker,
        milestonePct:     target,
        discordMessageId: String(reply.id),
      });
    } catch (err) {
      console.error('[milestone-checker] failed to backfill discord_message_id: '
        + err.message);
    }
  }

  db.updateWatchlistAfterAlert({
    ticker:           entry.ticker,
    lastMilestonePct: target,
    lastAlertAt:      now,
  });
} catch (err) {
  console.error('[milestone-checker] reply failed for ' + entry.ticker
    + ': ' + err.message);
}
```

Le `mark-then-send` reste intact : si toute la branche `try` échoue (mode dédié OU mode reply), la row `milestone_alerts` reste insérée → pas de re-fire au tick suivant.

## Tests

3 nouveaux tests dans `discord/milestone-checker.test.js`, en parallèle des existants :

1. **`tick mode reply : env var vide → comportement actuel inchangé`**
   - Pas de `process.env.MILESTONE_ALERTS_CHANNEL_ID`
   - Assert : `sourceMsg.reply` appelé, `channel.send` PAS appelé
   - Format du message = canonique sans lien
   - `setMilestoneAlertDiscordId` appelé avec le reply.id

2. **`tick mode canal dédié : env var set → post + lien source`**
   - `process.env.MILESTONE_ALERTS_CHANNEL_ID = 'dedicated-id'`
   - Fake Discord client retourne un guildId pour le source message
   - Assert : `channel.send` appelé sur `dedicated-id`, contenu inclut `📎 https://discord.com/channels/<g>/<c>/<m>`
   - `setMilestoneAlertDiscordId` appelé avec l'id du post
   - Cleanup : `delete process.env.MILESTONE_ALERTS_CHANNEL_ID` en `finally`

3. **`tick mode canal dédié : source message gone → post sans lien (graceful)`**
   - Env var set + fake `channels.fetch(source)` throws
   - Assert : le post a quand même eu lieu (`channel.send` appelé), contenu n'inclut PAS de lien `📎`
   - Pas de crash, pas de re-fire

Les tests existants (RTH guard, cooldown, FMP fail, etc.) doivent continuer à passer sans modification — le `mark-then-send` et la logique de palier ne changent pas.

## Étapes manuelles (opérateur)

1. Créer un canal de test dans le serveur Discord (ex : `#milestone-test`)
2. Activer le mode développeur Discord (Settings → Advanced → Developer Mode)
3. Clic droit sur le canal → "Copier l'identifiant" — récupérer un snowflake 18-20 chiffres
4. Vérifier que le bot a la permission **Send Messages** dans ce canal
5. Set `MILESTONE_ALERTS_CHANNEL_ID=<id>` sur Railway → redeploy automatique
6. Attendre le prochain tick (jusqu'à 30 min, en RTH US 09:30–16:00 ET)
7. Vérifier dans les logs Railway : `[milestone-checker] ...` sans erreur
8. Quand un ticker watché bouge de +20%, l'alerte doit apparaître dans `#milestone-test`
9. Pour revenir au mode reply en prod : retirer l'env var sur Railway → redeploy

## Risques

| Risque | Mitigation |
|--------|------------|
| Bot pas dans le canal dédié → `channels.fetch` throws | Try/catch externe préservé → log + mark-then-send protège du re-fire |
| Source message supprimé entre seed et tick | Mode dédié : fallback graceful (post sans lien). Mode reply : reply échoue, milestone perdu (comportement actuel) |
| Channel ID malformé / d'un autre guild où le bot n'est pas | `channels.fetch` retourne null/throws → log + skip cet alert |
| Opérateur set un canal NSFW/non-text | `ch.send` throws si pas un text channel → log + skip |

Tous les risques tombent dans le `catch` externe existant — pas de nouveau code de gestion d'erreur nécessaire.

## Out of scope

- Pas de fallback automatique vers le mode reply si le canal dédié est indisponible (ce serait du double-post)
- Pas de slash command `/milestone-channel <id>` pour switcher à chaud
- Pas de validation préalable du channel ID au boot (le bot try, log si échec — c'est l'opérateur qui valide)
- Pas de filtre par-ticker du routage (tous les milestones vont au même endroit)
