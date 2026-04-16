# Design Spec — Profits review & learning

**Date :** 2026-04-16
**Scope :** Stocker tous les messages du salon Discord `#profits`, permettre à l'utilisateur de les valider/corriger, faire apprendre le bot à partir du feedback.

---

## Objectif

Actuellement, le bot ne conserve aucun message individuel du salon `#profits` : il incrémente seulement un compteur quotidien quand un message contient une image, un ticker, ou des price ranges. Cette spec ajoute :

1. **Stockage** de chaque message du salon dans un fichier journalier.
2. **UI de revue** sur la page `/profits` (panel repliable) qui liste les messages et permet de marquer chaque message "bon" ou "pas bon".
3. **Apprentissage** par phrases : corriger un message met à jour un ensemble de phrases bloquées/autorisées qui influencent la décision du bot sur les messages futurs.

Le compteur historique quotidien **n'est jamais modifié rétroactivement** : l'apprentissage s'applique uniquement aux messages futurs.

---

## 1. Stockage

### 1.1 Fichiers de messages journaliers

Un nouveau fichier par jour : `<DATA_DIR>/profit-messages-YYYY-MM-DD.json`
(suivant le même pattern que `messages-YYYY-MM-DD.json` pour le salon trading).

Format : tableau d'objets, chacun représentant un message Discord reçu dans `#profits` :

```json
{
  "id": "1713234567890-abc12",
  "ts": "2026-04-16T20:05:33.000Z",
  "author": "sanibel2026",
  "content": "AAPL 175 to 180 📈",
  "preview": "AAPL 175 to 180 📈",
  "hasImage": false,
  "hasTicker": true,
  "textCount": 1,
  "counted": true,
  "reason": "price range(s)",
  "feedback": null
}
```

**Champs :**
- `id` — identifiant unique (timestamp + random, comme `messageLog`)
- `ts` — ISO timestamp de réception
- `author` — username Discord
- `content` — texte du message
- `preview` — texte tronqué à 120 caractères pour affichage
- `hasImage` — booléen, message avec attachement image
- `hasTicker` — booléen, un ticker détecté dans le texte
- `textCount` — nombre de price ranges détectés (résultat de `countProfitEntries`)
- `counted` — booléen, le bot a-t-il incrémenté le compteur pour ce message
- `reason` — pourquoi le bot a décidé : `image`, `price range(s)`, `ticker`, `ignored`, `learned-blocked`, `learned-allowed`
- `feedback` — `null` par défaut, ou `"good"` / `"bad"` si l'utilisateur l'a marqué

### 1.2 Fichier global de filtres profits

Un nouveau fichier unique : `<DATA_DIR>/profit-filters.json`
(séparé du fichier `custom-filters.json` utilisé par le trading).

Format :
```json
{ "blocked": ["test message", "just chatting"], "allowed": ["profit +50$"] }
```

**Isolation :** les filtres profits et trading sont indépendants — les phrases apprises pour un salon ne s'appliquent pas à l'autre.

---

## 2. Logique bot (handler `messageCreate` #profits)

Logique mise à jour du handler Discord qui écoute `#profits` :

```
Pour chaque message reçu dans #profits (non-bot) :
  1. Calculer hasImage, hasTicker, textCount (comme actuellement)
  2. Vérifier profitFilters.blocked :
     - Si le message contient (case-insensitive substring) une phrase bloquée
       → counted = false, reason = "learned-blocked"
  3. Sinon, vérifier profitFilters.allowed :
     - Si match → counted = true, reason = "learned-allowed"
  4. Sinon, logique actuelle :
     - Si hasImage OU hasTicker OU textCount > 0 → counted = true,
       reason ∈ {"image", "price range(s)", "ticker"}
     - Sinon → counted = false, reason = "ignored"
  5. Stocker le message (TOUJOURS, même ignoré) dans profit-messages-YYYY-MM-DD.json
     avec feedback = null
  6. Si counted, appeler addProfitMessage(content) comme actuellement
     (incrément + milestones inchangés)
```

**Pattern-matching** : substring case-insensitive — `content.toLowerCase().includes(phrase.toLowerCase())`. Identique au comportement de `customFilters` trading.

**Précédence learned-blocked > learned-allowed > règles par défaut** — permet à l'utilisateur d'annuler un ajout automatique par une règle d'exclusion.

---

## 3. UI — panel repliable sur `/profits`

Nouveau panel ajouté en bas de la page `/profits`, après les cards existantes. Style identique au panel `#authors-panel` du Dashboard (fond glass, collapsible).

### 3.1 Structure

