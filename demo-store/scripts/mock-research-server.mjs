#!/usr/bin/env node
// Mock research/debug server for developing web/app/sessions/** without the
// real server (server/**) being ready. Implements the contract from the
// /sessions brief with two fake sessions (one plain, one with interventions
// + labels) and a replay job that finishes after 3 polls.
//
// Run: node web/scripts/mock-research-server.mjs   # :4811
// Then: NEXT_PUBLIC_AGENT_HTTP=http://localhost:4811 npx next dev -p 3811

import http from "node:http";

const PORT = 4811;
const now = Date.now();

const sessionA = {
  session: "s_alpha",
  startedAt: now - 5 * 60_000,
  lastAt: now - 4 * 60_000,
  mode: "live",
  backend: "openai",
  model: "gpt-4o-mini",
  events: [
    { i: 0, ts: now - 5 * 60_000, type: "page_view", target: "/product/rain-jacket", meta: { targets: ["size-guide", "add-to-cart"] } },
    { i: 1, ts: now - 5 * 60_000 + 5000, type: "dwell", target: "/product/rain-jacket", meta: { ms: 5000 } },
    { i: 2, ts: now - 5 * 60_000 + 10000, type: "dwell", target: "/product/rain-jacket", meta: { ms: 10000 } },
    { i: 3, ts: now - 5 * 60_000 + 15000, type: "dwell", target: "/product/rain-jacket", meta: { ms: 15000 } },
    { i: 4, ts: now - 5 * 60_000 + 20000, type: "dwell", target: "size-guide", meta: { ms: 3000, kind: "attention", interactions: { clicks: 1 } } },
    { i: 5, ts: now - 5 * 60_000 + 40000, type: "dwell", target: "/product/rain-jacket", meta: { ms: 40000 } },
    { i: 6, ts: now - 5 * 60_000 + 45000, type: "back_nav", target: null, meta: {} },
    { i: 7, ts: now - 5 * 60_000 + 50000, type: "cart_view", target: "/cart", meta: { total: 1950, items: [{ sku: "jkt-1", qty: 1, price: 1950 }] } },
  ],
  decisions: [
    { ts: now - 5 * 60_000 + 5000, eventIndex: 1, trigger: "dwell", decided: "noop", reason: "quiet", ms: 120, action: { action: "noop", target: null, style: null, duration_ms: 0, message: null }, delivered: false },
    { ts: now - 5 * 60_000 + 10000, eventIndex: 2, trigger: "dwell", decided: "noop", reason: "quiet", ms: 110, action: { action: "noop", target: null, style: null, duration_ms: 0, message: null }, delivered: false },
    { ts: now - 5 * 60_000 + 15000, eventIndex: 3, trigger: "dwell", decided: "noop", reason: "quiet", ms: 115, action: { action: "noop", target: null, style: null, duration_ms: 0, message: null }, delivered: false },
    {
      ts: now - 5 * 60_000 + 40000,
      eventIndex: 5,
      trigger: "dwell",
      decided: "highlight size-guide",
      reason: "llm",
      ms: 1800,
      action: { action: "highlight", target: "size-guide", style: "pulse", duration_ms: 8000, message: null, id: "a_mock0001" },
      delivered: true,
      trace: {
        signals: ["dwell page 40s", "size-guide clicked"],
        hypothesis: "shopper is sizing-hesitant",
        decision: "highlight size-guide",
        confidence: 0.82,
        why: "long dwell + repeated size-guide interaction suggests uncertainty about fit",
      },
    },
    {
      ts: now - 5 * 60_000 + 50000,
      eventIndex: 7,
      trigger: "cart_view",
      decided: "message shipping-banner",
      reason: "llm",
      ms: 1600,
      action: { action: "message", target: "shipping-banner", style: null, duration_ms: 8000, message: "৳50 away from free delivery", id: "a_mock0002" },
      delivered: true,
      trace: {
        signals: ["cart total 1950", "free delivery threshold 2000"],
        hypothesis: "shopper is close to free delivery",
        decision: "message shipping-banner",
        confidence: 0.75,
        why: "৳50 short of free delivery threshold",
      },
    },
  ],
  labels: [{ ts: now - 60_000, atEventIndex: 5, expected: "help", note: "good catch on sizing hesitation" }],
  // Outcomes (server/RESEARCH.md "Outcomes" section) — the highlight was
  // dismissed; the message (a_mock0002) has no outcome yet, on purpose, so
  // the dev UI shows both the "resolved" and "no outcome yet" states.
  outcomes: [
    { action_id: "a_mock0001", action: "highlight", target: "size-guide", cta_kind: null, outcome: "dismiss", ms_visible: 4200, ts: now - 60_000 },
  ],
};

