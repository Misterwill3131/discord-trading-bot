# Rendu des mentions de rôle Discord dans les images générées — design

## Contexte

Quand un message Discord contient une mention de rôle (`<@&ROLE_ID>`), le canvas rend la chaîne brute (`<@&1497256488274624565>`) au lieu de la version stylée que Discord affiche (`@Swing` en couleur). Les user mentions (`<@id>`) et les emojis (`<:name:id>`) sont déjà gérés ; seul le format role manque au pipeline.

Cas concret signalé par l'utilisateur : le rôle d'ID `1497256488274624565` doit s'afficher comme `@Swing` avec un pill cyan style Discord (`#3498db`).

## Architecture

Pipeline existant (`canvas/proof.js`) :
- `parseRichSegments(text)` segmente une chaîne en `{type:'text', value}` ou `{type:'emoji', name, id, animated}`.
- `measureRichWidth` calcule la largeur visuelle d'une suite de segments.
- `wrapRichText` découpe en lignes pour respecter une largeur max.
- `drawRichLine` rend une ligne sur le canvas.

On étend ce pipeline avec un troisième type de segment : `{type:'roleMention', id}`. Le parser n'effectue **aucun lookup** — il identifie seulement le format. La résolution nom + couleur se fait dans `measureRichWidth` / `drawRichLine` via un helper `getRoleStyle(id)`.

Cette séparation parser/résolution colle au pattern existant et garde le parser sans dépendance à la config.

## Composants

### 1. Config (`canvas/config.js`)

Nouvelle constante exportée à côté de `CUSTOM_AVATARS` :

```js
const CUSTOM_ROLES = {
  '1497256488274624565': { name: 'Swing', color: '#3498db' },
};
```

Format : `{ [roleId]: { name: string, color: string } }`. Une entrée par rôle. Extensible — l'utilisateur peut ajouter d'autres rôles plus tard sans toucher au reste du code.

### 2. Helper (`canvas/proof.js`)

```js
const { CUSTOM_ROLES } = require('./config');

function getRoleStyle(id) {
  return CUSTOM_ROLES[id] || null;
}
```

Centralise le lookup, retourne `null` si inconnu.

### 3. Parser étendu (`canvas/proof.js`)

`parseRichSegments` accepte désormais deux formats. Le regex unifié :

```js
const re = /<(a?):(\w+):(\d+)>|<@&(\d+)>/g;
```

Si match groupe 4 (l'ID après `<@&`) : pousser `{type:'roleMention', id}`. Sinon comportement actuel pour les emojis.

### 4. Mesure et rendu (`canvas/proof.js`)

`measureRichWidth` ajoute une branche pour `roleMention` :
- `getRoleStyle(id)` connu → mesurer `'@' + name` + 6px padding (3 de chaque côté du pill).
- Inconnu → mesurer la chaîne brute `<@&id>` comme du texte normal.

`drawRichLine` ajoute la même branche :
- Connu → dessiner un rectangle arrondi (rayon 3) rempli de `rgba(R,G,B,0.18)` (la couleur convertie en RGB), puis le texte `'@' + name` par-dessus en couleur `color`.
- Inconnu → afficher la chaîne brute en texte normal (pas de pill).

Helper interne pour convertir hex → rgba :

```js
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
```

## Data flow

```
"<@&1497256488274624565> hello"
        ↓ parseRichSegments
[{type:'roleMention', id:'1497256488274624565'},
 {type:'text', value:' hello'}]
        ↓ measureRichWidth (somme par segment)
total px  →  utilisé par wrapRichText pour le wrapping
        ↓ drawRichLine (rendu segment par segment)
canvas: pill cyan + "@Swing" + " hello"
```

## Tests

Trois tests unitaires (`canvas/proof.test.js` — fichier nouveau) :

1. **`parseRichSegments` reconnaît un role mention isolé**
   - Input : `'<@&12345>'`
   - Expected : `[{type:'roleMention', id:'12345'}]`

2. **`parseRichSegments` mixe texte + role + emoji dans le bon ordre**
   - Input : `'hi <@&12345> bye <:emo:67>'`
   - Expected : 4 segments :
     ```js
     [
       {type:'text', value:'hi '},
       {type:'roleMention', id:'12345'},
       {type:'text', value:' bye '},
       {type:'emoji', name:'emo', id:'67', animated:false},
     ]
     ```

3. **`getRoleStyle` retourne `null` pour un ID inconnu**
   - Input : `getRoleStyle('999999999999999999')`
   - Expected : `null`

Plus un test sur la config (`canvas/config.test.js` — fichier existant, on ajoute un test) :

4. **`CUSTOM_ROLES['1497256488274624565']` est correctement défini**
   - Expected : `{ name: 'Swing', color: '#3498db' }`

Pas de test E2E sur le rendu visuel (canvas → PNG → comparaison pixel) : trop coûteux, peu de valeur. La vérif visuelle est manuelle.

## Hors scope

- Résolution dynamique via `guild.roles.cache` (on hardcode dans la config — l'utilisateur a explicitement choisi cette option).
- Support de `@everyone` / `@here` (formats différents `<@here>`).
- Calcul automatique de la teinte du pill : on fixe l'opacity à 18% pour tous les rôles.
- Pluralisation ou négociation de cas (case-insensitive matching). Les role IDs sont des entiers, pas concernés.

## Vérification

- Ajouter en local un message test contenant `<@&1497256488274624565>` au formulaire `/image-generator` et vérifier que l'image générée affiche `@Swing` en pill cyan.
- Tester avec un ID inconnu : doit rendre `<@&123>` en texte brut sans crash.
- Tester wrapping : message long avec mention au milieu doit wrapper correctement (mention reste sur une seule ligne — c'est un "mot" indivisible).
