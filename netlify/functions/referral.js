/* POST /api/referral — referral attribution (DEPLOY CANDIDATE, feature-flagged)
   Flag: REFERRALS_ENABLED=true — 404s until set. Earnings ledger comes with
   designer-earnings tracking (wave 2); this ships ATTRIBUTION so no referral
   is ever lost, per spec decision 2026-07-06.
   Actions:
     { action:'resolve', code }        -> { ok, display_name }   (is this a real code?)
     { action:'attach',  code }        -> { ok }                 (auth'd designer: stamp referred_by, sticky)
     { action:'register', display_name } -> { ok, code }         (auth'd user becomes a referrer — open signup) */
const crypto = require('crypto');
const { json, corsHeaders, isOriginAllowed, rateLimit, verifyUser, supabaseEnv } = require('./_lib');

const ENABLED = process.env.REFERRALS_ENABLED === 'true';
function sb(path, opts = {}) {
  const { url, serviceKey } = supabaseEnv();
  return fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) }
  });
}
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!ENABLED) return json(404, { error: 'not available' });
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 20, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  try {
    const body = JSON.parse(event.body || '{}');

    if (body.action === 'resolve') {
      const code = cleanCode(body.code);
      if (!code) return json(400, { error: 'code required' });
      const rows = await sb(`referrers?code=eq.${code}&select=display_name`).then(r => r.json());
      return json(200, rows[0] ? { ok: true, display_name: rows[0].display_name } : { ok: false });
    }

    if (body.action === 'attach') {
      const user = await verifyUser(event);
      if (!user) return json(401, { error: 'sign in required' });
      const code = cleanCode(body.code);
      const refs = await sb(`referrers?code=eq.${code}&select=id,user_id`).then(r => r.json());
      if (!refs[0]) return json(200, { ok: false, error: 'unknown code' });
      if (refs[0].user_id === user.id) return json(200, { ok: false, error: 'self-referral' }); // spec §3.1
      // sticky: only stamp if currently null
      const prof = await sb(`profiles?id=eq.${user.id}&select=referred_by`).then(r => r.json());
      if (prof[0] && prof[0].referred_by) return json(200, { ok: true, already: true });
      await sb(`profiles?id=eq.${user.id}&referred_by=is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ referred_by: refs[0].id, referred_at: new Date().toISOString() })
      });
      return json(200, { ok: true });
    }

    if (body.action === 'register') { // open signup (Oliver 2026-07-06); custom rates set by admin later
      const user = await verifyUser(event);
      if (!user) return json(401, { error: 'sign in required' });
      const existing = await sb(`referrers?user_id=eq.${user.id}&select=code`).then(r => r.json());
      if (existing[0]) return json(200, { ok: true, code: existing[0].code });
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const code = Array.from(crypto.randomBytes(8)).map(b => A[b % A.length]).join('');
      const ins = await sb('referrers', {
        method: 'POST',
        body: JSON.stringify({ user_id: user.id, code, display_name: String(body.display_name || '').slice(0, 60) || null })
      }).then(r => r.json());
      if (!ins[0]) return json(500, { error: 'could not register' });
      return json(200, { ok: true, code });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    return json(500, { error: 'referral service error' });
  }
};
