import { MongoServerError, ObjectId, type Db } from "mongodb";
import { getDb } from "@/lib/db/client";
import { ensureIndexes } from "@/lib/db/indexes";
import { objectIdSchema } from "@/lib/schemas";

/**
 * Repository-wide serialization convention (BUILD-DECISIONS.md §11):
 *
 * - Every document's Mongo `ObjectId` is converted to its 24-char hex string
 *   before it is validated through the collection's Zod schema (the schemas
 *   in `lib/schemas/` already declare `_id` — and every other id-shaped
 *   field, e.g. `cartItem.productId` — as `objectIdSchema`, a string).
 * - Every `Date` is converted to an ISO-8601 string in the value a
 *   repository function actually returns. The Zod schemas validate the
 *   as-stored shape (`z.date()`), so the conversion happens in a second
 *   step, after validation, immediately before the value leaves `lib/db/`.
 *   This is what makes it safe to pass repository results straight into a
 *   Server Component or across to a Client Component: no `ObjectId`, no
 *   `Date` instance, ever.
 * - Only the document's own `_id` is stored as a real `ObjectId` in Mongo.
 *   Every other id-shaped field (`cartItem.productId`, `order.userId`, …)
 *   is stored as the plain hex string the schema already validates it as —
 *   there is no round-trip conversion for those, and no query ever needs
 *   one since they are only ever compared for equality, never joined by the
 *   driver.
 */

export const PAGE_SIZE = 24;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  totalPages: number;
}

/** Clamps to a positive integer; anything unusable (NaN, 0, negative, float) becomes page 1. */
export function normalizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  const floored = Math.floor(page);
  return floored < 1 ? 1 : floored;
}

/** `Math.ceil` gives 0 for an empty result set, not 1 — there are no pages of nothing. */
export function totalPagesFor(total: number, pageSize: number = PAGE_SIZE): number {
  return Math.ceil(total / pageSize);
}

export function skipFor(page: number, pageSize: number = PAGE_SIZE): number {
  return (page - 1) * pageSize;
}

export function toObjectId(id: string): ObjectId {
  return new ObjectId(id);
}

/** Never throws on a malformed id — returns null so callers can 404/return-null instead of crashing. */
export function tryToObjectId(id: string): ObjectId | null {
  return objectIdSchema.safeParse(id).success ? new ObjectId(id) : null;
}

export function isDuplicateKeyError(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11000;
}

/**
 * `getDb()` plus a one-time-per-process `ensureIndexes` call. BUILD-DECISIONS
 * §11.8/§11.10: indexes are the repositories' job, and the data layer is
 * expected to call `ensureIndexes` on startup (not only from the seed
 * script). `createIndex` is idempotent, but we still cache the promise so a
 * busy process doesn't re-issue seven `createIndex` calls on every query.
 * Mirrors `client.ts`'s own pattern: cache the promise, evict on failure so
 * the next call retries instead of replaying a stale error forever.
 */
let indexesReady: Promise<void> | undefined;

export async function getReadyDb(): Promise<Db> {
  const db = await getDb();
  if (!indexesReady) {
    const promise = ensureIndexes(db).catch((error: unknown) => {
      if (indexesReady === promise) indexesReady = undefined;
      throw error;
    });
    indexesReady = promise;
  }
  await indexesReady;
  return db;
}

/** Test-only: forces the next getReadyDb() call to re-run ensureIndexes. Not used by app code. */
export function _resetIndexesReadyForTests(): void {
  indexesReady = undefined;
}
