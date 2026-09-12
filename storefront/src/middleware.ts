import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, decodeSessionCookie } from "@/lib/session/cookie";

/**
 * `/admin/*` gate (BUILD-DECISIONS.md §5) for feature 9's admin pages.
 * Runs on the Edge runtime, which cannot use the `mongodb` driver — that's
 * why the session cookie carries `role` directly (see
 * `lib/session/cookie.ts`) rather than this middleware looking the user up
 * in the database. A signed-out or non-admin visitor is redirected to
 * `/login?next=<attempted path>`, never shown a blank/broken page.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const session = await decodeSessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (!session || session.role !== "admin") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
