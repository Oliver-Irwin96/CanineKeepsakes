/* POST /api/notify — transactional brand emails via Resend.
   AUTH REQUIRED. The recipient is ALWAYS the signed-in user's own email — the
   client cannot specify an arbitrary "to" (this closes the open-relay vector:
   previously any caller could send branded mail from our verified domain to any
   address). Body: { type:'creator'|'design', ...fields }.
   Custom-art ("design") confirmations are now sent server-side by /api/design-pay
   against the verified payment; this endpoint is used by the (login-required)
   creator submission flow. No-ops gracefully (200 {skipped}) until RESEND_API_KEY
   is set. */
const { json, corsHeaders, isOriginAllowed, rateLimit, verifyUser, sendBrandedEmail } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    /* Auth gate: only a signed-in user may trigger mail, and only to themselves. */
    const user = await verifyUser(event);
    if (!user || !user.email) return json(401, { error: 'login required' });

    const b = JSON.parse(event.body || '{}');
    const type = b.type === 'creator' ? 'creator' : 'design';
    const fields = type === 'creator'
      ? { name: b.name, title: b.title }
      : { dogName: b.dogName, collection: b.collection, total: b.total };

    const result = await sendBrandedEmail(type, user.email, fields);
    if (result.skipped) return json(200, { skipped: true, reason: result.reason });
    if (!result.sent) return json(502, { error: 'send failed', detail: result.detail });
    return json(200, { sent: true, id: result.id });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
