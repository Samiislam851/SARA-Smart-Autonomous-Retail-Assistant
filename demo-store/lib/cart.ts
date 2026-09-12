// Tiny cart store. Module-level state + a subscribe/getSnapshot pair so any
// client component can read it with useSyncExternalStore — no context
// provider needed, and it survives client-side route changes (the module
// stays loaded across app-router navigations). Persisted to sessionStorage
// so a hard refresh doesn't lose it either.

import { useSyncExternalStore } from "react";
import {
  PROMOS,
  activeAutoPromos,
  findPromoByCode,
  isPromoActive,
  promoAppliesToSlug,
  type Promo,
} from "./promos";
// Side-effect only: resolves the active `agent_session` id and — if it just
// changed (e.g. `?agent_session=<new id>` re-pinning this tab to a
// different shopper identity, see agentSession.ts) — clears this module's
// own sessionStorage keys (agent_cart/agent_cart_promo_code) BEFORE `load()`
// below reads them. Must be imported before any storage read in this file.
import "./agentSession";

export type CartItem = { sku: string; name: string; price: number; qty: number };

export type AppliedPromo = { promo: Promo; discount: number; auto: boolean };

const STORAGE_KEY = "agent_cart";
const PROMO_STORAGE_KEY = "agent_cart_promo_code";

function load(): CartItem[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CartItem[]) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore quota/serialization errors — cart state is best-effort
  }
}

// Frozen, module-level empty array so getServerSnapshot() (and any
// zero-item snapshot) returns the SAME reference across calls. Returning a
// freshly-allocated [] each call breaks useSyncExternalStore's
// Object.is-based cache check, triggering React's "getServerSnapshot should
// be cached" warning and unnecessary re-renders on every render pass.
const EMPTY: CartItem[] = [];

