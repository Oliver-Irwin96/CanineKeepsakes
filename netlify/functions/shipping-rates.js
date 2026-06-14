/* POST /api/shipping-rates  { recipient, items } -> Printful shipping rates */
const { printfulShippingRates, json } = require('./_lib');

exports.handler = async (event) => {
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
