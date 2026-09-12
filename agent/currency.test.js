// server/store/currency.js probe — plain node asserts (same style as
// store.test.js/gate.test.js). Run with `node currency.test.js`.

import assert from "node:assert/strict";
import { normalizeCurrency, formatMoney } from "./store/currency.js";

// (i) bare code string -> known symbol, "before" position.
{
  assert.deepEqual(normalizeCurrency({ currency: "BDT" }), { code: "BDT", symbol: "৳", position: "before" });
  assert.deepEqual(normalizeCurrency({ currency: "USD" }), { code: "USD", symbol: "$", position: "before" });
  console.log("(i) ok — bare currency code resolves to the right symbol");
}

// (ii) missing/malformed policies -> default store's own currency (৳/BDT), never throws.
{
  assert.deepEqual(normalizeCurrency(null), { code: "BDT", symbol: "৳", position: "before" });
  assert.deepEqual(normalizeCurrency({}), { code: "BDT", symbol: "৳", position: "before" });
  assert.deepEqual(normalizeCurrency(undefined), { code: "BDT", symbol: "৳", position: "before" });
  console.log("(ii) ok — missing/malformed policies falls back to the default store's currency");
}

// (iii) unknown code -> the code itself stands in as its own symbol (never crashes, never silently defaults to ৳/$).
{
  assert.deepEqual(normalizeCurrency({ currency: "XYZ" }), { code: "XYZ", symbol: "XYZ", position: "before" });
  console.log("(iii) ok — unknown currency code degrades to using the code as its own symbol");
}

// (iv) already-rich object form {code, symbol, position} is accepted as-is (a merchant override).
{
  const rich = normalizeCurrency({ currency: { code: "eur", symbol: "€", position: "after" } });
  assert.deepEqual(rich, { code: "EUR", symbol: "€", position: "after" });
  console.log("(iv) ok — object-form currency accepted, code upper-cased, position honored");
}

// (v) formatMoney: "before" (৳/$ default) vs "after" position.
{
  assert.equal(formatMoney(120, normalizeCurrency({ currency: "BDT" })), "৳120");
  assert.equal(formatMoney(37.99, normalizeCurrency({ currency: "USD" })), "$37.99");
  assert.equal(formatMoney(9.5, { code: "EUR", symbol: "€", position: "after" }), "9.5€");
  console.log("(v) ok — formatMoney respects symbol + position");
}

// (vi) formatMoney also accepts a raw `policies`-shaped object (normalizes internally).
{
  assert.equal(formatMoney(50, { currency: "USD" }), "$50");
  console.log("(vi) ok — formatMoney(amount, policies) normalizes internally when passed a raw policies object");
}

console.log("currency.test: all assertions passed");
