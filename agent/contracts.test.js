// contracts.js probe — plain node asserts (same style as gate.test.js).
// Covers the 5 context-aware trigger event types added 2026-09-12
// (exit_intent, atc_hesitation, variant_switch, promo_focus_blur,
// scroll_uturn): every one must be a recognized EVENT_TYPE, have a
// META_SHAPES entry, and validateMeta must never reject/throw on a
// well-formed or malformed payload (lenient validation contract).

import assert from "node:assert/strict";
import { EVENT_TYPES, META_SHAPES, validateMeta, isValidSessionId } from "./contracts.js";

const NEW_TYPES = ["exit_intent", "atc_hesitation", "variant_switch", "promo_focus_blur", "scroll_uturn"];

for (const t of NEW_TYPES) {
  assert.ok(EVENT_TYPES.includes(t), `expected EVENT_TYPES to include "${t}"`);
  assert.ok(t in META_SHAPES, `expected META_SHAPES to document "${t}"`);
}
console.log("(i) ok — every new context-aware event type is registered + documented");

// validateMeta never throws, on well-formed or malformed meta
const samples = {
  exit_intent: { kind: "mouse_leave" },
  atc_hesitation: { target: "add-to-cart", hovers: 2 },
  variant_switch: { kind: "size" },
  promo_focus_blur: { empty: true },
  scroll_uturn: { downPct: 72 },
};
for (const [type, meta] of Object.entries(samples)) {
  assert.doesNotThrow(() => validateMeta(type, meta), `validateMeta should not throw for well-formed ${type}`);
}
const malformed = {
  exit_intent: { kind: 123 },
  atc_hesitation: { hovers: "two" },
  variant_switch: { kind: null },
  promo_focus_blur: { empty: "yes" },
  scroll_uturn: { downPct: "seventy" },
};
for (const [type, meta] of Object.entries(malformed)) {
  assert.doesNotThrow(() => validateMeta(type, meta), `validateMeta should not throw (lenient) for malformed ${type}`);
}
console.log("(ii) ok — validateMeta stays lenient (never throws) for well-formed and malformed new-event meta");

// (ii-b) page_context (2026-09-12 "richer scanned site context" brief):
// registered EVENT_TYPE + META_SHAPES entry, lenient validateMeta.
assert.ok(EVENT_TYPES.includes("page_context"), "expected EVENT_TYPES to include page_context");
assert.ok("page_context" in META_SHAPES, "expected META_SHAPES to document page_context");
assert.doesNotThrow(
  () =>
    validateMeta("page_context", {
      page_type: "product",
      product: { title: "Khadi Field Jacket", price: 3450 },
      variants: [{ name: "M", available: false }],
      stock_text: "Only 2 left",
      promo_present: false,
    }),
  "validateMeta should not throw for well-formed page_context"
);
assert.doesNotThrow(
  () => validateMeta("page_context", { page_type: 123, variants: "not-an-array", promo_present: "yes" }),
  "validateMeta should not throw (lenient) for malformed page_context"
);
console.log("(ii-b) ok — page_context registered + documented, validateMeta stays lenient");

assert.equal(isValidSessionId("nextcart_s1"), true);
assert.equal(isValidSessionId(""), false);
console.log("(iii) ok — isValidSessionId sanity check unaffected by new event types");

console.log("contracts.test: all assertions passed");
