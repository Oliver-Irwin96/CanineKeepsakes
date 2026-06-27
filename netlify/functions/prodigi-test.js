/* TEMPORARY Prodigi sandbox diagnostic — remove after Phase-2 verification.
   Read-only: product lookups + quotes. Hard-guarded to PRODIGI_ENV=sandbox (can NEVER hit live),
   never creates an order, never returns the API key.
   GET /api/prodigi-test                         -> batch probe (canvas+card SKUs + sample quotes)
   GET /api/prodigi-test?action=product&sku=...
   GET /api/prodigi-test?action=quote&sku=...&country=GB|DE|US&copies=1 */
const ENV = (process.env.PRODIGI_ENV || 'sandbox').toLowerCase();
const KEY = process.env.PRODIGI_SANDBOX_API_KEY || process.env.PRODIGI_API_KEY;
const BASE = 'https://api.sandbox.prodigi.com/v4.0';
const H = () => ({ 'X-API-Key': KEY, 'Content-Type': 'application/json' });
const j = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o, null, 2) });

const CANDIDATES = [
  'GLOBAL-CAN-10X10','GLOBAL-CAN-12X12','GLOBAL-CAN-16X16','GLOBAL-CAN-16X20','GLOBAL-CAN-12X16','GLOBAL-CAN-20X20','GLOBAL-CAN-A1','GLOBAL-CAN-A2',
  'GLOBAL-GRE-4X6','GLOBAL-GRE-5X5','GLOBAL-GRE-5X7','GLOBAL-GRE-A5'
];

async function product(sku){ const r=await fetch(`${BASE}/products/${encodeURIComponent(sku)}`,{headers:H()});
  let d={}; try{d=await r.json();}catch(_){} 
  return { sku, status:r.status, ok:r.ok, description:d.product&&d.product.description, attributes:d.product&&d.product.attributes, outcome:d.outcome }; }

async function quote(sku,country,copies){
  const body={ destinationCountryCode:country, currencyCode:'GBP', items:[{sku,copies:copies||1,assets:[{printArea:'default'}]}] };
  const r=await fetch(`${BASE}/quotes`,{method:'POST',headers:H(),body:JSON.stringify(body)});
  let d={}; try{d=await r.json();}catch(_){}
  return { sku, country, status:r.status, ok:r.ok, data:d };
}

exports.handler = async (event) => {
  if (ENV !== 'sandbox') return j(403, { error: 'sandbox only (PRODIGI_ENV is not sandbox)' });
  if (!KEY) return j(500, { error: 'PRODIGI_SANDBOX_API_KEY not set' });
  const q = event.queryStringParameters || {};
  try {
    if (q.action === 'product') return j(200, await product(q.sku || 'GLOBAL-CAN-10X10'));
    if (q.action === 'quote') return j(200, await quote(q.sku || 'GLOBAL-CAN-10X10', q.country || 'GB', parseInt(q.copies)||1));
    // default: batch probe
    const products = [];
    for (const s of CANDIDATES) products.push(await product(s));
    const quotes = [];
    for (const c of ['GB','DE','US']) quotes.push(await quote('GLOBAL-CAN-10X10', c, 1));
    return j(200, { env: ENV, keyPresent: !!KEY, products, sampleQuotes: quotes });
  } catch (e) { return j(500, { error: e.message }); }
};
