import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/session/auth";

/**
 * Wraps every `/admin/*` page. Access itself is already gated by
 * `src/middleware.ts` (`role === "admin"`, HMAC-verified session cookie —
 * see BUILD-DECISIONS.md §11.14); this layout just renders who's signed in
 * (BUILD-DECISIONS.md §11.13: admin pages should call `getCurrentUser()`
 * the same way `Header`/`/login` do) and a small admin-only nav shell.
 * Deliberately does not restyle to match the storefront — REQUIREMENTS say
 * "Admin-shaped UI... does not need to match the storefront's styling".
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-6">
          <Link href="/admin/products" className="text-lg font-bold text-slate-900">
            NextCart Admin
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/admin/products" className="font-medium text-slate-600 hover:text-slate-900">
              Products
            </Link>
            <Link href="/admin/promo-codes" className="font-medium text-slate-600 hover:text-slate-900">
              Promo codes
            </Link>
            <Link href="/admin/notifications" className="font-medium text-slate-600 hover:text-slate-900">
              Notifications
            </Link>
            <Link href="/admin/agent-mock" className="font-medium text-slate-600 hover:text-slate-900">
              Agent mock
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          {user && <span>Signed in as {user.name}</span>}
          <Link
            href="/"
            className="rounded border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-100"
          >
            View storefront
          </Link>
        </div>
      </div>
      {children}
    </div>
  );
}
