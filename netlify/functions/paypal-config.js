/* GET /api/paypal-config — returns public PayPal client ID for SDK loading.
   Client ID is intentionally public (it's the browser-facing key) but we
   keep it server-side to avoid Netlify's secret scanner blocking deploys. */
const { json } = require('./_lib');

exports.handler = async () => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) return json(500, { error: 'PayPal not configured' });
  return json(200, { clientId });
};
