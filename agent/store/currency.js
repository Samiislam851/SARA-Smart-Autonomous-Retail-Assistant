// Currency — store-derived fact, never hardcoded in templates/prompt/gate
// reasons. Category fix (live finding: NextCart card showed "৳4" while the
// store's own prices are "$" — the ৳ symbol was baked directly into
// prompts/templates.json's card skeletons and server/store/index.js's offer
// labels instead of being read from the site's own policies.json).
//
// Every site's policies.json already carries a `currency` field (a plain
// ISO code string today — "BDT", "USD" — written by both
// server/scripts/import-store.mjs and import-nextcart.mjs). This module is
// the ONLY place that turns that code into a symbol + position a template/
// label can render with — one lookup table, so a merchant's currency can
// never drift between what a card says and what the storefront itself
// charges.
//
// `policies.currency` may also already be the richer `{code, symbol,
// position}` object form (a merchant who wants a symbol this table doesn't
// know, or a non-default position) — accepted as-is, validated/defaulted
// field-by-field, so upgrading from a bare code string to the object form
// is backward compatible with zero migration.

// Known ISO 4217 code -> symbol. Extend as new sites are onboarded; an
// unknown code falls back to using the code itself as its own "symbol"
// (e.g. a future site with a currency this table doesn't list yet degrades
// to "150 XYZ" rather than crashing or silently defaulting to ৳/$).
const SYMBOLS = {
  BDT: "৳",
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  JPY: "¥",
};

const DEFAULT_CODE = "BDT"; // matches the default store's own currency, used only when policies.json is entirely missing/malformed
const DEFAULT_POSITION = "before";

/**
 * normalizeCurrency(policies) → { code, symbol, position: "before"|"after" }
 * `policies` is `store.policies` (server/store/index.js's loadStore()
 * output) — may be null/malformed, in which case this falls back to the
 * default store's own currency (৳/BDT/before) rather than throwing.
 */
export function normalizeCurrency(policies) {
  const raw = policies?.currency;

  if (raw && typeof raw === "object") {
    const code = typeof raw.code === "string" && raw.code ? raw.code.toUpperCase() : DEFAULT_CODE;
    const symbol = typeof raw.symbol === "string" && raw.symbol ? raw.symbol : SYMBOLS[code] ?? code;
    const position = raw.position === "after" ? "after" : DEFAULT_POSITION;
    return { code, symbol, position };
  }

  const code = typeof raw === "string" && raw ? raw.toUpperCase() : DEFAULT_CODE;
  const symbol = SYMBOLS[code] ?? code;
  return { code, symbol, position: DEFAULT_POSITION };
}

/**
 * formatMoney(amount, currency) → e.g. "৳120" / "$37.99" — `currency` is a
 * normalizeCurrency() result (or `store.policies` directly; normalized
 * internally so callers can pass either). `amount` is rendered verbatim
 * (never rounded/reformatted here — that's the caller's job, e.g.
 * server/store/index.js already rounds `saving`/`gap` to whole units before
 * this is called) — this only decides symbol + which side it goes on.
 */
export function formatMoney(amount, currency) {
  const cur = currency && currency.symbol ? currency : normalizeCurrency(currency);
  const value = amount == null ? "" : String(amount);
  return cur.position === "after" ? `${value}${cur.symbol}` : `${cur.symbol}${value}`;
}