function loadPromoCode(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(PROMO_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistPromoCode() {
  if (typeof window === "undefined") return;
  try {
    if (appliedCode) sessionStorage.setItem(PROMO_STORAGE_KEY, appliedCode);
    else sessionStorage.removeItem(PROMO_STORAGE_KEY);
  } catch {
    // best-effort only
  }
}

let items: CartItem[] = load();
let appliedCode: string | null = loadPromoCode();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): CartItem[] {
  return items;
}

export function getServerSnapshot(): CartItem[] {
  return EMPTY;
}

export function addToCart(sku: string, name: string, price: number, qty = 1) {
  const existing = items.find((i) => i.sku === sku);
  if (existing) {
    items = items.map((i) => (i.sku === sku ? { ...i, qty: i.qty + qty } : i));
  } else {
    items = [...items, { sku, name, price, qty }];
  }
  persist();
  emit();
}

export function cartTotal(list: CartItem[] = items): number {
  return list.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function cartCount(list: CartItem[] = items): number {
  return list.reduce((sum, i) => sum + i.qty, 0);
}

/** React hook: re-renders the caller whenever the cart changes. */
export function useCart(): CartItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Every store here (cart items, applied promo) is sessionStorage-backed, so
// its real value is unknowable during SSR/the hydration pass — getServerSnapshot
// must lie (EMPTY/null) to match the server-rendered HTML. React corrects
// this on the client a moment after hydration (useSyncExternalStore reruns
// getSnapshot() in an effect and force-rerenders if it differs), but on a
// slow connection/device that correction can be visibly late: shoppers see a
// confidently wrong "Cart is empty." / ৳0 total flash on every hard load.
// `useHydrated()` is the standard fix (same idiom as next-themes' isClient
// flag): false during SSR and the hydration render, true from the very next
// client render onward, with no subscription ever firing (the "snapshot"
// never changes after mount, so this never fights the store's own
// self-correction render). Callers use it to render a neutral placeholder
// instead of a wrong definitive claim until real data is known.
function neverSubscribe() {
  return () => {};
}
export function useHydrated(): boolean {
  return useSyncExternalStore(neverSubscribe, () => true, () => false);
}

/** Discount a promo yields against a given cart line list. Pure — does not
 * touch module state, so it's safe to call with hypothetical/derived item
 * lists (e.g. checkout re-render). Returns 0 if the promo is inactive,
 * doesn't apply to anything in `list`, or `min_cart` isn't met. */
export function cartDiscount(list: CartItem[], promo: Promo | null | undefined): number {
  if (!promo) return 0;
  if (!isPromoActive(promo)) return 0;
  const eligible = list.filter((i) => promoAppliesToSlug(promo, i.sku));
  const eligibleTotal = eligible.reduce((sum, i) => sum + i.price * i.qty, 0);
  if (eligibleTotal <= 0) return 0;
  if (promo.min_cart != null && cartTotal(list) < promo.min_cart) return 0;
  if (promo.kind === "percent") return Math.round((eligibleTotal * promo.value) / 100);
  return Math.min(promo.value, eligibleTotal);
}

/** Applies a promo code. Validates active + applies to something in the
 * cart + min_cart before storing it. */
export function applyPromo(code: string): { ok: true } | { ok: false; error: string } {
  const promo = findPromoByCode(code);
  if (!promo) return { ok: false, error: "That code isn't valid or has expired." };
  const eligible = items.some((i) => promoAppliesToSlug(promo, i.sku));
  if (!eligible) return { ok: false, error: "That code doesn't apply to anything in your cart." };
  if (promo.min_cart != null && cartTotal(items) < promo.min_cart) {
    const gap = promo.min_cart - cartTotal(items);
    return { ok: false, error: `Add ৳ ${gap.toLocaleString("en-BD")} more to use this code.` };
  }
  appliedCode = promo.code;
  persistPromoCode();
  invalidatePromoSnapshot();
  emit();
  return { ok: true };
}

export function clearPromo() {
  appliedCode = null;
  persistPromoCode();
  invalidatePromoSnapshot();
  emit();
}

// getPromos()/usePromos() must return a referentially-stable array when
// nothing relevant changed (useSyncExternalStore compares with Object.is),
// so cache the computed snapshot and only recompute when `items` or
// `appliedCode` actually changed identity.
let promoSnapshot: AppliedPromo[] = [];
let promoSnapshotItems: CartItem[] | null = null;
let promoSnapshotCode: string | null = null;
let promoSnapshotValid = false;

function invalidatePromoSnapshot() {
  promoSnapshotValid = false;
}

/** Stacking rule: automatic promos always apply to their eligible items —
 * a manual code can never remove or replace one. At most one manual code
 * may additionally apply, on top, for the items *it* covers. Each promo's
 * discount is computed independently against full price (cartDiscount only
 * looks at the items it applies to), so this is only exactly correct when
 * no two simultaneously-active promos target the same item — true of the
 * current catalog (PROMOS in ./promos: each promo's `applies.slugs` is
 * disjoint from every other's). If that ever changes, cartDiscount would
 * need to account for price already discounted by an earlier promo in the
 * stack to avoid double-discounting the overlapping item.
 */
function computeAppliedPromos(): AppliedPromo[] {
  const result: AppliedPromo[] = [];
  for (const promo of activeAutoPromos()) {
    const discount = cartDiscount(items, promo);
    if (discount > 0) result.push({ promo, discount, auto: true });
  }
  if (appliedCode) {
    const codePromo = PROMOS.find(
      (p) => p.code != null && p.code.toUpperCase() === appliedCode!.toUpperCase(),
    );
    if (
      codePromo &&
      isPromoActive(codePromo) &&
      !result.some((r) => r.promo.id === codePromo.id)
    ) {
      const discount = cartDiscount(items, codePromo);
      if (discount > 0) result.push({ promo: codePromo, discount, auto: false });
    }
  }
  return result;
}

/** Currently-applied promos: every active auto-apply promo, plus the
 * explicit code (if any, and if it isn't already one of those auto promos),
 * each with its own discount against the current cart. Empty array if none
 * apply. */
export function getPromos(): AppliedPromo[] {
  if (!promoSnapshotValid || promoSnapshotItems !== items || promoSnapshotCode !== appliedCode) {
    promoSnapshot = computeAppliedPromos();
    promoSnapshotItems = items;
    promoSnapshotCode = appliedCode;
    promoSnapshotValid = true;
  }
  return promoSnapshot;
}

export function getPromosServerSnapshot(): AppliedPromo[] {
  return EMPTY_PROMOS;
}
const EMPTY_PROMOS: AppliedPromo[] = [];

/** React hook: re-renders the caller whenever the applied promos (or the
 * cart items they depend on) change. */
export function usePromos(): AppliedPromo[] {
  return useSyncExternalStore(subscribe, getPromos, getPromosServerSnapshot);
}

/** Total discount across every currently-applied promo. */
export function totalPromoDiscount(list: AppliedPromo[]): number {
  return list.reduce((sum, p) => sum + p.discount, 0);
}

/** Single "primary" promo for event meta sent to the decider — server/
 * state.js and server/store/index.js's computeOffers() read `meta.promo` as
 * flat `{code, discount} | null` (an informal field outside the fixed
 * Event/Action/Trace contract, so this fix doesn't reshape it into an array
 * for that consumer). Prefers the manual code (the thing the shopper
 * actively did) over an auto-apply promo, matching the old single-promo
 * getPromo()'s precedence. */
export function getPrimaryPromoMeta(): { code: string | null; discount: number } | null {
  const list = getPromos();
  const primary = list.find((p) => !p.auto) ?? list[0] ?? null;
  return primary ? { code: primary.promo.code, discount: primary.discount } : null;
}
