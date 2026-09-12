"use client";

import { useEffect, useState } from "react";
import "../research.css";
import EmptyState from "@/components/research/EmptyState";
import SessionsTable from "@/components/research/SessionsTable";
import { getSessionStats, isToday, listSessions, type SessionStats, type SessionSummary } from "@/lib/research";

const REFRESH_MS = 5000;

type Filter = "interventions" | "labelled" | "today";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  // Outcomes (server/RESEARCH.md "Outcomes" section) — a rates strip from
  // GET /sessions/stats, above the table. Kept `null` (renders nothing) on
  // any error — the table itself is the important thing; a stats fetch
  // failure shouldn't block it.
  const [stats, setStats] = useState<SessionStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await listSessions(50);
        if (!cancelled) {
          setSessions(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      }
      try {
        const s = await getSessionStats();
        if (!cancelled) setStats(s);
      } catch {
        if (!cancelled) setStats(null);
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  function toggle(f: Filter) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  const filtered = (sessions ?? []).filter((s) => {
    if (filters.has("interventions") && s.interventions <= 0) return false;
    if (filters.has("labelled") && s.labels <= 0) return false;
    if (filters.has("today") && !isToday(s.startedAt)) return false;
    return true;
  });

  return (
    <main className="research-page">
      <header className="research-header">
        <h1>Sessions</h1>
        <div className="research-filters">
          <label className={filters.has("interventions") ? "research-filter-on" : ""}>
            <input
              type="checkbox"
              checked={filters.has("interventions")}
              onChange={() => toggle("interventions")}
            />
            with interventions
          </label>
          <label className={filters.has("labelled") ? "research-filter-on" : ""}>
            <input
              type="checkbox"
              checked={filters.has("labelled")}
              onChange={() => toggle("labelled")}
            />
            labelled
          </label>
          <label className={filters.has("today") ? "research-filter-on" : ""}>
            <input type="checkbox" checked={filters.has("today")} onChange={() => toggle("today")} />
            today
          </label>
        </div>
      </header>

      {stats && stats.totalActionsShown > 0 && (
        <div className="research-stats-strip" title="Across every recorded live session (GET /sessions/stats)">
          <span>{stats.totalActionsShown} actions shown</span>
          {Object.entries(stats.byActionType).map(([action, b]) => (
            <span key={action}>
              {action}: {Math.round(b.cta_rate * 100)}% tapped · {Math.round(b.dismiss_rate * 100)}% dismissed
              {b.outcomes.ignored ? ` · ${b.outcomes.ignored} ignored` : ""}
            </span>
          ))}
        </div>
      )}

      {!error && sessions === null ? (
        <p className="research-muted">Loading…</p>
      ) : error || !sessions || filtered.length === 0 ? (
        <EmptyState
          error={error}
          emptyMessage={
            sessions && sessions.length > 0 ? "No sessions match the current filters." : undefined
          }
        />
      ) : (
        <SessionsTable sessions={filtered} />
      )}
    </main>
  );
}
