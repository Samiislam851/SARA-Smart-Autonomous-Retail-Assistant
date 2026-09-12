import { createHash } from "node:crypto";

/**
 * Deterministic 24-char hex id derived from a natural key (slug or email).
 *
 * Re-running the seed script must upsert the same document, not insert a
 * duplicate. Rather than querying Mongo first to discover an existing `_id`,
 * we derive `_id` itself from the natural key so it is stable across runs:
 * `replaceOne({ _id }, doc, { upsert: true })` then always targets the same
 * document, and never hits Mongo's "immutable _id" error on update.
 *
 * MD5 is used purely as a fast, stable, non-cryptographic hash here — no
 * security property is needed, only determinism and a 24-hex-char output
 * that satisfies `objectIdSchema` and constructs a valid `ObjectId`.
 */
export function deterministicHexId(namespace: string, naturalKey: string): string {
  return createHash("md5").update(`${namespace}:${naturalKey}`).digest("hex").slice(0, 24);
}
