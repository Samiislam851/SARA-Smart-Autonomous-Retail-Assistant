// Live session recorder for the research loop (server/RESEARCH.md).
//
// Enabled when AGENT_LIVE_RECORD=1 OR AGENT_DEBUG=1 (default off). Records
// every live session's events and decisions to sessions/live/<sessionId>.json
// so a team studying "what does stuck look like" can list/inspect/label/
// replay real sessions after the fact.
//
// NOT recorded (isRecordable() below): shadow replay sessions (`rp_*` —
// research-routes.js's own POST /sessions/:id/replay shadow runs) and
// demo-player fixture sessions (`fx_*`) — both are synthetic re-runs of
// already-recorded (or already-scripted) material, recording them would
// just duplicate/pollute the corpus of real shopper sessions this tool
// exists to study.
//
// Write model: in-memory record per session, debounced to disk at most once
// per second (server-receive-time), flushed immediately (bypassing the
// debounce) whenever a decision is appended — a decision is the moment a
// human/reviewer is most likely to look at the file next, and it's rare
// enough (one per decider tick, not one per event) that flushing on every
// one is cheap. Cap: 500 files under sessions/live/, oldest by `lastAt`
// deleted first once exceeded (checked after every disk write).
//
// Path safety: session ids are already validated (contracts.js's
// SESSION_ID_RE) everywhere they enter the system; filePath() still
// resolves-and-checks before touching the filesystem, same defense-in-depth
// pattern as decide/cached.js's filePath() and demo-play.js's
// safeFixturePath() — never trust a validated-elsewhere string as a path
// component without checking again at the point of use.

import fs from "node:fs";
import path from "node:path";
import { isValidSessionId } from "./contracts.js";
import * as metrics from "./metrics.js";
import { log } from "./log.js";

const ENABLED = process.env.AGENT_LIVE_RECORD === "1" || process.env.AGENT_DEBUG === "1";
const LIVE_DIR = path.join(process.cwd(), "sessions", "live");
const MAX_FILES = 500;
const WRITE_DEBOUNCE_MS = 1000;

/** session id -> in-memory record (mirrors the on-disk shape). */
const records = new Map();
/** session id -> debounce timer, only while a write is pending. */
const pendingWrite = new Map();
/** session ids with in-memory changes not yet flushed to disk. */
const dirty = new Set();

export function isLiveRecordEnabled() {
  return ENABLED;
}

/** Sessions this recorder never writes a file for, regardless of ENABLED —
 * see the module comment above. */
function isRecordable(sessionId) {
  if (!ENABLED) return false;
  if (!isValidSessionId(sessionId)) return false;
  if (sessionId.startsWith("fx_") || sessionId.startsWith("rp_")) return false;
  return true;
}

function filePath(sessionId) {
  const file = path.join(LIVE_DIR, `${sessionId}.json`);
  const resolvedDir = path.resolve(LIVE_DIR);
  const resolved = path.resolve(file);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return file;
}

function freshRecord(sessionId) {
  return {
    session: sessionId,
    startedAt: Date.now(),
    lastAt: Date.now(),
    mode: process.env.AGENT_MODE || "stub",
    backend: process.env.LLM_BACKEND || "codex",
    model: process.env.LLM_MODEL || null,
    events: [],
    decisions: [],
    labels: [],
    // Outcomes (server/RESEARCH.md "Outcomes" section): what the shopper
    // DID after a non-noop action was shown — { action_id, action, target,
    // cta_kind, outcome, ms_visible, ts }, one per action_id (recordOutcome()
    // below dedups). Joined against `decisions` by `decisions[i].action.id`
    // === `outcomes[j].action_id` — see research-routes.js.
    outcomes: [],
  };
}

function loadOrCreate(sessionId) {
  if (records.has(sessionId)) return records.get(sessionId);
  const file = filePath(sessionId);
  let rec = null;
  if (file && fs.existsSync(file)) {
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      rec = null;
    }
  }
  if (!rec) rec = freshRecord(sessionId);
  records.set(sessionId, rec);
  return rec;
}

function writeNow(sessionId, rec) {
  const file = filePath(sessionId);
  if (!file) return;
  try {
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    enforceCap();
  } catch (err) {
    log.error("live-record: write failed", { session: sessionId, err: String(err?.message ?? err) });
  }
}

function enforceCap() {
  let entries;
  try {
    entries = fs.readdirSync(LIVE_DIR, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json"));
  } catch {
    return;
  }
  if (entries.length <= MAX_FILES) return;
  const withAge = entries.map((e) => {
    const p = path.join(LIVE_DIR, e.name);
    let lastAt = 0;
    try {
      lastAt = JSON.parse(fs.readFileSync(p, "utf8"))?.lastAt ?? 0;
    } catch {
      // fall through to mtime below
    }
    if (!lastAt) {
      try {
        lastAt = fs.statSync(p).mtimeMs;
      } catch {
        lastAt = 0;
      }
    }
    return { p, lastAt };
  });
  withAge.sort((a, b) => a.lastAt - b.lastAt);
  const excess = withAge.length - MAX_FILES;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(withAge[i].p);
    } catch {
      // already gone / racing another cleanup — fine
    }
  }
}

