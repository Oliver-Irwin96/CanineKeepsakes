/* POST /api/admin-action — staff-only mutations (admin v2).
   entities:
     submission  { id, action:'approve'|'reject'|'changes'|'reopen', reason?, notes? }
     request     { id, status, assigned_to?, notes? }
     sign        { bucket, path }
   Lead-admin lock: once a LEAD finalises a submission, only a lead can change it.
   Lead list = LEAD_ADMIN_EMAILS, else defaults to the first ADMIN_EMAILS entry.
   On a submission decision the creator is emailed (Resend) AND the reason is stored
   so it shows on their account page. */
const { json, corsHeaders, isOriginAllowed, rateLimit, verifyUser } = require('./_lib');

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.resend_api_key;
const RESEND_FROM = process.env.RESEND_FROM || 'Canine Keepsakes <noreply@caninekeepsakes.co.uk>';
const adminHeaders = () => ({ apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' });
const clean = (s, m = 2000) => (s == null ? null : String(s).trim().slice(0, m) || null);
const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const splitList = v => String(v || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
const adminEmails = () => splitList(process.env.ADMIN_EMAILS || process.env.admin_emails);
function leadEmails() {
  const explicit = splitList(process.env.LEAD_ADMIN_EMAILS || process.env.lead_admin_emails);
  if (explicit.length) return explicit;
  const a = adminEmails(); return a.length ? [a[0]] : [];
}

async function requireAdmin(event) {
  if (!SB_URL || !SB_SERVICE) return { ok: false, code: 500, error: 'Supabase not configured' };
  const u = await verifyUser(event);
  if (!u) return { ok: false, code: 401, error: 'Please sign in' };
  const email = String(u.email || '').toLowerCase();
  if (!email || !adminEmails().includes(email)) return { ok: false, code: 403, error: 'Not authorised' };
  return { ok: true, email, isLead: leadEmails().includes(email) };
}

async function sbGetOne(table, id) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=*`, { headers: adminHeaders() });
  if (!r.ok) throw new Error(`${table} get -> ${r.status}`);
  const rows = await r.json(); return rows[0] || null;
}
async function sbPatch(table, id, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { ...adminHeaders(), Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error(`${table} patch -> ${r.status}: ${await r.text()}`);
  const rows = await r.json(); return rows[0] || null;
}

async function sendDecisionEmail(to, status, title, reason) {
  if (!RESEND_KEY || !to) return;
  const t = title || 'your design';
  let subject, intro;
  if (status === 'approved') { subject = `Good news about "${t}"`; intro = `Great news — your design <b>"${esc(t)}"</b> has been approved for Canine Keepsakes. We'll be in touch with the next steps.`; }
  else if (status === 'changes_requested') { subject = `A few tweaks for "${t}"`; intro = `We'd love to feature <b>"${esc(t)}"</b> with a small change first:<br><br><b>${esc(reason || 'See notes')}</b><br><br>Once updated, just resubmit it and we'll take another look.`; }
  else { subject = `Update on "${t}"`; intro = `Thank you for submitting <b>"${esc(t)}"</b>. Unfortunately we're not able to accept it this time.<br><br><b>Reason:</b> ${esc(reason || 'Not specified')}`; }
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:auto">
    <div style="background:#16181f;padding:18px 22px;border-bottom:3px solid #d2922f"><span style="color:#fff;font-family:Georgia,serif;font-size:20px">&#128062; Canine <span style="color:#d2922f">Keepsakes</span></span></div>
    <div style="padding:22px;color:#2a2f3a;font-size:15px;line-height:1.6">${intro}<br><br>Thank you,<br>Canine Keepsakes</div></div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html })
    });
  } catch (e) { console.error('decision email failed (non-fatal)', e.message); }
}

const SUB_STATUS = { approve: 'approved', reject: 'rejected', changes: 'changes_requested', reopen: 'submitted' };
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
      const status = SUB_STATUS[body.action];
      if (!body.id || !status) return json(400, { error: 'id and valid action required' });
      const row = await sbGetOne('creator_submissions', body.id);
      if (!row) return json(404, { error: 'submission not found' });
      // Lead lock: a lead-finalised decision can only be changed by a lead.
      if (row.locked_by_lead && !gate.isLead) {
        return json(403, { error: 'This decision was finalised by a lead admin and can only be changed by a lead.' });
      }
      const reason = clean(body.reason, 200);
      const isReopen = body.action === 'reopen';
      const patch = {
        status,
        reviewed_by: gate.email,
        reviewed_at: new Date().toISOString(),
        review_notes: clean(body.notes),
        decision_reason: isReopen ? null : (body.action === 'approve' ? null : reason),
        locked_by_lead: isReopen ? false : !!gate.isLead
      };
      const updated = await sbPatch('creator_submissions', body.id, patch);
      if (!isReopen) await sendDecisionEmail(row.email, status, row.title, reason);
      return json(200, { ok: true, row: updated });
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
