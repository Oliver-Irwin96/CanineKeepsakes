/* POST /api/capture-order  { orderID, items, shipping, recipient }
   1. Captures the PayPal payment
   2. Creates a Printful order as DRAFT (confirm: false) — manual confirm at launch
   Print files must be at public URLs at order time (Drive direct-download links for now). */
const { PF_BASE, pfHeaders, paypalBase, paypalToken, json } = require('./_lib');

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
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { orderID, items, shipping, recipient } = JSON.parse(event.body || '{}');
    if (!orderID || !items?.length || !recipient) return json(400, { error: 'orderID, items, recipient required' });

    /* 1 ─ capture PayPal payment */
    const token = await paypalToken();
    const capRes = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const capture = await capRes.json();
    const status = capture?.status;
    if (status !== 'COMPLETED') return json(402, { status: status || 'FAILED', detail: capture });

    /* 2 ─ create Printful DRAFT order */
    const pfItems = [];
    for (const i of items) {
      const variant_id = await resolveVariantId(i.catalogProductId, i.colour, i.size);
      pfItems.push({
        variant_id,
        quantity: Math.max(1, parseInt(i.qty) || 1),
        name: `${i.collectionName} — ${i.productName} (${i.designLabel})`,
        files: [{ url: i.printFileUrl }]
        // NOTE: left-chest placement uses the pre-composited print file
        // (Sharp 35%/8%/5% formula) — compositing service is the mockup
        // pipeline's job; raw design file used until that ships.
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
        confirm: false   // DRAFT — Oliver confirms manually in Printful dashboard
      })
    });
    const pfData = await pfRes.json();
    if (!pfRes.ok) {
      // Payment captured but fulfilment draft failed — surface loudly for manual fix.
      console.error('PRINTFUL DRAFT FAILED after successful capture', pfData);
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_FOLLOWUP_REQUIRED', detail: pfData });
    }
    return json(200, { status: 'COMPLETED', printfulOrderId: pfData?.result?.id, fulfilment: 'DRAFT_CREATED' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
