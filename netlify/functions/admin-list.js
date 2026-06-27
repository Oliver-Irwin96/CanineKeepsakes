/* GET /api/admin-list — staff-only dashboard data.
   Gate: caller must be signed in AND their email must be in ADMIN_EMAILS.
   Reads across creator_submissions, design_submissions, orders with the
   service-role key (bypasses RLS) only AFTER the staff check passes. */
const { json, corsHeaders, isOriginAllowed, rateLimit, verifyUser } = require('./_lib');

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminHeaders = () => ({ apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' });

async function requireAdmin(event) {
  if (!SB_URL || !SB_SERVICE) return { ok: false, code: 500, error: 'Supabase not configured' };
  const u = await verifyUser(event);
  if (!u) return { ok: false, code: 401, error: 'Please sign in' };
  const allow = String(process.env.ADMIN_EMAILS || process.env.admin_emails || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  const email = String(u.email || '').toLowerCase();
  if (!email || !allow.includes(email)) return { ok: false, code: 403, error: 'Not authorised' };
  return { ok: true, user: u, email };
}

async function sbGet(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const sinceDays = d => new Date(Date.now() - d * 86400000).toISOString();
const num = r => Number(r.amount ?? r.total ?? r.amount_total ?? r.amount_paid ?? 0) || 0;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.code, { error: gate.error });

  try {
    const [submissions, requests, orders] = await Promise.all([
      sbGet('creator_submissions?select=*&order=created_at.desc&limit=300'),
      sbGet('design_submissions?select=*&order=created_at.desc&limit=300'),
      sbGet('orders?select=*&order=created_at.desc&limit=150')
    ]);
    const wk = sinceDays(7);
    const isPending = s => !['approved', 'rejected'].includes(String(s.status || '').toLowerCase());
    const counts = {
      pendingSubmissions: submissions.filter(isPending).length,
      openRequests: requests.filter(r => String(r.fulfilment_status || 'new') !== 'done').length,
      submissionsThisWeek: submissions.filter(s => (s.created_at || '') >= wk).length,
      ordersThisWeek: orders.filter(o => (o.created_at || '') >= wk).length,
      salesThisWeek: Math.round(orders.filter(o => (o.created_at || '') >= wk).reduce((t, o) => t + num(o), 0) * 100) / 100
    };
    return json(200, { me: gate.email, counts, submissions, requests, orders });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
