/* POST /api/mockup  { product, designId, printFileUrl }
   Returns a real GELATO product mockup for a design on a product, generating +
   caching on first request and serving instantly thereafter. Server-side only —
   the Gelato key lives in Netlify env, never in the browser.

   Flow (kept short per call so we never hit the function timeout):
     - cache hit (completed)   -> { status:'completed', url }
     - no/failed/stale row     -> create Gelato product-from-template, store 'pending' + gelato id
     - pending row             -> poll Gelato once; on ready cache + return url, else 'pending'
   The browser polls this endpoint every few seconds until status==='completed'.
   Cache table: public.mockups (service-role only, RLS on). */
const {
  json, corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile, supabaseEnv
} = require('./_lib');
const TEMPLATES = require('./gelato-templates.json');

const GKEY = process.env.GELATO_API_SECRET || process.env.GELATO_API_KEY;
const EC = process.env.GELATO_EC_BASE || (TEMPLATES.ecBase || 'https://ecommerce.gelatoapis.com/v1');
const STORE = process.env.GELATO_STORE_ID || TEMPLATES.store;
const gHeaders = { 'X-API-KEY': GKEY || '', 'Content-Type': 'application/json' };

const SB = supabaseEnv();
function sbHeaders(extra = {}) {
  if (!SB.serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return { apikey: SB.serviceKey, Authorization: `Bearer ${SB.serviceKey}`, 'Content-Type': 'application/json', ...extra };
}
async function cacheGet(key) {
  const r = await fetch(`${SB.url}/rest/v1/mockups?cache_key=eq.${encodeURIComponent(key)}&select=*`, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
async function cacheInsert(row) {
  const r = await fetch(`${SB.url}/rest/v1/mockups`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(row) });
  if (r.status === 409) return cacheGet(row.cache_key);
  if (!r.ok) throw new Error(`mockup cache insert failed ${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}
async function cacheUpdate(key, fields) {
  fields.updated_at = new Date().toISOString();
  await fetch(`${SB.url}/rest/v1/mockups?cache_key=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(fields) });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 40, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    if (!GKEY) return json(503, { status: 'error', detail: 'GELATO_API_SECRET not configured in Netlify env' });
    if (!STORE) return json(503, { status: 'error', detail: 'Gelato store id missing' });
    const { product, designId, printFileUrl } = JSON.parse(event.body || '{}');
    if (!product || !designId || !printFileUrl) return json(400, { error: 'product, designId, printFileUrl required' });
    const cfg = TEMPLATES.products && TEMPLATES.products[product];
    if (!cfg || !cfg.templateId) return json(404, { status: 'error', detail: `no template for product ${product}` });
    if (!isAllowedPrintFile(printFileUrl)) return json(400, { error: 'image url not allowed' });

    const key = `g1:${product}:${designId}`;
    let row = await cacheGet(key);
    if (row && row.status === 'completed' && row.mockup_url) return json(200, { status: 'completed', url: row.mockup_url });

    const stalePending = row && row.task_key && row.status !== 'completed' && row.updated_at && (Date.now() - Date.parse(row.updated_at) > 1200000); // 20 min — must exceed Gelato's first-render time so we never abandon+recreate a still-rendering mockup
    if (!row || (!row.task_key && row.status !== 'completed') || row.status === 'failed' || stalePending) {
      const cr = await fetch(`${EC}/stores/${STORE}/products:create-from-template`, {
        method: 'POST', headers: gHeaders,
        body: JSON.stringify({ templateId: cfg.templateId, title: `CK ${product} ${designId}`, isVisibleInTheOnlineStore: true, tags: ['ck-mockup'], imagePlaceholders: [{ name: cfg.placeholder || 'ImageFront', fileUrl: printFileUrl }] })
      });
      const cd = await cr.json().catch(() => ({}));
      const gid = cd && cd.id;
      if (!gid) return json(502, { status: 'error', detail: (cd && (cd.message || cd.error)) || 'create-from-template failed' });
      const fields = { catalog_product_id: product, colour: 'default', design_id: designId, image_url: printFileUrl, task_key: gid, status: 'pending' };
      if (row) await cacheUpdate(key, fields); else await cacheInsert({ cache_key: key, ...fields });
      return json(200, { status: 'pending' });
    }

    if (row.task_key && row.status !== 'completed') {
      const gr = await fetch(`${EC}/stores/${STORE}/products/${row.task_key}`, { headers: gHeaders });
      const gd = await gr.json().catch(() => ({}));
      const url = gd && (gd.previewUrl || (gd.media && gd.media[0] && gd.media[0].url));
      if (url) { await cacheUpdate(key, { status: 'completed', mockup_url: url }); return json(200, { status: 'completed', url }); }
      return json(200, { status: 'pending', _g: { gStatus: gd && gd.status, hasPreview: !!(gd && gd.previewUrl), keys: gd ? Object.keys(gd) : [], previewUrl: (gd && gd.previewUrl) || null } }); // TEMP diagnostic: surface raw Gelato product shape
    }
    return json(200, { status: row.status || 'pending' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
