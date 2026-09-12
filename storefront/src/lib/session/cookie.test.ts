import { describe, expect, it } from "vitest";
import { decodeSessionCookie, encodeSessionCookie } from "./cookie";

const PAYLOAD = { userId: "507f1f77bcf86cd799439011", role: "customer" as const };

function forgeUnsignedCookie(payload: unknown): string {
  const json = JSON.stringify(payload);
  const base64 = btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return base64;
}

describe("session cookie codec", () => {
  it("round-trips a valid payload", async () => {
    const encoded = await encodeSessionCookie(PAYLOAD);
    expect(await decodeSessionCookie(encoded)).toEqual(PAYLOAD);
  });

  it("produces a cookie-safe value with no characters needing percent-encoding", async () => {
    const encoded = await encodeSessionCookie(PAYLOAD);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("decodes null/undefined/empty as null", async () => {
    expect(await decodeSessionCookie(null)).toBeNull();
    expect(await decodeSessionCookie(undefined)).toBeNull();
    expect(await decodeSessionCookie("")).toBeNull();
  });

  it("decodes garbage as null instead of throwing", async () => {
    expect(await decodeSessionCookie("not-valid-base64url-json!!!")).toBeNull();
    expect(await decodeSessionCookie("YWJj")).toBeNull(); // valid base64 ("abc"), no signature
    expect(await decodeSessionCookie("a.b.c")).toBeNull(); // more than one "."
    expect(await decodeSessionCookie(".")).toBeNull();
  });

  it("rejects a payload with a bad role or malformed userId (unsigned, so never even reaches schema validation as trusted)", async () => {
    expect(await decodeSessionCookie(forgeUnsignedCookie({ userId: PAYLOAD.userId, role: "superadmin" }))).toBeNull();
    expect(await decodeSessionCookie(forgeUnsignedCookie({ userId: "not-an-id", role: "admin" }))).toBeNull();
  });

  it("round-trips an admin role", async () => {
    const encoded = await encodeSessionCookie({ userId: PAYLOAD.userId, role: "admin" });
    expect(await decodeSessionCookie(encoded)).toEqual({ userId: PAYLOAD.userId, role: "admin" });
  });

  // --- Regression tests for the HMAC signing fix (BUILD-DECISIONS.md §11.14) ---

  it("REGRESSION: accepts a genuinely valid signed cookie", async () => {
    const encoded = await encodeSessionCookie({ userId: PAYLOAD.userId, role: "admin" });
    const decoded = await decodeSessionCookie(encoded);
    expect(decoded).toEqual({ userId: PAYLOAD.userId, role: "admin" });
  });

  it("REGRESSION: rejects a forged unsigned cookie (the pre-fix attack)", async () => {
    // This is exactly what an attacker could previously hand-craft: base64url
    // JSON with no signature at all, claiming admin.
    const forged = forgeUnsignedCookie({ userId: PAYLOAD.userId, role: "admin" });
    expect(await decodeSessionCookie(forged)).toBeNull();
  });

  it("REGRESSION: rejects a tampered payload with the original (now-mismatched) signature", async () => {
    const encoded = await encodeSessionCookie({ userId: PAYLOAD.userId, role: "customer" });
    const [payloadB64, signatureB64] = encoded.split(".");
    // Swap in a forged "admin" payload but keep the original signature —
    // simulates an attacker editing the cookie's payload segment directly.
    const forgedPayloadB64 = btoa(JSON.stringify({ userId: PAYLOAD.userId, role: "admin" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const tampered = `${forgedPayloadB64}.${signatureB64}`;
    expect(tampered).not.toBe(encoded);
    expect(payloadB64).not.toBe(forgedPayloadB64);
    expect(await decodeSessionCookie(tampered)).toBeNull();
  });

  it("REGRESSION: rejects a valid payload with a bad/random signature", async () => {
    const encoded = await encodeSessionCookie({ userId: PAYLOAD.userId, role: "admin" });
    const [payloadB64] = encoded.split(".");
    const badSignature = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(await decodeSessionCookie(`${payloadB64}.${badSignature}`)).toBeNull();
  });

  it("REGRESSION: rejects completely garbage input without throwing", async () => {
    await expect(decodeSessionCookie("garbage-not-base64url-json")).resolves.toBeNull();
    await expect(decodeSessionCookie("../../etc/passwd")).resolves.toBeNull();
    await expect(decodeSessionCookie("a".repeat(5000))).resolves.toBeNull();
  });
});
