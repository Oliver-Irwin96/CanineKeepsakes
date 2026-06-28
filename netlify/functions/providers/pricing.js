/* Pricing engine — pure, config-driven. base GBP cost -> live FX -> per-category margin -> regional retail.
   Never store fixed retail prices; always derive. */
'use strict';
const POLICY = require('./launch-policy.json');
const { regionConfig } = require('./regions');

function marginFor(category) {
  const m = POLICY.marginsByCategory;
  return (category && m[category] != null) ? m[category] : m.default;
}

/* charm rounding: round UP to the next whole unit then drop a penny -> ends in .99
   e.g. 22.75 -> 22.99, 23.01 -> 23.99. Never rounds below the cost-plus figure. */
function charm(amount) {
  const ends = (POLICY.pricing.rounding && POLICY.pricing.rounding.endsWith) || 0.99;
  const whole = Math.floor(amount);
  const candidate = whole + ends;            // e.g. 22.99
  return +(candidate >= amount ? candidate : whole + 1 + ends).toFixed(2);
}

/* rates: { GBP:1, USD:1.27, EUR:1.17, CAD:1.71, AUD:1.93, NZD:2.10 } (per 1 GBP), from currency_rates cache. */
function convertFromGBP(amountGBP, currency, rates) {
  if (currency === 'GBP') return amountGBP;
  const r = rates && rates[currency];
  if (!r || !Number.isFinite(r)) throw new Error(`no FX rate for ${currency}`);
  return amountGBP * r;
}

/* costGBP = provider item cost (+ fees) in GBP. Returns retail in the region's currency. */
function regionalRetail({ costGBP, category, region, rates }) {
  const cfg = regionConfig(region);
  if (!cfg) throw new Error(`unknown region ${region}`);
  const margin = marginFor(category);
  const base = costGBP / (1 - margin);            // cost-plus-margin, forward only
  const local = convertFromGBP(base, cfg.currency, rates);
  return { region, currency: cfg.currency, symbol: cfg.symbol, price: +charm(local).toFixed(2), margin, costGBP };
}

/* Free shipping if subtotal (local) >= region threshold, else caller uses live provider quote. */
function shippingFree(region, subtotalLocal) {
  const cfg = regionConfig(region);
  return !!cfg && Number(subtotalLocal) >= Number(cfg.freeShipThreshold);
}

/* ---------------------------------------------------------------------------
   FIXED per-currency retail (the customer-facing price = the charged price).
   prices.json is generated from catalog retailGBP x daily FX, charm-rounded, and
   FROZEN. Display (region.js) and charge (server) both read this table, so the
   customer is charged exactly what they saw. To refresh FX, regenerate the table.
   Gelato's live cost is COGS only (margin monitoring), never the charge basis.
   --------------------------------------------------------------------------- */
const PRICES = require('./prices.json');
const MAX_QTY = 100;
const clampQty = q => Math.min(MAX_QTY, Math.max(1, parseInt(q) || 1));

/* retail for one product slug in a currency. Falls back to GBP if a currency
   column is missing (defensive); throws on a genuinely unknown product. */
function retailFor(slug, currency) {
  const row = PRICES[slug];
  if (!row) throw new Error(`unknown product: ${slug}`);
  const v = row[currency] != null ? row[currency] : row.GBP;
  if (v == null) throw new Error(`no price for ${slug} in ${currency}`);
  return +Number(v).toFixed(2);
}

/* authoritative basket subtotal in `currency` — NEVER trust client prices. */
function priceBasket(items, currency) {
  return items.reduce((sum, i) => sum + retailFor(i.productSlug, currency) * clampQty(i.qty), 0);
}

/* Deterministic delivery the customer is charged (display==charge): a fixed flat
   rate per region in local currency, FREE over the region threshold. Gelato's live
   shipping is COGS, handled separately at order creation. */
function standardShipping(region, subtotalLocal) {
  const cfg = regionConfig(region) || {};
  const free = Number(subtotalLocal) >= Number(cfg.freeShipThreshold || Infinity);
  const rate = free ? 0 : +Number(cfg.shipFlat || 0).toFixed(2);
  return { free, rate, name: free ? 'Free delivery' : 'Standard delivery', currency: cfg.currency };
}

module.exports = { marginFor, convertFromGBP, regionalRetail, shippingFree, charm,
  PRICES, retailFor, priceBasket, clampQty, standardShipping };
