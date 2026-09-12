import type { Metadata } from "next";
import { listMockUsers } from "@/lib/db/repositories";
import { getSession } from "@/lib/session/auth";
import { loginAction } from "./actions";

export const metadata: Metadata = { title: "Sign in — NextCart" };

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  const [users, session] = await Promise.all([listMockUsers(), getSession()]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Sign in to NextCart</h1>
        <p className="mt-1 text-sm text-slate-600">
          This is a mock login for demo purposes — no password required. Pick an account below.
        </p>
      </div>

      {session && (
        <p className="rounded-md bg-slate-100 p-3 text-sm text-slate-700">
          You&apos;re currently signed in. Choose an account below to switch.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {users.map((user) => (
          <li key={user._id}>
            <form action={loginAction.bind(null, user._id, next)}>
              <button
                type="submit"
                className="flex w-full items-center justify-between gap-3 rounded-md border border-slate-300 px-4 py-3 text-left transition hover:border-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {user.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500">{user.email}</span>
                </span>
                {user.role === "admin" && (
                  <span className="shrink-0 rounded bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">
                    Admin
                  </span>
                )}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
