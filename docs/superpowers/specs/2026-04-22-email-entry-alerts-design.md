# Email alerts on trade entry

**Date :** 2026-04-22
**Auteur :** William
**Status :** Design validé

## Problème

Le bot envoie actuellement les alertes trading (entry / fill / cancel / exit) dans un salon Discord via `sendTradingAlert` ([index.js:127](../../../index.js)). L'utilisateur veut en plus recevoir un **email** à chaque **alerte d'entrée** (nouvelle position placée) pour ne pas les rater quand il n'est pas sur Discord.

Seules les alertes d'entrée sont concernées — pas les fills, cancels, ou exits (trop de bruit).

## Objectif

Quand l'engine émet une alerte d'entrée (message préfixé `📥` dans [trading/engine.js:164](../../../trading/engine.js)), envoyer un email au destinataire configuré, **en plus** du message Discord.

Aucune alerte Discord existante ne change. L'engine n'est pas modifié.

## Non-objectifs

- Pas d'emails pour les fills, cancels, exits — explicitement hors-scope
- Pas de digest / résumé quotidien par email
- Pas de configuration par utilisateur (single-tenant, un seul destinataire)
- Pas d'interface UI pour gérer les destinataires — tout en env vars
- Pas de retry logic si Resend est down — best-effort, log et continue
- Pas de typage des alertes à la source (refactor `notify(msg)` → `notify({kind, text})`) — garde le préfixe emoji comme discriminant

## Architecture

Approche 1 validée : **notifier parallèle, filtrage dans un wrapper, engine inchangé.**

```
                    ┌──────────────────────┐
engine.notify(msg)─>│  combined notifier   │
                    │  (new, in index.js)  │
                    └──────┬────────┬──────┘
                           │        │
                           │        └──> sendEmailAlert(msg)
                           │                 │
                           │                 ├── if !msg.startsWith('📥') → return
                           │                 └── POST https://api.resend.com/emails
                           │
                           └──> sendTradingAlert(msg)  [existing, unchanged]
                                   │
                                   └──> Discord channel
```

### Composants

**`notifications/email.js` (nouveau)**

Fichier unique, ~40 lignes, pas de dépendance externe (utilise `fetch` natif Node 18+).

Export :

```js
function createEmailNotifier({ apiKey, to, from, logger = console }) {
  // Retourne async (message) => void
  // No-op silencieux si apiKey, to, ou from est falsy
  // No-op silencieux si message ne commence pas par '📥'
  // POST vers https://api.resend.com/emails
  // Body: { from, to, subject, text }
  //   subject = 1ère ligne de message, sans **, sans emojis Discord (optionnel)
  //   text    = message brut tel quel (Resend supporte les retours ligne)
  // Erreur réseau ou HTTP non-2xx → logger.error, pas de throw
}
module.exports = { createEmailNotifier };
```

**Modification `index.js`**

Avant :
```js
const tradingEngine = createTradingEngine({
  ...
  notifier: sendTradingAlert,
});
```

Après :
```js
const { createEmailNotifier } = require('./notifications/email');

const sendEmailAlert = createEmailNotifier({
  apiKey: process.env.RESEND_API_KEY,
  to:     process.env.ALERT_EMAIL_TO,
  from:   process.env.ALERT_EMAIL_FROM,
});

async function notifyAll(message) {
  await sendTradingAlert(message);       // Discord, existant
  await sendEmailAlert(message);          // Email, filtre interne sur '📥'
}

const tradingEngine = createTradingEngine({
  ...
  notifier: notifyAll,
});
```

Les deux appels sont awaités mais le wrapper n'écrase jamais une erreur de l'autre (les deux notifiers sont déjà try/catch internes).

### Flow

1. Engine détecte un signal d'entrée → `notify('📥 **MARKET ENTRY** $AAPL\n• Author: jdoe\n• Qty: 10 @ entry 150.0\n• TP: 160.0 (+6.67%)\n• SL: trailing 2% (147.0 initial)\n• Risk: 300.00')`
2. `notifyAll` appelle `sendTradingAlert` → message posté dans le salon Discord (inchangé)
3. `notifyAll` appelle `sendEmailAlert` → vérifie préfixe `📥` → match → POST Resend
4. Resend envoie l'email à `williammarchand2005@gmail.com`
5. Les autres alertes (`✅`, `❌`) passent dans `sendEmailAlert` mais retournent immédiatement (no-op)

### Format email

- **Subject :** 1ère ligne du message, avec les `**` retirés. Exemple : `📥 MARKET ENTRY $AAPL`
- **Body (text) :** message complet tel qu'envoyé à Discord, markdown `**` retiré (optionnel — Resend affiche le texte brut de toute façon). Les `•` et `\n` sont préservés.
- **Pas de HTML.** Plain text suffit, robuste aux clients email.

