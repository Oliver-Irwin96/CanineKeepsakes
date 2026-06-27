/* POST /api/admin-action — staff-only mutations.
   Body (one of):
     { entity:'submission', id, action:'approve'|'reject'|'changes', notes? }
     { entity:'request',    id, status:'new'|'in_progress'|'proof_sent'|'done', assigned_to?, notes? }
     { entity:'sign',       bucket:'creator-submissions'|'design-submissions', path }
   Every write stamps who did it (reviewed_by / assigned_to) + when. */
const { json, corsHeaders, isOriginAllowed, rateLimit, verifyUser } = require('./_lib');

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminHeaders = () => ({ apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' });
const clean = (s, m = 2000) => (s == null ? null : String(s).trim().slice(0, m) || null);

async function requireAdmin(event) {
  if (!SB_URL || !SB_SERVICE) return { ok: false, code: 500, error: 'Supabase not configured' };
  const u = await verifyUser(event);
  if (!u) return { ok: false, code: 401, error: 'Please sign in' };
  const allow = String(process.env.ADMIN_EMAILS || process.env.admin_emails || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  const email = String(u.email || '').toLowerCase();
  if (!email || !allow.includes(email)) return { ok: false, code: 403, error: 'Not authorised' };
  return { ok: true, user: u, email };
}

async function sbPatch(table, id, patch) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...adminHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`${table} patch -> ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

const SUB_STATUS = { approve: 'approved', reject: 'rejected', changes: 'changes_requested' };
const REQ_STATUS = ['new', 'in_progress', 'proof_sent', 'done'];
const BUCKETS = ['creator-submissions', 'design-submissions'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.code, { error: gate.error });

  try {
    const body = JSON.parse(event.body || '{}');
    const { entity } = body;

    if (entity === 'sign') {
      if (!BUCKETS.includes(body.bucket) || !body.path) return json(400, { error: 'bucket and path required' });
      const res = await fetch(`${SB_URL}/storage/v1/object/sign/${body.bucket}/${String(body.path).replace(/^\/+/, '')}`, {
        method: 'POST', headers: adminHeaders(), body: JSON.stringify({ expiresIn: 600 })
      });
      if (!res.ok) return json(502, { error: `sign failed ${res.status}` });
      const d = await res.json();
      return json(200, { url: `${SB_URL}/storage/v1${d.signedURL || d.signedUrl}` });
    }

    if (entity === 'submission') {
      if (!body.id || !SUB_STATUS[body.action]) return json(400, { error: 'id and valid action required' });
      const row = await sbPatch('creator_submissions', body.id, {
        status: SUB_STATUS[body.action],
        reviewed_by: gate.email,
        reviewed_at: new Date().toISOString(),
        review_notes: clean(body.notes)
      });
      return json(200, { ok: true, row });
    }

    if (entity === 'request') {
      if (!body.id || !REQ_STATUS.includes(body.status)) return json(400, { error: 'id and valid status required' });
      const patch = { fulfilment_status: body.status, admin_notes: clean(body.notes) };
      if (body.assigned_to !== undefined) patch.assigned_to = clean(body.assigned_to, 120);
      const row = await sbPatch('design_submissions', body.id, patch);
      return json(200, { ok: true, row });
    }

    return json(400, { error: "entity must be 'submission', 'request' or 'sign'" });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
