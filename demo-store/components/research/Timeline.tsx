"use client";

import { useState } from "react";
import {
  anchoredEventIndexes,
  buildEventRows,
  eventMetaSummary,
  fmtElapsed,
  groupQuietDecisions,
  type SessionDecision,
  type SessionDetail,
  type SessionLabel,
} from "@/lib/research";

type Props = {
  detail: SessionDetail;
  replayDecisions?: SessionDecision[] | null;
  onLabel: (atEventIndex: number, expected: "help" | "quiet", note?: string) => void;
  onDeleteLabel: (index: number) => void;
};

function decisionsByIndex(decisions: SessionDecision[]): Map<number, SessionDecision[]> {
  const m = new Map<number, SessionDecision[]>();
  for (const d of decisions) {
    const list = m.get(d.eventIndex) ?? [];
    list.push(d);
    m.set(d.eventIndex, list);
  }
  return m;
}

function labelsByIndex(labels: SessionLabel[]): Map<number, SessionLabel[]> {
  const m = new Map<number, SessionLabel[]>();
  for (const l of labels) {
    const list = m.get(l.atEventIndex) ?? [];
    list.push(l);
    m.set(l.atEventIndex, list);
  }
  return m;
}

function DecisionCell({ d }: { d: SessionDecision }) {
  return (
    <div className={`research-decision ${d.acted ? "research-decision-acted" : "research-decision-quiet"}`}>
      <div className="research-decision-head">
        <span className={d.acted ? "research-tag-yes" : "research-tag-no"}>
          {d.acted ? d.actionLabel ?? "act" : "quiet"}
        </span>
        <span className="research-muted">{d.reason}</span>
        {typeof d.ms === "number" && <span className="research-num research-muted">{d.ms}ms</span>}
        {typeof d.trace?.confidence === "number" && (
          <span className="research-num research-muted">{d.trace.confidence.toFixed(2)}</span>
        )}
        {d.delivered !== undefined && (
          <span className={d.delivered ? "research-badge-delivered" : "research-badge-suppressed"}>
            {d.delivered ? "delivered" : "suppressed"}
          </span>
        )}
        {/* Outcomes (server/RESEARCH.md "Outcomes" section): what the
            shopper did with this delivered action, or "no outcome yet" —
            never shown for a quiet/undelivered decision (no action id to
            report against). */}
        {d.delivered && (
          <span className="research-outcome-chip">{d.outcome ?? "no outcome yet"}</span>
        )}
      </div>
      {d.trace?.hypothesis && <div className="research-decision-detail">hyp: {d.trace.hypothesis}</div>}
      {d.trace?.why && <div className="research-decision-detail">why: {d.trace.why}</div>}
    </div>
  );
}

export default function Timeline({ detail, replayDecisions, onLabel, onDeleteLabel }: Props) {
  const [notes, setNotes] = useState<Record<number, string>>({});
  const decByIdx = decisionsByIndex(detail.decisions);
  const labByIdx = labelsByIndex(detail.labels);
  const replayByIdx = replayDecisions ? decisionsByIndex(replayDecisions) : null;
  const anchored = anchoredEventIndexes(detail.decisions, detail.labels);
  const rows = buildEventRows(detail.events, anchored);
  const origin = detail.startedAt;
  const quiet = groupQuietDecisions(detail.decisions);
  const replayQuiet = replayDecisions ? groupQuietDecisions(replayDecisions) : null;

  return (
    <div className="research-timeline">
      <div className={`research-timeline-head${replayDecisions ? " research-3col" : ""}`}>
        <div>shopper events</div>
        <div>agent decisions</div>
        {replayDecisions && <div>replay</div>}
      </div>
      {rows.map((row) => {
        if (row.kind === "dwell-collapsed") {
          return (
            <div
              className={`research-row research-row-collapsed${replayDecisions ? " research-3col" : ""}`}
              key={`dwell-${row.fromIndex}-${row.toIndex}`}
            >
              <div className="research-cell-event">
                <span className="research-muted">
                  dwell / {Math.round(row.fromMs / 1000)}s → {Math.round(row.toMs / 1000)}s ({row.count} ticks)
                </span>
              </div>
              <div className="research-cell-decision" />
              {replayDecisions && <div className="research-cell-decision" />}
            </div>
          );
        }
        const ev = row.ev;
        const decisions = quiet.suppressed.has(ev.i) ? [] : decByIdx.get(ev.i) ?? [];
        const quietGroup = quiet.leaders.get(ev.i);
        const replayForRow = replayQuiet?.suppressed.has(ev.i) ? [] : replayByIdx?.get(ev.i) ?? [];
        const replayQuietGroup = replayQuiet?.leaders.get(ev.i);
        const labels = labByIdx.get(ev.i) ?? [];
        const meta = eventMetaSummary(ev);
        return (
          <div className={`research-row${replayDecisions ? " research-3col" : ""}`} key={ev.i}>
            <div className="research-cell-event">
              <span className="research-num research-muted">{fmtElapsed(ev.ts, origin)}</span>{" "}
              <span className="research-tag">{ev.type}</span>{" "}
              {ev.target && <span className="research-mono">{ev.target}</span>}{" "}
              {meta && <span className="research-muted">{meta}</span>}
              {ev.replay && <span className="research-badge-replay">replay</span>}
              <div className="research-label-actions">
                <button type="button" onClick={() => onLabel(ev.i, "help", notes[ev.i])}>
                  should help here
                </button>
                <button type="button" onClick={() => onLabel(ev.i, "quiet", notes[ev.i])}>
                  should stay quiet
                </button>
                <input
                  type="text"
                  maxLength={200}
                  placeholder="note"
                  className="research-note-input"
                  value={notes[ev.i] ?? ""}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [ev.i]: e.target.value }))}
                />
              </div>
              {labels.length > 0 && (
                <div className="research-labels">
                  {labels.map((l) => (
                    <span
                      key={l.index}
                      className={l.expected === "help" ? "research-label-help" : "research-label-quiet"}
                    >
                      {l.expected}
                      {l.note ? ` — ${l.note}` : ""}
                      <button type="button" onClick={() => onDeleteLabel(l.index)} aria-label="delete label">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="research-cell-decision">
              {quietGroup && quietGroup.count > 1 ? (
                <span className="research-tag-no">
                  quiet ×{quietGroup.count} ({quietGroup.reason})
                </span>
              ) : (
                decisions.map((d, idx) => <DecisionCell d={d} key={idx} />)
              )}
            </div>
            {replayDecisions && (
              <div className="research-cell-decision">
                {replayQuietGroup && replayQuietGroup.count > 1 ? (
                  <span className="research-tag-no">
                    quiet ×{replayQuietGroup.count} ({replayQuietGroup.reason})
                  </span>
                ) : (
                  replayForRow.map((d, idx) => <DecisionCell d={d} key={idx} />)
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
