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
    /* DUMP: master catalogue reference. For a page of catalogs, return each catalog's
       attribute OPTIONS (every size/colour/format/etc.) + product count + a sample UID.
       This is the recipe to build any product ID without listing 100k+ variants.
       Paged to avoid timeout: ?action=dump&offset=0&limit=10
       Noisy attributes are skipped; each option list capped. */
    if (q.action === 'dump') {
      const offset = parseInt(q.offset) || 0;
      const limit = parseInt(q.limit) || 10;
      const SKIP = new Set(['GarmentPrint','ApparelManufacturerSKU','ProductStatus','State','ProductModel']);
      const CAP = 80;
      const list = await getJSON(`${PROD}/catalogs`);
      const cats = ((list.data && list.data.data) || []).map(c => c.catalogUid);
      const page = cats.slice(offset, offset + limit);
      const out = {};
      for (const uid of page) {
        try {
          const s = await getJSON(`${PROD}/catalogs/${encodeURIComponent(uid)}/products:search`, { method:'POST', headers:H(), body: JSON.stringify({ limit: 1 }) });
          const hits = (s.data && s.data.hits && s.data.hits.attributeHits) || {};
          const attrs = {};
          for (const k of Object.keys(hits)) {
            if (SKIP.has(k)) continue;
            attrs[k] = Object.keys(hits[k]).slice(0, CAP);
          }
          const sample = s.data && s.data.products && s.data.products[0] && s.data.products[0].productUid;
          out[uid] = { count: (s.data && s.data.pagination && s.data.pagination.total) || null, attributes: attrs, sampleUid: sample };
        } catch (e) { out[uid] = { error: e.message }; }
      }
      return j(200, { offset, limit, totalCatalogs: cats.length, returned: page.length, nextOffset: offset + page.length < cats.length ? offset + page.length : null, catalogs: out });
    }
    /* BATCH cost scan: for each catalog, pick the first activated product and return its
       item price per country. Compact output. Keep cats list small (<=7) to avoid timeout.
       GET ...?action=scan&cats=canvas,mugs,t-shirts&countries=GB,US */
    if (q.action === 'scan') {
      const cats = (q.cats || '').split(',').map(s=>s.trim()).filter(Boolean).slice(0, 8);
      const countries = (q.countries || 'GB,US').split(',').map(s=>s.trim()).filter(Boolean);
      const rows = [];
      for (const cat of cats) {
        let uid = null;
        try {
          const s = await getJSON(`${PROD}/catalogs/${encodeURIComponent(cat)}/products:search`, { method:'POST', headers:H(), body: JSON.stringify({ limit: 60 }) });
          const prods = (s.data && s.data.products) || [];
          const act = prods.find(p => p.attributes && p.attributes.ProductStatus === 'activated') || prods[0];
          uid = act && act.productUid;
        } catch (_) {}
        const row = { category: cat, productUid: uid, itemPrice: {} };
        if (uid) for (const c of countries) {
          try {
            const pr = await getJSON(`${PROD}/products/${encodeURIComponent(uid)}/prices?country=${encodeURIComponent(c)}`);
            const f = (pr.data || [])[0];
            row.itemPrice[c] = f ? `${Number(f.price).toFixed(2)} ${f.currency}` : null;
          } catch (_) { row.itemPrice[c] = 'err'; }
        }
        rows.push(row);
      }
      return j(200, { scanned: cats.length, countries, rows });
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
