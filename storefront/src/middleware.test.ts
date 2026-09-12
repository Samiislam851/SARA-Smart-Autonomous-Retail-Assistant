// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { encodeSessionCookie, SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { middleware } from "./middleware";

function requestFor(path: string, cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  return new NextRequest(new URL(path, "https://nextcart.example"), { headers });
}

function forgeUnsignedCookie(payload: unknown): string {
  const json = JSON.stringify(payload);
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("/admin/* middleware gate", () => {
  it("redirects to /login with a next param when there is no session cookie", async () => {
    const response = await middleware(requestFor("/admin/products"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/admin/products");
  });

  it("redirects a signed-in customer (non-admin) to /login", async () => {
    const cookie = await encodeSessionCookie({
      userId: "507f1f77bcf86cd799439011",
      role: "customer",
    });
    const response = await middleware(requestFor("/admin/products", cookie));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("redirects on a malformed/tampered cookie", async () => {
    const response = await middleware(requestFor("/admin/products", "garbage-not-base64url-json"));
    expect(response.status).toBe(307);
  });

  it("lets an admin session through", async () => {
    const cookie = await encodeSessionCookie({
      userId: "507f1f77bcf86cd799439011",
      role: "admin",
    });
    const response = await middleware(requestFor("/admin/products", cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  // --- Regression tests for the HMAC signing fix (BUILD-DECISIONS.md §11.14) ---

  it("REGRESSION: rejects a forged, unsigned admin cookie (the pre-fix attack) and redirects to /login", async () => {
    const forged = forgeUnsignedCookie({ userId: "507f1f77bcf86cd799439011", role: "admin" });
    const response = await middleware(requestFor("/admin/products", forged));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("REGRESSION: rejects a tampered payload (role swapped to admin, stale signature)", async () => {
    const customerCookie = await encodeSessionCookie({
      userId: "507f1f77bcf86cd799439011",
      role: "customer",
    });
    const [, signatureB64] = customerCookie.split(".");
    const forgedPayloadB64 = forgeUnsignedCookie({
      userId: "507f1f77bcf86cd799439011",
      role: "admin",
    });
    const tampered = `${forgedPayloadB64}.${signatureB64}`;
    const response = await middleware(requestFor("/admin/products", tampered));
    expect(response.status).toBe(307);
  });
});
