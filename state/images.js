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
//   imageGallery          — 100 dernières images (proof + signal) ; hydraté
//                           depuis SQLite au boot, persisté à chaque ajout
//
// Méthodes :
//   addToGallery(type, ticker, author, buffer)
//     → Ajoute une entrée en tête (RAM + DB). Retourne l'id pour pointer dessus.
//     → Cap à 100 entrées (pop du plus ancien + trim DB).
//
// Les `last*Buffer` restent volatiles — toujours rafraîchis au prochain
// message traité. Pas la peine de les persister.
// ─────────────────────────────────────────────────────────────────────

const {
  insertGalleryItem,
  getRecentGalleryItems,
  trimGalleryItems,
} = require('../db/sqlite');

const imageState = {
  lastImageBuffer: null,
  lastImageId: null,
  lastPromoImageBuffer: null,
  // Hydrate depuis la DB au boot pour que /gallery fonctionne
  // immédiatement après un restart (sinon vide jusqu'au prochain signal).
  // better-sqlite3 renvoie déjà les BLOB comme Buffer.
  imageGallery: getRecentGalleryItems(100),

  addToGallery(type, ticker, author, buffer) {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const entry = {
      id,
      type,
      ticker: ticker || null,
      author: author || null,
      ts: new Date().toISOString(),
      buffer,
    };
    // RAM d'abord pour la latence immédiate (SSE/UI).
    this.imageGallery.unshift(entry);
    if (this.imageGallery.length > 100) this.imageGallery.pop();

    // Puis persist en DB. Échec non bloquant — la galerie RAM fonctionne
    // quand même, seul le restart perdrait l'entrée.
    try {
      insertGalleryItem(entry);
      trimGalleryItems(100);
    } catch (e) {
      console.error('[gallery] DB persist failed:', e.message);
    }
    return id;
  },
};

module.exports = imageState;