function scheduleWrite(sessionId) {
  dirty.add(sessionId);
  if (pendingWrite.has(sessionId)) return;
  const t = setTimeout(() => flush(sessionId), WRITE_DEBOUNCE_MS);
  t.unref?.();
  pendingWrite.set(sessionId, t);
}

function flush(sessionId) {
  const t = pendingWrite.get(sessionId);
  if (t) clearTimeout(t);
  pendingWrite.delete(sessionId);
  if (!dirty.has(sessionId)) return;
  dirty.delete(sessionId);
  const rec = records.get(sessionId);
  if (rec) writeNow(sessionId, rec);
}

/**
 * recordEvent(ev, { replay }) — append one event to its session's live
 * record. `replay` = true when this event's POST /event carried
 * `x-agent-replay: 1` (server/replay.js driving a live, non-fixture session
 * — the day-of tuning tool, not this module's own shadow-replay jobs, which
 * are excluded entirely via the rp_ prefix check above). No-op for
 * unrecordable sessions.
 */
export function recordEvent(ev, { replay = false } = {}) {
  if (!isRecordable(ev.session)) return;
  const rec = loadOrCreate(ev.session);
  rec.lastAt = Date.now();
  rec.mode = process.env.AGENT_MODE || rec.mode;
  const i = rec.events.length;
  rec.events.push({
    i,
    ts: ev.ts ?? Date.now(),
    type: ev.type,
    target: ev.target ?? null,
    meta: ev.meta ?? null,
    replay: Boolean(replay),
  });
  metrics.inc("liveRecorded");
  scheduleWrite(ev.session);
}

/**
 * recordDecision(sessionId, entry) — append one decision cycle. Flushes to
 * disk immediately (see module comment). No-op for unrecordable sessions.
 */
export function recordDecision(sessionId, entry) {
  if (!isRecordable(sessionId)) return;
  const rec = loadOrCreate(sessionId);
  rec.lastAt = Date.now();
  rec.decisions.push(entry);
  dirty.add(sessionId);
  flush(sessionId);
}

/**
 * recordOutcome(sessionId, entry) → { recorded, duplicate } — append one
 * outcome (server/RESEARCH.md "Outcomes" section), deduped by
 * entry.action_id: a second report for an id already present is
 * acknowledged (recorded: false, duplicate: true) but not appended — the
 * server-side half of "exactly one outcome per action id" (the widget's
 * own client-side Set of reported ids is the first line of defense; this
 * is defense in depth against e.g. a slow tab-close beacon racing an
 * earlier explicit dismiss). Flushes to disk immediately, same rationale
 * as recordDecision() (a human/reviewer looking at the session right after
 * an outcome lands shouldn't see a stale file). No-op (recorded: false,
 * duplicate: false) for unrecordable sessions (recording disabled, or a
 * fx_ or rp_ synthetic session).
 */
export function recordOutcome(sessionId, entry) {
  if (!isRecordable(sessionId)) return { recorded: false, duplicate: false };
  const rec = loadOrCreate(sessionId);
  rec.outcomes = rec.outcomes || [];
  if (rec.outcomes.some((o) => o.action_id === entry.action_id)) {
    return { recorded: false, duplicate: true };
  }
  rec.lastAt = Date.now();
  rec.outcomes.push(entry);
  dirty.add(sessionId);
  flush(sessionId);
  return { recorded: true, duplicate: false };
}

/** Index (0-based) of the most recently recorded event for this session, or
 * -1 if none recorded yet — used to stamp a decision's `eventIndex` against
 * this recorder's own (unbounded) event list, independent of state.js's
 * ring-buffered session.events. */
export function lastEventIndex(sessionId) {
  const rec = records.get(sessionId);
  if (!rec) return -1;
  return rec.events.length - 1;
}

function forceFlushIfPending(sessionId) {
  if (pendingWrite.has(sessionId)) flush(sessionId);
}

/**
 * readLiveRecord(id) → the full on-disk record, or null if none exists /
 * the id is invalid. Flushes any pending in-memory write first so a read
 * immediately after an event always sees it (debounced writes never make a
 * GET stale by more than this call).
 */
export function readLiveRecord(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  forceFlushIfPending(sessionId);
  const file = filePath(sessionId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** listLiveSessionIds() → every recorded session id (validated, `.json`
 * stripped), in filesystem enumeration order — callers sort/slice. */
export function listLiveSessionIds() {
  let entries;
  try {
    entries = fs.readdirSync(LIVE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.slice(0, -".json".length))
    .filter(isValidSessionId);
}

/**
 * persistRecord(id, rec) — overwrite a session's live record (used by
 * research-routes.js's label endpoints, which mutate a record read via
 * readLiveRecord() and write it straight back). Keeps the in-memory cache in
 * sync so a still-live session's next event/decision doesn't clobber the
 * mutation with a stale in-memory copy.
 */
export function persistRecord(sessionId, rec) {
  if (!isValidSessionId(sessionId)) return;
  records.set(sessionId, rec);
  dirty.add(sessionId);
  flush(sessionId);
}