const sessionB = {
  session: "s_bravo",
  startedAt: now - 20 * 60_000,
  lastAt: now - 18 * 60_000,
  mode: "live",
  backend: "openai",
  model: "gpt-4o-mini",
  events: [
    { i: 0, ts: now - 20 * 60_000, type: "page_view", target: "/", meta: { targets: ["search", "cart-link"] } },
    { i: 1, ts: now - 20 * 60_000 + 5000, type: "dwell", target: "/", meta: { ms: 5000 } },
    { i: 2, ts: now - 20 * 60_000 + 10000, type: "search", target: "search", meta: { q: "jacket" } },
    { i: 3, ts: now - 20 * 60_000 + 15000, type: "cart_update", target: "cart-link", meta: { total: 900, items: [] } },
  ],
  decisions: [
    { ts: now - 20 * 60_000 + 5000, eventIndex: 1, trigger: "dwell", decided: "noop", reason: "quiet", ms: 90, action: { action: "noop", target: null, style: null, duration_ms: 0, message: null }, delivered: false },
    { ts: now - 20 * 60_000 + 15000, eventIndex: 3, trigger: "cart_update", decided: "noop", reason: "noop: happy browsing", ms: 95, action: { action: "noop", target: null, style: null, duration_ms: 0, message: null }, delivered: false },
  ],
  labels: [],
  outcomes: [],
};

const sessions = new Map([
  [sessionA.session, sessionA],
  [sessionB.session, sessionB],
]);

// Outcomes (server/RESEARCH.md "Outcomes" section) — mirrors
// research-routes.js's OUTCOME_KINDS-derived zeroed bucket + outcomeCounts().
const OUTCOME_KINDS = ["cta", "dismiss", "turn_off", "navigated", "ignored"];
function emptyOutcomeCounts() {
  const c = {};
  for (const k of OUTCOME_KINDS) c[k] = 0;
  return c;
}
function outcomeCounts(s) {
  const c = emptyOutcomeCounts();
  for (const o of s.outcomes || []) {
    if (o.outcome in c) c[o.outcome]++;
  }
  return c;
}

function summary(s) {
  // Real server shape (server/research-routes.js summarizeSession):
  // `interventions` is a count of `delivered` decisions, `labels` is the
  // FULL labels array (not a count — the web client normalizes it to a
  // count itself), `lastDecision.decided` is the string field, not boolean.
  const interventions = s.decisions.filter((d) => d.delivered).length;
  const last = s.decisions[s.decisions.length - 1];
  return {
    session: s.session,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    events: s.events.length,
    decisions: s.decisions.length,
    interventions,
    pages: [...new Set(s.events.filter((e) => e.type === "page_view").map((e) => e.target))],
    labels: s.labels,
    lastDecision: last ? { decided: last.decided, reason: last.reason } : null,
    outcomes: outcomeCounts(s),
  };
}

// Outcomes (server/RESEARCH.md "Outcomes" section) — mirrors
// research-routes.js's /sessions/:id join-by-action-id.
function withJoinedOutcomes(s) {
  const outcomeById = new Map((s.outcomes || []).map((o) => [o.action_id, o.outcome]));
  return {
    ...s,
    decisions: s.decisions.map((d) => ({
      ...d,
      outcome: d.action?.id ? (outcomeById.get(d.action.id) ?? null) : null,
    })),
  };
}

