// Client for the research/debug API (only live when the server runs with
// AGENT_DEBUG=1 — every route below 404s otherwise). Mirrors the contract in
// the /sessions brief; not part of the fixed Event/Action/Trace contract in
// lib/contracts.ts, so it lives on its own.

const HTTP = process.env.NEXT_PUBLIC_AGENT_HTTP ?? "http://localhost:4000";

// ---- raw wire types (exactly what server/research-routes.js + live-record.js
// emit — see server/RESEARCH.md). Never rendered directly; normalized below
// into the page's internal types before a component sees them.

export type RawAction = {
  action: string;
  target: string | null;
  style: string | null;
  duration_ms: number;
  message: string | null;
  id?: string | null;
} | null;

// Outcomes (server/RESEARCH.md "Outcomes" section) — what the shopper did
// after a non-noop action was shown.
export const OUTCOME_KINDS = ["cta", "dismiss", "turn_off", "navigated", "ignored"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
export type RawOutcomeCounts = Record<OutcomeKind, number>;

export type RawSessionSummary = {
  session: string;
  startedAt: number;
  lastAt: number;
  events: number;
  decisions: number;
  interventions: number;
  pages: string[];
  labels: RawSessionLabel[];
  lastDecision: { decided: string; reason: string } | null;
  outcomes?: RawOutcomeCounts;
};

export type SessionEvent = {
  i: number;
  ts: number;
  type: string;
  target: string | null;
  meta?: Record<string, unknown> | null;
  replay?: boolean;
};

export type DecisionTrace = {
  signals?: string[];
  hypothesis?: string;
  decision?: string;
  confidence?: number;
  why?: string;
  [key: string]: unknown;
};

// `decided` is a STRING: "noop", or "<action> <target>" (falls back to just
// the action when target is null) — see index.js line ~670. `action` is the
// full object broadcast to the widget (or null for a noop decision cycle
// that never constructed one). `delivered` is true iff a non-noop action was
// actually broadcast — the authoritative "did this decision intervene" flag.
export type RawSessionDecision = {
  ts: number;
  eventIndex: number;
  trigger?: string;
  decided: string;
  reason: string;
  ms?: number;
  action?: RawAction;
  trace?: DecisionTrace | null;
  delivered?: boolean;
  // Outcomes (server/RESEARCH.md "Outcomes" section) — joined server-side
  // (GET /sessions/:id) by action.id; null when no outcome has been
  // reported yet (or the decision has no action.id at all, e.g. a noop or
  // an action broadcast before this feature shipped).
  outcome?: OutcomeKind | null;
};

export type RawSessionLabel = {
  ts: number;
  atEventIndex: number;
  expected: "help" | "quiet";
  note?: string;
};

export type RawSessionDetail = {
  session: string;
  startedAt: number;
  lastAt: number;
  mode?: string;
  backend?: string;
  model?: string;
  events: SessionEvent[];
  decisions: RawSessionDecision[];
  labels: RawSessionLabel[];
};

export type RawReplayStatus = {
  state: "running" | "done" | "error";
  progress: { done: number; total: number };
  decisions: RawSessionDecision[];
  error?: string;
};

// ---- normalized (page-facing) types -----------------------------------------

export type SessionSummary = {
  session: string;
  startedAt: number;
  lastAt: number;
  events: number;
  decisions: number;
  interventions: number;
  pages: string[];
  labels: number;
  lastDecision: { acted: boolean; reason: string } | null;
  // Outcomes (server/RESEARCH.md "Outcomes" section) — always present
  // (zeroed) even for a summary from before this feature shipped.
  outcomes: RawOutcomeCounts;
};

export type SessionDecision = {
  ts: number;
  eventIndex: number;
  trigger?: string;
  acted: boolean;
  // Short display label for the intervention, e.g. "highlight" — null when
  // `acted` is false. Prefers the structured action's own verb, falling back
  // to the server's combined `decided` string if `action` came back null.
  actionLabel: string | null;
  target: string | null;
  reason: string;
  ms?: number;
  action: RawAction;
  trace?: DecisionTrace | null;
  delivered?: boolean;
  outcome: OutcomeKind | null;
};

// `index` is this label's position in the session's `labels[]` array — the
// value `DELETE /sessions/:id/labels/:index` actually expects (NOT
// `atEventIndex`, which merely says which event the label is anchored to and
// is not unique — two labels can share an eventIndex).
export type SessionLabel = {
  index: number;
  ts: number;
  atEventIndex: number;
  expected: "help" | "quiet";
  note?: string;
};

export type SessionDetail = {
  session: string;
  startedAt: number;
  lastAt: number;
  mode?: string;
  backend?: string;
  model?: string;
  events: SessionEvent[];
  decisions: SessionDecision[];
  labels: SessionLabel[];
};

export type ReplayStartResponse = { job: string; shadowSession: string };
export type ReplayStatus = {
  state: "running" | "done" | "error";
  progress: { done: number; total: number };
  decisions: SessionDecision[];
  error?: string;
};

// ---- normalization -----------------------------------------------------------

function normalizeAction(action: RawAction | undefined): RawAction {
  return action ?? null;
}

export function normalizeDecision(raw: RawSessionDecision): SessionDecision {
  const action = normalizeAction(raw.action);
  const acted =
    typeof raw.delivered === "boolean" ? raw.delivered : !!(action?.action && action.action !== "noop");
  return {
    ts: raw.ts,
    eventIndex: raw.eventIndex,
    trigger: raw.trigger,
    acted,
    actionLabel: acted ? action?.action ?? raw.decided ?? null : null,
    target: action?.target ?? null,
    reason: raw.reason,
    ms: raw.ms,
    action,
    trace: raw.trace,
    delivered: raw.delivered,
    outcome: raw.outcome ?? null,
  };
}

function emptyOutcomeCounts(): RawOutcomeCounts {
  return { cta: 0, dismiss: 0, turn_off: 0, navigated: 0, ignored: 0 };
}

function normalizeLabel(raw: RawSessionLabel, index: number): SessionLabel {
  return { index, ts: raw.ts, atEventIndex: raw.atEventIndex, expected: raw.expected, note: raw.note };
}

function normalizeLabels(raw: RawSessionLabel[]): SessionLabel[] {
  return raw.map(normalizeLabel);
}

function normalizeSummary(raw: RawSessionSummary): SessionSummary {
  return {
    session: raw.session,
    startedAt: raw.startedAt,
    lastAt: raw.lastAt,
    events: raw.events,
    decisions: raw.decisions,
    interventions: raw.interventions,
    pages: raw.pages,
    labels: raw.labels?.length ?? 0,
    lastDecision: raw.lastDecision ? { acted: raw.lastDecision.decided !== "noop", reason: raw.lastDecision.reason } : null,
    outcomes: raw.outcomes ?? emptyOutcomeCounts(),
  };
}

function normalizeDetail(raw: RawSessionDetail): SessionDetail {
  return {
    session: raw.session,
    startedAt: raw.startedAt,
    lastAt: raw.lastAt,
    mode: raw.mode,
    backend: raw.backend,
    model: raw.model,
    events: raw.events,
    decisions: raw.decisions.map(normalizeDecision),
    labels: normalizeLabels(raw.labels),
  };
}

function normalizeReplayStatus(raw: RawReplayStatus): ReplayStatus {
  return {
    state: raw.state,
    progress: raw.progress,
    decisions: raw.decisions.map(normalizeDecision),
    error: raw.error,
  };
}

// Distinguishes "research endpoints are off" (404 — server not run with
// AGENT_DEBUG=1) from an actual network failure (server unreachable) and
// from a conflict (409 replay already running / cached mode) so callers can
// render distinct empty/error states instead of a generic failure.
export class ResearchApiError extends Error {
  kind: "off" | "network" | "conflict" | "http";
  status?: number;
  constructor(kind: ResearchApiError["kind"], message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${HTTP}${path}`, init);
  } catch {
    throw new ResearchApiError("network", `network error reaching ${HTTP}${path}`);
  }
  if (res.status === 404) {
    throw new ResearchApiError("off", "research endpoints are off", 404);
  }
  if (res.status === 409) {
    let body = "replay already running or cached mode";
    try {
      const j = await res.json();
      if (j?.error) body = j.error;
    } catch {
      /* ignore */
    }
    throw new ResearchApiError("conflict", body, 409);
  }
  if (!res.ok) {
    throw new ResearchApiError("http", `request failed: ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Outcomes (server/RESEARCH.md "Outcomes" section) — GET /sessions/stats
// aggregate. cta_rate/dismiss_rate are fractions of `shown` (already 0,
// never NaN, when shown is 0 — see research-routes.js).
export type OutcomeBucket = { shown: number; outcomes: RawOutcomeCounts; cta_rate: number; dismiss_rate: number };
export type RawSessionStats = {
  totalActionsShown: number;
  byActionType: Record<string, OutcomeBucket>;
  byTarget: Record<string, OutcomeBucket>;
};
export type SessionStats = RawSessionStats;

export async function getSessionStats(): Promise<SessionStats> {
  return req<RawSessionStats>(`/sessions/stats`);
}

export async function listSessions(limit = 50): Promise<SessionSummary[]> {
  const raw = await req<RawSessionSummary[]>(`/sessions?limit=${limit}`);
  return raw.map(normalizeSummary);
}

export async function getSession(id: string): Promise<SessionDetail> {
  const raw = await req<RawSessionDetail>(`/sessions/${encodeURIComponent(id)}`);
  return normalizeDetail(raw);
}

export async function addLabel(
  id: string,
  atEventIndex: number,
  expected: "help" | "quiet",
  note?: string
): Promise<{ labels: SessionLabel[] }> {
  const res = await req<{ ok: true; labels: RawSessionLabel[] }>(`/sessions/${encodeURIComponent(id)}/labels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ atEventIndex, expected, note }),
  });
  return { labels: normalizeLabels(res.labels) };
}

// `index` is the label's position in `labels[]` (SessionLabel.index) — the
// server keys deletion off the array index, not the event index the label is
// anchored to (see /sessions/:id/labels/:index in server/RESEARCH.md).
export async function deleteLabel(id: string, index: number): Promise<{ labels: SessionLabel[] }> {
  const res = await req<{ ok: true; labels: RawSessionLabel[] }>(
    `/sessions/${encodeURIComponent(id)}/labels/${index}`,
    { method: "DELETE" }
  );
  return { labels: normalizeLabels(res.labels) };
}

export function startReplay(id: string): Promise<ReplayStartResponse> {
  return req(`/sessions/${encodeURIComponent(id)}/replay`, { method: "POST" });
}

export async function getReplayStatus(id: string, job: string): Promise<ReplayStatus> {
  const raw = await req<RawReplayStatus>(`/sessions/${encodeURIComponent(id)}/replay/${encodeURIComponent(job)}`);
  return normalizeReplayStatus(raw);
}

export function getFixture(id: string): Promise<unknown> {
  return req(`/sessions/${encodeURIComponent(id)}/fixture`);
}

export function resetLiveSession(id: string): Promise<void> {
  return req(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- formatting helpers ----------------------------------------------------

export function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 10)}…`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// mm:ss (or h:mm:ss beyond an hour) elapsed since `originTs`.
export function fmtElapsed(ts: number, originTs: number): string {
  return fmtDurationMs(Math.max(0, ts - originTs));
}

export function fmtDurationMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---- quiet-decision collapsing ---------------------------------------------
// Consecutive quiet (decided:false) decisions collapse into a single summary
// on the leading eventIndex; the brief calls this out explicitly ("quiet
// ticks collapsed with a count") to keep long stretches of noop from
// dominating the decisions column.

export type QuietGroup = { count: number; reason: string; fromEventIndex: number; toEventIndex: number };

export function groupQuietDecisions(
  decisions: SessionDecision[]
): { leaders: Map<number, QuietGroup>; suppressed: Set<number> } {
  const leaders = new Map<number, QuietGroup>();
  const suppressed = new Set<number>();
  let i = 0;
  const sorted = [...decisions].sort((a, b) => a.eventIndex - b.eventIndex);
  while (i < sorted.length) {
    const d = sorted[i];
    if (!d.acted) {
      let j = i;
      while (j + 1 < sorted.length && !sorted[j + 1].acted) j += 1;
      leaders.set(d.eventIndex, {
        count: j - i + 1,
        reason: d.reason,
        fromEventIndex: d.eventIndex,
        toEventIndex: sorted[j].eventIndex,
      });
      for (let k = i + 1; k <= j; k += 1) suppressed.add(sorted[k].eventIndex);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { leaders, suppressed };
}

// ---- event row collapsing ---------------------------------------------------
// Collapse consecutive page-level dwell heartbeats (same target, monotonically
// increasing meta.ms, no decision or label anchored to any of them) into a
// single summary row so a long idle page-view doesn't dominate the timeline.

export type EventRow =
  | { kind: "event"; ev: SessionEvent }
  | {
      kind: "dwell-collapsed";
      target: string | null;
      fromIndex: number;
      toIndex: number;
      fromMs: number;
      toMs: number;
      count: number;
    };

function dwellMs(ev: SessionEvent): number | undefined {
  const m = ev.meta as { ms?: number; kind?: string } | undefined;
  if (!m || m.kind === "attention") return undefined; // only page-level heartbeats collapse
  return typeof m.ms === "number" ? m.ms : undefined;
}

export function buildEventRows(
  events: SessionEvent[],
  anchoredIndexes: Set<number>
): EventRow[] {
  const rows: EventRow[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    const startMs = dwellMs(ev);
    if (ev.type === "dwell" && startMs !== undefined && !anchoredIndexes.has(ev.i)) {
      let j = i;
      let lastMs = startMs;
      while (
        j + 1 < events.length &&
        events[j + 1].type === "dwell" &&
        events[j + 1].target === ev.target &&
        dwellMs(events[j + 1]) !== undefined &&
        !anchoredIndexes.has(events[j + 1].i)
      ) {
        j += 1;
        lastMs = dwellMs(events[j])!;
      }
      if (j > i) {
        rows.push({
          kind: "dwell-collapsed",
          target: ev.target,
          fromIndex: ev.i,
          toIndex: events[j].i,
          fromMs: startMs,
          toMs: lastMs,
          count: j - i + 1,
        });
        i = j + 1;
        continue;
      }
    }
    rows.push({ kind: "event", ev });
    i += 1;
  }
  return rows;
}

// Anchored indexes = every eventIndex referenced by a decision or a label —
// these must never be swallowed into a collapsed row since the right-hand
// columns align to them.
export function anchoredEventIndexes(
  decisions: SessionDecision[],
  labels: SessionLabel[]
): Set<number> {
  const s = new Set<number>();
  for (const d of decisions) s.add(d.eventIndex);
  for (const l of labels) s.add(l.atEventIndex);
  return s;
}

export function eventMetaSummary(ev: SessionEvent): string {
  const m = (ev.meta ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "dwell": {
      const interactions = m.interactions as Record<string, unknown> | undefined;
      const bits: string[] = [];
      if (typeof m.ms === "number") bits.push(`${Math.round((m.ms as number) / 1000)}s`);
      if (interactions?.clicks) bits.push(`${interactions.clicks} clicks`);
      if (interactions?.hover_ms) bits.push(`hover ${Math.round((interactions.hover_ms as number) / 1000)}s`);
      return bits.join(" · ");
    }
    case "scroll_depth":
      return typeof m.pct === "number" ? `${m.pct}%` : "";
    case "rage_click":
      return typeof m.count === "number" ? `${m.count}x` : "";
    case "cart_view":
    case "cart_update":
      return typeof m.total === "number" ? `৳${m.total}` : "";
    case "search":
      return typeof m.q === "string" ? `"${m.q}"` : "";
    default:
      return "";
  }
}

export type ReplayDiff = {
  same: number;
  changed: number;
  newIntervention: number;
  lostIntervention: number;
};

function isIntervention(d: SessionDecision | undefined): boolean {
  return !!d && d.acted;
}

export function diffReplay(
  original: SessionDecision[],
  replay: SessionDecision[]
): ReplayDiff {
  const byIndex = new Map<number, SessionDecision>();
  for (const d of original) byIndex.set(d.eventIndex, d);
  const rByIndex = new Map<number, SessionDecision>();
  for (const d of replay) rByIndex.set(d.eventIndex, d);
  const allIndexes = new Set<number>([...byIndex.keys(), ...rByIndex.keys()]);
  const diff: ReplayDiff = { same: 0, changed: 0, newIntervention: 0, lostIntervention: 0 };
  for (const idx of allIndexes) {
    const o = byIndex.get(idx);
    const r = rByIndex.get(idx);
    const oInt = isIntervention(o);
    const rInt = isIntervention(r);
    if (!oInt && rInt) diff.newIntervention += 1;
    if (oInt && !rInt) diff.lostIntervention += 1;
    const same =
      !!o && !!r && o.acted === r.acted && o.actionLabel === r.actionLabel && o.reason === r.reason;
    if (same) diff.same += 1;
    else diff.changed += 1;
  }
  return diff;
}
