// Research API — list/inspect/label/replay recorded live sessions, export a
// fixture, and force a decision now. Mounted from index.js only when
// AGENT_DEBUG=1 (plain 404 otherwise, same treatment as every other
// debug-only route — see index.js's own comment at the mount site).
//
// Depends on a handful of index.js closures (broadcast, decideAndBroadcast,
// processEventSerial, getSession/peekSession, an in-flight check) passed in
// via createResearchRouter({...}) — same factory-router pattern health.js
// already uses (createHealthRouter({sockets, server})) so index.js stays
// route-wiring only and this module never has to reach into index.js's
// module-scoped state directly.
//
// See server/RESEARCH.md for the file format, the full endpoint walkthrough,
// and the fixtures-promoted-from-real-sessions convention.

import { randomBytes } from "node:crypto";
import express from "express";
import { isValidSessionId } from "./contracts.js";
import * as metrics from "./metrics.js";
import { log } from "./log.js";
import { readLiveRecord, listLiveSessionIds, persistRecord } from "./live-record.js";
import { OUTCOME_KINDS } from "./contracts.js";

const MAX_JOBS = 50;
const MAX_LABEL_NOTE_LEN = 200;

/** session id -> job id, only while that session's replay is RUNNING —
 * enforces "one replay job per source session at a time". Removed once the
 * job settles (done or error), so a session can be replayed again. */
const runningJobBySession = new Map();

/** job id -> job record, insertion order (Map preserves it) — capped at
 * MAX_JOBS, oldest evicted first, skipping a job that's still running (there
 * can be at most one of those per session, and at most a handful across the
 * whole process for this dev tool, so this never starves eviction). */
const jobs = new Map();

function newId(prefix) {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function evictOldJobs() {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.state === "running") continue;
    jobs.delete(id);
  }
}

function pageList(rec) {
  const pages = [];
  for (const e of rec.events || []) {
    if (e.type !== "page_view") continue;
    if (pages[pages.length - 1] !== e.target) pages.push(e.target);
  }
  return pages;
}

/** emptyOutcomeCounts() → { cta: 0, dismiss: 0, turn_off: 0, navigated: 0,
 * ignored: 0 } — one zeroed bucket per OUTCOME_KINDS entry, shared by
 * summarizeSession() and /sessions/stats below so both always report every
 * kind (even at 0) rather than omitting a kind that never happened. */
function emptyOutcomeCounts() {
  const counts = {};
  for (const k of OUTCOME_KINDS) counts[k] = 0;
  return counts;
}

/** outcomeCounts(rec) → emptyOutcomeCounts() tallied from rec.outcomes
 * (missing/older recordings without the field count as all-zero). */
function outcomeCounts(rec) {
  const counts = emptyOutcomeCounts();
  for (const o of rec.outcomes || []) {
    if (o.outcome in counts) counts[o.outcome]++;
  }
  return counts;
}

function summarizeSession(rec) {
  const lastDecision = rec.decisions?.length ? rec.decisions[rec.decisions.length - 1] : null;
  return {
    session: rec.session,
    startedAt: rec.startedAt,
    lastAt: rec.lastAt,
    events: rec.events?.length ?? 0,
    decisions: rec.decisions?.length ?? 0,
    interventions: (rec.decisions || []).filter((d) => d.delivered).length,
    pages: pageList(rec),
    labels: rec.labels ?? [],
    lastDecision: lastDecision ? { decided: lastDecision.decided, reason: lastDecision.reason } : null,
    // Outcomes (server/RESEARCH.md "Outcomes" section): counts of what the
    // shopper did after each non-noop action this session — see
    // outcomeCounts() above.
    outcomes: outcomeCounts(rec),
  };
}

