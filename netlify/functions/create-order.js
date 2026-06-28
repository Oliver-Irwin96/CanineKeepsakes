/* POST /api/create-order  (GELATO multi-region version — replaces the Printful one at swap)
   { items, shipping, recipient } -> creates a PayPal order in the customer's REGIONAL CURRENCY,
   returns { id, currency }. Login required (Authorization: Bearer <supabase access token>).

   Proper multi-currency, no shortcuts:
     - currency is derived SERVER-SIDE from the shipping country (regions.isSellable),
       never trusted from the browser.
     - amount is computed SERVER-SIDE from the FIXED per-currency price table
       (pricing.priceBasket) + fixed flat delivery (pricing.standardShipping) + tax.
       This is the SAME table the storefront displays, so charge == what the customer saw.
     - region not sellable -> 403 before any PayPal call. */
const { paypalBase, paypalToken, verifyUser, json, corsHeaders, isOriginAllowed, rateLimit } = require('./_lib');
const regions = require('./providers/regions');
const pricing = require('./providers/pricing');
const tax = require('./providers/tax');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const user = await verifyUser(event);
    if (!user) return json(401, { error: 'login required' });

    const { items, shipping, recipient } = JSON.parse(event.body || '{}');
    if (!items?.length) return json(400, { error: 'empty basket' });
    if (!recipient?.address1 || !recipient?.zip) return json(400, { error: 'recipient address required' });

    // currency + region from the shipping country (authoritative; rejects disabled/excluded)
    const sell = regions.isSellable(recipient.country_code);
    if (!sell.ok) return json(403, { error: 'region not available', reason: sell.reason });
    const { region, currency } = sell;

    // authoritative amount in the regional currency (fixed price table; client prices ignored)
    let subtotal;
    try { subtotal = pricing.priceBasket(items, currency); }
    catch (e) { return json(400, { error: 'invalid basket — unknown product' }); }
    const ship = pricing.standardShipping(region, subtotal);
    const taxRes = await tax.computeTax({ region, address: recipient, subtotalLocal: subtotal + ship.rate });
    const taxAmt = taxRes.amount || 0;
    const total = +(subtotal + ship.rate + taxAmt).toFixed(2);

    const token = await paypalToken();
    const breakdown = {
      item_total: { currency_code: currency, value: subtotal.toFixed(2) },
      shipping:   { currency_code: currency, value: ship.rate.toFixed(2) }
    };
    if (taxAmt > 0) breakdown.tax_total = { currency_code: currency, value: taxAmt.toFixed(2) };

    const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: currency, value: total.toFixed(2), breakdown },
          description: 'Canine Keepsakes order'
        }]
      })
    });
    const data = await res.json();
    if (!res.ok) return json(502, { error: 'PayPal create failed', detail: data });
    return json(200, { id: data.id, currency });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