### Configuration (env vars)

| Variable | Exemple | Requis | Source |
|---|---|---|---|
| `RESEND_API_KEY` | `re_xxxxxxxx…` | oui | Dashboard Resend → API Keys |
| `ALERT_EMAIL_TO` | `williammarchand2005@gmail.com` | oui | — |
| `ALERT_EMAIL_FROM` | `onboarding@resend.dev` | oui | Adresse fournie par Resend (marche sans DNS) |

Toutes définies sur Railway (Variables). Si l'une est absente → `sendEmailAlert` est no-op silencieux au boot et aux appels suivants. Même pattern que `TRADING_ALERTS_CHANNEL_ID` absent aujourd'hui.

### Gestion d'erreurs

| Cas | Comportement |
|---|---|
| env var manquante | no-op silencieux, aucun log |
| message ne commence pas par `📥` | no-op silencieux, aucun log |
| `fetch` throw (réseau down) | `logger.error('[email] send failed:', err.message)`, pas de throw |
| Resend répond non-2xx | `logger.error('[email] resend non-2xx:', status, body)`, pas de throw |
| Resend répond 2xx | aucun log (pas de bruit en cas normal) |

**Principe :** une panne email **ne doit jamais bloquer** le trading ni faire crasher le process. Même principe que `sendTradingAlert` aujourd'hui.

## Tests

Nouveau fichier `notifications/email.test.js` utilisant node:test (cohérent avec le reste du repo : [trading/broker.test.js](../../../trading/broker.test.js), [trading/engine.test.js](../../../trading/engine.test.js)).

Scénarios :

1. **Happy path** : `createEmailNotifier({apiKey, to, from})` avec mock `fetch` → envoie `'📥 ENTRY $AAPL\nfoo'` → vérifie que `fetch` est appelé avec `https://api.resend.com/emails`, header `Authorization: Bearer <apiKey>`, body `{from, to, subject: '📥 ENTRY $AAPL', text: '📥 ENTRY $AAPL\nfoo'}`.
2. **Filtre non-entry** : envoie `'✅ FILLED $AAPL'` → `fetch` jamais appelé.
3. **Filtre non-entry bis** : envoie `'❌ CANCEL $AAPL'` → `fetch` jamais appelé.
4. **env var manquante** : `createEmailNotifier({apiKey: '', to: 'x', from: 'y'})` → envoie `'📥 ...'` → `fetch` jamais appelé, pas d'erreur.
5. **Erreur réseau** : mock `fetch` rejette → envoie `'📥 ...'` → `logger.error` appelé 1 fois, pas de throw.
6. **Réponse non-2xx** : mock `fetch` résout avec `{ok: false, status: 401, text: async () => 'unauthorized'}` → `logger.error` appelé avec status + body, pas de throw.

Pas de test d'intégration (pas de vrai HTTP vers Resend).

## Plan de déploiement (manuel, côté user)

1. Créer compte Resend ([resend.com](https://resend.com))
2. Générer API key
3. Railway → Variables → ajouter `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`
4. Redeploy (auto après push)
5. Vérifier : au prochain signal d'entrée, un email arrive à `williammarchand2005@gmail.com`

## Risques & mitigation

| Risque | Mitigation |
|---|---|
| Clé Resend leak | Env vars Railway, jamais commit. Rotation possible sur dashboard Resend. |
| Emails dans spam (from=`onboarding@resend.dev`) | Acceptable pour MVP. Si problème : ajouter domaine custom avec DNS. |
| Volume email excessif | Entries sont rares (quelques par jour max). Pas de rate limiting nécessaire. |
| Resend down | No-op silencieux, Discord continue. Pas de perte d'info — juste pas d'email. |
| Changement du préfixe emoji dans engine.js | Test unitaire vérifie le comportement avec `📥`. Si quelqu'un change l'emoji dans engine, le test email ne casse pas mais le filtrage silent-fail. Acceptable (engine est stable). |

## Fichiers impactés

- **Nouveau :** `notifications/email.js` (~40 lignes)
- **Nouveau :** `notifications/email.test.js` (~80 lignes)
- **Modifié :** `index.js` — ajout de 3 lignes de config + 1 wrapper `notifyAll`
- **Modifié :** `package.json` — aucune dépendance ajoutée (fetch natif)

## Ce qui n'est PAS dans le spec

- Pas de refactor de `notify(msg)` vers `notify({kind, text})` — séparé, optionnel plus tard
- Pas de UI de gestion des destinataires — env vars suffisent
- Pas de templating HTML — plain text
- Pas de digest / résumé — email live par alerte uniquement