/**
 * toFixture(rec) — replay.js-compatible fixture JSON. `events` reconstructs
 * `delay_ms` from consecutive recorded `ts` values (0 for the first event).
 * `expect` comes from the LAST label with expected:"help", matched to the
 * decision recorded at that same eventIndex (its action/target becomes the
 * expectation); with no "help" label, or no decision at that index, falls
 * back to {action:"noop"} — matching what an unlabeled/quiet session should
 * replay as.
 */
function toFixture(rec) {
  const events = (rec.events || []).map((e, i) => {
    const prevTs = i === 0 ? e.ts : rec.events[i - 1].ts;
    const out = { delay_ms: i === 0 ? 0 : Math.max(0, (e.ts ?? 0) - (prevTs ?? 0)), type: e.type };
    if (e.target != null) out.target = e.target;
    if (e.meta != null) out.meta = e.meta;
    return out;
  });

  let expect = { action: "noop" };
  const helpLabels = (rec.labels || []).filter((l) => l.expected === "help");
  const lastHelp = helpLabels[helpLabels.length - 1];
  if (lastHelp) {
    const decision = (rec.decisions || []).find((d) => d.eventIndex === lastHelp.atEventIndex);
    if (decision?.action && decision.action.action !== "noop") {
      expect = { action: decision.action.action };
      if (decision.action.target != null) expect.target = decision.action.target;
    }
  }

  return {
    name: rec.session,
    session: rec.session,
    description: `Exported from live session ${rec.session}`,
    expect,
    events,
  };
}

