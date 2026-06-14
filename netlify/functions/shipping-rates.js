/* POST /api/shipping-rates  { recipient, items } -> Printful shipping rates */
const { printfulShippingRates, json,
  corsHeaders, isOriginAllowed, rateLimit } = require('./_lib');

exports.handler = async (event) => {
  /* M2 - CORS preflight, foreign-origin block, best-effort throttle */
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 30, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { recipient, items } = JSON.parse(event.body || '{}');
    if (!recipient || !items || !items.length) {
      return json(400, { error: 'recipient and items required' });
    }
    const rates = await printfulShippingRates(recipient, items);
    return json(200, rates);
  } catch (err) {
    return json(502, { error: 'Printful rates error', detail: err.message });
  }
};
