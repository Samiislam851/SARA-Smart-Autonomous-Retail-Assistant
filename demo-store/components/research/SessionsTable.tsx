import Link from "next/link";
import { fmtDate, fmtDurationMs, shortId, type SessionSummary } from "@/lib/research";

// Outcomes (server/RESEARCH.md "Outcomes" section) — "✓1 ×2": ✓ counts
// "cta" (the shopper acted on it), × counts everything else that resolved
// WITHOUT acting (dismiss/turn_off/navigated/ignored). A session with no
// outcomes reported yet (all zero) renders nothing.
function OutcomeChip({ outcomes }: { outcomes: SessionSummary["outcomes"] }) {
  const acted = outcomes.cta;
  const notActed = outcomes.dismiss + outcomes.turn_off + outcomes.navigated + outcomes.ignored;
  if (acted === 0 && notActed === 0) return <span className="research-muted">—</span>;
  return (
    <span className="research-outcome-chip">
      ✓{acted} ×{notActed}
    </span>
  );
}

export default function SessionsTable({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <table className="research-table">
      <thead>
        <tr>
          <th>session</th>
          <th>started</th>
          <th>duration</th>
          <th>pages</th>
          <th>events</th>
          <th>decisions</th>
          <th>interventions</th>
          <th>labels</th>
          <th>last decision</th>
          <th>outcomes</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.session}>
            <td>
              <Link href={`/sessions/${encodeURIComponent(s.session)}`} className="research-mono">
                {shortId(s.session)}
              </Link>
            </td>
            <td>{fmtDate(s.startedAt)}</td>
            <td className="research-num">{fmtDurationMs(s.lastAt - s.startedAt)}</td>
            <td>
              <div className="research-chips">
                {s.pages.slice(0, 4).map((p, i) => (
                  <span key={i} className="research-chip research-mono">
                    {p}
                  </span>
                ))}
                {s.pages.length > 4 && (
                  <span className="research-chip">+{s.pages.length - 4}</span>
                )}
              </div>
            </td>
            <td className="research-num">{s.events}</td>
            <td className="research-num">{s.decisions}</td>
            <td className={`research-num ${s.interventions > 0 ? "research-highlight" : ""}`}>
              {s.interventions}
            </td>
            <td className="research-num">{s.labels}</td>
            <td>
              {s.lastDecision ? (
                <span className={s.lastDecision.acted ? "research-tag-yes" : "research-tag-no"}>
                  {s.lastDecision.acted ? "acted" : "quiet"} · {s.lastDecision.reason}
                </span>
              ) : (
                <span className="research-muted">—</span>
              )}
            </td>
            <td>
              <OutcomeChip outcomes={s.outcomes} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
