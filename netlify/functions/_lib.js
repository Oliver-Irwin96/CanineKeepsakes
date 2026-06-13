/* Shared helpers for CK Netlify functions */
const PF_BASE = 'https://api.printful.com';

/* Canine Keepsakes store ID — general API key covers 19 stores, this scopes all
   calls to the right one. Set PRINTFUL_STORE_ID env var to override. */
const CK_STORE_ID = process.env.PRINTFUL_STORE_ID || '18269364';

function pfHeaders() {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error('PRINTFUL_API_KEY not configured');
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-PF-Store-Id': CK_STORE_ID
  };
}

function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function paypalToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal credentials not configured');
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

/* Server-side price table — NEVER trust client prices.
   Mirror of data/products.json retail prices. */
const PRICES = {
  'summer-tee': 24.99, 'summer-long-sleeve': 29.99, 'winter-tee': 27.99,
  'winter-long-sleeve': 29.99, 'sweatshirt': 34.99, 'hoodie': 39.99,
  'zip-hoodie': 44.99, 'womens-relaxed-tee': 26.99, 'white-mug': 14.99,
  'black-mug': 14.99, 'pet-bowl': 17.99, 'stickers': 4.99, 'throw-blanket': 79.99
};

function priceBasket(items) {
  return items.reduce((sum, i) => {
    const p = PRICES[i.productSlug];
    if (p == null) throw new Error(`Unknown product: ${i.productSlug}`);
    return sum + p * Math.max(1, parseInt(i.qty) || 1);
  }, 0);
}

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

module.exports = { PF_BASE, pfHeaders, paypalBase, paypalToken, priceBasket, json };
