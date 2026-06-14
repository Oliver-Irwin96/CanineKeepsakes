/* Shared helpers for CK Netlify functions */
const PF_BASE = 'https://api.printful.com';

/* Canine Keepsakes store ID - general API key covers 19 stores, this scopes all
   calls to the right one. Set PRINTFUL_STORE_ID env var to override. */
const CK_STORE_ID = process.env.PRINTFUL_STORE_ID || '18269364';

function pfHeaders() {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error('PRINTFUL_API_KEY not configured');
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-PF-Store-Id': CK_STORE_ID
  };
}

function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal credentials not configured');
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

/* Server-side price table - NEVER trust client prices.
   Mirror of data/products.json retail prices. */
const PRICES = {
  'summer-tee': 24.99, 'summer-long-sleeve': 29.99, 'winter-tee': 27.99,
  'winter-long-sleeve': 29.99, 'sweatshirt': 34.99, 'hoodie': 39.99,
  'zip-hoodie': 44.99, 'womens-relaxed-tee': 26.99, 'white-mug': 14.99,
  'black-mug': 14.99, 'pet-bowl': 17.99, 'stickers': 4.99, 'throw-blanket': 79.99
};

function priceBasket(items) {
  return items.reduce((sum, i) => {
    const p = PRICES[i.productSlug];
    if (p == null) throw new Error(`Unknown product: ${i.productSlug}`);
    return sum + p * Math.max(1, parseInt(i.qty) || 1);
  }, 0);
}

/* -- Shipping (server-authoritative) --
   The browser must NEVER decide shipping cost. We always re-fetch live rates
   from Printful and use Printful's number. If Printful is unreachable we fall
   back to a SERVER-defined flat rate - never to a client-supplied value. */
const FLAT_SHIP_FALLBACK = { id: 'STANDARD', name: 'Standard UK', rate: 3.99 };

async function resolveFirstVariant(catalogProductId) {
  const res = await fetch(`${PF_BASE}/products/${catalogProductId}`, { headers: pfHeaders() });
  if (!res.ok) throw new Error(`catalog lookup failed for ${catalogProductId}`);
  const data = await res.json();
  const v = data?.result?.variants?.[0];
  if (!v) throw new Error(`no variants for product ${catalogProductId}`);
  return v.id;
}

