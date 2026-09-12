"use client";

import { diffReplay, type SessionDecision } from "@/lib/research";

type Props = {
  state: "idle" | "starting" | "running" | "done" | "error";
  progress?: { done: number; total: number };
  error?: string;
  original: SessionDecision[];
  replay?: SessionDecision[] | null;
  onStart: () => void;
};

export default function ReplayPanel({ state, progress, error, original, replay, onStart }: Props) {
  const diff = replay ? diffReplay(original, replay) : null;
  return (
    <div className="research-replay-panel">
      <button type="button" onClick={onStart} disabled={state === "starting" || state === "running"}>
        {state === "running" ? "Replaying…" : "Replay against current prompt"}
      </button>
      {state === "running" && progress && (
        <span className="research-muted">
          {progress.done}/{progress.total}
        </span>
      )}
      {state === "error" && <span className="research-tag-no">replay failed: {error}</span>}
      {diff && (
        <span className="research-diff-summary">
          same {diff.same} · changed {diff.changed} · new intervention {diff.newIntervention} · lost
          intervention {diff.lostIntervention}
        </span>
      )}
    </div>
  );
}
