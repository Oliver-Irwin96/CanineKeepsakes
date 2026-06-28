/* Tax engine — config-driven, degrades safely. If a region's tax isn't enabled (or no provider
   wired), CK simply doesn't add tax — which is correct for a small UK seller below foreign
   thresholds. Flip the switches in launch-policy.json (after professional advice) to start collecting.
   We NEVER hardcode tax rates or guess nexus. */
'use strict';
const { regionConfig } = require('./regions');

/* taxAdapters: optional map e.g. { taxjar: async(addr, subtotal)=>({amount,rate}) }.
   Returns { amount, currency, type, includedInPrice?, deferred?, note? }. */
async function computeTax({ region, address, subtotalLocal, taxAdapters }) {
  const cfg = regionConfig(region);
  const t = cfg && cfg.tax;
  if (!t || !t.enabled) return { amount: 0, type: (t && t.type) || 'none' };

  // VAT regions where prices already include tax (UK, future EU): nothing added at checkout.
  if (t.type === 'vat' && t.pricesIncludeTax) {
    const rate = t.rate || 0;
    const inclVat = rate ? +(subtotalLocal - subtotalLocal / (1 + rate)).toFixed(2) : 0;
    return { amount: 0, type: 'vat', includedInPrice: true, rate, vatPortion: inclVat };
  }

  // Sales tax / GST: must come from a real provider. If none configured, do not collect (and flag).
  if (t.type === 'sales_tax' || t.type === 'gst' || t.type === 'gst_hst') {
    const prov = t.provider;
    if (!prov || prov === 'TBD' || !(taxAdapters && taxAdapters[prov])) {
      return { amount: 0, type: t.type, deferred: true, note: 'no tax provider configured — not collecting (below threshold / pre-registration)' };
    }
    const res = await taxAdapters[prov](address, subtotalLocal);
    return { amount: +Number(res.amount || 0).toFixed(2), type: t.type, rate: res.rate, provider: prov };
  }

  return { amount: 0, type: t.type || 'none' };
}

module.exports = { computeTax };
