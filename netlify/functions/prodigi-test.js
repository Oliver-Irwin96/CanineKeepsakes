/* TEMPORARY Prodigi sandbox diagnostic — remove after Phase-2 verification.
   Read-only: product lookups + quotes. Hard-guarded to PRODIGI_ENV=sandbox (can NEVER hit live),
   never creates an order, never returns the API key.
   GET /api/prodigi-test                         -> batch probe (canvas+card SKUs + priced quotes GB/DE/US)
   GET /api/prodigi-test?action=product&sku=...
   GET /api/prodigi-test?action=quote&sku=...&country=GB|DE|US&copies=1&wrap=ImageWrap */
const ENV = (process.env.PRODIGI_ENV || 'sandbox').toLowerCase();
const KEY = process.env.PRODIGI_SANDBOX_API_KEY || process.env.PRODIGI_API_KEY;
const BASE = 'https://api.sandbox.prodigi.com/v4.0';
const H = () => ({ 'X-API-Key': KEY, 'Content-Type': 'application/json' });
const j = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o, null, 2) });

const CANVAS = ['GLOBAL-CAN-10X10','GLOBAL-CAN-12X12','GLOBAL-CAN-16X16','GLOBAL-CAN-12X16','GLOBAL-CAN-16X20','GLOBAL-CAN-20X20','GLOBAL-CAN-A2','GLOBAL-CAN-A1'];
const CARDS  = ['CLASSIC-GRE-FEDR-7X5-BLA','CLASSIC-GRE-FEDR-7X5-BLA-10','CLASSIC-GRE-FEDR-A5-BLA','CLASSIC-GRE-FEDR-A5-BLA-10'];

async function product(sku){ const r=await fetch(`${BASE}/products/${encodeURIComponent(sku)}`,{headers:H()});
  let d={}; try{d=await r.json();}catch(_){}
  return { sku, status:r.status, ok:r.ok, description:d.product&&d.product.description, attributes:d.product&&d.product.attributes, outcome:d.outcome }; }

/* attributes: pass {} for cards, {wrap:'ImageWrap'} for canvas. Returns the headline price only. */
async function quote(sku,country,copies,attributes){
  const item={ sku, copies:copies||1, assets:[{printArea:'default'}] };
  if (attributes && Object.keys(attributes).length) item.attributes=attributes;
  const body={ destinationCountryCode:country, currencyCode:'GBP', items:[item] };
  const r=await fetch(`${BASE}/quotes`,{method:'POST',headers:H(),body:JSON.stringify(body)});
  let d={}; try{d=await r.json();}catch(_){}
  let price=null, shipping=null;
  try { const q=(d.quotes||[])[0]; const c=q&&q.costSummary;
    if (c){ price=c.items&&(c.items.amount+' '+c.items.currency); shipping=c.shipping&&(c.shipping.amount+' '+c.shipping.currency); }
  } catch(_){}
  return { sku, country, status:r.status, ok:r.ok, itemCost:price, shippingCost:shipping, outcome:d.outcome||(d.failures?'ValidationFailed':undefined), failures:d.failures };
}

exports.handler = async (event) => {
  if (ENV !== 'sandbox') return j(403, { error: 'sandbox only (PRODIGI_ENV is not sandbox)' });
  if (!KEY) return j(500, { error: 'PRODIGI_SANDBOX_API_KEY not set' });
  const q = event.queryStringParameters || {};
  try {
    if (q.action === 'product') return j(200, await product(q.sku || 'GLOBAL-CAN-10X10'));
    if (q.action === 'quote') {
      const attrs = q.wrap ? { wrap: q.wrap } : {};
      return j(200, await quote(q.sku || 'GLOBAL-CAN-10X10', q.country || 'GB', parseInt(q.copies)||1, attrs));
    }
    // default: priced quotes for a representative canvas + card across GB/DE/US
    const quotes = [];
    for (const c of ['GB','DE','US']) quotes.push(await quote('GLOBAL-CAN-16X20', c, 1, { wrap:'ImageWrap' }));
    for (const c of ['GB','DE','US']) quotes.push(await quote('GLOBAL-CAN-10X10', c, 1, { wrap:'ImageWrap' }));
    for (const c of ['GB','DE','US']) quotes.push(await quote('CLASSIC-GRE-FEDR-A5-BLA', c, 1, {}));
    return j(200, { env: ENV, keyPresent: !!KEY, canvasSkus: CANVAS, cardSkus: CARDS, pricedQuotes: quotes });
  } catch (e) { return j(500, { error: e.message }); }
};
