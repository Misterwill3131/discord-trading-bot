# Templates de vidéo Remotion

Chaque fichier JSON est un **preset complet** de props pour une composition.
Sert de point de départ pour rendre une vidéo avec un style cohérent
sans avoir à retaper toutes les valeurs.

## Schéma des fichiers

```json
{
  "composition": "BoomEntry",  // ID de la composition (BoomEntry | BoomProof)
  "name": "Aggressive Red",    // nom lisible (affiché par list)
  "description": "...",        // courte description
  "props": {
    "ticker": "TSLA",
    "accentColor": "#ef4444",
    "...": "..."               // n'importe quel prop du schema Zod de la composition
  }
}
```

## Workflow

**Lister les templates dispos** :
```bash
cd video && npm run templates:list
```

**Rendre une vidéo avec un template** :
```bash
cd video && npm run template:render -- aggressive-red
# → produit out/aggressive-red.mp4
```

**Créer un nouveau template** :
1. Copie un fichier JSON existant (ex: `cp aggressive-red.json my-template.json`)
2. Édite le contenu (`composition`, `name`, `description`, `props`)
3. Le script `templates:list` le détectera automatiquement.

**Override des props à la volée** :
Le script accepte un 2e argument JSON pour merger des overrides :
```bash
npm run template:render -- aggressive-red '{"ticker":"NVDA","pnl":"+47%"}'
```

## Templates inclus

- `aggressive-red` (BoomEntry) — rouge intense, transitions slide, gros fonts
- `calm-gold` (BoomEntry) — doré/jaune, fade smooth, music réduite
- `minimal` (BoomEntry) — pas de SFX, fonts standards, design épuré
- `classic-green` (BoomProof) — vert win standard
- `gold-celebration` (BoomProof) — gold accent pour les gros wins
