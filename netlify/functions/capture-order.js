/* POST /api/capture-order  { orderID, items, shipping, recipient }
   Requires a signed-in customer (Authorization: Bearer <supabase access token>).
   1. Idempotency: if this PayPal order was already processed, return the stored result
   2. Captures the PayPal payment
   3. Reconciles paid amount vs a fresh server price (H2)
   4. Records the order in Supabase (incl. manual-review cases - H2 logging home)
   5. Creates a Printful order as DRAFT (confirm: false) - manual confirm at launch
   Print files must be at public URLs at order time (Drive direct-download links for now). */
const {
  PF_BASE, pfHeaders, paypalBase, paypalToken, priceBasket, authoritativeShipping,
  verifyUser, findOrderByPaypalId, recordOrder, json,
  corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile
} = require('./_lib');

async function resolveVariantId(catalogProductId, colour, size) {
  const res = await fetch(`${PF_BASE}/products/${catalogProductId}`, { headers: pfHeaders() });
  if (!res.ok) throw new Error(`catalog lookup failed for ${catalogProductId}`);
  const data = await res.json();
  const variants = data?.result?.variants || [];
  const norm = s => (s || '').toLowerCase().trim();
  const match = variants.find(v => norm(v.color) === norm(colour) && norm(v.size) === norm(size))
    || variants.find(v => norm(v.color) === norm(colour))
    || variants[0];
  if (!match) throw new Error(`no variant for ${catalogProductId} ${colour}/${size}`);
  return match.id;
}

exports.handler = async (event) => {
  /* M2 - CORS preflight, foreign-origin block, best-effort throttle */
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    /* Login required: reject anonymous callers. */
    const user = await verifyUser(event);
    if (!user) return json(401, { error: 'login required' });

    const { orderID, items, shipping, recipient } = JSON.parse(event.body || '{}');
    if (!orderID || !items?.length || !recipient) return json(400, { error: 'orderID, items, recipient required' });

    /* 0 - idempotency (M3): if we already processed this PayPal order, replay the
       stored outcome instead of capturing / drafting again. */
    let prior = null;
    try { prior = await findOrderByPaypalId(orderID); } catch (e) { console.error('idempotency lookup failed', e.message); }
    if (prior) {
      return json(200, {
        status: prior.status,
        fulfilment: prior.fulfilment_status,
        printfulOrderId: prior.printful_order_id || undefined,
        idempotent: true
      });
    }

    /* base record fields reused across every terminal branch below */
    const base = {
      user_id: user.id,
      paypal_order_id: orderID,
      currency: 'GBP',
      recipient,
      items,
      shipping: shipping || null
    };

    /* 1 - capture PayPal payment */
    const token = await paypalToken();
    const capRes = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const capture = await capRes.json();
    const status = capture?.status;
    if (status !== 'COMPLETED') return json(402, { status: status || 'FAILED', detail: capture });

    /* 1b - H2 fix: reconcile what was PAID against a fresh server price. */
    const paid = parseFloat(
      capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value
    );
    let expected;
    try {
      const subtotal = priceBasket(items);
      const ship = await authoritativeShipping(recipient, items, shipping?.id);
      expected = subtotal + ship.rate;
    } catch (e) {
      console.error('RECONCILE PRICING FAILED - holding for manual review', e.message);
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_REVIEW_REQUIRED',
        review_reason: 'could not re-price order', paid_amount: Number.isFinite(paid) ? paid : null });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_REVIEW_REQUIRED', reason: 'could not re-price order' });
    }
    if (!Number.isFinite(paid) || paid + 0.01 < expected) {
      console.error(`AMOUNT MISMATCH - paid GBP ${paid} but order worth GBP ${expected.toFixed(2)}; draft NOT created`);
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_REVIEW_REQUIRED',
        review_reason: 'amount mismatch', paid_amount: Number.isFinite(paid) ? paid : null,
        expected_amount: +expected.toFixed(2) });
      return json(200, {
        status: 'COMPLETED',
        fulfilment: 'MANUAL_REVIEW_REQUIRED',
        reason: 'amount mismatch',
        paid: Number.isFinite(paid) ? paid : null,
        expected: +expected.toFixed(2)
      });
    }

    /* M4 - never hand Printful an untrusted/missing file URL. Payment already
       captured, so hold for manual review rather than printing a bad URL. */
    const badFile = items.find(i => !isAllowedPrintFile(i.printFileUrl));
    if (badFile) {
      console.error('BLOCKED untrusted/missing print file url', badFile && badFile.printFileUrl);
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_REVIEW_REQUIRED',
        review_reason: 'print file url not allowed', paid_amount: paid, expected_amount: +expected.toFixed(2) });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_REVIEW_REQUIRED', reason: 'print file url not allowed' });
    }

    /* 2 - create Printful DRAFT order (raw design file until mockup pipeline ships) */
    const pfItems = [];
    for (const i of items) {
      const variant_id = await resolveVariantId(i.catalogProductId, i.colour, i.size);
      pfItems.push({
        variant_id,
        quantity: Math.max(1, parseInt(i.qty) || 1),
        name: `${i.collectionName} - ${i.productName} (${i.designLabel})`,
        files: [{ url: i.printFileUrl }]
      });
    }

    const pfRes = await fetch(`${PF_BASE}/orders`, {
      method: 'POST',
      headers: pfHeaders(),
      body: JSON.stringify({
        external_id: `ck-${orderID}`,
        recipient: {
          name: `${recipient.first_name} ${recipient.last_name}`,
          email: recipient.email,
          address1: recipient.address1,
          address2: recipient.address2 || '',
          city: recipient.city,
          zip: recipient.zip,
          country_code: 'GB'
        },
        items: pfItems,
        shipping: shipping?.id || 'STANDARD',
        confirm: false
      })
    });
    const pfData = await pfRes.json();
    if (!pfRes.ok) {
      console.error('PRINTFUL DRAFT FAILED after successful capture', pfData);
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_FOLLOWUP_REQUIRED',
        review_reason: 'printful draft failed', paid_amount: paid, expected_amount: +expected.toFixed(2) });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_FOLLOWUP_REQUIRED', detail: pfData });
    }

    const printfulOrderId = pfData?.result?.id;
    await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'DRAFT_CREATED',
      printful_order_id: printfulOrderId ? String(printfulOrderId) : null,
      paid_amount: paid, expected_amount: +expected.toFixed(2) });
    return json(200, { status: 'COMPLETED', printfulOrderId, fulfilment: 'DRAFT_CREATED' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
