/* TEMPORARY Gelato diagnostic — remove after evaluation.
   READ-ONLY: catalog/product/price lookups + shipping quotes. Never creates an order,
   never charges, never returns the API key. Uses GELATO_API_SECRET (server-side only).

   GET /api/gelato-test                              -> list all catalogs (product categories)
   GET /api/gelato-test?action=catalog&uid=canvas    -> catalog detail + attributes
   GET /api/gelato-test?action=search&uid=canvas      -> first products in a catalog
   GET /api/gelato-test?action=product&uid=<productUid>
   GET /api/gelato-test?action=prices&uid=<productUid>&country=GB|US|DE
   GET /api/gelato-test?action=quote&uid=<productUid>&country=GB|US|DE&currency=GBP&file=<url> */
const KEY = process.env.GELATO_API_SECRET || process.env.GELATO_API_KEY;
const PROD = 'https://product.gelatoapis.com/v3';
const ORDER = 'https://order.gelatoapis.com/v4';
const H = () => ({ 'X-API-KEY': KEY, 'Content-Type': 'application/json' });
const j = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o, null, 2) });

async function getJSON(url, init) {
  const r = await fetch(url, init || { headers: H() });
  let d = null; try { d = await r.json(); } catch (_) { d = { _nonJson: true }; }
  return { status: r.status, ok: r.ok, data: d };
}

exports.handler = async (event) => {
  if (!KEY) return j(500, { error: 'GELATO_API_SECRET not set' });
  const q = event.queryStringParameters || {};
  try {
    if (q.action === 'catalog') return j(200, await getJSON(`${PROD}/catalogs/${encodeURIComponent(q.uid)}`));
    if (q.action === 'product') return j(200, await getJSON(`${PROD}/products/${encodeURIComponent(q.uid)}`));
    if (q.action === 'prices') {
      const cc = q.country ? `?country=${encodeURIComponent(q.country)}${q.currency?`&currency=${encodeURIComponent(q.currency)}`:''}` : '';
      return j(200, await getJSON(`${PROD}/products/${encodeURIComponent(q.uid)}/prices${cc}`));
    }
    if (q.action === 'search') {
      const body = {}; if (q.limit) body.limit = parseInt(q.limit) || 20; else body.limit = 20;
      return j(200, await getJSON(`${PROD}/catalogs/${encodeURIComponent(q.uid)}/products:search`, { method:'POST', headers:H(), body: JSON.stringify(body) }));
    }
    if (q.action === 'quote') {
      const country = q.country || 'GB';
      const file = q.file || 'https://pub-7c3d2e8f.r2.dev/placeholder.png';
      const body = {
        orderReferenceId: 'ck-quote-test',
        customerReferenceId: 'ck',
        currency: q.currency || 'GBP',
        recipient: { firstName:'Test', lastName:'Quote', addressLine1:'1 Test St', city:'London', postCode:'EC1A 1BB', country, email:'test@example.com' },
        products: [ { itemReferenceId:'1', productUid:q.uid, fileUrl:file, quantity: parseInt(q.copies)||1 } ]
      };
      return j(200, await getJSON(`${ORDER}/orders:quote`, { method:'POST', headers:H(), body: JSON.stringify(body) }));
    }
    // default: list all catalogs (the full product-category list)
    return j(200, await getJSON(`${PROD}/catalogs`));
  } catch (e) { return j(500, { error: e.message }); }
};