export function createResearchRouter({
  broadcast,
  decideAndBroadcast,
  processEventSerial,
  getSession,
  peekSession,
  isSessionDecisionInFlight,
}) {
  const router = express.Router();

  router.get("/sessions", (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const ids = listLiveSessionIds();
    const recs = ids.map(readLiveRecord).filter(Boolean);
    recs.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    res.json(recs.slice(0, limit).map(summarizeSession));
  });

  // GET /sessions/stats — aggregate outcome rates across every recorded
  // live session (server/RESEARCH.md "Outcomes" section), by action type
  // and by target. cta_rate/dismiss_rate are fractions of `shown` (0 when
  // shown is 0, never NaN). Mounted under the same AGENT_DEBUG gate as
  // every other route this factory returns (see index.js's mount site).
  router.get("/sessions/stats", (_req, res) => {
    const byActionType = {};
    const byTarget = {};
    let totalActionsShown = 0;
    // Stale-response guard (server/stale.js): how often a decision was
    // dropped because the shopper's context moved on while the decider was
    // thinking, broken down by drift class — so the research page shows
    // WHY nothing appeared instead of it just looking like a silent noop.
    // Parsed from denied()'s trace.why (server/policy.js), the only place
    // this reason string is written: "...(guard: stale_context:<class>; ...)".
    const staleDrops = { product_changed: 0, cart_changed: 0, moved_on: 0 };
    const STALE_WHY_RE = /guard: stale_context:(product_changed|cart_changed|moved_on)/;

    const bump = (bucket, key, outcome) => {
      if (!bucket[key]) bucket[key] = { shown: 0, outcomes: emptyOutcomeCounts() };
      bucket[key].shown++;
      if (outcome && outcome in bucket[key].outcomes) bucket[key].outcomes[outcome]++;
    };

    for (const id of listLiveSessionIds()) {
      const rec = readLiveRecord(id);
      if (!rec) continue;
      const outcomeById = new Map((rec.outcomes || []).map((o) => [o.action_id, o.outcome]));
      for (const d of rec.decisions || []) {
        const staleMatch = d.trace?.why?.match(STALE_WHY_RE);
        if (staleMatch) staleDrops[staleMatch[1]]++;
        if (!d.delivered || !d.action || d.action.action === "noop" || !d.action.id) continue;
        totalActionsShown++;
        const outcome = outcomeById.get(d.action.id) ?? null;
        bump(byActionType, d.action.action, outcome);
        bump(byTarget, d.action.target ?? "(none)", outcome);
      }
    }

    const withRates = (bucket) => {
      const out = {};
      for (const [key, v] of Object.entries(bucket)) {
        const rate = (n) => (v.shown > 0 ? n / v.shown : 0);
        out[key] = {
          shown: v.shown,
          outcomes: v.outcomes,
          cta_rate: rate(v.outcomes.cta),
          dismiss_rate: rate(v.outcomes.dismiss),
        };
      }
      return out;
    };

    res.json({
      totalActionsShown,
      byActionType: withRates(byActionType),
      byTarget: withRates(byTarget),
      staleDrops,
    });
  });

  router.get("/sessions/:id", (req, res) => {
    const rec = readLiveRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: "no such recorded session" });
    // Outcomes (server/RESEARCH.md "Outcomes" section): join each decision
    // to its outcome by action id — computed on read, never persisted onto
    // the stored record (rec.outcomes stays the single source of truth).
    // A decision with no matching outcome (never happened yet, or a noop
    // with no action.id at all) gets `outcome: null`.
    const outcomeById = new Map((rec.outcomes || []).map((o) => [o.action_id, o.outcome]));
    const decisions = (rec.decisions || []).map((d) => ({
      ...d,
      outcome: d.action?.id ? (outcomeById.get(d.action.id) ?? null) : null,
    }));
    res.json({ ...rec, decisions });
  });

  router.post("/sessions/:id/labels", (req, res) => {
    const id = req.params.id;
    const rec = readLiveRecord(id);
    if (!rec) return res.status(404).json({ error: "no such recorded session" });

    const { atEventIndex, expected, note } = req.body ?? {};
    if (!Number.isInteger(atEventIndex) || atEventIndex < 0) {
      return res.status(400).json({ error: "atEventIndex must be a non-negative integer" });
    }
    if (expected !== "help" && expected !== "quiet") {
      return res.status(400).json({ error: 'expected must be "help" or "quiet"' });
    }
    if (note !== undefined && (typeof note !== "string" || note.length > MAX_LABEL_NOTE_LEN)) {
      return res.status(400).json({ error: `note must be a string of at most ${MAX_LABEL_NOTE_LEN} chars` });
    }

    rec.labels = rec.labels ?? [];
    const label = { ts: Date.now(), atEventIndex, expected };
    if (note !== undefined) label.note = note;
    rec.labels.push(label);
    persistRecord(id, rec);
    res.json({ ok: true, labels: rec.labels });
  });

  router.delete("/sessions/:id/labels/:index", (req, res) => {
    const id = req.params.id;
    const rec = readLiveRecord(id);
    if (!rec) return res.status(404).json({ error: "no such recorded session" });

    const idx = Number(req.params.index);
    const labels = rec.labels ?? [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= labels.length) {
      return res.status(400).json({ error: "bad label index" });
    }
    labels.splice(idx, 1);
    rec.labels = labels;
    persistRecord(id, rec);
    res.json({ ok: true, labels: rec.labels });
  });

  router.get("/sessions/:id/fixture", (req, res) => {
    const rec = readLiveRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: "no such recorded session" });
    res.json(toFixture(rec));
  });

  router.post("/sessions/:id/replay", (req, res) => {
    const id = req.params.id;
    const mode = process.env.AGENT_MODE || "stub";
    if (mode !== "llm" && mode !== "stub") {
      return res.status(409).json({ error: "replay requires AGENT_MODE=llm or stub" });
    }
    const rec = readLiveRecord(id);
    if (!rec) return res.status(404).json({ error: "no such recorded session" });
    if (runningJobBySession.has(id)) {
      return res.status(409).json({ error: "replay already running for this session", job: runningJobBySession.get(id) });
    }

    const shadowSession = newId("rp");
    const job = newId("job");
    const sourceEvents = (rec.events || []).filter((e) => !e.replay);

    const jobRecord = {
      job,
      sourceSession: id,
      shadowSession,
      state: "running",
      total: sourceEvents.length,
      done: 0,
      decisions: [],
      startedAt: Date.now(),
      error: null,
    };
    jobs.set(job, jobRecord);
    evictOldJobs();
    runningJobBySession.set(id, job);

    metrics.inc("replayJobs");
    res.status(202).json({ job, shadowSession });

    broadcast(id, { kind: "replay", state: "running", job, done: 0, total: jobRecord.total });

    (async () => {
      try {
        for (const e of sourceEvents) {
          // Preserve the ORIGINAL event ts (not Date.now()) — tick.js/gate.js
          // time-window rules key off event.ts, and the whole point of a
          // replay is "would today's rules reach the same call given the
          // same shopper timeline", not a timeline compressed to zero. Known
          // limitation (documented in RESEARCH.md, same category as
          // decide/cached.js's own cooldown caveat): policy.js's cooldown
          // check IS wall-clock (Date.now()), so a session whose real
          // decisions were minutes apart can, replayed with no real-time
          // delay between POSTs, see a LATER proposal wrongly denied by
          // cooldown even though the original wasn't — tick/gate/policy all
          // apply, unmodified, per the brief.
          const ev = { session: shadowSession, type: e.type, target: e.target, ts: e.ts, meta: e.meta };
          let result;
          try {
            result = await processEventSerial(ev);
          } catch (err) {
            log.error("replay job: event failed", { job, session: id, err: String(err?.message ?? err) });
            result = null;
          }
          jobRecord.done++;
          if (result) {
            jobRecord.decisions.push({
              ts: result.trace?.ts ?? Date.now(),
              eventIndex: jobRecord.done - 1,
              trigger: e.type,
              decided: result.action.action === "noop" ? "noop" : [result.action.action, result.action.target].filter(Boolean).join(" "),
              reason: result.reason,
              ms: result.ms,
              action: result.action,
              trace: result.trace,
              delivered: result.action.action !== "noop",
            });
          }
          broadcast(id, { kind: "replay", state: "running", job, done: jobRecord.done, total: jobRecord.total });
        }
        jobRecord.state = "done";
      } catch (err) {
        jobRecord.state = "error";
        jobRecord.error = String(err?.message ?? err);
        log.error("replay job failed", { job, session: id, err: jobRecord.error });
      } finally {
        runningJobBySession.delete(id);
        broadcast(id, { kind: "replay", state: jobRecord.state, job, done: jobRecord.done, total: jobRecord.total });
      }
    })();
  });

  router.get("/sessions/:id/replay/:job", (req, res) => {
    const job = jobs.get(req.params.job);
    if (!job || job.sourceSession !== req.params.id) {
      return res.status(404).json({ error: "no such replay job" });
    }
    res.json({
      state: job.state,
      progress: { done: job.done, total: job.total },
      decisions: job.decisions,
    });
  });

  router.post("/session/:id/decide", async (req, res) => {
    const id = req.params.id;
    if (!isValidSessionId(id)) return res.status(400).json({ error: "bad session id" });

    const mode = process.env.AGENT_MODE || "stub";
    if (mode !== "llm" && mode !== "stub") {
      return res.status(409).json({ error: "forced decide requires AGENT_MODE=llm or stub" });
    }
    const session = peekSession(id);
    if (!session) return res.status(404).json({ error: "no such live session" });
    if (isSessionDecisionInFlight(id)) {
      return res.status(409).json({ error: "decision in flight" });
    }

    metrics.inc("forcedDecisions");
    const ev = { session: id, type: "forced", target: null, ts: Date.now(), meta: null };
    try {
      const result = await decideAndBroadcast(getSession(id), ev, { force: true, reasonLabel: "forced" });
      res.json({ action: result.action, trace: result.trace, ms: result.ms });
    } catch (err) {
      log.error("forced decide failed", { session: id, err: String(err?.message ?? err) });
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
