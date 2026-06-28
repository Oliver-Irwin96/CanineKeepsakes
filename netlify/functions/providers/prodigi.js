/* Prodigi Print API v4 adapter (Phase 2 — staged, server-side only, untested until sandbox key).
   Env: PRODIGI_API_KEY (sandbox or live), PRODIGI_ENV ("sandbox"|"live").
   CK item shape expected: { providerSku, qty, printFileUrl, sizing?, attributes?, retailPrice? } */
const crypto = require('crypto');
const ENV = (process.env.PRODIGI_ENV || 'sandbox').toLowerCase();
const BASE = ENV === 'live' ? 'https://api.prodigi.com/v4.0' : 'https://api.sandbox.prodigi.com/v4.0';
const KEY = (ENV === 'live'
  ? (process.env.PRODIGI_LIVE_API_KEY || process.env.PRODIGI_API_KEY)
  : (process.env.PRODIGI_SANDBOX_API_KEY || process.env.PRODIGI_API_KEY));

function headers() {
  if (!KEY) throw new Error(`Prodigi key missing for env '${ENV}' (expected ${ENV==='live'?'PRODIGI_LIVE_API_KEY':'PRODIGI_SANDBOX_API_KEY'})`);
  return { 'X-API-Key': KEY, 'Content-Type': 'application/json' };
}
function toRecipient(r) {
  return { name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.name, email: r.email, phoneNumber: r.phone || null,
    address: { line1: r.address1, line2: r.address2 || '', postalOrZipCode: r.zip, countryCode: r.country_code || 'GB',
      townOrCity: r.city, stateOrCounty: r.state || null } }; }
function toItems(items) {
  return items.map((i, n) => ({ merchantReference: `item-${n + 1}`, sku: i.providerSku, copies: Math.max(1, parseInt(i.qty) || 1),
    sizing: i.sizing || 'fitPrintArea', attributes: i.attributes || {}, assets: [{ printArea: 'default', url: i.printFileUrl }] })); }

/* Price + shipping without creating an order — call before checkout. */
async function quote(items, recipient, shippingMethod) {
  const body = { shippingMethod: shippingMethod || undefined, destinationCountryCode: (recipient && (recipient.country_code || 'GB')),
    currencyCode: 'GBP', items: toItems(items).map(({ merchantReference, ...rest }) => rest) };
  const res = await fetch(`${BASE}/quotes`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* Create a Prodigi order. idempotencyKey defaults to a CK-scoped GUID from the PayPal order id. */
async function createOrder({ items, recipient, shippingMethod, idempotencyKey, merchantReference, metadata }) {
  const body = { merchantReference: merchantReference || null, shippingMethod: shippingMethod || 'Standard',
    idempotencyKey: idempotencyKey || crypto.randomUUID(), recipient: toRecipient(recipient), items: toItems(items), metadata: metadata || {} };
  const res = await fetch(`${BASE}/Orders`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, outcome: data.outcome, orderId: data.order && data.order.id, data };
}

async function getOrder(id) {
  const res = await fetch(`${BASE}/orders/${encodeURIComponent(id)}`, { headers: headers() });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
module.exports = { quote, createOrder, getOrder, ENV, BASE };
