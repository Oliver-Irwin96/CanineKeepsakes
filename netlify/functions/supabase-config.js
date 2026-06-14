/* GET /api/supabase-config -> { url, anonKey }
   Both values are PUBLIC (the anon key is safe to expose to the browser; RLS
   protects the data). Served from env so nothing is hard-coded in the repo,
   mirroring the paypal-config pattern. */
const { json, isOriginAllowed, rateLimit } = require('./_lib');

exports.handler = async (event) => {
  if (!isOriginAllowed(event)) return json(403, { error: 'forbidden origin' });
  if (!rateLimit(event, 60, 60000)) return json(429, { error: 'too many requests' });
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return json(200, { error: 'supabase config missing' });
  return json(200, { url, anonKey });
};
