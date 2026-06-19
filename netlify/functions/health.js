/* GET /api/health — verifies PayPal + Printful credentials without touching money.
   Returns no secrets. Hardened: throttled + origin-gated so it can't be hammered
   (each call hits PayPal + Printful upstream), and it no longer leaks the store
   name/id or raw upstream error bodies — just OK / FAIL + the environment. */
const { PF_BASE, pfHeaders, paypalToken, json, isOriginAllowed, rateLimit } = require('./_lib');

exports.handler = async (event) => {
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 6, 60000)) return json(429, { error: 'too many requests' });

  const out = { paypal: 'unconfigured', printful: 'unconfigured', env: process.env.PAYPAL_ENV || 'sandbox' };

  try {
    await paypalToken();
    out.paypal = 'OK';
  } catch (_) { out.paypal = 'FAIL'; }

  try {
    const res = await fetch(`${PF_BASE}/stores`, { headers: pfHeaders() });
    out.printful = res.ok ? 'OK' : `FAIL: ${res.status}`;
  } catch (_) { out.printful = 'FAIL'; }

  return json(200, out);
};
