import { ObjectId } from "mongodb";

/**
 * Recursively walks a repository result and fails if it finds a raw driver
 * type (`ObjectId` or `Date`) anywhere in it. Every `lib/db/repositories/`
 * function is required to serialize both to strings before returning —
 * this is the shared assertion every repository test file uses to check
 * that promise, rather than each file re-implementing the walk.
 */
export function assertJsonSafe(value: unknown, path = "root"): void {
  if (value === null || value === undefined) return;
  if (value instanceof Date) {
    throw new Error(
      `assertJsonSafe: found a Date instance at "${path}" — repository results must serialize dates to ISO strings`
    );
  }
  if (value instanceof ObjectId) {
    throw new Error(
      `assertJsonSafe: found an ObjectId instance at "${path}" — repository results must serialize ids to strings`
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertJsonSafe(nested, `${path}.${key}`);
    }
  }
}

/** Test-only slug/id prefix, so cleanup can precisely target only what a test created. */
export const TEST_PREFIX = "repo-test-";
