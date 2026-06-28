/* POST /api/capture-order  (GELATO migration version — replaces the Printful one at swap)
   { orderID, items, shipping, recipient }  — login required (Bearer supabase token).

   Flow (mirrors the proven Printful defensive pattern; never lose a paid order):
     0. idempotency replay
     1. region gate (config-driven: excluded/disabled -> reject BEFORE charging)
     2. capture PayPal
     3. quote Gelato in the customer's currency (authoritative cost + shipping + production country)
     4. re-price server-side: retail = cost / (1 - per-category margin), charm-rounded; + shipping (free over threshold) + tax (config; 0 day one)
     5. verify paid >= expected, else record MANUAL_REVIEW (paid, safe)
     6. create Gelato order (draft until GELATO_LIVE_ORDERS=true), idempotent on ck-<orderID>
     7. record order with provider/currency/production-country/etc.

   Cart item shape (frontend supplies): { itemReferenceId?, gelatoProductUid, printFileUrl, category,
     qty, collectionName, productName, designLabel }  */
const {
  paypalBase, paypalToken, verifyUser, findOrderByPaypalId, recordOrder, json,
  corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile, clampQty, sendBrandedEmail
} = require('./_lib');
const gelato = require('./providers/gelato');
const regions = require('./providers/regions');
const pricing = require('./providers/pricing');
const tax = require('./providers/tax');

const LIVE_ORDERS = process.env.GELATO_LIVE_ORDERS === 'true'; // false -> create drafts (safe) until go-live

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const user = await verifyUser(event);
    if (!user) return json(401, { error: 'login required' });

    const { orderID, items, shipping, recipient } = JSON.parse(event.body || '{}');
    if (!orderID || !items?.length || !recipient) return json(400, { error: 'orderID, items, recipient required' });

    // 0 - idempotency
    let prior = null;
    try { prior = await findOrderByPaypalId(orderID); } catch (e) { console.error('idempotency lookup failed', e.message); }
    if (prior) return json(200, { status: prior.status, fulfilment: prior.fulfilment_status, providerOrderId: prior.provider_order_id || prior.printful_order_id || undefined, idempotent: true });

    // 1 - region gate (before charging)
    const sell = regions.isSellable(recipient.country_code);
    if (!sell.ok) return json(403, { error: 'region not available', reason: sell.reason });
    const region = sell.region, currency = sell.currency;

    const base = { user_id: user.id, paypal_order_id: orderID, provider: 'gelato', region, currency, recipient, items, shipping: shipping || null };

    // 1b - print files must be trusted/public (Gelato fetches them)
    const badFile = items.find(i => !isAllowedPrintFile(i.printFileUrl));
    const missingUid = items.find(i => !i.gelatoProductUid);

    // 2 - capture PayPal
    const token = await paypalToken();
    const capRes = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const capture = await capRes.json();
    if (capture?.status !== 'COMPLETED') return json(402, { status: capture?.status || 'FAILED', detail: capture });
    const paid = parseFloat(capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);

    // confirmation email (non-fatal)
    try {
      await sendBrandedEmail('order', recipient.email, {
        firstName: recipient.first_name, orderRef: orderID,
        total: Number.isFinite(paid) ? `${currency} ${paid.toFixed(2)}` : '',
        items: items.map(i => ({ name: `${i.collectionName} ${i.productName}`, qty: clampQty(i.qty) }))
      });
    } catch (e) { console.error('order email failed (non-fatal)', e.message); }

    // hold paid order if any item can't be fulfilled cleanly
    if (badFile || missingUid) {
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_REVIEW_REQUIRED',
        review_reason: badFile ? 'print file url not allowed' : 'missing gelato product id', paid_amount: paid });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_REVIEW_REQUIRED' });
    }

    // 3 - quote Gelato (authoritative)
    const qItems = items.map((i, idx) => ({ itemReferenceId: String(i.itemReferenceId || idx + 1), gelatoProductUid: i.gelatoProductUid, printFileUrl: i.printFileUrl, quantity: clampQty(i.qty) }));
    let quote;
    try { quote = await gelato.quote({ items: qItems, recipient, currency }); }
    catch (e) { quote = { ok: false, error: e.message }; }
    if (!quote.ok) {
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_FOLLOWUP_REQUIRED', review_reason: 'gelato quote failed', paid_amount: paid });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_FOLLOWUP_REQUIRED', reason: 'quote failed' });
    }

    // 4 - authoritative expected = FIXED per-currency price table + flat delivery + tax.
    //     This is the SAME table the storefront showed, so charge == what the customer saw.
    //     Gelato's quote is COGS + production country + the shipmentMethod we fulfil with.
    let subtotal;
    try { subtotal = pricing.priceBasket(items, currency); }
    catch (e) {
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_REVIEW_REQUIRED', review_reason: 'unknown product at capture', paid_amount: paid });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_REVIEW_REQUIRED', reason: 'unknown product' });
    }
    const ship = pricing.standardShipping(region, subtotal);
    const chosen = (quote.shippingOptions || []).find(s => s.uid === (shipping && shipping.id)) || quote.cheapestShipping;
    const cogsShip = chosen ? chosen.price : null;       // our Gelato delivery cost (COGS), for margin records
    const taxRes = await tax.computeTax({ region, address: recipient, subtotalLocal: subtotal + ship.rate });
    const expected = +(subtotal + ship.rate + (taxRes.amount || 0)).toFixed(2);

    // 5 - verify paid
    if (!Number.isFinite(paid) || paid + 0.01 < expected) {
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_REVIEW_REQUIRED', review_reason: 'amount mismatch', paid_amount: Number.isFinite(paid) ? paid : null, expected_amount: expected });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_REVIEW_REQUIRED', reason: 'amount mismatch', paid, expected });
    }

    // 6 - create Gelato order (draft until go-live)
    let res;
    try { res = await gelato.createOrder({ ref: `ck-${orderID}`, items: qItems, recipient, currency, shipmentMethodUid: chosen && chosen.uid, orderType: LIVE_ORDERS ? 'order' : 'draft' }); }
    catch (e) { res = { ok: false, error: e.message }; }
    if (!res.ok) {
      await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: 'MANUAL_FOLLOWUP_REQUIRED', review_reason: 'gelato order create failed', paid_amount: paid, expected_amount: expected });
      return json(200, { status: 'COMPLETED', fulfilment: 'MANUAL_FOLLOWUP_REQUIRED', detail: res.error });
    }

    // 7 - record success
    await recordOrder({ ...base, status: 'COMPLETED', fulfilment_status: LIVE_ORDERS ? 'ORDER_CREATED' : 'DRAFT_CREATED',
      provider_order_id: res.providerOrderId ? String(res.providerOrderId) : null,
      production_country: quote.productionCountry || null, paid_amount: paid, expected_amount: expected,
      shipment_method: chosen ? chosen.uid : null });
    return json(200, { status: 'COMPLETED', providerOrderId: res.providerOrderId, fulfilment: LIVE_ORDERS ? 'ORDER_CREATED' : 'DRAFT_CREATED' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
