# Rendu des mentions de rôle Discord — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire en sorte qu'une mention de rôle Discord (`<@&ID>`) dans le contenu d'un message soit rendue par le canvas comme un pill cyan stylé "@Swing" au lieu de la chaîne brute.

**Architecture:** Étendre la table de config (`canvas/config.js`) avec un mapping `CUSTOM_ROLES`, puis étendre le pipeline rich-text de `canvas/proof.js` (parser + helpers + measure/draw) pour reconnaître et rendre le nouveau format `<@&ID>` comme un nouveau type de segment `roleMention`. Le parser n'effectue pas de lookup ; il identifie seulement le format. La résolution nom+couleur se fait au moment du rendu via un helper `getRoleStyle(id)`.

**Tech Stack:** Node.js, `@napi-rs/canvas`, `node:test`.

---

### Task 1 : Ajouter `CUSTOM_ROLES` à la config

**Files:**
- Modify: `canvas/config.js` (ajout d'un nouvel objet exporté)
- Modify: `canvas/config.test.js` (ajout d'un test)

- [ ] **Step 1: Écrire le test qui échoue**

Ouvre `canvas/config.test.js` et ajoute ce test à la fin du fichier (après le dernier `test(...)` existant) :

```js
test('CUSTOM_ROLES["1497256488274624565"] correspond au rôle Swing', () => {
  const { CUSTOM_ROLES } = require('./config');
  const role = CUSTOM_ROLES['1497256488274624565'];
  assert.ok(role, 'CUSTOM_ROLES["1497256488274624565"] is undefined');
  assert.strictEqual(role.name, 'Swing');
  assert.strictEqual(role.color, '#3498db');
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `node --test canvas/config.test.js`

Expected: 1 fail, 1 pass (le test existant pour Protrader Alerts passe ; le nouveau échoue avec `CUSTOM_ROLES` undefined ou la propriété inexistante).

- [ ] **Step 3: Ajouter `CUSTOM_ROLES` dans `canvas/config.js`**

Dans `canvas/config.js`, juste après la fermeture de l'objet `CUSTOM_AVATARS` (ligne `};` qui termine la table CUSTOM_AVATARS) et avant le commentaire `// Emojis personnalisés...`, insère :

```js
// Rôles personnalisés (id Discord → nom affiché + couleur). Si présent
// dans cette table, une mention <@&id> est rendue comme un pill cyan
// "@nom". Sinon la chaîne brute reste affichée.
const CUSTOM_ROLES = {
  '1497256488274624565': { name: 'Swing', color: '#3498db' },
};
```

Et à la fin du fichier, modifie l'export pour ajouter `CUSTOM_ROLES` :

```js
module.exports = { CONFIG, FONT, CUSTOM_AVATARS, CUSTOM_ROLES, CUSTOM_EMOJIS };
```

- [ ] **Step 4: Relancer le test pour vérifier qu'il passe**

Run: `node --test canvas/config.test.js`

Expected: 2 pass, 0 fail.

- [ ] **Step 5: Lancer toute la suite pour s'assurer qu'on n'a rien cassé**

Run: `npm test`

Expected: tous les tests passent (existants + nouveau).

- [ ] **Step 6: Commit**

```bash
git add canvas/config.js canvas/config.test.js
git commit -m "feat: ajouter CUSTOM_ROLES à canvas/config.js

Première entrée : Swing (id 1497256488274624565) avec couleur
Discord blue #3498db. Table extensible — ajouter d'autres rôles
en suivant le même format { name, color }."
```

---

### Task 2 : Étendre `parseRichSegments` pour reconnaître `<@&id>`

**Files:**
- Create: `canvas/proof.test.js`
- Modify: `canvas/proof.js` (regex de `parseRichSegments` + nouvel export)

- [ ] **Step 1: Créer le fichier de test avec deux tests qui échouent**

Crée `canvas/proof.test.js` :

```js
const { test } = require('node:test');
const assert = require('node:assert');

const { parseRichSegments } = require('./proof');

test('parseRichSegments reconnaît un role mention isolé', () => {
  const segs = parseRichSegments('<@&12345>');
  assert.deepStrictEqual(segs, [
    { type: 'roleMention', id: '12345' },
  ]);
});

test('parseRichSegments mixe text + roleMention + text + emoji', () => {
  const segs = parseRichSegments('hi <@&12345> bye <:emo:67>');
  assert.deepStrictEqual(segs, [
    { type: 'text', value: 'hi ' },
    { type: 'roleMention', id: '12345' },
    { type: 'text', value: ' bye ' },
    { type: 'emoji', name: 'emo', id: '67', animated: false },
  ]);
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `node --test canvas/proof.test.js`

Expected: les deux tests échouent. Le premier crash avec `parseRichSegments is not a function` (la fonction n'est pas exportée).

- [ ] **Step 3: Exporter `parseRichSegments` depuis `canvas/proof.js`**

À la fin de `canvas/proof.js`, modifie le `module.exports` pour ajouter `parseRichSegments` :

```js
module.exports = {
  generateImage,
  drawMessageBlock,
  generateProofImage,
  setDiscordClient,
  parseRichSegments,
  PROOF_LAYOUT,
};
```

- [ ] **Step 4: Relancer le test — il doit toujours échouer mais différemment**

Run: `node --test canvas/proof.test.js`

Expected: test 1 échoue parce que `parseRichSegments('<@&12345>')` retourne actuellement `[{type:'text', value:'<@&12345>'}]` au lieu du segment `roleMention`. Le regex actuel ne capture pas ce format.

- [ ] **Step 5: Étendre le regex et la création de segment dans `parseRichSegments`**

Dans `canvas/proof.js`, remplace la fonction `parseRichSegments` actuelle (autour de la ligne 71-82) par cette version :

```js
// Segmente un texte en {text}, {emoji}, ou {roleMention}.
// Reconnaît :
//   • <:name:id>  ou  <a:name:id>   → emoji custom Discord
//   • <@&id>                         → mention de rôle Discord
function parseRichSegments(text) {
  const segs = [];
  const re = /<(a?):(\w+):(\d+)>|<@&(\d+)>/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', value: text.slice(last, m.index) });
    if (m[4] !== undefined) {
      segs.push({ type: 'roleMention', id: m[4] });
    } else {
      segs.push({ type: 'emoji', animated: m[1] === 'a', name: m[2], id: m[3] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', value: text.slice(last) });
  return segs.length ? segs : [{ type: 'text', value: text }];
}
```

- [ ] **Step 6: Relancer le test pour vérifier qu'il passe**

Run: `node --test canvas/proof.test.js`

Expected: 2 pass, 0 fail.

- [ ] **Step 7: Lancer toute la suite**

Run: `npm test`

Expected: tous les tests passent.

- [ ] **Step 8: Commit**

```bash
git add canvas/proof.js canvas/proof.test.js
git commit -m "feat: parseRichSegments reconnaît <@&id> (role mentions)

Nouveau type de segment 'roleMention' produit par le parser quand
il rencontre <@&ID>. Le parser reste pur : il identifie seulement
le format, sans lookup dans CUSTOM_ROLES (la résolution se fait
au moment du rendu)."
```

---

### Task 3 : Rendu visuel — `hexToRgba`, `getRoleStyle`, branches measure/draw

**Files:**
- Modify: `canvas/proof.js` (helpers + branches dans `measureRichWidth` et `drawRichLine`)
- Modify: `canvas/proof.test.js` (tests pour `hexToRgba`, `getRoleStyle`, smoke test)

- [ ] **Step 1: Ajouter trois tests qui échouent**

Ajoute ces tests à la fin de `canvas/proof.test.js` :

```js
const { hexToRgba, getRoleStyle, generateImage } = require('./proof');

test('hexToRgba convertit #3498db avec opacity 0.18', () => {
  assert.strictEqual(hexToRgba('#3498db', 0.18), 'rgba(52, 152, 219, 0.18)');
});

test('getRoleStyle retourne le rôle pour un id connu', () => {
  const r = getRoleStyle('1497256488274624565');
  assert.deepStrictEqual(r, { name: 'Swing', color: '#3498db' });
});

test('getRoleStyle retourne null pour un id inconnu', () => {
  assert.strictEqual(getRoleStyle('999999999999999999'), null);
});

test('generateImage produit un Buffer PNG quand le contenu inclut une role mention', async () => {
  const buf = await generateImage('Bora', 'check this <@&1497256488274624565> setup', new Date().toISOString());
  assert.ok(Buffer.isBuffer(buf), 'expected a Buffer');
  assert.ok(buf.length > 100, 'expected non-trivial PNG, got ' + buf.length + ' bytes');
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `node --test canvas/proof.test.js`

Expected: les 3 nouveaux tests `hexToRgba` / `getRoleStyle` échouent (`is not a function`). Le smoke test `generateImage` peut passer ou échouer selon comment l'emoji branch traite un `roleMention` segment (probablement passe sans crash mais sortie visuelle incorrecte).

- [ ] **Step 3: Implémenter `hexToRgba` et `getRoleStyle` dans `canvas/proof.js`**

Dans `canvas/proof.js`, juste après l'import de config (autour de la ligne 23, après `const { CONFIG, FONT, CUSTOM_AVATARS, CUSTOM_EMOJIS } = require('./config');`), modifie l'import pour inclure `CUSTOM_ROLES` :

```js
const { CONFIG, FONT, CUSTOM_AVATARS, CUSTOM_ROLES, CUSTOM_EMOJIS } = require('./config');
```

Puis ajoute ces deux helpers juste après les imports (avant la définition de `_discordClient` autour de la ligne 34) :

```js
// Lookup couleur+nom d'un rôle Discord par son id.
// Retourne null si non trouvé — le rendu retombe alors sur la chaîne brute.
function getRoleStyle(id) {
  return CUSTOM_ROLES[id] || null;
}

// Convertit un hex "#rrggbb" en string CSS "rgba(r, g, b, alpha)".
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
}
```

Modifie aussi le `module.exports` à la fin du fichier pour exporter ces deux helpers :

```js
module.exports = {
  generateImage,
  drawMessageBlock,
  generateProofImage,
  setDiscordClient,
  parseRichSegments,
  getRoleStyle,
  hexToRgba,
  PROOF_LAYOUT,
};
```

- [ ] **Step 4: Relancer les tests — `hexToRgba` et `getRoleStyle` doivent passer**

Run: `node --test canvas/proof.test.js`

Expected: les tests `hexToRgba`, `getRoleStyle (connu)`, `getRoleStyle (inconnu)` passent. Le smoke test `generateImage` passe (pas de crash).

- [ ] **Step 5: Étendre `measureRichWidth` pour gérer les role mentions**

Dans `canvas/proof.js`, remplace la fonction `measureRichWidth` actuelle (autour de la ligne 84-90) par :

```js
function measureRichWidth(ctx, text, emojiSize) {
  let w = 0;
  for (const seg of parseRichSegments(text)) {
    if (seg.type === 'text') {
      w += ctx.measureText(seg.value).width;
    } else if (seg.type === 'emoji') {
      w += emojiSize + 2;
    } else if (seg.type === 'roleMention') {
      const style = getRoleStyle(seg.id);
      if (style) {
        // Pill : '@' + name + 6px de padding total (3 de chaque côté).
        w += ctx.measureText('@' + style.name).width + 6;
      } else {
        // Inconnu : on tombe sur le rendu brut <@&id>.
        w += ctx.measureText('<@&' + seg.id + '>').width;
      }
    }
  }
  return w;
}
```

- [ ] **Step 6: Étendre `drawRichLine` pour rendre le pill**

Dans `canvas/proof.js`, remplace la fonction `drawRichLine` actuelle (autour de la ligne 111-137) par :

```js
async function drawRichLine(ctx, text, x, y, fontSize) {
  const emojiSize = Math.round(fontSize * 1.15);
  let cx = x;
  for (const seg of parseRichSegments(text)) {
    if (seg.type === 'text') {
      if (seg.value) {
        ctx.fillText(seg.value, cx, y);
        cx += ctx.measureText(seg.value).width;
      }
    } else if (seg.type === 'emoji') {
      const localPath = CUSTOM_EMOJIS[seg.name];
      const src = localPath || (seg.animated
        ? 'https://cdn.discordapp.com/emojis/' + seg.id + '.webp?size=32&animated=true'
        : 'https://cdn.discordapp.com/emojis/' + seg.id + '.png?size=32');
      try {
        const img = await loadImage(src);
        ctx.drawImage(img, cx, y - emojiSize * 0.82, emojiSize, emojiSize);
        cx += emojiSize + 2;
      } catch (e) {
        ctx.fillText(':' + seg.name + ':', cx, y);
        cx += ctx.measureText(':' + seg.name + ':').width;
      }
    } else if (seg.type === 'roleMention') {
      const style = getRoleStyle(seg.id);
      if (style) {
        const label = '@' + style.name;
        const labelW = ctx.measureText(label).width;
        const pillH = fontSize + 4;
        const pillY = y - fontSize * 0.85;
        // Fond pill (couleur du rôle à 18% d'opacity).
        ctx.fillStyle = hexToRgba(style.color, 0.18);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(cx, pillY, labelW + 6, pillH, 3);
        } else {
          // Fallback si roundRect n'est pas dispo dans la version de canvas.
          ctx.rect(cx, pillY, labelW + 6, pillH);
        }
        ctx.fill();
        // Texte du label par-dessus.
        const prevFill = ctx.fillStyle;
        ctx.fillStyle = style.color;
        ctx.fillText(label, cx + 3, y);
        ctx.fillStyle = prevFill;
        cx += labelW + 6;
      } else {
        const raw = '<@&' + seg.id + '>';
        ctx.fillText(raw, cx, y);
        cx += ctx.measureText(raw).width;
      }
    }
  }
}
```

- [ ] **Step 7: Relancer la suite complète pour vérifier le smoke test et le reste**

Run: `npm test`

Expected: tous les tests passent. Le smoke test `generateImage produit un Buffer PNG quand le contenu inclut une role mention` valide que la chaîne complète parse → measure → draw fonctionne sans crash.

- [ ] **Step 8: Vérification visuelle manuelle**

Lance le serveur en local :

```bash
npm start
```

Ouvre `http://localhost:3000/image-generator` (ou le port configuré). Dans le formulaire :
- Auteur : `Protrader Alerts`
- Message : `<@&1497256488274624565> $TSLA 150-155 entry long`
- Heure : laisse l'heure courante

Clique "Générer l'image". L'aperçu doit montrer :
- Avatar Protrader Alerts (le fix précédent fonctionne)
- Le message avec **`@Swing`** rendu en pill cyan (fond `rgba(52,152,219,0.18)`, texte `#3498db`) suivi de `$TSLA 150-155 entry long` en blanc.

Si la couleur n'apparaît pas → vérifier que `CUSTOM_ROLES` est bien exporté.
Si pas de pill (juste du texte coloré) → `roundRect` n'est pas supporté ; le fallback `rect` rectangulaire devrait être visible.

- [ ] **Step 9: Commit**

```bash
git add canvas/proof.js canvas/proof.test.js
git commit -m "feat: rendu pill cyan pour les role mentions Discord

Helpers hexToRgba et getRoleStyle exposés. Les branches
roleMention de measureRichWidth et drawRichLine font un lookup
dans CUSTOM_ROLES. Si trouvé : pill arrondi + texte coloré.
Sinon : fallback sur la chaîne brute <@&id>.

Smoke test sur generateImage qui valide le pipeline complet."
```
