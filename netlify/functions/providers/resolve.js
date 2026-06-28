/* Resolve a CK cart item -> Gelato productUid, using gelato-map.json. Pure, no network.
   Used by the frontend (to stamp the cart) and defensively server-side. Unknown product ->
   returns null so the caller routes to manual review rather than guessing. */
'use strict';
const MAP = require('./gelato-map.json');

const SIZE = MAP.size_map_apparel || {};
const COLOUR = MAP.colour_map_apparel || {};
const CONF = MAP.launchProductsConfirmed || {};

function fill(tpl, size, colour) {
  const s = SIZE[size] || (size || '').toLowerCase();
  const c = COLOUR[colour] || (colour || '').toLowerCase().replace(/\s+/g, '-');
  return tpl.replace('{SIZE}', s).replace('{COLOUR}', c);
}

/* item: { productType, size, colour, orientation, canvasSize, printFileUrl }
   productType one of: tshirt | hoodie | mug | canvas (extend as map grows). */
function ckItemToGelato(item) {
  const t = item.productType;
  if (!t) return null;

  if (t === 'canvas') {
    const cv = MAP.canvas;
    const token = cv.sizeTokens[item.canvasSize];
    if (!token) return null;
    const orient = cv.orientationFromAspect[item.orientation || 'portrait'] || 'ver';
    return { gelatoProductUid: cv.uidBuilder.replace('{sizeToken}', token).replace('{orientation}', orient), printFileUrl: item.printFileUrl };
  }

  const conf = CONF[t];
  if (!conf) return null;
  if (conf.uid && conf.uid.includes('{SIZE}')) {
    return { gelatoProductUid: fill(conf.uid, item.size, item.colour), printFileUrl: item.printFileUrl };
  }
  if (conf.uid) return { gelatoProductUid: conf.uid, printFileUrl: item.printFileUrl };
  return null;
}

module.exports = { ckItemToGelato };
