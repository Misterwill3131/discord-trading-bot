// ─────────────────────────────────────────────────────────────────────
// state/images.js — État mutable partagé pour les images générées
// ─────────────────────────────────────────────────────────────────────
// Singleton : exporte un objet mutable que le handler Discord, les routes
// HTTP et la galerie lisent/écrivent. Les consommateurs accèdent aux
// propriétés via la référence (ex. `imageState.lastImageBuffer = buf`) ;
// NE PAS faire `const { lastImageBuffer } = imageState` car ça capture
// un snapshot et manque les mises à jour.
//
// Champs :
//   lastImageBuffer       — PNG de la dernière image générée (signal/proof)
//   lastImageId           — Date.now() au moment du dernier generateImage
//   lastPromoImageBuffer  — PNG de la dernière promo 1080×1080
//   imageGallery          — 100 dernières images (proof + signal) en RAM
//
// Méthodes :
//   addToGallery(type, ticker, author, buffer)
//     → Ajoute une entrée en tête. Retourne l'id pour pointer dessus.
//     → Cap à 100 entrées (pop du plus ancien).
// ─────────────────────────────────────────────────────────────────────

const imageState = {
  lastImageBuffer: null,
  lastImageId: null,
  lastPromoImageBuffer: null,
  imageGallery: [], // { id, type, ticker, author, ts, buffer }

  addToGallery(type, ticker, author, buffer) {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    this.imageGallery.unshift({
      id,
      type,
      ticker: ticker || null,
      author: author || null,
      ts: new Date().toISOString(),
      buffer,
    });
    if (this.imageGallery.length > 100) this.imageGallery.pop();
    return id;
  },
};

module.exports = imageState;