```
┌─ 📨 Messages #profits  ▼ ─────────────────────────────────┐
│                                                            │
│  Date : [2026-04-16 ▼]    Filtre : [Tous] [Comptés] [Ignorés] [Marqués] │
│                                                            │
│  ┌─ Liste (50 par page, tri récent → ancien) ────────────┐│
│  │ 20:05  sanibel2026   ✅ Compté (price range)          ││
│  │        "AAPL 175 to 180 📈"          [❌ Pas un profit]││
│  │                                                        ││
│  │ 20:03  trader_xyz    ⚪ Ignoré                         ││
│  │        "lol nice"                    [✅ C'est un profit]││
│  │                                                        ││
│  │ 19:58  viking9496    ✅ Compté (image)                 ││
│  │        [image]                feedback: ❌ pas un profit││
│  │                                                        ││
│  └────────────────────────────────────────────────────────┘│
│                                                            │
│  [Page précédente]  Page 1/3  [Page suivante]             │
│                                                            │
│  ── Phrases apprises ────────────────────────────────────  │
│  Bloquées (3) : [test] [lol] [chatting] ✕                 │
│  Autorisées (1) : [profit +] ✕                            │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Comportement

- Panel **fermé par défaut**, lazy-load des données à l'ouverture.
- **Sélecteur de date** : jour courant par défaut ; permet de revoir les jours passés disponibles dans `DATA_DIR`.
- **Filtre** : `Tous` / `Comptés` (seulement `counted=true`) / `Ignorés` (`counted=false`) / `Marqués` (seulement ceux avec `feedback !== null`).
- **Pagination** : 50 messages par page, tri récent → ancien.
- **Pour chaque message**, afficher un seul bouton d'action selon l'état :
  - Si `counted = true` → bouton **❌ Pas un profit** (ajoute la phrase à `profitFilters.blocked`, set `feedback = "bad"`)
  - Si `counted = false` → bouton **✅ C'est un profit** (ajoute la phrase à `profitFilters.allowed`, set `feedback = "good"`)
- **Après clic** : bouton disparaît, message grisé (`opacity: 0.5`), badge "feedback: ✅/❌" affiché, filtres rechargés. **Compteur quotidien non modifié.**
- **Section "Phrases apprises"** sous la liste : deux lignes (bloquées, autorisées) avec tags cliquables (bouton ✕ pour supprimer une règle).

### 3.3 Déduplication des phrases apprises

Quand l'utilisateur clique sur un bouton de feedback, la phrase ajoutée aux filtres est la version **tronquée à 120 caractères** du contenu (identique à `preview`). Cela évite de stocker des phrases gigantesques et augmente la probabilité de match sur des messages similaires.

Si la même phrase existe déjà dans la liste cible → noop (pas de doublon).

---

## 4. API endpoints

### 4.1 `GET /api/profit-messages?date=YYYY-MM-DD&filter=all|counted|ignored|flagged&page=1`

**Auth :** `requireAuth`.

**Réponse :**
```json
{
  "date": "2026-04-16",
  "total": 137,
  "page": 1,
  "pageSize": 50,
  "messages": [ /* array d'entrées profit-message tronqué à la page */ ]
}
```

Source des données : lit `profit-messages-YYYY-MM-DD.json` depuis `DATA_DIR`. Tri récent → ancien avant pagination. Si fichier absent, renvoyer `total: 0, messages: []`.

### 4.2 `POST /api/profit-feedback`

**Auth :** `requireAuth`.

**Body :**
```json
{
  "id": "1713234567890-abc12",
  "content": "AAPL 175 to 180 📈",
  "action": "block" | "allow" | "unblock-blocked" | "unblock-allowed"
}
```

**Actions :**
- `block` — ajoute `content` tronqué à 120 char à `profitFilters.blocked` et met `feedback = "bad"` sur le message d'id `id`.
- `allow` — ajoute à `profitFilters.allowed` et met `feedback = "good"`.
- `unblock-blocked` — retire `content` de `profitFilters.blocked` (utilisé par le clic ✕ sur un tag).
- `unblock-allowed` — retire de `profitFilters.allowed`.

**Réponse :**
```json
{ "ok": true, "profitFilters": { "blocked": [...], "allowed": [...] } }
```

**Note :** l'action `block`/`allow` ne modifie PAS le compteur quotidien. Elle update le message (`feedback`) et le fichier `profit-filters.json`.

### 4.3 `GET /api/profit-filters`

**Auth :** `requireAuth`.

**Réponse :** contenu actuel de `profit-filters.json`.

---

## 5. Implémentation

### 5.1 Fichiers concernés

Tout dans `index.js` :
- Constantes et helpers : `loadProfitMessages(dateKey)`, `saveProfitMessages(dateKey, msgs)`, `loadProfitFilters()`, `saveProfitFilters()`.
- Handler Discord : modifier la fonction existante qui écoute `#profits` (~ligne 4574).
- API : ajouter les 3 nouveaux endpoints dans la zone des routes `/api/*`.
- UI : étendre `PROFITS_PAGE_HTML` avec le panel repliable et le JS associé.

### 5.2 Ce qui ne change pas

- Compteur quotidien et milestones — logique `addProfitMessage` intacte.
- Format `profits-YYYY-MM-DD.json` (inchangé — ne contient que `{count, milestones}`).
- Fichier global `custom-filters.json` — séparé, non touché.
- Page `/profits` existante (graphe, stat-boxes, modifier count, bot silent) — tout reste.

---

## Hors scope

- Correction rétroactive du compteur quand un message est marqué "pas bon" (explicitement refusé en Q4).
- Apprentissage par auteur (choix Q3 = phrases uniquement).
- Suppression complète d'un message du stockage (pas demandé).
- Nouvelle page dédiée — c'est un panel sur `/profits` (Q5).
- Notifications temps réel via SSE — la revue est manuelle/async.
- Pagination infinite-scroll — pagination classique par boutons.
