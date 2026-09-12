export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8" aria-busy="true" aria-live="polite">
      <div className="h-6 w-72 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="aspect-[3/4] animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
      <span className="sr-only">Searching…</span>
    </div>
  );
}
