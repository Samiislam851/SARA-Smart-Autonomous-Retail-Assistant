import Link from "next/link";
import { logoutAction } from "@/app/login/actions";
import { countUnreadForUser, getOrCreateCart } from "@/lib/db/repositories";
import { getCurrentUser } from "@/lib/session/auth";
import { readCartId } from "@/lib/session/cart";
import { minorUnitExponent } from "@/lib/format";

/**
 * `data-agent-cart` JSON payload for `AgentCartBridge` (see
 * agent-storefront/docs/NEXTCART.md "Cart mechanism") — amounts converted
 * from minor units to major units via the repo's own sanctioned
 * `minorUnitExponent()` helper, matching TrendMerch's convention of
 * exposing already-human-readable amounts.
 */
interface AgentCartLike {
  subtotal?: number;
  currency?: string;
  items?: {
    title?: string;
    variantSelection?: Record<string, string>;
    quantity?: number;
    price?: number;
  }[];
}

function buildAgentCartPayload(cart: AgentCartLike | null): string {
  if (!cart) return JSON.stringify({ total: 0, items: [] });
  // Defensive against a partial cart shape (e.g. a test double that only
  // stubs `items`) — a real cart from getOrCreateCart() always carries
  // `currency`/`subtotal`, so this only ever matters off the happy path.
  const exponent = minorUnitExponent(cart.currency ?? "USD");
  const toMajor = (minor: number | undefined) => (minor ?? 0) / 10 ** exponent;
  return JSON.stringify({
    total: toMajor(cart.subtotal),
    items: (cart.items ?? []).map((item) => ({
      name: item.title ?? null,
      variant: Object.values(item.variantSelection ?? {}).join(" / ") || null,
      quantity: item.quantity ?? 0,
      price: toMajor(item.price),
    })),
  });
}

/**
 * Site header — Amazon-shaped: dark bar, dense layout. Reads the session
 * (signed-in state) and the cart item count. The cart lookup only happens
 * when the cart cookie already exists (`readCartId` never creates one), so
 * rendering the header on every page never mints a cart — see
 * `lib/session/cart.ts`.
 *
 * Feature B (notifications): the unread count is computed fresh from the
 * database on every render of this header (i.e. on every navigation) — no
 * WebSocket, no polling, no push (BUILD-DECISIONS.md §0). It is always
 * scoped to `user._id` from the server session, never a client-supplied id,
 * so one signed-in visitor can never see another's count. Signed-out
 * visitors see no bell at all — there is nothing to notify them about, and
 * showing a bell that requires signing in first would be misleading.
 */
export async function Header() {
  const [user, cartId] = await Promise.all([getCurrentUser(), readCartId()]);
  const cart = cartId ? await getOrCreateCart(cartId) : null;
  const itemCount = cart ? cart.items.reduce((sum, item) => sum + item.quantity, 0) : 0;
  const unreadCount = user ? await countUnreadForUser(user._id) : 0;

  return (
    <header
      className="sticky top-0 z-40 bg-slate-900 text-slate-50"
      data-agent-cart={buildAgentCartPayload(cart)}
    >
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <Link
          href="/"
          className="shrink-0 rounded px-1 text-lg font-bold tracking-tight hover:outline hover:outline-1 hover:outline-white"
        >
          NextCart
        </Link>

        <form
          action="/search"
          method="GET"
          role="search"
          className="flex min-w-0 flex-1 items-stretch"
        >
          <input
            type="search"
            name="q"
            placeholder="Search NextCart"
            aria-label="Search NextCart"
            data-agent-target="search-input"
            className="min-w-0 flex-1 rounded-l-md border-0 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-amber-400"
          />
          <button
            type="submit"
            aria-label="Search"
            className="rounded-r-md bg-amber-400 px-4 text-sm font-semibold text-slate-900 hover:bg-amber-300"
          >
            Search
          </button>
        </form>

        <nav className="flex shrink-0 items-center gap-3 text-sm">
          {user ? (
            <div className="flex items-center gap-1">
              <Link
                href="/login"
                className="rounded px-2 py-1 leading-tight hover:outline hover:outline-1 hover:outline-white"
              >
                <span className="block text-[11px] text-slate-300">
                  Hello, {user.name.split(" ")[0]}
                </span>
                <span className="block font-semibold">Account</span>
              </Link>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="rounded px-2 py-1 text-xs text-slate-300 hover:outline hover:outline-1 hover:outline-white"
                >
                  Sign out
                </button>
              </form>
            </div>
          ) : (
            <Link
              href="/login"
              className="rounded px-2 py-1 leading-tight hover:outline hover:outline-1 hover:outline-white"
            >
              <span className="block text-[11px] text-slate-300">Hello, sign in</span>
              <span className="block font-semibold">Account</span>
            </Link>
          )}

          {user && (
            <Link
              href="/notifications"
              aria-label={
                unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
              }
              className="relative rounded px-2 py-1 hover:outline hover:outline-1 hover:outline-white"
            >
              Notifications
              {unreadCount > 0 && (
                <span className="absolute -right-2 -top-2 min-w-[1.1rem] rounded-full bg-amber-400 px-1 text-center text-xs font-bold text-slate-900">
                  {unreadCount}
                </span>
              )}
            </Link>
          )}

          <Link
            href="/cart"
            data-agent-target="cart-link"
            className="relative rounded px-2 py-1 hover:outline hover:outline-1 hover:outline-white"
          >
            Cart
            {itemCount > 0 && (
              <span className="absolute -right-2 -top-2 min-w-[1.1rem] rounded-full bg-amber-400 px-1 text-center text-xs font-bold text-slate-900">
                {itemCount}
              </span>
            )}
          </Link>
        </nav>
      </div>
    </header>
  );
}