async function printfulShippingRates(recipient, items) {
  const resolved = [];
  for (const i of items) {
    const variant_id = await resolveFirstVariant(i.catalogProductId);
    resolved.push({ variant_id, quantity: Math.max(1, parseInt(i.qty) || 1) });
  }
  const res = await fetch(`${PF_BASE}/shipping/rates`, {
    method: 'POST',
    headers: pfHeaders(),
    body: JSON.stringify({
      recipient: {
        address1: recipient.address1,
        city: recipient.city,
        country_code: 'GB',
        zip: recipient.zip
      },
      items: resolved,
      currency: 'GBP',
      locale: 'en_GB'
    })
  });
  if (!res.ok) throw new Error(`Printful rates error ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

/* Returns authoritative { id, name, rate } for the chosen option.
   chosenId only PICKS among server rates - its price is discarded.
   Unknown id -> cheapest live rate. Printful down -> server flat fallback. */
async function authoritativeShipping(recipient, items, chosenId) {
  try {
    const rates = await printfulShippingRates(recipient, items);
    if (rates.length) {
      const match = rates.find(r => String(r.id) === String(chosenId));
      const pick = match || rates.reduce((a, b) => (parseFloat(a.rate) <= parseFloat(b.rate) ? a : b));
      return { id: pick.id, name: pick.name, rate: parseFloat(pick.rate) };
    }
  } catch (_) { /* fall through to flat fallback */ }
  return { ...FLAT_SHIP_FALLBACK };
}

/* ---------------------------------------------------------------------------
   Supabase (server-side, zero-dependency REST)
   - verifyUser: validates the caller's Supabase access token (login is required
     at checkout, so the browser sends Authorization: Bearer <access_token>).
   - The *_admin helpers use the SERVICE-ROLE key and bypass RLS. They are only
     ever called from server functions - never exposed to the browser.
--------------------------------------------------------------------------- */
function supabaseEnv() {
  return {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
}

async function verifyUser(event) {
  const { url, anonKey } = supabaseEnv();
  if (!url || !anonKey) throw new Error('Supabase not configured');
  const hdrs = event.headers || {};
  const auth = hdrs.authorization || hdrs.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

function sbAdminHeaders() {
  const { serviceKey } = supabaseEnv();
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

async function findOrderByPaypalId(paypalOrderId) {
  const { url } = supabaseEnv();
  const res = await fetch(
    `${url}/rest/v1/orders?paypal_order_id=eq.${encodeURIComponent(paypalOrderId)}&select=*`,
    { headers: sbAdminHeaders() }
  );
  if (!res.ok) throw new Error(`order lookup failed ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

/* Insert an order row. The UNIQUE(paypal_order_id) constraint is the real
   idempotency guard: a duplicate insert returns 409, which we treat as
   "already recorded" and swallow (returns null). Returns the stored row. */
async function recordOrder(row) {
  const { url } = supabaseEnv();
  const res = await fetch(`${url}/rest/v1/orders`, {
    method: 'POST',
    headers: { ...sbAdminHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  if (res.status === 409) return null; // duplicate paypal_order_id
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`order insert failed ${res.status}: ${detail}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
   M2 - origin allowlist + best-effort rate limiting (CORS hardening)
--------------------------------------------------------------------------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://caninekeepsakes.co.uk,https://www.caninekeepsakes.co.uk')
  .split(',').map(s => s.trim()).filter(Boolean);

function originHeader(event) {
  const h = event.headers || {};
  return h.origin || h.Origin || '';
}

/* CORS headers for an allowed Origin (used on the OPTIONS preflight). */
function corsHeaders(event) {
  const origin = originHeader(event);
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
  }
  return {};
}

/* Reject requests that carry a *foreign* Origin (browser-driven cross-site
   abuse / CSRF). An absent Origin (same-origin GET, server-to-server, direct
   URL hit) is allowed so we don't break normal use or smoke tests. */
function isOriginAllowed(event) {
  const origin = originHeader(event);
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

/* Best-effort in-memory rate limit. NOTE: serverless instances are ephemeral
   and not shared, so this throttles per warm instance only - it raises the bar
   for casual abuse but is not a hard global limit. For a global limit, back it
   with a store (e.g. Supabase) keyed by IP. */
const _hits = new Map();
function rateLimit(event, max = 30, windowMs = 60000) {
  const h = event.headers || {};
  const ip = (h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || 'unknown')
    .toString().split(',')[0].trim();
  const now = Date.now();
  const rec = _hits.get(ip);
  if (!rec || now > rec.reset) { _hits.set(ip, { count: 1, reset: now + windowMs }); return true; }
  rec.count += 1;
  return rec.count <= max;
}

/* ---------------------------------------------------------------------------
   M4 - print-file URL allowlist. capture-order sends files:[{url}] to Printful
   with a client-supplied URL; restrict it to trusted hosts so a logged-in
   attacker can't make Printful fetch/print an arbitrary URL.
--------------------------------------------------------------------------- */
const PRINT_FILE_HOSTS = (process.env.PRINT_FILE_ALLOWED_HOSTS ||
  'drive.google.com,drive.usercontent.google.com,lh3.googleusercontent.com,caninekeepsakes.co.uk,www.caninekeepsakes.co.uk')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isAllowedPrintFile(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return PRINT_FILE_HOSTS.includes(u.hostname.toLowerCase());
}

const json = (status, body, extraHeaders = {}) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

module.exports = {
  PF_BASE, pfHeaders, paypalBase, paypalToken, priceBasket, json,
  printfulShippingRates, authoritativeShipping, FLAT_SHIP_FALLBACK,
  supabaseEnv, verifyUser, findOrderByPaypalId, recordOrder,
  ALLOWED_ORIGINS, corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile
};
