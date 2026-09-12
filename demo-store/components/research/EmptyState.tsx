import { ResearchApiError } from "@/lib/research";

// Three empty states the research pages can land in: no sessions recorded
// yet, the server's debug routes are off (not run with AGENT_DEBUG=1), or a
// network failure reaching the server at all.
export default function EmptyState({
  error,
  emptyMessage,
}: {
  error?: unknown;
  emptyMessage?: string;
}) {
  if (error instanceof ResearchApiError) {
    if (error.kind === "off") {
      return (
        <div className="research-empty research-empty-warn">
          <p>Research endpoints are off.</p>
          <p className="research-empty-hint">
            Start the server with <code>AGENT_DEBUG=1</code> to record and browse sessions.
          </p>
        </div>
      );
    }
    if (error.kind === "network") {
      return (
        <div className="research-empty research-empty-error">
          <p>Can&apos;t reach the agent server.</p>
          <p className="research-empty-hint">{error.message}</p>
        </div>
      );
    }
    return (
      <div className="research-empty research-empty-error">
        <p>Request failed.</p>
        <p className="research-empty-hint">{error.message}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="research-empty research-empty-error">
        <p>Something went wrong.</p>
        <p className="research-empty-hint">{String((error as Error)?.message ?? error)}</p>
      </div>
    );
  }
  return (
    <div className="research-empty">
      <p>{emptyMessage ?? "No sessions yet."}</p>
      <p className="research-empty-hint">
        Browse the store in another tab; sessions appear here within seconds.
      </p>
    </div>
  );
}
