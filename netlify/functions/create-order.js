/* POST /api/create-order  { items, shipping, recipient } -> creates PayPal order, returns { id }
   Requires a signed-in customer (Authorization: Bearer <supabase access token>).
   Total is computed SERVER-SIDE: prices from the table, shipping re-fetched live
   from Printful. Client-supplied prices AND shipping rate are ignored. */
const { paypalBase, paypalToken, priceBasket, authoritativeShipping, verifyUser, json,
  corsHeaders, isOriginAllowed, rateLimit } = require('./_lib');

exports.handler = async (event) => {
  /* M2 - CORS preflight, foreign-origin block, best-effort throttle */
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    /* Login required: reject anonymous callers before doing any work. */
    const user = await verifyUser(event);
    if (!user) return json(401, { error: 'login required' });

    const { items, shipping, recipient } = JSON.parse(event.body || '{}');
    if (!items?.length) return json(400, { error: 'empty basket' });
    if (!recipient?.address1 || !recipient?.zip) return json(400, { error: 'recipient address required' });

    /* Validate basket server-side: an unknown/tampered productSlug is a clean 400,
       not a 500. */
    let subtotal;
    try { subtotal = priceBasket(items); }
    catch (e) { return json(400, { error: 'invalid basket — unknown product' }); }
    /* H1 fix - never trust shipping.rate from the browser; re-derive it. */
    const ship = await authoritativeShipping(recipient, items, shipping?.id);
    const shipCost = ship.rate;
    const total = (subtotal + shipCost).toFixed(2);

    const token = await paypalToken();
    const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'GBP',
            value: total,
            breakdown: {
              item_total: { currency_code: 'GBP', value: subtotal.toFixed(2) },
              shipping: { currency_code: 'GBP', value: shipCost.toFixed(2) }
            }
          },
          description: 'Canine Keepsakes order'
        }]
      })
    });
    const data = await res.json();
    if (!res.ok) return json(502, { error: 'PayPal create failed', detail: data });
    return json(200, { id: data.id });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
