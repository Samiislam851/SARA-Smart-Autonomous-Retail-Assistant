// @vitest-environment node
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { getUserByEmail, getUserById, listMockUsers } from "./users";
import { assertJsonSafe } from "./test-helpers";

/**
 * Read-only against the seeded 6 mock users — users.ts has no write
 * functions (mock login has no passwords, nothing to create), so there is
 * nothing to clean up.
 */
describe("listMockUsers", () => {
  it("returns the seeded mock users", async () => {
    const users = await listMockUsers();
    expect(users.length).toBeGreaterThanOrEqual(1);
    for (const user of users) {
      expect(user).not.toHaveProperty("password");
    }
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const users = await listMockUsers();
    assertJsonSafe(users);
  });
});

describe("getUserById", () => {
  it("returns a seeded user by id", async () => {
    const [first] = await listMockUsers();
    const found = await getUserById(first._id);
    expect(found?.email).toBe(first.email);
  });

  it("returns null for a well-formed but nonexistent id", async () => {
    const found = await getUserById(new ObjectId().toString());
    expect(found).toBeNull();
  });

  it("returns null for a malformed id instead of throwing", async () => {
    await expect(getUserById("not-an-object-id")).resolves.toBeNull();
  });
});

describe("getUserByEmail", () => {
  it("returns a seeded user by email", async () => {
    const [first] = await listMockUsers();
    const found = await getUserByEmail(first.email);
    expect(found?._id).toBe(first._id);
  });

  it("returns null for a nonexistent email", async () => {
    const found = await getUserByEmail("nobody-zzz@example.com");
    expect(found).toBeNull();
  });
});
