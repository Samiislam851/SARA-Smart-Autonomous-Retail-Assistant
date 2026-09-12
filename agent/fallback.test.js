// server/decide/fallback.js probe — plain node asserts (same style as
// server/templates.test.js / server/probe-policy.test.js). Runnable with
// `node fallback.test.js` or `node --test fallback.test.js`.

import assert from "node:assert/strict";
import { decideFallback } from "./decide/fallback.js";

function fakeState(overrides = {}) {
  return {
    page: "/p/wavecrest-noise-isolating-wireless-earbuds-2-0",
    visibleTargets: ["size-guide", "promo-code", "cart-link", "agent-banner"],
    cart: null,
    promo: null,
    search: null,
    facts: null,
    business: {
      currency: { code: "USD", symbol: "$", position: "before" },
      delivery: { free_over: 0, days: "5-7" },
      returns: { window_days: 30 },
      payment: { methods: ["COD"] },
    },
    offers: [],
    product: null,
    gateSignals: [],
    ...overrides,
  };
}

// (a) variant_churn on a NextCart-style product (real fit_notes fact) ->
// variant_help card, rendered, grounded slot.
{
  const state = fakeState({
    page: "/p/arclight-smart-watch",
    product: { slug: "arclight-smart-watch", name: "Arclight Smart Watch", price: 182.99, sizes: [], fit_notes: "Adjustable strap fits most wrists." },
    gateSignals: [{ name: "variant_churn", template: "variant_help" }],
  });
  const { action, trace } = decideFallback(state, { reason: "timeout" });
  assert.equal(action.action, "card");
  assert.equal(action.card.template, "variant_help");
  assert.equal(action.card.title, "Need a hand choosing?");
  assert.equal(action.card.body, "Adjustable strap fits most wrists.");
  assert.equal(trace.decision, "card size-guide");
  assert.ok(trace.why.startsWith("fallback: llm_timeout"), trace.why);
  assert.deepEqual(trace.signals, ["variant_churn"]);
  console.log("(a) ok — variant_churn -> variant_help card, grounded fit_notes:", action.card.body);
}

// (b) promo_focus_empty on cart with NEXT10 -> promo_hint card with a $ saving.
{
  const state = fakeState({
    page: "/cart",
    cart: { total: 53.99, items: [{ slug: "wavecrest-noise-isolating-wireless-earbuds-2-0", qty: 1 }] },
    offers: [
      {
        kind: "missed_discount",
        target_hint: "promo-code",
        slug: "wavecrest-noise-isolating-wireless-earbuds-2-0",
        code: "NEXT10",
        label: "10% off with code NEXT10",
        saving: 5.4,
      },
    ],
    gateSignals: [{ name: "promo_focus_empty", template: "promo_hint" }],
  });
  const { action, trace } = decideFallback(state, { reason: "error" });
  assert.equal(action.action, "card");
  assert.equal(action.card.template, "promo_hint");
  assert.equal(action.card.title, "Have a code?");
  assert.match(action.card.body, /NEXT10/);
  assert.match(action.card.body, /\$5\.4/);
  assert.equal(action.card.cta.kind, "apply_code");
  assert.equal(action.card.cta.value, "NEXT10");
  assert.equal(trace.decision, "card promo-code");
  console.log("(b) ok — promo_focus_empty -> promo_hint card with $ saving:", action.card.body);
}

// (c) no signals, product page -> a grounded generic message from business
// facts (returns window), not a noop.
{
  const state = fakeState({
    page: "/p/arclight-smart-watch",
    product: { slug: "arclight-smart-watch", name: "Arclight Smart Watch", price: 182.99, sizes: [], fit_notes: null },
    gateSignals: [],
  });
  const { action, trace } = decideFallback(state, { reason: "bad_shape" });
  assert.equal(action.action, "message");
  assert.match(action.message, /30 days/);
  assert.equal(trace.decision, "message");
  assert.ok(trace.why.startsWith("fallback: llm_bad_shape"), trace.why);
  console.log("(c) ok — no signals, product page -> grounded returns-window message:", action.message);
}

// (d) nothing groundable at all -> noop, with a real trace entry.
{
  const state = fakeState({
    page: "/about",
    business: { currency: { code: "USD", symbol: "$", position: "before" }, delivery: null, returns: null, payment: null },
    gateSignals: [{ name: "idle", template: "idle_check_in" }],
  });
  const { action, trace } = decideFallback(state, { reason: "error" });
  assert.equal(action.action, "noop");
  assert.equal(trace.decision, "noop");
  assert.ok(trace.why.startsWith("fallback: llm_error"), trace.why);
  console.log("(d) ok — nothing groundable -> noop:", trace.why);
}

// (e) llm.js's own failure path invokes the fallback decider (real import,
// no mocking framework — force a fast, deterministic network failure by
// pointing the "openai" backend at an unreachable base URL before import,
// since env-driven backend selection happens at module load time).
{
  process.env.LLM_BACKEND = "openai";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1"; // nothing listens here -> fast ECONNREFUSED
  process.env.LLM_TIMEOUT_MS = "3000";
  process.env.AGENT_FALLBACK = "on";

  const { decide } = await import("./decide/llm.js");
  const state = fakeState({
    page: "/p/arclight-smart-watch",
    product: { slug: "arclight-smart-watch", name: "Arclight Smart Watch", price: 182.99, sizes: [], fit_notes: "Adjustable strap fits most wrists." },
    gateSignals: [{ name: "variant_churn", template: "variant_help" }],
  });
  const session = { id: "s_fallback_test", events: [] };
  const { action, trace } = await decide(state, session);
  assert.equal(action.action, "card");
  assert.equal(action.card.template, "variant_help");
  assert.ok(trace.why.startsWith("fallback: llm_"), trace.why);
  console.log("(e) ok — llm.js backend failure invoked decideFallback:", trace.why);
}
