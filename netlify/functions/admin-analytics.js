/* GET /api/admin-analytics?range=7|30 — staff-only website traffic, pulled from
   Cloudflare Web Analytics via the GraphQL API so staff need only their CK login.
   Secrets live in Netlify env (never in the browser, never shared):
     CLOUDFLARE_API_TOKEN        (Account Analytics -> Read)
     CLOUDFLARE_ACCOUNT_ID
     CF_WEB_ANALYTICS_SITE_TAG   (the Web Analytics site tag)
   If those aren't set yet, returns { configured:false } so the UI shows a
   friendly "ask the owner to switch it on" note instead of erroring. */
const { json, corsHeaders, isOriginAllowed, rateLimit, verifyUser } = require('./_lib');

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_SITE = process.env.CF_WEB_ANALYTICS_SITE_TAG;

async function requireAdmin(event) {
  const u = await verifyUser(event);
  if (!u) return { ok: false, code: 401, error: 'Please sign in' };
  const allow = String(process.env.ADMIN_EMAILS || process.env.admin_emails || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  const email = String(u.email || '').toLowerCase();
  if (!email || !allow.includes(email)) return { ok: false, code: 403, error: 'Not authorised' };
  return { ok: true, email };
}

const ymd = d => new Date(d).toISOString().slice(0, 10);

const QUERY = `query($acct:String!,$tag:String!,$start:Date!,$end:Date!){
  viewer{ accounts(filter:{accountTag:$acct}){
    totals: rumPageloadEventsAdaptiveGroups(limit:1, filter:{date_geq:$start, date_leq:$end, siteTag:$tag}){ count sum{ visits } }
    series: rumPageloadEventsAdaptiveGroups(limit:100, orderBy:[date_ASC], filter:{date_geq:$start, date_leq:$end, siteTag:$tag}){ count sum{ visits } dimensions{ date } }
    pages: rumPageloadEventsAdaptiveGroups(limit:10, orderBy:[count_DESC], filter:{date_geq:$start, date_leq:$end, siteTag:$tag}){ count dimensions{ requestPath } }
    countries: rumPageloadEventsAdaptiveGroups(limit:10, orderBy:[count_DESC], filter:{date_geq:$start, date_leq:$end, siteTag:$tag}){ count dimensions{ countryName } }
  }}}`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' };
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const gate = await requireAdmin(event);
  if (!gate.ok) return json(gate.code, { error: gate.error });

  if (!CF_TOKEN || !CF_ACCT || !CF_SITE) return json(200, { configured: false });

  const range = Math.min(90, Math.max(1, parseInt((event.queryStringParameters || {}).range, 10) || 7));
  const end = new Date();
  const start = new Date(Date.now() - (range - 1) * 86400000);

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { acct: CF_ACCT, tag: CF_SITE, start: ymd(start), end: ymd(end) } })
    });
    const data = await res.json();
    if (data.errors && data.errors.length) return json(502, { error: 'Cloudflare: ' + data.errors.map(e => e.message).join('; ') });
    const acc = (((data.data || {}).viewer || {}).accounts || [])[0] || {};
    const t = (acc.totals || [])[0] || { count: 0, sum: { visits: 0 } };
    return json(200, {
      configured: true,
      range,
      totals: { pageViews: t.count || 0, visits: (t.sum && t.sum.visits) || 0 },
      series: (acc.series || []).map(d => ({ date: d.dimensions.date, pageViews: d.count || 0, visits: (d.sum && d.sum.visits) || 0 })),
      topPages: (acc.pages || []).map(p => ({ path: p.dimensions.requestPath, count: p.count || 0 })),
      topCountries: (acc.countries || []).map(p => ({ country: p.dimensions.countryName, count: p.count || 0 }))
    });
  } catch (err) {
    return json(502, { error: err.message });
  }
};
