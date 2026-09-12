import { z } from "zod";
import { userRoleSchema } from "@/lib/schemas";

/**
 * Pure, edge-runtime-safe session cookie codec — no `next/headers`, no
 * MongoDB import. `src/middleware.ts` runs on the Edge runtime (no Node
 * `mongodb` driver there) and needs to decide `/admin/*` access from the
 * cookie alone, so the session payload carries `role` directly rather than
 * requiring a database round trip to look it up. This is why the mock-login
 * cookie is not just a bare user id.
 *
 * SECURITY (fixed — see BUILD-DECISIONS.md §11.14): the cookie value is now
 * `<base64url(payload JSON)>.<base64url(HMAC-SHA256 signature)>`, signed
 * with a server-only secret (`SESSION_SECRET`). Base64 alone is *encoding*,
 * not authentication — anyone could previously hand-craft
 * `{"userId":"x","role":"admin"}`, base64url it, and set it as their own
 * cookie to reach `/admin/*`. The payload itself is still readable (it is
 * not encrypted — there is nothing secret in `{userId, role}`, only
 * something that must not be forgeable), but it can no longer be produced
 * or modified without the server's secret. This signs the cookie's
 * integrity, not the user: the mock-login model (§5, no passwords) is
 * unchanged — a visitor still just picks a seeded user — but once the
 * server has minted `{userId, role}` for them, they cannot then edit it
 * client-side and have it still verify.
 *
 * **Web Crypto (`crypto.subtle`), not `node:crypto`.** `node:crypto`'s
 * `createHmac`/`timingSafeEqual` are Node-only and are not available in
 * the Edge runtime that `middleware.ts` executes in — confirmed by actually
 * running this codec from `middleware.ts` against the dev server (see
 * BUILD-DECISIONS.md §11.14), not assumed. `crypto.subtle` is available as
 * a global in both the Node runtime (Node 19+) and the Edge runtime, so one
 * implementation serves both callers (`middleware.ts` and
 * `lib/session/auth.ts`). `crypto.subtle.verify` performs the HMAC
 * recomputation *and* the signature comparison inside one WebCrypto call —
 * this is the Web Crypto equivalent of `node:crypto`'s
 * `timingSafeEqual`-guarded comparison (a constant-time MAC verification
 * primitive), just via the API that actually exists in both runtimes this
 * file must run in.
 *
 * Base64url (not raw JSON, and no `+`/`/`/`=`) so the cookie value never
 * needs percent-encoding and round-trips identically however the
 * `Cookie`/`Set-Cookie` header is parsed. `btoa`/`atob` (not `Buffer`)
 * because both are available in Node and the Edge runtime.
 */
export const SESSION_COOKIE_NAME = "nextcart_session";

/**
 * Dev-only fallback so the app still runs if `SESSION_SECRET` is somehow
 * unset — `.env.example` and `.env.local` both define a real dev value
 * (loaded by Next.js, and by Vitest via `loadEnv` in `vitest.config.mts`),
 * so this fallback is not the value actually used in normal dev/test runs.
 * Never used in production if the platform sets `SESSION_SECRET` for real.
 */
const DEV_FALLBACK_SECRET = "dev-insecure-session-secret-change-me-in-production";

const SESSION_SECRET = process.env.SESSION_SECRET ?? DEV_FALLBACK_SECRET;

const sessionPayloadSchema = z.object({
  userId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Must be a 24-character hex ObjectId"),
  role: userRoleSchema,
});
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

function toBase64Url(base64: string): string {
  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): string {
  let base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  while (base64.length % 4 !== 0) base64 += "=";
  return base64;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return toBase64Url(btoa(binary));
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(fromBase64Url(value));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Imported once per process/isolate and reused — `crypto.subtle.importKey`
// is async, so the key is cached as a promise rather than re-imported on
// every encode/decode call.
let hmacKeyPromise: Promise<CryptoKey> | null = null;

function getHmacKey(): Promise<CryptoKey> {
  hmacKeyPromise ??= crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return hmacKeyPromise;
}

/** Signs `{userId, role}` and returns `<payload>.<signature>`, both base64url. */
export async function encodeSessionCookie(payload: SessionPayload): Promise<string> {
  const payloadB64 = toBase64Url(btoa(JSON.stringify(payload)));
  const key = await getHmacKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const signatureB64 = bytesToBase64Url(new Uint8Array(signature));
  return `${payloadB64}.${signatureB64}`;
}

/**
 * Never throws — a missing, malformed, unsigned, or tampered cookie decodes
 * to `null` (treated as signed-out), not a 500. Verifies the HMAC signature
 * before trusting the payload at all: a payload that fails to verify is
 * never even JSON-parsed as a session.
 */
export async function decodeSessionCookie(
  raw: string | undefined | null
): Promise<SessionPayload | null> {
  if (!raw) return null;

  const dotIndex = raw.indexOf(".");
  if (dotIndex === -1 || dotIndex !== raw.lastIndexOf(".")) return null; // exactly one "."

  const payloadB64 = raw.slice(0, dotIndex);
  const signatureB64 = raw.slice(dotIndex + 1);
  if (!payloadB64 || !signatureB64) return null;

  const signatureBytes = base64UrlToBytes(signatureB64);
  if (!signatureBytes) return null;

  try {
    const key = await getHmacKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;

    const json = atob(fromBase64Url(payloadB64));
    const parsed = sessionPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
