/* POST /api/shipping-rates (GELATO multi-region version)  { items, recipient }
   Returns the FIXED delivery the customer will be charged for their destination region,
   in local currency, plus whether the basket already qualifies for free delivery.
   Deterministic (display == charge): a flat rate per region, free over the region threshold.
   Gelato's live shipping is COGS and is handled at order creation, not shown to the customer.
   Region-gated and config-driven; no hardcoded countries or rates. */
const { json, corsHeaders, isOriginAllowed, rateLimit } = require('./_lib');
const regions = require('./providers/regions');
const pricing = require('./providers/pricing');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 40, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { items, recipient } = JSON.parse(event.body || '{}');
    if (!items?.length || !recipient?.country_code) return json(400, { error: 'items and recipient.country_code required' });

    const sell = regions.isSellable(recipient.country_code);
    if (!sell.ok) return json(200, { available: false, reason: sell.reason });
    const { region, currency } = sell;
    const cfg = regions.regionConfig(region);

    // authoritative subtotal from the fixed price table -> tests the free-delivery threshold
    let subtotal;
    try { subtotal = pricing.priceBasket(items, currency); }
    catch (e) { return json(400, { error: 'invalid basket — unknown product' }); }

    const ship = pricing.standardShipping(region, subtotal);
    return json(200, {
      available: true, region, currency, symbol: cfg.symbol,
      freeShippingThreshold: cfg.freeShipThreshold,
      subtotal: +subtotal.toFixed(2), freeQualified: ship.free,
      options: [{ id: 'STANDARD', name: ship.name, rate: ship.rate }]
    });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
