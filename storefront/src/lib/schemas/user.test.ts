import { describe, expect, it } from "vitest";
import { userSchema } from "./user";

const valid = {
  _id: "507f1f77bcf86cd799439011",
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "customer",
};

describe("userSchema", () => {
  it("accepts a valid customer", () => {
    const result = userSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts a valid admin", () => {
    const result = userSchema.safeParse({ ...valid, role: "admin" });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = userSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown role", () => {
    const result = userSchema.safeParse({ ...valid, role: "superuser" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = userSchema.safeParse({ ...valid, name: "" });
    expect(result.success).toBe(false);
  });
});
