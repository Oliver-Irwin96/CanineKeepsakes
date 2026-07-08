/* POST /api/mockup  { product, designId, printFileUrl }
   SELF-HOSTED mockup generator (no third-party render, no per-image fee, no external blanks).
   Renders each design as a premium framed art-print mockup with jimp (pure JS): warm wall
   background, white mat, dark frame, soft drop shadow. Uploads the finished mockup to
   Supabase Storage (public bucket 'mockups') and caches the URL.
   Synchronous: generates and returns { status:'completed', url } in one call (~2-4s first time,
   instant from cache after). Cache table: public.mockups. Storage: public bucket 'mockups'.

   UPGRADE PATH (per-product photoreal): drop a blank product photo per product into the repo /
   Storage and set BLANKS[product] to its URL + PLACE[product] rectangle; the generator will then
   composite the design onto the real product photo instead of the framed default. */
const Jimp = require('jimp');
const {
  json, corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile, supabaseEnv
} = require('./_lib');
const TEMPLATES = require('./gelato-templates.json');
const SB = supabaseEnv();

/* Optional per-product real blank photo + print rectangle (fractions of blank).
   Empty for now (Gelato's API doesn't expose blanks); fill to enable photoreal per product. */
const BLANKS = {};
const PLACE = {
  'white-mug': { cx: 0.50, cy: 0.50, w: 0.30 }, 'summer-tee': { cx: 0.50, cy: 0.44, w: 0.34 },
  'tote-bag': { cx: 0.50, cy: 0.54, w: 0.40 }, 'phone-case': { cx: 0.50, cy: 0.50, w: 0.55 }
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
  if (existing) await fetch(`${SB.url}/rest/v1/mockups?cache_key=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(fields) });
  else await fetch(`${SB.url}/rest/v1/mockups`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ cache_key: key, ...fields }) });
}
async function fetchBuf(url, headers) {
  const r = await fetch(url, headers ? { headers } : undefined);
  if (!r.ok) throw new Error(`fetch ${r.status} for ${String(url).slice(0, 80)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function storageUpload(path, buf) {
  const r = await fetch(`${SB.url}/storage/v1/object/mockups/${path}`, {
    method: 'POST',
    headers: { apikey: SB.serviceKey, Authorization: `Bearer ${SB.serviceKey}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: buf
  });
  if (!r.ok && r.status !== 409) { const t = await r.text().catch(() => ''); throw new Error(`storage ${r.status} ${t.slice(0, 140)}`); }
  return `${SB.url}/storage/v1/object/public/mockups/${path}`;
}

/* Premium framed art-print mockup — self-contained, no external blank needed. */
async function framedMockup(designBuf) {
  const design = await Jimp.read(designBuf);
  const W = 1100, H = 1100;
  const bg = new Jimp(W, H, 0xefe9dfff);           // warm gallery wall
  // soft top-down light: lighten upper area a touch
  const light = new Jimp(W, Math.round(H * 0.55), 0xffffff22); bg.composite(light, 0, 0);
  const artW = Math.round(W * 0.58);
  design.resize(artW, Jimp.AUTO);
  const artH = design.bitmap.height;
  const matPad = Math.round(W * 0.055);
  const mat = new Jimp(artW + matPad * 2, artH + matPad * 2, 0xffffffff);
  const frameB = Math.round(W * 0.02);
  const fw = mat.bitmap.width + frameB * 2, fh = mat.bitmap.height + frameB * 2;
  const frame = new Jimp(fw, fh, 0x2b2620ff);       // dark wood frame
  const shadow = new Jimp(fw, fh, 0x0000004d); shadow.blur(14);
  const fx = Math.round((W - fw) / 2), fy = Math.round((H - fh) / 2);
  bg.composite(shadow, fx + 8, fy + 18);
  bg.composite(frame, fx, fy);
  bg.composite(mat, fx + frameB, fy + frameB);
  bg.composite(design, fx + frameB + matPad, fy + frameB + matPad);
  return bg.getBufferAsync(Jimp.MIME_PNG);
}

/* Composite onto a real product photo (used only when BLANKS[product] is set). */
async function photoMockup(blankBuf, designBuf, place) {
  const blank = await Jimp.read(blankBuf);
  const design = await Jimp.read(designBuf);
  const bw = blank.bitmap.width, bh = blank.bitmap.height;
  const targetW = Math.max(16, Math.round((place.w || 0.4) * bw));
  design.resize(targetW, Jimp.AUTO);
  const x = Math.round((place.cx || 0.5) * bw - design.bitmap.width / 2);
  const y = Math.round((place.cy || 0.5) * bh - design.bitmap.height / 2);
  blank.composite(design, x, y, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 1, opacityDest: 1 });
  return blank.getBufferAsync(Jimp.MIME_PNG);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { product, designId, printFileUrl } = JSON.parse(event.body || '{}');
    const cfg = TEMPLATES.products && TEMPLATES.products[product];
    if (!product || !designId || !printFileUrl) return json(400, { error: 'product, designId, printFileUrl required' });
    if (!cfg) return json(404, { status: 'error', detail: `unknown product ${product}` });
    if (!isAllowedPrintFile(printFileUrl)) return json(400, { error: 'image url not allowed' });
    if (!SB.serviceKey) return json(503, { status: 'error', detail: 'Supabase service key missing' });

    const key = `g1:${product}:${designId}`;
    const cached = await cacheGet(key);
    if (cached && cached.status === 'completed' && cached.mockup_url) return json(200, { status: 'completed', url: cached.mockup_url });

    const designBuf = await fetchBuf(printFileUrl);
    let outBuf;
    if (BLANKS[product]) {
      const blankBuf = await fetchBuf(BLANKS[product]);
      outBuf = await photoMockup(blankBuf, designBuf, PLACE[product] || DEFAULT_PLACE);
    } else {
      outBuf = await framedMockup(designBuf);
    }
    const path = `v1/${product}/${designId}.png`;
    const url = await storageUpload(path, outBuf);
    await cacheUpsert(key, { catalog_product_id: product, colour: 'default', design_id: designId, image_url: printFileUrl, task_key: null, status: 'completed', mockup_url: url });
    return json(200, { status: 'completed', url });
  } catch (err) {
    return json(500, { status: 'error', detail: String(err && err.message || err) });
  }
};
