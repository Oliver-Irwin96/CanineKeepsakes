/* GET /api/paypal-config — returns public PayPal client ID for SDK loading.
   Client ID is intentionally public (it's the browser-facing key) but we
   keep it server-side to avoid Netlify's secret scanner blocking deploys. */
const { json, isOriginAllowed, rateLimit } = require('./_lib');

exports.handler = async (event) => {
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) return json(500, { error: 'PayPal not configured' });
  return json(200, { clientId });
};
