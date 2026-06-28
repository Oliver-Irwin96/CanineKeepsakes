/* Region gate — pure, config-driven. Reads launch-policy.json. No hardcoded country logic in app code.
   regionForCountry('US') -> 'US'; isSellable('DE') -> false (EU disabled); isSellable('RU') -> false (excluded). */
'use strict';
const POLICY = require('./launch-policy.json');

const EU_MEMBERS = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

/* Map an ISO country code to a CK region key, or null if not in any configured region. */
function regionForCountry(cc) {
  const c = (cc || '').toUpperCase();
  if (c === 'GB' || c === 'UK') return 'UK';
  if (['US','CA','AU','NZ'].includes(c)) return c;
  if (EU_MEMBERS.includes(c)) return 'EU';
  return null; // rest of world -> phase 3, not yet configured
}

function isExcluded(cc) {
  const c = (cc || '').toUpperCase();
  return (POLICY.excludedCountries.codes || []).includes(c);
}

function regionConfig(region) { return POLICY.regions[region] || null; }

/* Can we sell to this country right now? */
function isSellable(cc) {
  if (isExcluded(cc)) return { ok: false, reason: 'excluded' };
  const region = regionForCountry(cc);
  if (!region) return { ok: false, reason: 'region_not_configured' };
  const cfg = POLICY.regions[region];
  if (!cfg || !cfg.enabled) return { ok: false, reason: region === 'EU' ? 'coming_soon_eu' : 'region_disabled', region };
  return { ok: true, region, currency: cfg.currency };
}

function enabledRegions() { return Object.entries(POLICY.regions).filter(([, c]) => c.enabled).map(([k]) => k); }

module.exports = { regionForCountry, isExcluded, regionConfig, isSellable, enabledRegions, EU_MEMBERS, POLICY };
