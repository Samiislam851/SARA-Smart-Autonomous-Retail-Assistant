/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 *
 * This file intentionally crosses BUILD-DECISIONS.md §0 ("no sockets, SSE,
 * or push") to prove out a real-time admin -> shopper demo. It exists only
 * in the working tree for a live rehearsal and must never be `git add`ed or
 * committed. Do not edit BUILD-DECISIONS.md to "make this legal" — the rule
 * still protects the real, committed repo; this prototype is exempt only
 * because it never enters git history.
 *
 * Pure copy-generation for the "variant churn" (size/colour indecision)
 * signal mock. Kept separate from the command route so the one rule that
 * actually matters — the badge text is a REAL count computed from the
 * product's own `variants`, never a hardcoded string — is easy to see in
 * one small, side-effect-free place. No DB access, no SSE here.
 */
import type { ProductVariant } from "@/lib/schemas";

function joinWithAnd(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function sizeVariants(variants: readonly ProductVariant[]): ProductVariant[] {
  return variants.filter((variant) => variant.type === "size");
}

function availableSizeVariants(variants: readonly ProductVariant[]): ProductVariant[] {
  return sizeVariants(variants).filter((variant) => variant.available);
}

/**
 * The badge pill's text — the "in-gaze" primary mechanism. Always derived
 * from the product's real `variants`, so it reads a true count on camera
 * ("3 sizes in stock", "Only 1 size left") instead of a fixed string, and
 * says so honestly when nothing is left.
 */
export function sizeStockBadgeText(variants: readonly ProductVariant[]): string {
  const sizes = sizeVariants(variants);
  if (sizes.length === 0) return "No sizes on this product";

  const available = availableSizeVariants(variants);
  if (available.length === 0) return "No sizes in stock right now";
  if (available.length === 1) return `Only 1 size left (${available[0].label})`;
  return `${available.length} sizes in stock`;
}

/** Chat copy for the "availability" branch (oosRatio >= 0.5): the shopper's
 * combination is out of stock and they're hunting for one that isn't. The
 * chat carries the reasoning + offer; the badge (rendered separately, right
 * on the variant row) carries the attention. */
export function outOfStockChatCopy(variants: readonly ProductVariant[]): {
  text: string;
  chips: string[];
} {
  const available = availableSizeVariants(variants);

  if (available.length === 0) {
    return {
      text:
        "Every size on this one looks sold out right now, sorry — I don't have a swap to offer. Want me to let you know the moment it's back in stock?",
      chips: [],
    };
  }

  const labels = available.map((variant) => variant.label);
  const list = joinWithAnd(labels);
  const verb = available.length === 1 ? "is" : "are";

  return {
    text: `That size looks sold out — but ${list} ${verb} in stock right now. Want to try one of those instead?`,
    chips: labels.slice(0, 4),
  };
}

/** Chat copy for the "fit" branch (oosRatio < 0.5): plenty is in stock, the
 * shopper is just unsure which size is *them*. The chat carries reassurance;
 * the real answer — free returns — lives in the shipping/returns panel this
 * pairs with a `reveal` for. */
export function fitChatCopy(): { text: string; chips: string[] } {
  return {
    text:
      "Going back and forth on size? If you're between two, sizing up for a relaxed fit is the safer bet — and if it's still not right, returns are free within 30 days.",
    chips: ["Free 30-day returns"],
  };
}
