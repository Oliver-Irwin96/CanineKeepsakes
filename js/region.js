/* CK region + currency (frontend). Standalone, additive — load BEFORE store.js.
   Fixed per-currency pricing model (matches the server): every product carries a
   `prices` map { GBP, USD, CAD, AUD, NZD, EUR } baked into the catalog. The storefront
   shows the price for the active region's currency, and the server charges the SAME
   number — so the customer is charged exactly what they saw. No runtime FX, no drift.
   Active region: explicit cookie override -> default UK. Geo-IP can set the cookie later;
   at checkout the chosen shipping country sets the region (setRegionByCountry). */
(function () {
  'use strict';

  var REGIONS = {
    UK: { enabled: true,  currency: 'GBP', symbol: '£', freeShip: 60,  shipFlat: 3.99 },
    US: { enabled: true,  currency: 'USD', symbol: '$', freeShip: 75,  shipFlat: 5.99 },
    CA: { enabled: true,  currency: 'CAD', symbol: '$', freeShip: 100, shipFlat: 7.99 },
    AU: { enabled: true,  currency: 'AUD', symbol: '$', freeShip: 110, shipFlat: 8.99 },
    NZ: { enabled: true,  currency: 'NZD', symbol: '$', freeShip: 130, shipFlat: 9.99 },
    EU: { enabled: false, currency: 'EUR', symbol: '€', freeShip: 70,  shipFlat: 4.99 }
  };

  var EU_CODES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  var EXCLUDED = ['RU','BY','KP','IR','SY'];

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, val) { document.cookie = name + '=' + encodeURIComponent(val) + ';path=/;max-age=' + (60 * 60 * 24 * 365); }

  function regionForCountry(cc) {
    cc = (cc || '').toUpperCase();
    if (cc === 'GB' || cc === 'UK') return 'UK';
    if (['US','CA','AU','NZ'].indexOf(cc) >= 0) return cc;
    if (EU_CODES.indexOf(cc) >= 0) return 'EU';
    return null;
  }
  function currencyForCountry(cc) {
    var r = regionForCountry(cc);
    return r && REGIONS[r] ? REGIONS[r].currency : 'GBP';
  }

  // current region: explicit cookie override -> default UK (geo-IP can set the cookie later)
  var current = cookie('ck-region');
  if (!current || !REGIONS[current]) current = 'UK';

  function cfg() { return REGIONS[current]; }

  /* format a number that is ALREADY in the active currency */
  function fmt(amount) { return cfg().symbol + Number(amount || 0).toFixed(2); }

  /* the active-currency price for a product/cart-item that carries a `prices` map.
     Falls back to GBP base if a currency column is missing (defensive). */
  function priceOf(o) {
    if (!o) return 0;
    var c = cfg().currency;
    if (o.prices && o.prices[c] != null) return +o.prices[c];
    if (o.prices && o.prices.GBP != null) return +o.prices.GBP;
    return +(o.retailGBP != null ? o.retailGBP : (o.retailPrice != null ? o.retailPrice : (o.priceGBP || 0)));
  }

  function setRegion(r) {
    if (REGIONS[r]) { current = r; setCookie('ck-region', r); document.dispatchEvent(new CustomEvent('ck-region-change', { detail: r })); }
  }
  /* set the active region from a shipping country (used at checkout) */
  function setRegionByCountry(cc) {
    var r = regionForCountry(cc);
    if (r && REGIONS[r] && REGIONS[r].enabled) { setRegion(r); return r; }
    return null;
  }
  function isSellable(cc) {
    if (EXCLUDED.indexOf((cc || '').toUpperCase()) >= 0) return { ok: false, reason: 'excluded' };
    var r = regionForCountry(cc);
    if (!r) return { ok: false, reason: 'not_configured' };
    if (!REGIONS[r].enabled) return { ok: false, reason: r === 'EU' ? 'coming_soon_eu' : 'disabled', region: r };
    return { ok: true, region: r, currency: REGIONS[r].currency };
  }

  window.CKRegion = {
    get region() { return current; },
    get currency() { return cfg().currency; },
    get symbol() { return cfg().symbol; },
    get freeShipThreshold() { return cfg().freeShip; },
    get shipFlat() { return cfg().shipFlat; },
    regions: REGIONS,
    setRegion: setRegion, setRegionByCountry: setRegionByCountry,
    fmt: fmt, money: fmt, priceOf: priceOf,
    regionForCountry: regionForCountry, currencyForCountry: currencyForCountry,
    isSellable: isSellable,
    enabledRegions: function () { return Object.keys(REGIONS).filter(function (k) { return REGIONS[k].enabled; }); }
  };
})();
