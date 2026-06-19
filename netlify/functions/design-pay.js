/* POST /api/design-pay  — upfront payment for the Custom Dog Conversion service.
   Body:
     { action:'create', addons }                         -> { id, amount }
     { action:'capture', orderID, addons, submission }    -> { status, paypalOrderId, amount, submissionId }
   Price is computed SERVER-SIDE from the chosen add-ons — the browser never sets it.
   On a COMPLETED capture the SERVER (not the browser) records the design_submissions
   row via the service-role key, stamped with the VERIFIED PayPal order id + captured
   amount, and sends the confirmation email. This closes the integrity hole where the
   browser self-reported status:'paid'/amount for a row RLS would happily accept.
   The photo is uploaded to storage by the browser first; only its path is passed here. */
const {
  paypalBase, paypalToken, json, corsHeaders, isOriginAllowed, rateLimit,
  verifyUser, findDesignByPaypalId, recordDesignSubmission, sendBrandedEmail
} = require('./_lib');

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

const gbp = n => '£' + Number(n).toFixed(2);
const clean = (s, max = 500) => (s == null ? null : String(s).trim().slice(0, max) || null);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 30, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { action, addons, orderID, submission } = JSON.parse(event.body || '{}');
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
      const s = submission || {};
      if (!s.email || !s.name) return json(400, { error: 'submission name and email required' });

      /* Idempotency: if we already recorded this PayPal order, replay it. */
      let prior = null;
      try { prior = await findDesignByPaypalId(orderID); } catch (e) { console.error('design idempotency lookup failed', e.message); }
      if (prior) {
        return json(200, { status: 'COMPLETED', paypalOrderId: orderID, amount: prior.amount_paid, submissionId: prior.id, idempotent: true });
      }

      /* Capture the payment (server-authoritative). */
      const token = await paypalToken();
      const res = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      const capture = await res.json();
      if (capture.status !== 'COMPLETED') return json(402, { status: capture.status || 'FAILED', detail: capture });
      const paid = parseFloat(capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);
      const paidOk = Number.isFinite(paid) && paid + 0.01 >= expected;

      /* Optional ownership: stamp the row with the buyer's account if signed in. */
      let userId = null;
      try { const u = await verifyUser(event); if (u) userId = u.id; } catch (_) {}

      /* Record the row server-side. status reflects the verified payment, not a
         browser claim. A short-paid capture is still recorded but flagged. */
      const row = {
        user_id: userId,
        name: clean(s.name, 120),
        email: clean(s.email, 200),
        dog_name: clean(s.dog_name, 120),
        breed: clean(s.breed, 120),
        collection_slug: clean(s.collection_slug, 120),
        notes: clean(s.notes, 2000),
        photo_path: clean(s.photo_path, 300),
        paypal_order_id: orderID,
        amount_paid: Number.isFinite(paid) ? paid : null,
        currency: 'GBP',
        addons: addons || {},
        status: paidOk ? 'paid' : 'review_underpaid'
      };
      let stored = null;
      try {
        stored = await recordDesignSubmission(row);
      } catch (e) {
        /* Payment captured but we couldn't persist — surface a clear ref so support can recover. */
        console.error('DESIGN RECORD FAILED after capture', e.message);
        return json(200, { status: 'COMPLETED', paypalOrderId: orderID, amount: Number.isFinite(paid) ? paid : expected, recordFailed: true });
      }

      /* Confirmation email, server-side, to the email on the verified submission. */
      try {
        await sendBrandedEmail('design', row.email, {
          dogName: row.dog_name, collection: clean(s.collection_name, 160) || 'your chosen design', total: gbp(row.amount_paid != null ? row.amount_paid : expected)
        });
      } catch (e) { console.error('design email send failed (non-fatal)', e.message); }

      return json(200, {
        status: 'COMPLETED',
        paypalOrderId: orderID,
        amount: Number.isFinite(paid) ? paid : expected,
        submissionId: stored ? stored.id : null
      });
    }

    return json(400, { error: "action must be 'create' or 'capture'" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
