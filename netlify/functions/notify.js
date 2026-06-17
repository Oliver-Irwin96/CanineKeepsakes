/* POST /api/notify — transactional brand emails via Resend.
   Body: { type:'design'|'creator', email, ...fields }
     design  → { dogName, collection, total }   (after a paid custom-dog-art request)
     creator → { name, title }                  (after a creator design submission)
   Fire-and-forget from the browser; failures here never affect the user's flow.
   No-ops gracefully (200 {skipped}) until RESEND_API_KEY is set in Netlify env. */
const { json, corsHeaders, isOriginAllowed, rateLimit } = require('./_lib');

const RESEND_KEY = process.env.RESEND_API_KEY || process.env.resend_api_key;
const FROM = process.env.RESEND_FROM || 'Canine Keepsakes <noreply@caninekeepsakes.co.uk>';
const REPLY_TO = process.env.RESEND_REPLY_TO || 'caninekeepsakes.admin@gmail.com';

const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const shell = inner => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ec;margin:0;padding:24px 0;font-family:Helvetica,Arial,sans-serif;"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e1d4;"><tr><td style="background:#16181f;padding:26px 32px;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;color:#ffffff;">Canine <span style="color:#d2922f;">Keepsakes</span></span></td></tr>${inner}</table></td></tr></table>`;

const btn = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:#d2922f;"><a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:bold;color:#1a1206;text-decoration:none;border-radius:999px;">${label}</a></td></tr></table>`;

function designEmail(b) {
  const dog = esc(b.dogName) || 'your dog';
  const collection = esc(b.collection) || 'your chosen design';
  const total = esc(b.total) || '';
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
      ${btn('mailto:caninekeepsakes.admin@gmail.com', 'Questions? Contact us')}
    </td></tr>
    <tr><td style="padding:24px 32px 30px;border-top:1px solid #eee7d8;">
      <p style="font-size:13px;line-height:1.6;color:#9aa0ac;margin:0;">Original dog artwork.<br>Made for people who are properly obsessed with their dogs.</p>
      <p style="font-size:12px;color:#b3b8c2;margin:8px 0 0;">© Canine Keepsakes</p>
    </td></tr>`;
  return { subject: "Your dog's artwork is officially booked — Canine Keepsakes", html: shell(body) };
}

function creatorEmail(b) {
  const who = esc(b.name) || 'there';
  const title = esc(b.title) || 'your design';
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
      ${btn('mailto:caninekeepsakes.admin@gmail.com', 'Questions? Contact us')}
    </td></tr>
    <tr><td style="padding:24px 32px 30px;border-top:1px solid #eee7d8;">
      <p style="font-size:13px;line-height:1.6;color:#9aa0ac;margin:0;">Original dog artwork.<br>Built with creators and dog lovers.</p>
      <p style="font-size:12px;color:#b3b8c2;margin:8px 0 0;">© Canine Keepsakes</p>
    </td></tr>`;
  return { subject: 'Your design is in — Canine Keepsakes', html: shell(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const b = JSON.parse(event.body || '{}');
    const to = (b.email || '').trim();
    if (!to) return json(400, { error: 'email required' });
    if (!RESEND_KEY) return json(200, { skipped: true, reason: 'RESEND_API_KEY not set' });
    const built = b.type === 'creator' ? creatorEmail(b) : designEmail(b);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, reply_to: REPLY_TO, subject: built.subject, html: built.html })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json(502, { error: 'send failed', detail: data });
    return json(200, { sent: true, id: data.id });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
