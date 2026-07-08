/* CK referral capture (deploy candidate, tiny + inert without REFERRALS_ENABLED)
   Include on any page: stores ?ref=CODE for 90 days so attribution survives
   the browse → sign-up → submit journey. creators flow calls /api/referral
   {action:'attach'} after login. New file — changes nothing existing. */
(function () {
  try {
    var ref = new URLSearchParams(location.search).get('ref');
    if (ref && /^[A-Za-z0-9-]{4,16}$/.test(ref)) {
      localStorage.setItem('ck-ref', JSON.stringify({ code: ref.toUpperCase(), at: Date.now() }));
    }
  } catch (_) {}
})();
window.CKRef = {
  get: function () {
    try {
      var d = JSON.parse(localStorage.getItem('ck-ref') || 'null');
      if (!d) return null;
      if (Date.now() - d.at > 90 * 24 * 3600 * 1000) { localStorage.removeItem('ck-ref'); return null; }
      return d.code;
    } catch (_) { return null; }
  },
  clear: function () { try { localStorage.removeItem('ck-ref'); } catch (_) {} }
};
