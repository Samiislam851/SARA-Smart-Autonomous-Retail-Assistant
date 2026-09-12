import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-auto bg-slate-900 text-slate-300">
      <div className="mx-auto max-w-7xl px-4 py-8 text-sm">
        <nav data-agent-target="policies-link" className="flex flex-wrap gap-x-6 gap-y-2">
          <Link
            href="/policies/shipping"
            data-agent-target="shipping-policy"
            className="hover:text-white hover:underline"
          >
            Shipping policy
          </Link>
          <Link
            href="/policies/returns"
            data-agent-target="returns-policy"
            className="hover:text-white hover:underline"
          >
            Returns policy
          </Link>
        </nav>
        <p className="mt-6 text-slate-400">
          &copy; {new Date().getFullYear()} NextCart. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
