/* POST /api/create-order  { items, shipping } → creates PayPal order, returns { id }
   Total is computed SERVER-SIDE from the price table — client totals ignored. */
const { paypalBase, paypalToken, priceBasket, json } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const { items, shipping } = JSON.parse(event.body || '{}');
    if (!items?.length) return json(400, { error: 'empty basket' });

    const subtotal = priceBasket(items);
    const shipCost = Math.max(0, parseFloat(shipping?.rate) || 0);
    const total = (subtotal + shipCost).toFixed(2);

    const token = await paypalToken();
    const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'GBP',
            value: total,
            breakdown: {
              item_total: { currency_code: 'GBP', value: subtotal.toFixed(2) },
              shipping: { currency_code: 'GBP', value: shipCost.toFixed(2) }
            }
          },
          description: 'Canine Keepsakes order'
        }]
      })
    });
    const data = await res.json();
    if (!res.ok) return json(502, { error: 'PayPal create failed', detail: data });
    return json(200, { id: data.id });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
