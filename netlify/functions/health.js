/* GET /api/health — verifies PayPal + Printful credentials without touching money.
   Safe to leave deployed; returns no secrets. */
const { PF_BASE, pfHeaders, paypalToken, json } = require('./_lib');

exports.handler = async () => {
  const out = { paypal: 'unconfigured', printful: 'unconfigured', env: process.env.PAYPAL_ENV || 'sandbox' };

  try {
    await paypalToken();
    out.paypal = 'OK';
  } catch (e) { out.paypal = `FAIL: ${e.message}`; }

  try {
    const res = await fetch(`${PF_BASE}/stores`, { headers: pfHeaders() });
    const data = await res.json();
    if (res.ok) {
      const store = (data?.result || []).find(s => s.id === 18269364) || data?.result?.[0];
      out.printful = store
        ? `OK — store: ${store.name} (id:${store.id}, type:${store.type || '?'})`
        : 'OK — key valid but Canine Keepsakes store not found';
    } else {
      out.printful = `FAIL: ${res.status} ${JSON.stringify(data?.error || data).slice(0, 200)}`;
    }
  } catch (e) { out.printful = `FAIL: ${e.message}`; }

  return json(200, out);
};
