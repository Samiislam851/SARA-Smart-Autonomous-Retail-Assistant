import { cookies } from "next/headers";
import { getUserById, type UserDTO } from "@/lib/db/repositories";
import {
  SESSION_COOKIE_NAME,
  decodeSessionCookie,
  encodeSessionCookie,
  type SessionPayload,
} from "./cookie";

export type { SessionPayload } from "./cookie";
export { SESSION_COOKIE_NAME };

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
};

/**
 * Server-only session helper — feature 9's `/admin/*` gate is `role ===
 * "admin"` in `src/middleware.ts`, which reads the same cookie directly
 * (via `lib/session/cookie.ts`, edge-safe) rather than calling these
 * functions, since `next/headers` `cookies()` + the Mongo-backed
 * `getCurrentUser()` below only work in the Node server runtime. Use THIS
 * module from Server Components, Server Actions and Route Handlers; use
 * `lib/session/cookie.ts` directly from `middleware.ts`.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return decodeSessionCookie(store.get(SESSION_COOKIE_NAME)?.value);
}

/** Server Actions / Route Handlers only — `cookies()` is only mutable there. */
export async function setSession(payload: SessionPayload): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, await encodeSessionCookie(payload), SESSION_COOKIE_OPTIONS);
}

/** Server Actions / Route Handlers only. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

/**
 * Re-validates against the database (defensive: the cookie could name a
 * user that was since removed) and returns the full `UserDTO`, or `null`
 * if there is no session, it's malformed, or the user no longer exists.
 * This is what `Header` and `/login` use to reflect signed-in state.
 */
export async function getCurrentUser(): Promise<UserDTO | null> {
  const session = await getSession();
  if (!session) return null;
  return getUserById(session.userId);
}
