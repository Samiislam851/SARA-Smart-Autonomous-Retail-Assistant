import type { Db } from "mongodb";

/**
 * Creates every index this storefront depends on, if it does not already
 * exist. Safe to call on every process start (feature 3's data layer does)
 * and from the seed script: MongoDB's `createIndex` is a no-op when called
 * again with the identical key pattern and options, so calling this twice in
 * a row — or once per server boot for the life of the app — never errors and
 * never duplicates an index.
 *
 * Ownership and rationale per index:
 * - `products.slug` / `categories.slug`: unique, human-readable lookup keys.
 * - `products` text index over title/brand/description, weighted so a title
 *   match ranks above a brand match, which ranks above a description match.
 *   This is what `/search` runs against — local MongoDB has no Atlas Vector
 *   Search (BUILD-DECISIONS.md §2).
 * - `products.categorySlug` + `products.isActive`: a compound index, in that
 *   order, because the PLP's actual query filters by both together (active
 *   products in one category); the compound index also serves a
 *   `categorySlug`-only query as a prefix.
 * - `carts.cartId`, `orders.orderNumber`, `users.email`: unique natural keys.
 * - `checkoutStates.cartId`: unique natural key, added by feature 7/8 for
 *   the in-progress checkout state collection (BUILD-DECISIONS.md §11.13,
 *   `schemas/checkout.ts`) — same pattern as `carts.cartId`.
 * - `promoCodes.code`: unique natural key (Feature A). Codes are always
 *   normalized to uppercase before insert/lookup, so this is a
 *   case-sensitive index over an already-canonical value.
 * - `notifications.(userId, createdAt)`: compound, in that order (Feature
 *   B). Every read is "this user's notifications, newest first" —
 *   `listNotificationsForUser`/`countUnreadForUser` both filter on `userId`
 *   and (for the list) sort by `createdAt` descending, so the compound
 *   index serves both without a separate single-field `userId` index.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("products").createIndex(
      { slug: 1 },
      { unique: true, name: "products_slug_unique" }
    ),
    db.collection("categories").createIndex(
      { slug: 1 },
      { unique: true, name: "categories_slug_unique" }
    ),
    db.collection("products").createIndex(
      { title: "text", brand: "text", description: "text" },
      {
        name: "products_text_search",
        weights: { title: 10, brand: 5, description: 1 },
      }
    ),
    db.collection("products").createIndex(
      { categorySlug: 1, isActive: 1 },
      { name: "products_categorySlug_isActive" }
    ),
    db.collection("carts").createIndex(
      { cartId: 1 },
      { unique: true, name: "carts_cartId_unique" }
    ),
    db.collection("orders").createIndex(
      { orderNumber: 1 },
      { unique: true, name: "orders_orderNumber_unique" }
    ),
    db.collection("users").createIndex(
      { email: 1 },
      { unique: true, name: "users_email_unique" }
    ),
    db.collection("checkoutStates").createIndex(
      { cartId: 1 },
      { unique: true, name: "checkoutStates_cartId_unique" }
    ),
    db.collection("promoCodes").createIndex(
      { code: 1 },
      { unique: true, name: "promoCodes_code_unique" }
    ),
    db.collection("notifications").createIndex(
      { userId: 1, createdAt: -1 },
      { name: "notifications_userId_createdAt" }
    ),
  ]);
}
