/* Gelato provider adapter — Phase 3 (full-site migration target).
   Server-side only. Reads GELATO_API_SECRET. Never expose the key to the browser.

   Implements the common provider interface used by providers/_registry.js:
     quote({ items, recipient, currency })      -> { ok, itemCost, shippingOptions, productionCountry }
     createOrder({ ref, items, recipient, currency, shipmentMethodUid }) -> { ok, providerOrderId, status }
     getOrder(id)                                -> { ok, status, raw }

   Gelato APIs:
     Product catalog : https://product.gelatoapis.com/v3
     Order/quote     : https://order.gelatoapis.com/v4   (orders:quote, orders)
   Auth header: X-API-KEY

   Golden rules (CK_Fulfilment_Research_Pack):
     - quote before order (server-side) for price + shipping
     - idempotency: pass a stable orderReferenceId (ck-<paypalOrderId>)
     - artwork via public URL (cdn.caninekeepsakes.co.uk), high-res master (.png)
     - never throw past a captured payment: caller records the order regardless
*/
'use strict';

const KEY = process.env.GELATO_API_SECRET || process.env.GELATO_API_KEY;
const PRODUCT_BASE = 'https://product.gelatoapis.com/v3';
const ORDER_BASE = 'https://order.gelatoapis.com/v4';

function H(extra) { return Object.assign({ 'X-API-KEY': KEY, 'Content-Type': 'application/json' }, extra || {}); }
function assertKey() { if (!KEY) throw new Error('GELATO_API_SECRET not configured'); }

async function api(url, init) {
  const r = await fetch(url, init || { headers: H() });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, data };
}

/* Build the Gelato recipient block. Gelato requires a country-appropriate address;
   stateCode is required for US/CA/AU. */
function gelatoRecipient(r) {
  const out = {
    firstName: r.first_name, lastName: r.last_name,
    addressLine1: r.address1, addressLine2: r.address2 || '',
    city: r.city, postCode: r.zip, country: (r.country_code || 'GB').toUpperCase(),
    email: r.email, phone: r.phone || undefined
  };
  if (r.state) out.state = r.state;
  return out;
}

/* items: [{ gelatoProductUid, quantity, printFileUrl }] (mapped upstream from CK catalog) */
function gelatoProducts(items) {
  return items.map((i, idx) => ({
    itemReferenceId: String(i.itemReferenceId || idx + 1),
    productUid: i.gelatoProductUid,
    fileUrl: i.printFileUrl,
    quantity: Math.max(1, parseInt(i.quantity) || 1)
  }));
}

/* Quote: returns the cheapest standard shipping + item cost + where it prints. */
async function quote({ items, recipient, currency = 'GBP' }) {
  assertKey();
  const body = {
    orderReferenceId: 'ck-quote',
    customerReferenceId: 'ck',
    currency,
    recipient: gelatoRecipient(recipient),
    products: gelatoProducts(items)
  };
  const res = await api(`${ORDER_BASE}/orders:quote`, { method: 'POST', headers: H(), body: JSON.stringify(body) });
  if (!res.ok) return { ok: false, status: res.status, error: res.data };
  const q = (res.data.quotes || [])[0] || {};
  const itemCost = (q.products || []).reduce((s, p) => s + (Number(p.price) || 0), 0);
  const shipping = (q.shipmentMethods || [])
    .map(m => ({ uid: m.shipmentMethodUid, name: m.name, price: Number(m.price), currency: m.currency, minDays: m.minDeliveryDays, maxDays: m.maxDeliveryDays }))
    .filter(m => Number.isFinite(m.price))
    .sort((a, b) => a.price - b.price);
  const products = (q.products || []).map(p => ({ itemReferenceId: String(p.itemReferenceId), price: Number(p.price), currency: p.currency }));
  return { ok: true, itemCost, currency, products, shippingOptions: shipping, cheapestShipping: shipping[0] || null,
           productionCountry: q.productionCountry, fulfillmentCountry: q.fulfillmentCountry };
}

/* Create a real order. Mirrors Printful capture-order pattern: quote-driven, idempotent. */
async function createOrder({ ref, items, recipient, currency = 'GBP', shipmentMethodUid, orderType = 'draft' }) {
  assertKey();
  const body = {
    orderType,                             // 'draft' (safe, manual confirm) until go-live, then 'order'
    orderReferenceId: ref,                 // ck-<paypalOrderId> -> Gelato dedupes on this
    customerReferenceId: 'ck',
    currency,
    recipient: gelatoRecipient(recipient),
    products: gelatoProducts(items)
  };
  if (shipmentMethodUid) body.shipmentMethodUid = shipmentMethodUid;
  const res = await api(`${ORDER_BASE}/orders`, { method: 'POST', headers: H(), body: JSON.stringify(body) });
  if (!res.ok) return { ok: false, status: res.status, error: res.data };
  return { ok: true, providerOrderId: res.data.id, status: res.data.fulfillmentStatus || res.data.orderStatus || 'created', raw: res.data };
}

async function getOrder(id) {
  assertKey();
  const res = await api(`${ORDER_BASE}/orders/${encodeURIComponent(id)}`);
  return { ok: res.ok, status: res.data && (res.data.fulfillmentStatus || res.data.orderStatus), raw: res.data };
}

/* Item price only (no shipping), per country — for catalog/pricing builds. */
async function itemPrice(gelatoProductUid, country, currency) {
  assertKey();
  const cc = country ? `?country=${encodeURIComponent(country)}${currency ? `&currency=${encodeURIComponent(currency)}` : ''}` : '';
  const res = await api(`${PRODUCT_BASE}/products/${encodeURIComponent(gelatoProductUid)}/prices${cc}`);
  return res.data;
}

module.exports = { name: 'gelato', quote, createOrder, getOrder, itemPrice };
