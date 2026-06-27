/* TEMPORARY Gelato diagnostic — remove after evaluation.
   READ-ONLY: catalog/product/price lookups + shipping quotes. Never creates an order,
   never charges, never returns the API key. Uses GELATO_API_SECRET (server-side only).

   GET /api/gelato-test                              -> list all catalogs (product categories)
   GET /api/gelato-test?action=catalog&uid=canvas
   GET /api/gelato-test?action=search&uid=canvas&limit=3
   GET /api/gelato-test?action=product&uid=<productUid>
   GET /api/gelato-test?action=prices&uid=<productUid>&country=GB&currency=GBP   (item price, no shipping)
   GET /api/gelato-test?action=quote&uid=<productUid>&country=GB|US|DE|AU|CA&currency=GBP  (item + shipping, real address) */
const KEY = process.env.GELATO_API_SECRET || process.env.GELATO_API_KEY;
const PROD = 'https://product.gelatoapis.com/v3';
const ORDER = 'https://order.gelatoapis.com/v4';
const H = () => ({ 'X-API-KEY': KEY, 'Content-Type': 'application/json' });
const j = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o, null, 2) });

/* valid sample delivery addresses per country so shipping actually computes */
const ADDR = {
  GB: { addressLine1:'10 Downing Street', city:'London', postCode:'SW1A 2AA', country:'GB' },
  US: { addressLine1:'350 5th Ave', city:'New York', postCode:'10118', state:'NY', country:'US' },
  DE: { addressLine1:'Unter den Linden 77', city:'Berlin', postCode:'10117', country:'DE' },
  AU: { addressLine1:'1 Martin Place', city:'Sydney', postCode:'2000', state:'NSW', country:'AU' },
  CA: { addressLine1:'100 Queen St W', city:'Toronto', postCode:'M5H 2N2', state:'ON', country:'CA' },
};

async function getJSON(url, init) {
  const r = await fetch(url, init || { headers: H() });
  let d = null; try { d = await r.json(); } catch (_) { d = { _nonJson: true }; }
  return { status: r.status, ok: r.ok, data: d };
}

/* trim a quote response to the bits that matter: item price, shipping price, where it's made */
function summariseQuote(res, country, currency) {
  const out = { country, status: res.status, ok: res.ok };
  try {
    const q = res.data && res.data.quotes && res.data.quotes[0];
    if (!q) { out.raw = res.data; return out; }
    out.itemPrice = q.products && q.products[0] && (q.products[0].price + ' ' + q.products[0].currency);
    out.productionCountry = q.productionCountry;
    out.fulfillmentCountry = q.fulfillmentCountry;
    const sm = (q.shipmentMethods || []).map(m => ({ name:m.name, price: (m.price==null?'(needs paid order)':m.price+' '+m.currency), days: `${m.minDeliveryDays}-${m.maxDeliveryDays}` }));
    out.shipping = sm;
  } catch (e) { out.parseError = e.message; out.raw = res.data; }
  return out;
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
      const body = { limit: parseInt(q.limit) || 20 };
      return j(200, await getJSON(`${PROD}/catalogs/${encodeURIComponent(q.uid)}/products:search`, { method:'POST', headers:H(), body: JSON.stringify(body) }));
    }
    if (q.action === 'quote') {
      const country = (q.country || 'GB').toUpperCase();
      const addr = ADDR[country] || ADDR.GB;
      const currency = q.currency || 'GBP';
      const file = q.file || 'https://caninekeepsakes.co.uk/images/logo.png';
      const body = {
        orderReferenceId: 'ck-quote-test', customerReferenceId: 'ck', currency,
        recipient: Object.assign({ firstName:'Test', lastName:'Quote', email:'test@example.com' }, addr),
        products: [ { itemReferenceId:'1', productUid:q.uid, fileUrl:file, quantity: parseInt(q.copies)||1 } ]
      };
      const res = await getJSON(`${ORDER}/orders:quote`, { method:'POST', headers:H(), body: JSON.stringify(body) });
      return j(200, q.raw ? res : summariseQuote(res, country, currency));
    }
    return j(200, await getJSON(`${PROD}/catalogs`));
  } catch (e) { return j(500, { error: e.message }); }
};
