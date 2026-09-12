"use client";

import { useEffect } from "react";

export default function CategoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-3 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-slate-900">
        This category couldn&apos;t be loaded
      </h1>
      <p className="max-w-md text-sm text-slate-600">
        Something went wrong while fetching these products. Please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Try again
      </button>
    </div>
  );
}
