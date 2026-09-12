import { MongoClient, type Db } from "mongodb";

/**
 * MongoDB connection singleton for the Next.js App Router.
 *
 * Three properties matter here, and each one is load-bearing:
 *
 * 1. **Lazy.** Nothing connects — and nothing throws — at import time. A
 *    module-scope `throw` would blow up `next build`'s page-data collection
 *    and any test that merely imports a repository, in both cases long
 *    before a real query is attempted. The URI is read, and the socket
 *    opened, on the first `getDb()` call.
 *
 * 2. **Hot-reload safe.** In development Next.js re-evaluates modules on
 *    every edit, which would leak a fresh connection pool per reload. The
 *    connection promise is cached on `globalThis`, which survives module
 *    reloads inside the same process. In production a new client is created
 *    once per server process, so module scope would do — but sharing one
 *    cache keeps a single code path in both modes.
 *
 * 3. **Retryable.** A rejected `connect()` is evicted from the cache so the
 *    next call gets a fresh attempt. Caching a rejected promise forever
 *    would mean starting the dev server before `docker compose up` poisons
 *    the process until you restart it. Eagerly calling `connect()` at import
 *    also risks an unhandled rejection crashing the server before any
 *    request handler is there to await it.
 *
 * Works identically in Server Components, route handlers and server
 * actions: they all run in the Node.js server runtime and all await
 * `getDb()`.
 */

const globalForMongo = globalThis as typeof globalThis & {
  _nextcartMongoClientPromise?: Promise<MongoClient>;
};

function readUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'Missing environment variable "MONGODB_URI". Copy .env.example to .env.local (see README).'
    );
  }
  return uri;
}

/**
 * Resolves to a connected `MongoClient`, opening the pool at most once.
 * Rejects — rather than throwing synchronously — if the URI is missing or
 * the server is unreachable.
 */
export function getMongoClient(): Promise<MongoClient> {
  const cached = globalForMongo._nextcartMongoClientPromise;
  if (cached) return cached;

  const promise = (async () => new MongoClient(readUri()).connect())().catch(
    (error: unknown) => {
      // Evict the failed attempt so the next caller retries, then re-throw
      // so this caller still sees the real error.
      if (globalForMongo._nextcartMongoClientPromise === promise) {
        globalForMongo._nextcartMongoClientPromise = undefined;
      }
      throw error;
    }
  );

  globalForMongo._nextcartMongoClientPromise = promise;
  return promise;
}

/**
 * Resolves to the `nextcart` database handle. The database name comes from
 * the path segment of `MONGODB_URI`.
 *
 * This is the entry point `lib/db/` repositories use. Pages, components and
 * route handlers never call the driver directly — see BUILD-DECISIONS.md §10.
 */
export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db();
}

/**
 * Closes the pooled connection and clears the cache. For test teardown and
 * one-shot scripts (e.g. seeding); the long-lived server never needs it.
 */
export async function closeMongoClient(): Promise<void> {
  const pending = globalForMongo._nextcartMongoClientPromise;
  if (!pending) return;
  globalForMongo._nextcartMongoClientPromise = undefined;
  const client = await pending.catch(() => undefined);
  await client?.close();
}
