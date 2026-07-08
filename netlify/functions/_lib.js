/* Shared helpers for CK Netlify functions */
const PF_BASE = 'https://api.printful.com';

/* Canine Keepsakes store ID - general API key covers 19 stores, this scopes all
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

/* PayPal credentials toggle on PAYPAL_ENV, mirroring paypalBase():
     live    -> PAYPAL_LIVE_CLIENT_ID / PAYPAL_LIVE_CLIENT_SECRET
     sandbox -> PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET
   Falls back to legacy PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET so nothing breaks
   before the split keys are added. Flip the whole environment by changing PAYPAL_ENV. */
function paypalCreds() {
  const live = process.env.PAYPAL_ENV === 'live';
  const id = (live ? process.env.PAYPAL_LIVE_CLIENT_ID : process.env.PAYPAL_SANDBOX_CLIENT_ID) || process.env.PAYPAL_CLIENT_ID;
  const secret = (live ? process.env.PAYPAL_LIVE_CLIENT_SECRET : process.env.PAYPAL_SANDBOX_CLIENT_SECRET) || process.env.PAYPAL_CLIENT_SECRET;
  return { id, secret, live };
}

async function paypalToken() {
  const { id, secret } = paypalCreds();
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

/* Server-side price table - NEVER trust client prices.
   Mirror of data/products.json retail prices. */
const PRICES = {
  'summer-tee': 24.99, 'summer-long-sleeve': 29.99, 'winter-tee': 27.99,
  'winter-long-sleeve': 29.99, 'sweatshirt': 34.99, 'hoodie': 39.99,
  'zip-hoodie': 44.99, 'womens-relaxed-tee': 26.99, 'white-mug': 14.99,
  'black-mug': 14.99, 'pet-bowl': 17.99, 'stickers': 4.99, 'throw-blanket': 79.99
};

/* Server-authoritative quantity clamp — never trust the browser's qty. Caps the
   charge AND the Printful order line so a tampered qty (e.g. 999999) can't push a
   huge payment or order through. */
const MAX_QTY = 100;
const clampQty = q => Math.min(MAX_QTY, Math.max(1, parseInt(q) || 1));

function priceBasket(items) {
  return items.reduce((sum, i) => {
    const p = PRICES[i.productSlug];
    if (p == null) throw new Error(`Unknown product: ${i.productSlug}`);
    return sum + p * clampQty(i.qty);
  }, 0);
}

/* -- Shipping (server-authoritative) --
   The browser must NEVER decide shipping cost. We always re-fetch live rates
   from Printful and use Printful's number. If Printful is unreachable we fall
   back to a SERVER-defined flat rate - never to a client-supplied value. */
const FLAT_SHIP_FALLBACK = { id: 'STANDARD', name: 'Standard UK', rate: 3.99 };

async function resolveFirstVariant(catalogProductId) {
  const res = await fetch(`${PF_BASE}/products/${catalogProductId}`, { headers: pfHeaders() });
  if (!res.ok) throw new Error(`catalog lookup failed for ${catalogProductId}`);
  const data = await res.json();
  const v = data?.result?.variants?.[0];
  if (!v) throw new Error(`no variants for product ${catalogProductId}`);
  return v.id;
}

async function printfulShippingRates(recipient, items) {
  const resolved = [];
  for (const i of items) {
    const variant_id = await resolveFirstVariant(i.catalogProductId);
    resolved.push({ variant_id, quantity: clampQty(i.qty) });
  }
  const res = await fetch(`${PF_BASE}/shipping/rates`, {
    method: 'POST',
    headers: pfHeaders(),
    body: JSON.stringify({
      recipient: {
        address1: recipient.address1,
        city: recipient.city,
        country_code: 'GB',
        zip: recipient.zip
      },
      items: resolved,
      currency: 'GBP',
      locale: 'en_GB'
    })
  });
  if (!res.ok) throw new Error(`Printful rates error ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

/* Returns authoritative { id, name, rate } for the chosen option.
   chosenId only PICKS among server rates - its price is discarded.
   Unknown id -> cheapest live rate. Printful down -> server flat fallback. */
async function authoritativeShipping(recipient, items, chosenId) {
  try {
    const rates = await printfulShippingRates(recipient, items);
    if (rates.length) {
      const match = rates.find(r => String(r.id) === String(chosenId));
      const pick = match || rates.reduce((a, b) => (parseFloat(a.rate) <= parseFloat(b.rate) ? a : b));
      return { id: pick.id, name: pick.name, rate: parseFloat(pick.rate) };
    }
  } catch (_) { /* fall through to flat fallback */ }
  return { ...FLAT_SHIP_FALLBACK };
}

/* ---------------------------------------------------------------------------
   Supabase (server-side, zero-dependency REST)
   - verifyUser: validates the caller's Supabase access token (login is required
     at checkout, so the browser sends Authorization: Bearer <access_token>).
   - The *_admin helpers use the SERVICE-ROLE key and bypass RLS. They are only
     ever called from server functions - never exposed to the browser.
--------------------------------------------------------------------------- */
function supabaseEnv() {
  return {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
}

async function verifyUser(event) {
  const { url, anonKey } = supabaseEnv();
  if (!url || !anonKey) throw new Error('Supabase not configured');
  const hdrs = event.headers || {};
  const auth = hdrs.authorization || hdrs.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

function sbAdminHeaders() {
  const { serviceKey } = supabaseEnv();
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

async function findOrderByPaypalId(paypalOrderId) {
  const { url } = supabaseEnv();
  const res = await fetch(
    `${url}/rest/v1/orders?paypal_order_id=eq.${encodeURIComponent(paypalOrderId)}&select=*`,
    { headers: sbAdminHeaders() }
  );
  if (!res.ok) throw new Error(`order lookup failed ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

/* Insert an order row. The UNIQUE(paypal_order_id) constraint is the real
   idempotency guard: a duplicate insert returns 409, which we treat as
   "already recorded" and swallow (returns null). Returns the stored row. */
async function recordOrder(row) {
  const { url } = supabaseEnv();
  const res = await fetch(`${url}/rest/v1/orders`, {
    method: 'POST',
    headers: { ...sbAdminHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  if (res.status === 409) return null; // duplicate paypal_order_id
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`order insert failed ${res.status}: ${detail}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/* Look up a custom-art submission by its PayPal order id (service role). */
async function findDesignByPaypalId(paypalOrderId) {
  const { url } = supabaseEnv();
  const res = await fetch(
    `${url}/rest/v1/design_submissions?paypal_order_id=eq.${encodeURIComponent(paypalOrderId)}&select=*`,
    { headers: sbAdminHeaders() }
  );
  if (!res.ok) throw new Error(`design lookup failed ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

/* Insert a custom-art submission row (service role, bypasses RLS). The unique
   index on paypal_order_id makes this idempotent: a duplicate returns 409 which
   we swallow (returns null). Returns the stored row otherwise. */
async function recordDesignSubmission(row) {
  const { url } = supabaseEnv();
  const res = await fetch(`${url}/rest/v1/design_submissions`, {
    method: 'POST',
    headers: { ...sbAdminHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  if (res.status === 409) return null; // duplicate paypal_order_id
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`design insert failed ${res.status}: ${detail}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
   Branded transactional email (Resend). Shared by /api/notify and /api/design-pay
   so the email HTML lives in one place. sendBrandedEmail no-ops gracefully when
   RESEND_API_KEY is unset (returns { skipped:true }).
--------------------------------------------------------------------------- */
const _esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const _emailShell = inner => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ec;margin:0;padding:24px 0;font-family:Helvetica,Arial,sans-serif;"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e1d4;"><tr><td style="background:#16181f;padding:24px 32px;border-bottom:3px solid #d2922f;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;color:#ffffff;">&#128062; Canine <span style="color:#d2922f;">Keepsakes</span></span><div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#d2922f;margin-top:7px;">Original Dog Artwork</div></td></tr>${inner}</table></td></tr></table>`;

const _emailBtn = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:#d2922f;"><a href="${href}" style="display:inline-block;padding:17px 36px;font-size:15px;font-weight:bold;letter-spacing:.3px;color:#1a1206;text-decoration:none;border-radius:999px;">${label}</a></td></tr></table>`;

function _designEmail(b) {
  const dog = _esc(b.dogName) || 'your dog';
  const collection = _esc(b.collection) || 'your chosen design';
  const total = _esc(b.total) || '';
  const body = `
    <tr><td style="padding:34px 32px 8px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#16181f;margin:0 0 16px;">Your dog's artwork is officially booked.</h1>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Thank you — we've safely received your photo and your artwork request is now in the queue.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">We can't wait to show you what your dog looks like in the collection.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 18px;">Here's what you've booked:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f4ea;border:1px solid #eee2cc;border-radius:12px;margin:0 0 22px;"><tr><td style="padding:16px 18px;font-size:15px;color:#3a4150;">
        <strong style="color:#16181f;">Design:</strong> ${collection}<br>
        <strong style="color:#16181f;">Dog:</strong> ${dog}${total ? `<br><strong style="color:#16181f;">Artwork fee paid:</strong> ${total}` : ''}
      </td></tr></table>
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">Here's what happens next</h2>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">Our artists will replace the dog in your chosen design with your dog, matching breed, colour and markings as closely as the artwork style allows. Typical turnaround is <strong>3–5 working days</strong> (Priority aims for 48 hours).</p>
      <p style="font-size:15px;line-height:1.6;color:#16181f;margin:0 0 4px;font-weight:bold;">Good artwork takes a little time.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">Every custom request is reviewed by a real person to make sure your dog looks right before we send the preview.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 22px;">We'll email you a <strong>digital preview to approve before anything is printed</strong>. Your fee includes <strong>one revision</strong> for likeness tweaks.</p>
      ${_emailBtn('mailto:caninekeepsakes.admin@gmail.com', 'Questions? Contact us')}
    </td></tr>
    ${_footer('Original dog artwork.<br>Made for people who are properly obsessed with their dogs.')}`;
  return { subject: "Your dog's artwork is officially booked — Canine Keepsakes", html: _emailShell(body) };
}

function _creatorEmail(b) {
  const who = _esc(b.name) || 'there';
  const title = _esc(b.title) || 'your design';
  const body = `
    <tr><td style="padding:34px 32px 8px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#16181f;margin:0 0 16px;">Your design is in.</h1>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Hi ${who},</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Thanks for submitting <strong>"${title}"</strong>.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Your design is now in our review queue and will be looked at by a real person.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 18px;">Every Canine Keepsakes collection starts with an idea. Some come from us. The best ones might come from creators like you.</p>
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">What we'll do next</h2>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">If your idea is approved, we'll adapt it into the Canine Keepsakes style, create breed variations and publish it as a collection with creator credit attached to your name.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">If approved and published, you earn <strong>10% of net profit</strong> from eligible sales of your collection, paid monthly by PayPal once your balance reaches £50.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 22px;">We'll be in touch by email either way. A quick reminder: submissions must be your own original work, with no copyrighted characters, logos or brands.</p>
      ${_emailBtn('mailto:caninekeepsakes.admin@gmail.com', 'Questions? Contact us')}
    </td></tr>
    ${_footer('Original dog artwork.<br>Built with creators and dog lovers.')}`;
  return { subject: 'Your design is in — Canine Keepsakes', html: _emailShell(body) };
}

/* Hidden preheader (inbox preview text) + button fallback link — shared by emails below. */
const _preheader = t => `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${_esc(t)}</div>`;
const _fallback = url => `<p style="font-size:12px;line-height:1.5;color:#9aa0ac;margin:16px 0 0;">If the button doesn't work, copy and paste this link into your browser:<br><span style="color:#3a4150;word-break:break-all;">${_esc(url)}</span></p>`;
const _footerNav = `<p style="font-size:12px;line-height:1.6;margin:0 0 12px;"><a href="https://caninekeepsakes.co.uk/index.html#collections" style="color:#d2922f;text-decoration:none;">Shop</a> &middot; <a href="https://caninekeepsakes.co.uk/submit-design.html" style="color:#d2922f;text-decoration:none;">Custom Dog Art</a> &middot; <a href="mailto:caninekeepsakes.admin@gmail.com" style="color:#d2922f;text-decoration:none;">Contact</a></p>`;
const _footer = line => `<tr><td style="padding:24px 32px 30px;border-top:1px solid #eee7d8;">${_footerNav}<p style="font-size:13px;line-height:1.6;color:#9aa0ac;margin:0;">${line}</p><p style="font-size:12px;color:#b3b8c2;margin:8px 0 0;">© Canine Keepsakes</p></td></tr>`;

/* CK_EMAIL_COPY_PACK_v1 — copy verbatim from owner; do not rewrite. */
const ACCOUNT_URL = 'https://caninekeepsakes.co.uk/account.html';
const SHOP_URL = 'https://caninekeepsakes.co.uk/index.html#collections';

/* 1. ORDER CONFIRMATION — sent after a captured checkout payment (wired in capture-order.js). */
function _orderEmail(b) {
  const ref = _esc(b.orderRef) || '';
  const total = _esc(b.total) || '';
  const items = Array.isArray(b.items) ? b.items : [];
  const rows = items.map(i =>
    `<tr><td style="padding:6px 0;font-size:15px;color:#3a4150;">${_esc(i.name)} × ${_esc(i.qty)}</td></tr>`
  ).join('');
  const body = `
    <tr><td style="padding:34px 32px 8px;">
      ${_preheader("Your order is confirmed and we're getting it ready.")}
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#16181f;margin:0 0 16px;">Your order is confirmed.</h1>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Thank you for your order — we've safely received it and your Canine Keepsakes items are now being prepared.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 18px;">Every item is printed to order, so your chosen artwork and product will be made specifically for you.</p>
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">Your order</h2>
      ${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f4ea;border:1px solid #eee2cc;border-radius:12px;margin:0 0 8px;"><tr><td style="padding:14px 18px;"><table role="presentation" width="100%">${rows}</table></td></tr></table>` : ''}
      ${total ? `<p style="font-size:15px;color:#16181f;margin:0 0 6px;text-align:right;"><strong>Total paid: ${total}</strong></p>` : ''}
      ${ref ? `<p style="font-size:13px;color:#9aa0ac;margin:0 0 18px;">Order reference: ${ref}</p>` : ''}
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">What happens next</h2>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">We'll prepare your order, send it to production, and keep you updated as it moves through the process.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 18px;">If anything needs checking before production, we'll contact you using the email address on your order.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 22px;">If you have any questions, just reply to this email and we'll help.</p>
      ${_emailBtn(ACCOUNT_URL, 'View Your Account')}
      ${_fallback(ACCOUNT_URL)}
    </td></tr>
    ${_footer('Original dog artwork. Made for people who are properly obsessed with their dogs.')}`;
  return { subject: "We've got your Canine Keepsakes order", html: _emailShell(body) };
}

/* 2. ARTWORK PREVIEW READY — TEMPLATE ONLY. No automatic trigger yet (needs an admin
   "mark preview ready" action + a review page). Send via sendBrandedEmail('preview', ...). */
function _previewEmail(b) {
  const reviewUrl = b.reviewUrl || ACCOUNT_URL;
  const body = `
    <tr><td style="padding:34px 32px 8px;">
      ${_preheader('Come and see how your dog looks in the artwork.')}
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#16181f;margin:0 0 16px;">Your dog's preview is ready.</h1>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Good news — your custom Canine Keepsakes artwork preview is ready to review.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 18px;">We've taken your dog's photo and created a preview inside the collection style you chose.</p>
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">Review your artwork</h2>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">Please take a look carefully. Check your dog's markings, colours, expression and overall likeness.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 18px;">Remember, this is a dog-swap artwork service. The design, background, scene and overall composition stay the same as the original collection.</p>
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">Need a small tweak?</h2>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">Your order includes one revision for likeness tweaks, such as colour, markings or small details.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 22px;">Major redesigns, background changes, new scenes or completely different artwork are not included.</p>
      ${_emailBtn(reviewUrl, 'Review My Artwork')}
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:18px 0 0;">If something doesn't look right, use the review page to request your included revision.</p>
      ${_fallback(reviewUrl)}
    </td></tr>
    ${_footer('Original dog artwork. Customised for people who are properly obsessed with their dogs.')}`;
  return { subject: "Your dog's artwork preview is ready", html: _emailShell(body) };
}

/* 3. ARTWORK APPROVED — TEMPLATE ONLY. No automatic trigger yet (needs the approval
   action/endpoint). Send via sendBrandedEmail('approved', ...). */
function _approvedEmail(b) {
  const shopUrl = b.shopUrl || SHOP_URL;
  const body = `
    <tr><td style="padding:34px 32px 8px;">
      ${_preheader('Your artwork is approved and ready for products.')}
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#16181f;margin:0 0 16px;">Your artwork is approved.</h1>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Great news — your custom dog artwork has been approved.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 18px;">That means your design is now ready to be used on eligible Canine Keepsakes products.</p>
      <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#16181f;margin:0 0 8px;">Choose your product</h2>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 8px;">You can now choose the product you want your approved artwork printed on.</p>
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:0 0 22px;">Whether it's a tee, hoodie, mug, sticker or gift, your artwork is ready to become something worth keeping.</p>
      ${_emailBtn(shopUrl, 'Choose A Product')}
      <p style="font-size:15px;line-height:1.6;color:#3a4150;margin:18px 0 0;">If you approved the artwork by mistake or need help before ordering, reply to this email as soon as possible.</p>
      ${_fallback(shopUrl)}
    </td></tr>
    ${_footer('Original dog artwork. Made for people who are properly obsessed with their dogs.')}`;
  return { subject: 'Your custom dog artwork is approved', html: _emailShell(body) };
}

/* 4. WELCOME — TEMPLATE ONLY (optional). No automatic trigger yet: account confirm
   is handled by Supabase Auth (separate system); a post-confirm hook/webhook would be
   needed to fire this. Send via sendBrandedEmail('welcome', ...) once a trigger exists. */
function _welcomeEmail(b) {
  const customUrl = 'https://caninekeepsakes.co.uk/submit-design.html';
  const body = `
    <tr><td style="padding:34px 32px 8px;">
      ${_preheader('Your account is ready — come and explore the collections.')}
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#16181f;margin:0 0 16px;">Welcome to the pack.</h1>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">Your Canine Keepsakes account is ready.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 14px;">You can now explore our original dog artwork collections, save your favourites, manage orders, and use your account for custom dog artwork requests.</p>
      <p style="font-size:16px;line-height:1.6;color:#3a4150;margin:0 0 22px;">Every collection is made for people who know their dog is not "just a dog".</p>
      ${_emailBtn(SHOP_URL, 'Explore Collections')}
      <p style="font-size:15px;line-height:1.6;margin:16px 0 0;"><a href="${customUrl}" style="color:#d2922f;text-decoration:none;font-weight:bold;">Customise With My Dog &rarr;</a></p>
      ${_fallback(SHOP_URL)}
    </td></tr>
    ${_footer('Original dog artwork. Made for people who are properly obsessed with their dogs.')}`;
  return { subject: 'Welcome to Canine Keepsakes', html: _emailShell(body) };
}

async function sendBrandedEmail(type, to, fields) {
  const key = process.env.RESEND_API_KEY || process.env.resend_api_key;
  if (!key) return { skipped: true, reason: 'RESEND_API_KEY not set' };
  const recipient = (to || '').trim();
  if (!recipient) return { skipped: true, reason: 'no recipient' };
  const from = process.env.RESEND_FROM || 'Canine Keepsakes <noreply@caninekeepsakes.co.uk>';
  const replyTo = process.env.RESEND_REPLY_TO || 'caninekeepsakes.admin@gmail.com';
  const built = type === 'order' ? _orderEmail(fields || {})
    : type === 'welcome' ? _welcomeEmail(fields || {})
    : type === 'preview' ? _previewEmail(fields || {})
    : type === 'approved' ? _approvedEmail(fields || {})
    : type === 'creator' ? _creatorEmail(fields || {})
    : _designEmail(fields || {});
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: recipient, reply_to: replyTo, subject: built.subject, html: built.html })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { sent: false, detail: data };
  return { sent: true, id: data.id };
}

/* ---------------------------------------------------------------------------
   M2 - origin allowlist + best-effort rate limiting (CORS hardening)
--------------------------------------------------------------------------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://caninekeepsakes.co.uk,https://www.caninekeepsakes.co.uk')
  .split(',').map(s => s.trim()).filter(Boolean);

function originHeader(event) {
  const h = event.headers || {};
  return h.origin || h.Origin || '';
}

/* CORS headers for an allowed Origin (used on the OPTIONS preflight). */
function corsHeaders(event) {
  const origin = originHeader(event);
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
  }
  return {};
}

/* Reject requests that carry a *foreign* Origin (browser-driven cross-site
   abuse / CSRF). An absent Origin (same-origin GET, server-to-server, direct
   URL hit) is allowed so we don't break normal use or smoke tests. */
function isOriginAllowed(event) {
  const origin = originHeader(event);
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

/* Best-effort in-memory rate limit. NOTE: serverless instances are ephemeral
   and not shared, so this throttles per warm instance only - it raises the bar
   for casual abuse but is not a hard global limit. For a global limit, back it
   with a store (e.g. Supabase) keyed by IP. */
const _hits = new Map();
function rateLimit(event, max = 30, windowMs = 60000) {
  const h = event.headers || {};
  const ip = (h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || 'unknown')
    .toString().split(',')[0].trim();
  const now = Date.now();
  const rec = _hits.get(ip);
  if (!rec || now > rec.reset) { _hits.set(ip, { count: 1, reset: now + windowMs }); return true; }
  rec.count += 1;
  return rec.count <= max;
}

/* ---------------------------------------------------------------------------
   M4 - print-file URL allowlist. capture-order sends files:[{url}] to Printful
   with a client-supplied URL; restrict it to trusted hosts so a logged-in
   attacker can't make Printful fetch/print an arbitrary URL.
--------------------------------------------------------------------------- */
const PRINT_FILE_HOSTS = ((process.env.PRINT_FILE_ALLOWED_HOSTS ||
  'drive.google.com,drive.usercontent.google.com,lh3.googleusercontent.com,caninekeepsakes.co.uk,www.caninekeepsakes.co.uk')
  + ',pub-11ab8f6c9a06485f86caac1425c43b27.r2.dev,cdn.caninekeepsakes.co.uk')   // R2 + CDN print-file hosts (always allowed, even if env override is set)
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isAllowedPrintFile(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return PRINT_FILE_HOSTS.includes(u.hostname.toLowerCase());
}

const json = (status, body, extraHeaders = {}) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body)
});

/* ---------------------------------------------------------------------------
   Print-file placement (Group F-a). BACKWARD-COMPATIBLE: if there is no usable
   placement entry for the product, we send just [{ url }] exactly as before, so
   Printful applies its default placement and nothing changes. Fill real numbers
   per productSlug in print-placement.config.json to control size/position.
   A product is only "configured" when area_width/area_height/width/height/top/left
   are ALL numbers — partial/null entries are ignored (safe).
--------------------------------------------------------------------------- */
let _placementCfg;
function placementConfig() {
  if (_placementCfg) return _placementCfg;
  try { _placementCfg = require('./print-placement.config.json') || {}; }
  catch (_) { _placementCfg = {}; }
  return _placementCfg;
}

function buildPrintFiles(item) {
  const url = item.printFileUrl;
  try {
    const cfg = placementConfig()[item.productSlug] || {};
    const file = { url };
    // Placement-by-NAME (pawprint's proven approach): e.g. 'front_large' / 'front' / 'default'.
    // Printful auto-positions within that placement area, so no pixel coords needed.
    if (cfg.placement) file.type = cfg.placement;
    // Optional pixel-level override: only applied when ALL position numbers are present.
    const p = cfg.position;
    const keys = ['area_width', 'area_height', 'width', 'height', 'top', 'left'];
    const ready = p && keys.every(k => typeof p[k] === 'number' && isFinite(p[k]));
    if (ready) file.position = {
      area_width: p.area_width, area_height: p.area_height,
      width: p.width, height: p.height, top: p.top, left: p.left,
      limit_to_print_area: p.limit_to_print_area !== false
    };
    return [file];                                // {url} | {url,type} | {url,type,position}
  } catch (_) {
    return [{ url }];                             // any error -> safe default (unchanged behaviour)
  }
}

module.exports = {
  PF_BASE, pfHeaders, paypalBase, paypalToken, paypalCreds, priceBasket, json,
  printfulShippingRates, authoritativeShipping, FLAT_SHIP_FALLBACK,
  supabaseEnv, verifyUser, findOrderByPaypalId, recordOrder,
  findDesignByPaypalId, recordDesignSubmission, sendBrandedEmail,
  buildPrintFiles, clampQty,
  ALLOWED_ORIGINS, corsHeaders, isOriginAllowed, rateLimit, isAllowedPrintFile
};
