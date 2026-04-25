# Avatar manquant pour "Protrader Alerts" — design

## Contexte

Sur le serveur Discord, l'auteur **Protrader Alerts#9298** s'affiche avec ses initiales "PR" (cercle bleu Discord par défaut) au lieu de son avatar custom dans toutes les images générées par le bot (signaux, proofs, galerie, dashboard).

Cause exacte : le fichier `avatar/Protrader Alerts_avatar.png` existe sur disque, mais la clé `'Protrader Alerts'` n'est pas dans la table `CUSTOM_AVATARS` de [canvas/config.js](canvas/config.js). La fonction `drawAvatar()` retombe alors sur les initiales (voir `canvas/proof.js:181-204` et `canvas/proof.js:331-356`).

## Audit complet

Avant de fixer, audit structurel des trois sources :
- 17 fichiers `*_avatar.png` dans `/avatar/` (en excluant `tag_boom.png` et `great_call.png` qui ne sont pas des avatars).
- 16 entrées dans `CUSTOM_AVATARS` (`canvas/config.js`).
- 17 entrées dans `AUTHOR_ALIASES` (`utils/authors.js`).

Résultats :
- **1 fichier orphelin** : `Protrader Alerts_avatar.png` n'est référencé par aucune clé.
- **0 entrée morte** dans `CUSTOM_AVATARS` (tous les chemins pointent vers un fichier qui existe).
- **0 alias cassé** (toutes les valeurs de `AUTHOR_ALIASES` correspondent à une clé valide de `CUSTOM_AVATARS`).
- **0 auteur cassé** parmi les 6 auteurs distincts du backup DB local — mais cette DB est un snapshot ancien, donc non exhaustif.

Conclusion : un seul cas à corriger.

## Fix

Ajouter une ligne dans `CUSTOM_AVATARS` à [canvas/config.js:42](canvas/config.js):

```js
'Protrader Alerts': AV('Protrader Alerts_avatar.png'),
```

Pas besoin de toucher `AUTHOR_ALIASES` : le username Discord legacy "Protrader Alerts" (avec espace, casse préservée — confirmée par `message.author.username` à [discord/handler.js:163](discord/handler.js:163)) est déjà passé tel quel à `CUSTOM_AVATARS`. On lui fournit juste la clé qui manquait.

## Hors scope

- Pas de warning au démarrage du bot (rejeté par l'utilisateur — option B).
- Pas de script d'audit dédié (rejeté — option C).
- Pas de page de gestion d'avatars sur le dashboard.
- Pas de recherche insensible à la casse dans `CUSTOM_AVATARS`.

Si un autre auteur casse plus tard, ce design pourra être ré-ouvert.

## Vérification

Après l'ajout :
- Rebooter le bot (changement dans `canvas/config.js` → recharge module au prochain démarrage).
- Le prochain message de Protrader Alerts dans Discord doit générer une image avec l'avatar custom au lieu des initiales "PR".
- Sur le dashboard `/gallery`, les anciennes images générées avec les initiales restent telles quelles (elles sont en RAM/disque) ; seules les nouvelles images bénéficient du fix.
