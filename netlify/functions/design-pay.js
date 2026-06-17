/* POST /api/design-pay  — upfront payment for the Custom Dog Conversion service.
   Body: { action: 'create' | 'capture', addons: {extraDog,extraRevision,priority}, orderID? }
   Price is computed SERVER-SIDE from the chosen add-ons — the browser never sets it.
   No DB write here: after a COMPLETED capture the browser uploads the photo and
   inserts the submission row (RLS allows that) stamped with the PayPal order id + amount. */
const { paypalBase, paypalToken, json, corsHeaders, isOriginAllowed, rateLimit } = require('./_lib');

const BASE = parseFloat(process.env.DESIGN_FEE_GBP || '9.99');
const EXTRA_DOG = parseFloat(process.env.DESIGN_FEE_EXTRA_DOG || '6.99');
const EXTRA_REVISION = parseFloat(process.env.DESIGN_FEE_EXTRA_REVISION || '3.99');
const PRIORITY = parseFloat(process.env.DESIGN_FEE_PRIORITY || '6.99');

function amountFor(addons) {
  const a = addons || {};
  let total = BASE
    + (a.extraDog ? EXTRA_DOG : 0)
    + (a.extraRevision ? EXTRA_REVISION : 0)
    + (a.priority ? PRIORITY : 0);
  return Math.round(total * 100) / 100;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 30, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { action, addons, orderID } = JSON.parse(event.body || '{}');
    const expected = amountFor(addons);

    if (action === 'create') {
      const token = await paypalToken();
      const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            amount: { currency_code: 'GBP', value: expected.toFixed(2) },
            description: 'Canine Keepsakes — custom dog conversion'
          }]
        })
      });
      const data = await res.json();
      if (!res.ok) return json(502, { error: 'PayPal create failed', detail: data });
      return json(200, { id: data.id, amount: expected });
    }

    if (action === 'capture') {
      if (!orderID) return json(400, { error: 'orderID required' });
      const token = await paypalToken();
      const res = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      const capture = await res.json();
      if (capture.status !== 'COMPLETED') return json(402, { status: capture.status || 'FAILED', detail: capture });
      const paid = parseFloat(capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);
      return json(200, { status: 'COMPLETED', paypalOrderId: orderID, amount: Number.isFinite(paid) ? paid : expected, expected });
    }

    return json(400, { error: "action must be 'create' or 'capture'" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
