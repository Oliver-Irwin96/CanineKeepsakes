/* POST /api/mockup  { product, designId, printFileUrl }
   SELF-HOSTED mockup compositor (no third-party render, no per-image fee).
   Flow: fetch Gelato blank product image (template previewUrl) + our design ->
   composite the design onto the blank with jimp (pure JS) -> upload the finished
   mockup to Supabase Storage (public bucket 'mockups') -> cache the URL.
   Synchronous: composites and returns { status:'completed', url } in one call.
   Cache table: public.mockups (service-role only). Storage: public bucket 'mockups'. */
const Jimp = require('jimp');
const {
  json, corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile, supabaseEnv
} = require('./_lib');
const TEMPLATES = require('./gelato-templates.json');

const GKEY = process.env.GELATO_API_SECRET || process.env.GELATO_API_KEY;
const EC = process.env.GELATO_EC_BASE || (TEMPLATES.ecBase || 'https://ecommerce.gelatoapis.com/v1');
const gHeaders = { 'X-API-KEY': GKEY || '', 'Content-Type': 'application/json' };
const SB = supabaseEnv();

/* Per-product print placement on the blank, as fractions of the blank image.
   cx/cy = centre of the print; w = print width as a fraction of blank width.
   Starting values — tuned by product family; refined after first render. */
const PLACE = {
  'summer-tee':        { cx: 0.50, cy: 0.44, w: 0.34 },
  'winter-tee':        { cx: 0.50, cy: 0.44, w: 0.34 },
  'womens-relaxed-tee':{ cx: 0.50, cy: 0.44, w: 0.32 },
  'sweatshirt':        { cx: 0.50, cy: 0.46, w: 0.32 },
  'hoodie':            { cx: 0.50, cy: 0.50, w: 0.30 },
  'zip-hoodie':        { cx: 0.50, cy: 0.50, w: 0.26 },
  'kids-tee':          { cx: 0.50, cy: 0.44, w: 0.30 },
  'kids-hoodie':       { cx: 0.50, cy: 0.48, w: 0.28 },
  'baby-bodysuit':     { cx: 0.50, cy: 0.44, w: 0.26 },
  'white-mug':         { cx: 0.50, cy: 0.50, w: 0.30 },
  'water-bottle':      { cx: 0.50, cy: 0.50, w: 0.20 },
  'tote-bag':          { cx: 0.50, cy: 0.54, w: 0.40 },
  'phone-case':        { cx: 0.50, cy: 0.50, w: 0.55 },
  'canvas':            { cx: 0.50, cy: 0.50, w: 0.66 },
  'framed-canvas':     { cx: 0.50, cy: 0.50, w: 0.48 },
  'framed-poster':     { cx: 0.50, cy: 0.50, w: 0.46 },
  'metal-print':       { cx: 0.50, cy: 0.50, w: 0.66 },
  'photo-book':        { cx: 0.50, cy: 0.50, w: 0.50 }
};
const DEFAULT_PLACE = { cx: 0.5, cy: 0.5, w: 0.4 };

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
async function cacheUpsert(key, fields) {
  fields.updated_at = new Date().toISOString();
  const existing = await cacheGet(key);
  if (existing) {
    await fetch(`${SB.url}/rest/v1/mockups?cache_key=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(fields) });
  } else {
    await fetch(`${SB.url}/rest/v1/mockups`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ cache_key: key, ...fields }) });
  }
}
async function fetchBuf(url, headers) {
  const r = await fetch(url, headers ? { headers } : undefined);
  if (!r.ok) throw new Error(`fetch ${r.status} for ${String(url).slice(0, 80)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function templateBlank(templateId) {
  const r = await fetch(`${EC}/templates/${templateId}`, { headers: gHeaders });
  const td = await r.json().catch(() => ({}));
  return (td && td.previewUrl) || null;
}
async function storageUpload(path, buf) {
  const r = await fetch(`${SB.url}/storage/v1/object/mockups/${path}`, {
    method: 'POST',
    headers: { apikey: SB.serviceKey, Authorization: `Bearer ${SB.serviceKey}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: buf
  });
  if (!r.ok && r.status !== 409) { const t = await r.text().catch(() => ''); throw new Error(`storage ${r.status} ${t.slice(0, 120)}`); }
  return `${SB.url}/storage/v1/object/public/mockups/${path}`;
}
async function composite(blankBuf, designBuf, place) {
  const blank = await Jimp.read(blankBuf);
  const design = await Jimp.read(designBuf);
  const bw = blank.bitmap.width, bh = blank.bitmap.height;
  const targetW = Math.max(16, Math.round((place.w || 0.4) * bw));
  design.resize(targetW, Jimp.AUTO);
  const dw = design.bitmap.width, dh = design.bitmap.height;
  const x = Math.round((place.cx || 0.5) * bw - dw / 2);
  const y = Math.round((place.cy || 0.5) * bh - dh / 2);
  blank.composite(design, x, y, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 1, opacityDest: 1 });
  return blank.getBufferAsync(Jimp.MIME_PNG);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { product, designId, printFileUrl, action } = JSON.parse(event.body || '{}');
    const cfg = TEMPLATES.products && TEMPLATES.products[product];

    if (action === 'inspect') {
      if (!cfg || !cfg.templateId) return json(404, { error: `no template for ${product}` });
      const blank = await templateBlank(cfg.templateId);
      return json(200, { env: { hasSupabaseServiceKey: !!SB.serviceKey, hasSupabaseUrl: !!SB.url }, blank, place: PLACE[product] || DEFAULT_PLACE });
    }

    if (!product || !designId || !printFileUrl) return json(400, { error: 'product, designId, printFileUrl required' });
    if (!cfg || !cfg.templateId) return json(404, { status: 'error', detail: `no template for product ${product}` });
    if (!isAllowedPrintFile(printFileUrl)) return json(400, { error: 'image url not allowed' });
    if (!GKEY) return json(503, { status: 'error', detail: 'GELATO_API_SECRET missing (needed for blank image)' });
    if (!SB.serviceKey) return json(503, { status: 'error', detail: 'Supabase service key missing' });

    const key = `g1:${product}:${designId}`;
    const cached = await cacheGet(key);
    if (cached && cached.status === 'completed' && cached.mockup_url) return json(200, { status: 'completed', url: cached.mockup_url });

    const blankUrl = await templateBlank(cfg.templateId);
    if (!blankUrl) return json(502, { status: 'error', detail: 'no blank image from Gelato template' });

    const [blankBuf, designBuf] = await Promise.all([fetchBuf(blankUrl), fetchBuf(printFileUrl)]);
    const outBuf = await composite(blankBuf, designBuf, PLACE[product] || DEFAULT_PLACE);
    const path = `v1/${product}/${designId}.png`;
    const url = await storageUpload(path, outBuf);
    await cacheUpsert(key, { catalog_product_id: product, colour: 'default', design_id: designId, image_url: printFileUrl, task_key: null, status: 'completed', mockup_url: url });
    return json(200, { status: 'completed', url });
  } catch (err) {
    return json(500, { status: 'error', detail: String(err && err.message || err) });
  }
};