const replayJobs = new Map();
let jobCounter = 0;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  // GET /sessions?limit=50
  if (req.method === "GET" && parts.length === 1 && parts[0] === "sessions") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const list = [...sessions.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit)
      .map(summary);
    return send(res, 200, list);
  }

  // GET /sessions/stats — must be checked BEFORE the generic /sessions/:id
  // route below, same ordering requirement as the real server
  // (research-routes.js) so "stats" is never captured as a session id.
  if (req.method === "GET" && parts.length === 2 && parts[0] === "sessions" && parts[1] === "stats") {
    const byActionType = {};
    const byTarget = {};
    let totalActionsShown = 0;
    const bump = (bucket, key, outcome) => {
      if (!bucket[key]) bucket[key] = { shown: 0, outcomes: emptyOutcomeCounts() };
      bucket[key].shown++;
      if (outcome && outcome in bucket[key].outcomes) bucket[key].outcomes[outcome]++;
    };
    for (const s of sessions.values()) {
      const outcomeById = new Map((s.outcomes || []).map((o) => [o.action_id, o.outcome]));
      for (const d of s.decisions) {
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
        out[key] = { shown: v.shown, outcomes: v.outcomes, cta_rate: rate(v.outcomes.cta), dismiss_rate: rate(v.outcomes.dismiss) };
      }
      return out;
    };
    return send(res, 200, { totalActionsShown, byActionType: withRates(byActionType), byTarget: withRates(byTarget) });
  }

  // GET /sessions/:id
  if (req.method === "GET" && parts.length === 2 && parts[0] === "sessions") {
    const s = sessions.get(decodeURIComponent(parts[1]));
    if (!s) return send(res, 404, { error: "not found" });
    return send(res, 200, withJoinedOutcomes(s));
  }

  // POST /sessions/:id/labels
  if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "labels") {
    const s = sessions.get(decodeURIComponent(parts[1]));
    if (!s) return send(res, 404, { error: "not found" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { atEventIndex, expected, note } = JSON.parse(body || "{}");
      s.labels.push({ ts: Date.now(), atEventIndex, expected, note });
      send(res, 200, { ok: true, labels: s.labels });
    });
    return;
  }

  // DELETE /sessions/:id/labels/:index — :index is the ARRAY INDEX into
  // labels[], not atEventIndex (server/research-routes.js splices by index).
  if (req.method === "DELETE" && parts.length === 4 && parts[0] === "sessions" && parts[2] === "labels") {
    const s = sessions.get(decodeURIComponent(parts[1]));
    if (!s) return send(res, 404, { error: "not found" });
    const idx = Number(parts[3]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.labels.length) {
      return send(res, 400, { error: "bad label index" });
    }
    s.labels.splice(idx, 1);
    return send(res, 200, { ok: true, labels: s.labels });
  }

  // POST /sessions/:id/replay
  if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "replay") {
    const s = sessions.get(decodeURIComponent(parts[1]));
    if (!s) return send(res, 404, { error: "not found" });
    jobCounter += 1;
    const job = `job_${jobCounter}`;
    const shadowSession = `${s.session}_shadow_${jobCounter}`;
    // Completes after 3 polls; slightly tweak one decision so the diff isn't empty.
    const replayDecisions = s.decisions.map((d, i) =>
      i === s.decisions.length - 1
        ? { ...d, reason: "llm", trace: d.trace ? { ...d.trace, why: "replay: same signals, current prompt" } : d.trace }
        : d
    );
    replayJobs.set(job, { pollsLeft: 3, total: s.events.length, decisions: replayDecisions });
    return send(res, 202, { job, shadowSession });
  }

  // GET /sessions/:id/replay/:job
  if (req.method === "GET" && parts.length === 4 && parts[0] === "sessions" && parts[2] === "replay") {
    const job = replayJobs.get(parts[3]);
    if (!job) return send(res, 404, { error: "not found" });
    job.pollsLeft -= 1;
    const done = job.pollsLeft <= 0;
    return send(res, 200, {
      state: done ? "done" : "running",
      progress: { done: done ? job.total : Math.max(0, job.total - job.pollsLeft), total: job.total },
      decisions: done ? job.decisions : [],
    });
  }

  // GET /sessions/:id/fixture — replay.js-compatible shape (research-routes.js
  // toFixture()): {name, session, description, expect, events}.
  if (req.method === "GET" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "fixture") {
    const s = sessions.get(decodeURIComponent(parts[1]));
    if (!s) return send(res, 404, { error: "not found" });
    return send(res, 200, {
      name: s.session,
      session: s.session,
      description: `Exported from live session ${s.session}`,
      expect: { action: "noop" },
      events: s.events.map((e, i) => ({
        delay_ms: i === 0 ? 0 : Math.max(0, e.ts - s.events[i - 1].ts),
        type: e.type,
        ...(e.target != null ? { target: e.target } : {}),
        ...(e.meta != null ? { meta: e.meta } : {}),
      })),
    });
  }

  // DELETE /session/:id (reset live state)
  if (req.method === "DELETE" && parts.length === 2 && parts[0] === "session") {
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`mock-research-server listening on :${PORT}`);
});
