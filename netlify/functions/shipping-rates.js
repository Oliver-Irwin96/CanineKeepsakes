/* POST /api/shipping-rates  { recipient, items } → Printful shipping rates */
const { PF_BASE, pfHeaders, json } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { recipient, items } = JSON.parse(event.body || '{}');
    if (!recipient || !items?.length) return json(400, { error: 'recipient and items required' });

    // Printful rates accept catalog variant or product-level estimation.
    // We resolve variant_id at capture time; for rates, quantity + catalog product is enough
    // via the first variant of each catalog product (close enough for UK apparel rates).
    const body = {
      recipient: {
        address1: recipient.address1,
        city: recipient.city,
        country_code: 'GB',
        zip: recipient.zip
      },
      items: items.map(i => ({
        // variant lookup happens at order time; estimate with quantity only requires variant_id,
        // so we pass external catalog product + qty via "catalog product first variant" resolved below.
        quantity: Math.max(1, parseInt(i.qty) || 1),
        catalog_product_id: i.catalogProductId
      })),
      currency: 'GBP',
      locale: 'en_GB'
    };

    // Resolve a representative variant_id per catalog product (first UK-sellable variant)
    const resolved = [];
    for (const item of body.items) {
      const res = await fetch(`${PF_BASE}/products/${item.catalog_product_id}`, { headers: pfHeaders() });
      if (!res.ok) throw new Error(`catalog lookup failed for ${item.catalog_product_id}`);
      const data = await res.json();
      const v = data?.result?.variants?.[0];
      if (!v) throw new Error(`no variants for product ${item.catalog_product_id}`);
      resolved.push({ variant_id: v.id, quantity: item.quantity });
    }

    const ratesRes = await fetch(`${PF_BASE}/shipping/rates`, {
      method: 'POST',
      headers: pfHeaders(),
      body: JSON.stringify({ recipient: body.recipient, items: resolved, currency: 'GBP', locale: 'en_GB' })
    });
    if (!ratesRes.ok) {
      const t = await ratesRes.text();
      return json(502, { error: 'Printful rates error', detail: t });
    }
    const rates = await ratesRes.json();
    return json(200, rates.result);
  } catch (err) {
    return json(500, { error: err.message });
  }
};
