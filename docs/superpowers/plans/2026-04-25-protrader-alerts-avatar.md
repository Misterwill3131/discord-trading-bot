# Avatar manquant pour "Protrader Alerts" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brancher le fichier `Protrader Alerts_avatar.png` qui traîne orphelin dans `/avatar/` sur le username Discord legacy "Protrader Alerts" pour que ses messages soient générés avec son vrai avatar au lieu des initiales "PR".

**Architecture:** Une seule entrée à ajouter dans la table `CUSTOM_AVATARS` (`canvas/config.js`). Le code de rendu (`canvas/proof.js`) consomme déjà cette table sans modification. Pas de changement aux aliases — le username legacy "Protrader Alerts" arrive tel quel dans la table.

**Tech Stack:** Node.js, `node:test`, `@napi-rs/canvas`, mapping objet JS.

---

### Task 1 : Ajouter le mapping "Protrader Alerts" → avatar PNG

**Files:**
- Create: `canvas/config.test.js`
- Modify: `canvas/config.js:42` (ajout d'une ligne dans `CUSTOM_AVATARS`)

- [ ] **Step 1: Écrire le test qui échoue**

Crée le fichier `canvas/config.test.js` avec ce contenu exact :

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { CUSTOM_AVATARS } = require('./config');

test('CUSTOM_AVATARS["Protrader Alerts"] points to an existing PNG', () => {
  const p = CUSTOM_AVATARS['Protrader Alerts'];
  assert.ok(p, 'CUSTOM_AVATARS["Protrader Alerts"] is undefined — mapping is missing');
  assert.ok(p.endsWith('Protrader Alerts_avatar.png'),
    'Mapping should point to Protrader Alerts_avatar.png, got: ' + p);
  assert.ok(fs.existsSync(p),
    'Avatar file does not exist on disk: ' + p);
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `node --test canvas/config.test.js`

Expected: FAIL avec le message `CUSTOM_AVATARS["Protrader Alerts"] is undefined — mapping is missing`. La première assertion (`assert.ok(p, ...)`) tombe parce que la clé n'existe pas encore.

- [ ] **Step 3: Ajouter la ligne dans `CUSTOM_AVATARS`**

Dans `canvas/config.js`, à la fin de l'objet `CUSTOM_AVATARS` (juste après la ligne `'Legacy Trading': AV('Legacy Trading_avatar.png'),` à la ligne 42), insère la ligne suivante :

```js
  'Protrader Alerts': AV('Protrader Alerts_avatar.png'),
```

Le bloc final doit ressembler à ça :

```js
const CUSTOM_AVATARS = {
  'Z':              AV('z-avatar.jpg'),
  'AR':             AV('AR_AVATAR.png'),
  'beppels':        AV('beppels_avatar.png'),
  'L':              AV('L_avatar.png'),
  'RF':             AV('RF_AVATAR.png'),
  'Viking':         AV('Viking_avatar.png'),
  'ProTrader':      AV('ProTrader_avatar.png'),
  'Gaz':            AV('Gaz_avatar.png'),
  'CapitalGains':   AV('CapitalGains_avatar.png'),
  'THE REVERSAL':   AV('THE REVERSAL_avatar.png'),
  'kestrel':        AV('kestrel_avatar.png'),
  'the1albatross':  AV('the1albatross_avatar.png'),
  'Bora':           AV('Bora_avatar.png'),
  'Michael':        AV('Michael_avatar.png'),
  'thedutchess1':   AV('thedutchess1_avatar.png'),
  'Legacy Trading': AV('Legacy Trading_avatar.png'),
  'Protrader Alerts': AV('Protrader Alerts_avatar.png'),
};
```

- [ ] **Step 4: Relancer le test pour vérifier qu'il passe**

Run: `node --test canvas/config.test.js`

Expected: PASS — la clé existe, le chemin se termine par `Protrader Alerts_avatar.png`, et le fichier existe sur disque.

- [ ] **Step 5: Lancer toute la suite de tests pour vérifier qu'on n'a rien cassé**

Run: `npm test`

Expected: tous les tests passent (la suite existante + le nouveau test). Si un test échoue qui n'est pas lié à ce changement, c'est un faux positif pré-existant — vérifier avec `git stash` que l'échec existait déjà.

- [ ] **Step 6: Commit**

```bash
git add canvas/config.js canvas/config.test.js
git commit -m "fix: avatar manquant pour Protrader Alerts

Le fichier Protrader Alerts_avatar.png existait dans /avatar/ mais
n'était pas branché dans CUSTOM_AVATARS. Le bot retombait sur les
initiales PR pour cet auteur. Une seule ligne à ajouter — le username
Discord legacy 'Protrader Alerts' (avec espace, casse préservée) est
déjà passé tel quel à la table par message.author.username.

Test ajouté qui vérifie la présence de la clé + l'existence du fichier
sur disque pour prévenir une régression silencieuse."
```

---

## Vérification end-to-end (manuelle, après merge en prod)

Une fois mergé et redéployé sur Railway :

1. Attendre un nouveau message de Protrader Alerts dans le serveur Discord (ou demander à un admin de poster un message test).
2. Aller sur `/gallery` du dashboard et confirmer que la nouvelle image générée affiche l'avatar custom (pas les initiales "PR" sur fond bleu).
3. Si la nouvelle image montre toujours "PR" : c'est probablement que le bot tourne encore l'ancien build — forcer un redeploy.

Les anciennes images générées avant le fix restent inchangées (elles sont stockées en mémoire/disque telles quelles). C'est attendu.
