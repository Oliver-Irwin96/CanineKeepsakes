/* POST /api/giftcard — digital gift cards (DEPLOY CANDIDATE, feature-flagged)
   Flag: GIFTCARDS_ENABLED=true — every action 404s until set. Safe to deploy dark.
   Actions:
     { action:'create',  tier, currency, recipient_email, message, deliver_at? }
        -> { id, amount, currency }              (PayPal order, server-priced)
     { action:'capture', orderID }
        -> { status, code, balance, currency }   (verifies capture, mints card, emails)
     { action:'validate', code, currency }
        -> { ok, balance, currency, expires_at } | { expired:true, extendable:true } | { error }
     { action:'extend',  code }
        -> { ok, expires_at }                    (self-serve extension — Oliver 2026-07-06)
   Redemption at checkout is NOT wired here: it calls the atomic SQL function
   redeem_gift_card() from inside capture-order at capture time (wave-2 hook,
   documented in README). Codes: never stored plaintext — sha256 only.
   All copy in emails = placeholder pending copy review. */
const crypto = require('crypto');
const {
  paypalBase, paypalToken, json, corsHeaders, isOriginAllowed, rateLimit, supabaseEnv, verifyUser
} = require('./_lib');

const ENABLED = process.env.GIFTCARDS_ENABLED === 'true';
const TIERS = { '10': 10, '25': 25, '50': 50, '100': 100 };          // fixed tiers (Oliver 2026-07-06)
const CURRENCIES = ['GBP', 'USD', 'CAD', 'AUD', 'NZD', 'EUR'];       // all six from v1 (Oliver 2026-07-06)
const EXPIRY_MONTHS = parseInt(process.env.GIFTCARD_EXPIRY_MONTHS || '24', 10);      // pending legal check
const EXTENSION_MONTHS = parseInt(process.env.GIFTCARD_EXTENSION_MONTHS || '12', 10);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const splitList = v => String(v || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
async function requireAdmin(event) { // same ADMIN_EMAILS model as admin-action.js
  const u = await verifyUser(event);
  if (!u) return null;
  const email = String(u.email || '').toLowerCase();
  return splitList(process.env.ADMIN_EMAILS || process.env.admin_emails).includes(email) ? email : null;
}
function newCode() { // 16 chars, unambiguous alphabet, grouped: XXXX-XXXX-XXXX-XXXX
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.randomBytes(16)).map(b => A[b % A.length]).join('');
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}
function sb(path, opts = {}) {
  const { url, serviceKey } = supabaseEnv();
  return fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {})
    }
  });
}
async function cardByCode(code) {
  const r = await sb(`gift_cards?code_hash=eq.${sha256(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-'))}&select=*`);
  const rows = await r.json();
  return rows[0] || null;
}
async function balanceOf(cardId) {
  const r = await sb(`gift_card_transactions?gift_card_id=eq.${cardId}&select=amount`);
  const rows = await r.json();
  return rows.reduce((s, t) => s + parseFloat(t.amount), 0);
}
async function giftEmail(to, fields) { // self-contained (keeps _lib.js untouched)
  const key = process.env.RESEND_API_KEY; if (!key || !to) return { skipped: true };
  // certificate-style card (ChatGPT copy v2, Oliver-approved 2026-07-08): a gift, not a voucher
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:auto;color:#2a2f3a">
    <h2 style="color:#16181f;font-family:Georgia,serif">Someone thinks you'll love this. 🐾</h2>
    <p>You've been given a Canine Keepsakes gift card. Now comes the difficult part...<br>Choosing your favourite.</p>
    ${fields.message ? `<p style="background:#efe6d6;border-radius:10px;padding:14px;font-style:italic">"${esc(String(fields.message).slice(0, 500))}"</p>` : ''}
    <div style="background:#faf6ee;border:1px solid #e5dcc8;border-radius:16px;padding:34px 26px;text-align:center;margin:18px 0">
      <p style="letter-spacing:3px;font-size:11px;color:#8a7f68;margin:0 0 14px">────────────────</p>
      <p style="font-family:Georgia,serif;font-size:20px;letter-spacing:3px;color:#16181f;margin:0">CANINE <span style="color:#d2922f">KEEPSAKES</span></p>
      <p style="font-family:Georgia,serif;font-style:italic;font-size:15px;color:#5a5344;margin:6px 0 14px">Gift Card</p>
      <p style="font-size:22px;margin:0 0 14px">🐾</p>
      <p style="font-family:Georgia,serif;font-style:italic;font-size:14px;color:#5a5344;margin:0 0 18px">Made especially for someone<br>who loves dogs as much as we do.</p>
      <p style="letter-spacing:3px;font-size:11px;color:#8a7f68;margin:0 0 18px">────────────────</p>
      <p style="font-family:Georgia,serif;font-size:32px;color:#16181f;margin:0 0 18px">${fields.currency} ${fields.amount.toFixed(2)}</p>
      <p style="font-size:12px;letter-spacing:1px;color:#8a7f68;text-transform:uppercase;margin:0 0 8px">Your gift card code</p>
      <p style="font-size:1.4rem;font-weight:bold;letter-spacing:2px;background:#16181f;color:#ecc06a;padding:14px;border-radius:12px;margin:0">${fields.code}</p>
      ${fields.expires ? `<p style="font-size:12px;color:#8a7f68;margin:14px 0 0">Valid until ${fields.expires}</p>` : ''}
    </div>
    <p>Enter your code at checkout on <a href="https://caninekeepsakes.co.uk" style="color:#d2922f">caninekeepsakes.co.uk</a> whenever you're ready. Any remaining balance stays safely on your gift card.</p>
  </div>`;
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'Canine Keepsakes <noreply@caninekeepsakes.co.uk>',
      to, subject: 'Your Canine Keepsakes gift card', html
    })
  }).then(r => r.json()).catch(() => ({}));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!ENABLED) return json(404, { error: 'not available' });
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    if (action === 'create') {
      if (!rateLimit(event, 15, 60000)) return json(429, { error: 'too many requests' });
      const amount = TIERS[String(body.tier)];
      const currency = CURRENCIES.includes(body.currency) ? body.currency : null;
      if (!amount || !currency) return json(400, { error: 'invalid tier or currency' });
      const token = await paypalToken();
      const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            amount: { currency_code: currency, value: amount.toFixed(2) },
            description: `Canine Keepsakes gift card ${currency} ${amount}`,
            custom_id: JSON.stringify({
              t: 'giftcard', tier: String(amount), cur: currency,
              re: String(body.recipient_email || '').slice(0, 200),
              msg: String(body.message || '').slice(0, 300)
            }).slice(0, 255) // PayPal custom_id limit — message truncated defensively
          }]
        })
      });
      const order = await res.json();
      if (!res.ok) return json(502, { error: 'paypal order failed' });
      return json(200, { id: order.id, amount, currency });
    }

    if (action === 'capture') {
      if (!rateLimit(event, 15, 60000)) return json(429, { error: 'too many requests' });
      const orderID = String(body.orderID || '');
      if (!orderID) return json(400, { error: 'orderID required' });
      // idempotency: if a card already exists for this PayPal order, return it minted-once
      const dup = await sb(`gift_cards?order_id=eq.${encodeURIComponent(orderID)}&select=id`).then(r => r.json());
      if (dup.length) return json(200, { status: 'ALREADY_MINTED' });
      const token = await paypalToken();
      const cap = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      const data = await cap.json();
      if (!cap.ok || data.status !== 'COMPLETED') return json(402, { error: 'capture failed', status: data.status });
      const pu = data.purchase_units && data.purchase_units[0];
      const capd = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
      const amount = parseFloat(capd.amount.value), currency = capd.amount.currency_code;
      let meta = {}; try { meta = JSON.parse(pu.custom_id || '{}'); } catch (_) {}
      if (meta.t !== 'giftcard' || !TIERS[String(Math.round(amount))]) return json(400, { error: 'not a gift card order' });
      const payerEmail = data.payer && data.payer.email_address;
      const code = newCode();
      const expires = new Date(); expires.setMonth(expires.getMonth() + EXPIRY_MONTHS);
      const ins = await sb('gift_cards', {
        method: 'POST',
        body: JSON.stringify({
          code_hash: sha256(code), currency, initial_amount: amount, status: 'active',
          purchaser_email: payerEmail, recipient_email: meta.re || payerEmail,
          message: meta.msg || null, expires_at: expires.toISOString(), order_id: orderID
        })
      });
      const card = (await ins.json())[0];
      if (!card) return json(500, { error: 'mint failed — contact support with your PayPal receipt' });
      await sb('gift_card_transactions', {
        method: 'POST',
        body: JSON.stringify({ gift_card_id: card.id, type: 'issue', amount, order_id: orderID, note: 'purchase' })
      });
      await giftEmail(meta.re || payerEmail, { code, amount, currency, message: meta.msg, expires: expires.toLocaleDateString('en-GB') });
      return json(200, { status: 'COMPLETED', code, balance: amount, currency });
    }

    if (action === 'validate') {
      if (!rateLimit(event, 10, 60000)) return json(429, { error: 'too many requests' }); // strict: anti-enumeration
      const card = await cardByCode(body.code || '');
      if (!card || card.status === 'disabled') return json(200, { error: 'That gift card couldn\'t be recognised or has already been used.' }); // generic on purpose
      const balance = await balanceOf(card.id);
      if (balance <= 0) return json(200, { error: 'That gift card couldn\'t be recognised or has already been used.' }); // empty card: generic, never "extend?"
      if (card.expires_at && new Date(card.expires_at) < new Date())
        return json(200, { expired: true, extendable: true });
      if (body.currency && card.currency !== body.currency) {
        const REGION_NAME = { GBP: 'UK', USD: 'US', CAD: 'Canadian', AUD: 'Australian', NZD: 'New Zealand', EUR: 'European' };
        return json(200, { error: `This gift card is in ${card.currency}. Switch to the ${REGION_NAME[card.currency] || card.currency} store to use it.` });
      }
      return json(200, { ok: true, balance, currency: card.currency, expires_at: card.expires_at });
    }

    if (action === 'extend') {
      if (!rateLimit(event, 5, 60000)) return json(429, { error: 'too many requests' });
      const card = await cardByCode(body.code || '');
      if (!card || card.status === 'disabled') return json(200, { error: 'That gift card couldn\'t be recognised or has already been used.' });
      if (!card.expires_at || new Date(card.expires_at) >= new Date())
        return json(200, { error: 'This gift card is still valid — there\'s nothing to extend just yet.' }); // don't burn the one extension early
      if ((await balanceOf(card.id)) <= 0) return json(200, { error: 'That gift card couldn\'t be recognised or has already been used.' });
      const ext = await sb(`gift_card_transactions?gift_card_id=eq.${card.id}&type=eq.extend&select=id`).then(r => r.json());
      if (ext.length >= 1) return json(200, { error: 'This gift card has already been extended. If something doesn\'t look right, we\'ll happily help.' });
      const newExp = new Date(); newExp.setMonth(newExp.getMonth() + EXTENSION_MONTHS);
      await sb(`gift_cards?id=eq.${card.id}`, { method: 'PATCH', body: JSON.stringify({ expires_at: newExp.toISOString() }) });
      await sb('gift_card_transactions', {
        method: 'POST',
        body: JSON.stringify({ gift_card_id: card.id, type: 'extend', amount: 0, note: `self-serve extension to ${newExp.toISOString()}` })
      });
      return json(200, { ok: true, expires_at: newExp.toISOString() });
    }

    /* ── admin ops (brief §3: lookup / disable / adjust + refund clawback) ──
       Auth: signed-in ADMIN_EMAILS only (same model as admin-action.js).
       Every adjust/disable/refund writes a ledger row — full audit trail. */
    if (action === 'admin') {
      if (!rateLimit(event, 30, 60000)) return json(429, { error: 'too many requests' });
      const admin = await requireAdmin(event);
      if (!admin) return json(403, { error: 'not authorised' });
      const card = body.code ? await cardByCode(body.code)
        : body.card_id ? (await sb(`gift_cards?id=eq.${encodeURIComponent(body.card_id)}&select=*`).then(r => r.json()))[0]
        : null;
      if (!card) return json(404, { error: 'card not found' });
      const op = body.op;

      if (op === 'lookup') {
        const tx = await sb(`gift_card_transactions?gift_card_id=eq.${card.id}&select=*&order=created_at.asc`).then(r => r.json());
        return json(200, { card: { ...card, code_hash: undefined }, balance: await balanceOf(card.id), transactions: tx });
      }
      if (op === 'disable') { // e.g. purchase refunded / chargeback: kill the card
        await sb(`gift_cards?id=eq.${card.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) });
        await sb('gift_card_transactions', {
          method: 'POST',
          body: JSON.stringify({ gift_card_id: card.id, type: 'adjust', amount: 0, note: `disabled by ${admin}: ${String(body.note || 'no reason given').slice(0, 300)}` })
        });
        return json(200, { ok: true, status: 'disabled' });
      }
      if (op === 'clawback') { // purchase refund/chargeback: zero unspent balance, then disable
        const bal = await balanceOf(card.id);
        if (bal > 0) await sb('gift_card_transactions', {
          method: 'POST',
          body: JSON.stringify({ gift_card_id: card.id, type: 'refund', amount: -bal, order_id: card.order_id, note: `purchase refund clawback by ${admin}` })
        });
        await sb(`gift_cards?id=eq.${card.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) });
        return json(200, { ok: true, clawed_back: bal });
      }
      if (op === 'refund_to_card') { // an order paid WITH this card was refunded: restore balance
        const amt = parseFloat(body.amount);
        if (!(amt > 0)) return json(400, { error: 'positive amount required' });
        await sb('gift_card_transactions', {
          method: 'POST',
          body: JSON.stringify({ gift_card_id: card.id, type: 'refund', amount: amt, order_id: String(body.order_id || '') || null, note: `order refund by ${admin}` })
        });
        return json(200, { ok: true, balance: await balanceOf(card.id) });
      }
      if (op === 'adjust') { // signed manual correction; note required (audit)
        const amt = parseFloat(body.amount);
        const note = String(body.note || '').trim();
        if (!isFinite(amt) || amt === 0 || !note) return json(400, { error: 'non-zero amount and note required' });
        if (amt < 0 && (await balanceOf(card.id)) + amt < 0) return json(400, { error: 'would take balance below zero' });
        await sb('gift_card_transactions', {
          method: 'POST',
          body: JSON.stringify({ gift_card_id: card.id, type: 'adjust', amount: amt, note: `${note} (by ${admin})` })
        });
        return json(200, { ok: true, balance: await balanceOf(card.id) });
      }
      return json(400, { error: 'unknown admin op' });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    return json(500, { error: 'gift card service error' });
  }
};
