/* Canine Keepsakes - shared auth (Supabase, no build step).
   Loads supabase-js from CDN and exposes CK.auth.* . The anon key + url come
   from /api/supabase-config (both public; RLS protects the data). */
CK.auth = (() => {
  let client = null;
  let ready = null;

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      const cfg = await fetch('/api/supabase-config').then(r => r.json());
      if (!cfg.url || !cfg.anonKey) throw new Error('Supabase config missing');
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      client = createClient(cfg.url, cfg.anonKey);
      return client;
    })();
    return ready;
  }

  async function signUp(email, password) {
    const c = await init();
    return c.auth.signUp({ email, password });
  }
  async function signIn(email, password) {
    const c = await init();
    return c.auth.signInWithPassword({ email, password });
  }
  async function signOut() {
    const c = await init();
    await c.auth.signOut();
  }
  async function session() {
    const c = await init();
    const { data } = await c.auth.getSession();
    return data.session;
  }
  async function user() {
    const s = await session();
    return s ? s.user : null;
  }
  async function token() {
    const s = await session();
    return s ? s.access_token : null;
  }
  async function profile() {
    const c = await init();
    const u = await user();
    if (!u) return null;
    const { data } = await c.from('profiles').select('*').eq('id', u.id).maybeSingle();
    return data;
  }
  async function saveProfile(fields) {
    const c = await init();
    const u = await user();
    if (!u) return;
    await c.from('profiles').update(fields).eq('id', u.id);
  }
  async function orders() {
    const c = await init();
    const { data } = await c.from('orders').select('*').order('created_at', { ascending: false });
    return data || [];
  }
  /* Sends a password-reset email. The link returns the user to
     reset-password.html with a recovery token Supabase picks up automatically. */
  async function requestPasswordReset(email) {
    const c = await init();
    return c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/reset-password.html' });
  }
  /* Sets a new password for the currently-recovered session (used on reset-password.html). */
  async function updatePassword(password) {
    const c = await init();
    return c.auth.updateUser({ password });
  }
  return { init, signUp, signIn, signOut, session, user, token, profile, saveProfile, orders,
           requestPasswordReset, updatePassword };
})();
