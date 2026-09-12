// Promo catalog — mirrors ../../server/store/promos.json (merchant-edited).
//
// Why a mirror and not a direct JSON import: the web Dockerfile builds with
// `context: ./web` (see docker-compose.yml), so anything outside web/ is not
// visible to `docker build` even with resolveJsonModule enabled. Keep this
// file's data in lockstep with server/store/promos.json by hand, or run
// `node web/scripts/check-store-mirror.mjs` (wired into scripts/check.sh)
// which diffs ids/values/slugs between the two and fails loudly on drift.
//
// `ends_in_ms` assumption (no server code resolves this field yet as of
// 2026-09-11): treated as a rolling countdown anchored the first time this
// module observes the promo in a given browser session, so the badge
// actually expires ~ends_in_ms after a shopper first sees it instead of
// silently recomputing an ever-fresh "48h left" on every reload. The anchor
// is cached in sessionStorage per promo id. If the server later resolves
// `ends_in_ms` into a real `ends_at` server-side, this fallback becomes
// dead code (isPromoActive already prefers `ends_at` when present).

export type Promo = {
  id: string;
  code: string | null;
  kind: "percent" | "flat";
  value: number;
  applies: { slugs: string[] | "all"; categories?: string[] };
  min_cart: number | null;
  starts_at?: number | null;
  ends_at?: number | null;
  ends_in_ms?: number | null;
  label: string;
  auto_apply: boolean;
};

export const PROMOS: Promo[] = [
  {
    id: "jacket10",
    code: "JACKET10",
    kind: "percent",
    value: 10,
    applies: { slugs: ["khadi-field-jacket"] },
    min_cart: null,
    starts_at: null,
    ends_at: null,
    ends_in_ms: 172800000,
    label: "10% off the Khadi Field Jacket",
    auto_apply: false,
  },
  {
    id: "scarf15",
    code: null,
    kind: "percent",
    value: 15,
    applies: { slugs: ["nakshi-kantha-scarf"] },
    min_cart: null,
    starts_at: null,
    ends_at: null,
    ends_in_ms: null,
    label: "15% off the Nakshi Kantha Scarf",
    auto_apply: true,
  },
  {
    id: "saree200",
    code: "SAREE200",
    kind: "flat",
    value: 200,
    applies: { slugs: ["jamdani-saree-classic"] },
    min_cart: 1500,
    starts_at: null,
    ends_at: null,
    ends_in_ms: null,
    label: "৳200 off the Jamdani Saree (min cart ৳1,500)",
    auto_apply: false,
  },
];

const ANCHOR_KEY = "agent_promo_anchors";

function loadAnchors(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(ANCHOR_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveAnchors(anchors: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(ANCHOR_KEY, JSON.stringify(anchors));
  } catch {
    // best-effort only
  }
}

/** Resolves a rolling `ends_in_ms` countdown into a stable absolute deadline
 * for this browser session (first-seen anchor), falling back to `ends_at`
 * when present. Returns null when the promo has no expiry. */
function resolveEndsAt(promo: Promo): number | null {
  if (promo.ends_at != null) return promo.ends_at;
  if (promo.ends_in_ms == null) return null;
  const anchors = loadAnchors();
  const existing = anchors[promo.id];
  if (existing != null) return existing;
  const deadline = Date.now() + promo.ends_in_ms;
  anchors[promo.id] = deadline;
  saveAnchors(anchors);
  return deadline;
}

export function isPromoActive(promo: Promo, now: number = Date.now()): boolean {
  if (promo.starts_at != null && now < promo.starts_at) return false;
  const endsAt = resolveEndsAt(promo);
  if (endsAt != null && now > endsAt) return false;
  return true;
}

export function promoAppliesToSlug(promo: Promo, slug: string): boolean {
  if (promo.applies.slugs === "all") return true;
  return promo.applies.slugs.includes(slug);
}

/** The single active promo (if any) that applies to a product slug, for
 * product card / product page badges. */
export function findPromoForSlug(slug: string, now: number = Date.now()): Promo | undefined {
  return PROMOS.find((p) => isPromoActive(p, now) && promoAppliesToSlug(p, slug));
}

export function findPromoByCode(code: string, now: number = Date.now()): Promo | undefined {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return undefined;
  return PROMOS.find(
    (p) => p.code != null && p.code.toUpperCase() === normalized && isPromoActive(p, now),
  );
}

export function activeAutoPromos(now: number = Date.now()): Promo[] {
  return PROMOS.filter((p) => p.auto_apply && isPromoActive(p, now));
}

/** Unit-price discount for single-item display (product page strike-through).
 * Only meaningful for promos with no min_cart gate — auto-apply promos in
 * this catalog never set one. */
export function discountedUnitPrice(promo: Promo, price: number): number {
  if (promo.kind === "percent") return Math.round((price * (100 - promo.value)) / 100);
  return Math.max(0, price - promo.value);
}

/** Merchant `label` doesn't say whether a code is needed — append that so a
 * badge (and the agent reading it) can tell "needs a code" from "applied
 * automatically" at a glance. */
export function formatPromoBadge(promo: Promo): string {
  if (promo.code) return `${promo.label} · code ${promo.code}`;
  if (promo.auto_apply) return `${promo.label} · applied automatically`;
  return promo.label;
}
