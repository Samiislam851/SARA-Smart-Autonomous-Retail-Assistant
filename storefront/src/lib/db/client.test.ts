// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMongoClient, getDb, getMongoClient } from "./client";

/**
 * These tests deliberately need NO running MongoDB. They pin the three
 * properties the singleton exists for — laziness, caching, and recovery
 * after a failed connect — which is exactly the behaviour that is painful
 * to debug once eight features are sitting on top of it.
 *
 * A dead port plus a short server-selection timeout gives a fast, hermetic
 * connection failure.
 */
const DEAD_URI =
  "mongodb://127.0.0.1:59999/nextcart?serverSelectionTimeoutMS=150&connectTimeoutMS=150";

const originalUri = process.env.MONGODB_URI;

beforeEach(async () => {
  await closeMongoClient();
});

afterEach(async () => {
  await closeMongoClient();
  process.env.MONGODB_URI = originalUri;
});

describe("mongo client singleton", () => {
  it("does not throw at import time when MONGODB_URI is missing", async () => {
    delete process.env.MONGODB_URI;
    // The import itself is the assertion: a module-scope throw here would
    // break `next build`'s page-data collection and every test that merely
    // imports a repository.
    await expect(import("./client")).resolves.toBeDefined();
  });

  it("rejects (rather than throwing synchronously) when MONGODB_URI is missing", async () => {
    delete process.env.MONGODB_URI;
    // Must not throw on the calling line — it must return a rejected promise,
    // so callers can try/catch around `await` as normal.
    const promise = getMongoClient();
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow(/MONGODB_URI/);
  });

  it("returns the same cached promise across calls (one pool, not one per call)", () => {
    process.env.MONGODB_URI = DEAD_URI;
    const first = getMongoClient();
    const second = getMongoClient();
    expect(first).toBe(second);
  });

  it("evicts a failed connection so the next call retries instead of replaying the failure", async () => {
    process.env.MONGODB_URI = DEAD_URI;

    const first = getMongoClient();
    await expect(first).rejects.toThrow();

    // If the rejected promise stayed cached, starting the dev server before
    // `docker compose up` would poison the process until a restart.
    const second = getMongoClient();
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  }, 15000);

  it("surfaces the connection error through getDb()", async () => {
    process.env.MONGODB_URI = DEAD_URI;
    await expect(getDb()).rejects.toThrow();
  }, 15000);

  it("closeMongoClient() is safe to call when nothing was ever connected", async () => {
    await expect(closeMongoClient()).resolves.toBeUndefined();
  });

  it("closeMongoClient() swallows a failed pending connection", async () => {
    process.env.MONGODB_URI = DEAD_URI;
    void getMongoClient().catch(() => undefined);
    await expect(closeMongoClient()).resolves.toBeUndefined();
  }, 15000);
});
