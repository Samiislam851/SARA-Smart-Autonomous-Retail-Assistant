"use client";

import { findPromoForSlug, formatPromoBadge } from "@/lib/promos";

// Small badge shown on product cards + the product page when an active promo
// applies to that slug. Renders nothing when there's no active promo — the
// agent should never see a stale/empty target for a product with no deal.
export default function PromoBadge({ slug }: { slug: string }) {
  const promo = findPromoForSlug(slug);
  if (!promo) return null;

  return (
    <span className="promo-badge" data-agent-target={`promo-badge-${slug}`}>
      {formatPromoBadge(promo)}
    </span>
  );
}
