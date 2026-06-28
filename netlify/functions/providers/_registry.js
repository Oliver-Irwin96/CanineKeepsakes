/* CK fulfilment provider registry (Phase 2 groundwork — not yet wired into capture-order).
   Each provider exports: quote(items,recipient,shippingMethod?), createOrder(payload), getOrder(id).
   Pick provider per catalogue item: item.provider (default 'printful'). */
const printful = require('./printful');   // adapter to be extracted from capture-order/_lib later
const prodigi = require('./prodigi');

const PROVIDERS = { printful, prodigi };
function getProvider(name) {
  const p = PROVIDERS[String(name || 'printful').toLowerCase()];
  if (!p) throw new Error(`unknown provider: ${name}`);
  return p;
}
/* Group basket items by their provider so each provider gets its own order. */
function groupByProvider(items) {
  const groups = {};
  for (const it of items) { const k = (it.provider || 'printful').toLowerCase(); (groups[k] ||= []).push(it); }
  return groups;
}
module.exports = { getProvider, groupByProvider };
