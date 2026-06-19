/* POST /api/mockup  { catalogProductId, colour, size?, designId, imageUrl }
   Returns a Printful mockup for a design on a product, generating + caching on first
   request and serving instantly thereafter.

   Flow (kept short per call so we never hit the function timeout):
     - cache hit (completed)        -> { status:'completed', url }
     - no cache row                 -> create Printful mockup task, store 'pending', return task_key
     - cache row pending w/ task    -> poll Printful once; on done cache + return url, else 'pending'
   The browser polls this endpoint every few seconds until status==='completed'.

   The mockup cache (public.mockups) is written with the service-role key and is
   never exposed to the browser (RLS on, no anon policies). */
const {
  PF_BASE, pfHeaders, json, corsHeaders, isOriginAllowed, rateLimit,
  isAllowedPrintFile, supabaseEnv
} = require('./_lib');

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
  const r = await fetch(`${SB.url}/rest/v1/mockups`, {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(row)
  });
  if (r.status === 409) return cacheGet(row.cache_key); // someone else created it first
  if (!r.ok) throw new Error(`mockup cache insert failed ${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}
async function cacheUpdate(key, fields) {
  fields.updated_at = new Date().toISOString();
  await fetch(`${SB.url}/rest/v1/mockups?cache_key=eq.${encodeURIComponent(key)}`, {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(fields)
  });
}

async function resolveVariantId(catalogProductId, colour, size) {
  const res = await fetch(`${PF_BASE}/products/${catalogProductId}`, { headers: pfHeaders() });
  if (!res.ok) throw new Error(`catalog lookup failed for ${catalogProductId}`);
  const data = await res.json();
  const variants = (data && data.result && data.result.variants) || [];
  const norm = s => (s || '').toLowerCase().trim();
  const match = variants.find(v => norm(v.color) === norm(colour) && (!size || norm(v.size) === norm(size)))
    || variants.find(v => norm(v.color) === norm(colour))
    || variants[0];
  if (!match) throw new Error(`no variant for ${catalogProductId} ${colour}/${size}`);
  return match.id;
}

/* Pick a sensible print placement NAME for this product. We deliberately do NOT
   send a position block: forcing position {width/height = full print area, top:0}
   stretched the art and pushed it to the neckline (Neil bugs 001 bowl + 003 apparel).
   Omitting position lets Printful auto-place at its proven default (centred, correctly
   sized) — matching the pawprint approach. Never throws: falls back to 'front'. */
async function choosePlacement(catalogProductId) {
  try {
    const r = await fetch(`${PF_BASE}/mockup-generator/printfiles/${catalogProductId}`, { headers: pfHeaders() });
    const d = await r.json();
    const res = d.result || {};
    const ap = res.available_placements || {};
    const keys = Array.isArray(ap) ? ap.map(p => p.placement || p) : Object.keys(ap);
    return keys.includes('front')
      ? 'front'
      : (keys.find(k => k !== 'default' && !String(k).startsWith('label')) || keys.find(k => k === 'default') || keys[0] || 'front');
  } catch (_) {
    return 'front';
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 40, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { catalogProductId, colour, size, designId, imageUrl } = JSON.parse(event.body || '{}');
    if (!catalogProductId || !colour || !designId || !imageUrl) {
      return json(400, { error: 'catalogProductId, colour, designId, imageUrl required' });
    }
    // Only let Printful fetch artwork from our own trusted hosts.
    if (!isAllowedPrintFile(imageUrl)) return json(400, { error: 'image url not allowed' });

    /* cache key bumped to v2 to invalidate old mockups generated with the bad
       full-area position (Neil 001/003) so they regenerate with default placement. */
    const key = `v2:${catalogProductId}:${colour}:${designId}`;
    let row = await cacheGet(key);

    if (row && row.status === 'completed' && row.mockup_url) {
      return json(200, { status: 'completed', url: row.mockup_url });
    }

    // No task yet -> create one
    if (!row || (!row.task_key && row.status !== 'completed')) {
      const variantId = await resolveVariantId(catalogProductId, colour, size);
      const placement = await choosePlacement(catalogProductId);
      const cr = await fetch(`${PF_BASE}/mockup-generator/create-task/${catalogProductId}`, {
        method: 'POST', headers: pfHeaders(),
        body: JSON.stringify({ variant_ids: [variantId], format: 'jpg', files: [{ placement, image_url: imageUrl }] })
      });
      const cd = await cr.json();
      const taskKey = cd.result && cd.result.task_key;
      if (!taskKey) return json(502, { status: 'error', detail: (cd.result || cd.error || 'create-task failed') });
      await cacheInsert({
        cache_key: key, catalog_product_id: catalogProductId, colour, design_id: designId,
        image_url: imageUrl, task_key: taskKey, status: 'pending'
      });
      return json(200, { status: 'pending' });
    }

    // Pending task -> poll once
    if (row.task_key && row.status !== 'completed') {
      const tr = await fetch(`${PF_BASE}/mockup-generator/task?task_key=${encodeURIComponent(row.task_key)}`, { headers: pfHeaders() });
      const td = await tr.json();
      const st = td.result && td.result.status;
      if (st === 'completed') {
        const url = td.result.mockups[0].mockup_url;
        await cacheUpdate(key, { status: 'completed', mockup_url: url });
        return json(200, { status: 'completed', url });
      }
      if (st === 'failed') { await cacheUpdate(key, { status: 'failed' }); return json(200, { status: 'failed' }); }
      return json(200, { status: 'pending' });
    }

    return json(200, { status: row.status || 'pending' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
