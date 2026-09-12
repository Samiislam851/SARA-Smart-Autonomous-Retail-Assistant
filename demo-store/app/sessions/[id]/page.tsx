"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import "../../research.css";
import EmptyState from "@/components/research/EmptyState";
import ReplayPanel from "@/components/research/ReplayPanel";
import Timeline from "@/components/research/Timeline";
import {
  addLabel,
  deleteLabel,
  fmtDate,
  getFixture,
  getReplayStatus,
  getSession,
  resetLiveSession,
  shortId,
  startReplay,
  type ReplayStatus,
  type SessionDecision,
  type SessionDetail,
} from "@/lib/research";

const REPLAY_POLL_MS = 1500;

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [replayState, setReplayState] = useState<"idle" | "starting" | "running" | "done" | "error">(
    "idle"
  );
  const [replayJob, setReplayJob] = useState<string | null>(null);
  const [replayProgress, setReplayProgress] = useState<{ done: number; total: number } | undefined>();
  const [replayError, setReplayError] = useState<string | undefined>();
  const [replayDecisions, setReplayDecisions] = useState<SessionDecision[] | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getSession(id);
      setDetail(d);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleLabel(atEventIndex: number, expected: "help" | "quiet", note?: string) {
    try {
      const res = await addLabel(id, atEventIndex, expected, note);
      setDetail((prev) => (prev ? { ...prev, labels: res.labels } : prev));
    } catch (e) {
      setError(e);
    }
  }

  async function handleDeleteLabel(index: number) {
    try {
      const res = await deleteLabel(id, index);
      setDetail((prev) => (prev ? { ...prev, labels: res.labels } : prev));
    } catch (e) {
      setError(e);
    }
  }

  async function handleReplay() {
    setReplayState("starting");
    setReplayError(undefined);
    try {
      const { job } = await startReplay(id);
      setReplayJob(job);
      setReplayState("running");
      pollRef.current = setInterval(async () => {
        try {
          const status: ReplayStatus = await getReplayStatus(id, job);
          setReplayProgress(status.progress);
          if (status.state === "done") {
            setReplayDecisions(status.decisions);
            setReplayState("done");
            if (pollRef.current) clearInterval(pollRef.current);
          } else if (status.state === "error") {
            setReplayError(status.error ?? "unknown error");
            setReplayState("error");
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } catch (e) {
          setReplayError(e instanceof Error ? e.message : String(e));
          setReplayState("error");
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }, REPLAY_POLL_MS);
    } catch (e) {
      setReplayError(e instanceof Error ? e.message : String(e));
      setReplayState("error");
    }
  }

  async function handleCopyFixture() {
    try {
      const fixture = await getFixture(id);
      const text = JSON.stringify(fixture, null, 2);
      await navigator.clipboard.writeText(text);
      setCopyMsg(`copied — save as server/sessions/${id}.json`);
    } catch (e) {
      setCopyMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setCopyMsg(null), 4000);
  }

  async function handleReset() {
    if (!confirm(`Reset live server state for session ${id}? This cannot be undone.`)) return;
    try {
      await resetLiveSession(id);
      setCopyMsg("live session reset");
    } catch (e) {
      setCopyMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setCopyMsg(null), 4000);
  }

  if (error || !detail) {
    return (
      <main className="research-page">
        <EmptyState error={error ?? undefined} />
      </main>
    );
  }

  return (
    <main className="research-page">
      <header className="research-header">
        <div>
          <h1 className="research-mono">{shortId(detail.session)}</h1>
          <p className="research-muted">
            started {fmtDate(detail.startedAt)} · mode {detail.mode ?? "—"} · backend{" "}
            {detail.backend ?? "—"} · model {detail.model ?? "—"}
          </p>
        </div>
        <div className="research-actions">
          <ReplayPanel
            state={replayState}
            progress={replayProgress}
            error={replayError}
            original={detail.decisions}
            replay={replayDecisions}
            onStart={handleReplay}
          />
          <button type="button" onClick={handleCopyFixture}>
            Copy fixture JSON
          </button>
          <button type="button" onClick={handleReset} className="research-danger">
            Reset live session
          </button>
          {copyMsg && <span className="research-muted">{copyMsg}</span>}
        </div>
      </header>

      <Timeline
        detail={detail}
        replayDecisions={replayDecisions}
        onLabel={handleLabel}
        onDeleteLabel={handleDeleteLabel}
      />
    </main>
  );
}
