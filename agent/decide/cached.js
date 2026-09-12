// Demo safety net: replay a previously recorded decision sequence instead of
// calling a live decider. Falls back to stub if nothing recorded (or index
// runs off the end of the recording).
//
// Recording semantics: the recorder writes ONE entry per EVENT (including
// quiet ticks that don't produce an intervention) — index.js bypasses the
// decider tick-throttle whenever AGENT_RECORD is set, so recorded[n] always
// lines up with the nth event regardless of session, exactly like playback
// (which also calls the decider on every event in cached mode). What gets
// recorded is the decider's PRE-policy proposal, not the post-policy result —
// policy (cooldowns, target checks) is re-applied identically on playback.
// The one guard cached mode explicitly skips is the wall-clock cooldown:
// `--speed 10` compresses delays, so a proposal that was allowed 31s apart
// during recording could land <30s apart on playback and get wrongly denied.
// Allow-list/target/shape guards still apply on playback.

import fs from "node:fs";
import path from "node:path";
import { isValidSessionId } from "../contracts.js";
import { decide as decideStub } from "./stub.js";

const RECORDED_DIR = path.join(process.cwd(), "sessions", "recorded");

const warnedSessions = new Set();

function filePath(sessionId) {
  const file = path.join(RECORDED_DIR, `${sessionId}.json`);
  // Defense in depth: even though isValidSessionId() should already have
  // rejected anything with path separators, never resolve to a path outside
  // the recorded dir.
  const resolvedDir = path.resolve(RECORDED_DIR);
  const resolved = path.resolve(file);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return file;
}

export function decide(state, session) {
  const sessionId = session.id;
  if (!isValidSessionId(sessionId)) return decideStub(state, session);

  const file = filePath(sessionId);
  if (!file || !fs.existsSync(file)) return decideStub(state, session);

  try {
    const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
    const n = session.events.length - 1;
    if (Array.isArray(recorded) && recorded[n]) return recorded[n];
    warnMissing(sessionId, n);
  } catch {
    warnMissing(sessionId, session.events.length - 1);
  }
  return decideStub(state, session);
}

/** Does this session id have a recording file? Used by index.js to isolate
 * cached-mode playback from interleaved live-browser events (see the
 * x-agent-replay handling in index.js's /event handler). */
export function hasRecording(sessionId) {
  if (!isValidSessionId(sessionId)) return false;
  const file = filePath(sessionId);
  return !!file && fs.existsSync(file);
}

function warnMissing(sessionId, n) {
  if (warnedSessions.has(sessionId)) return;
  warnedSessions.add(sessionId);
  console.warn(`[cached] session "${sessionId}": no recorded entry at index ${n} — falling back to stub`);
}

/** Appends the PRE-policy {action, trace} proposal for a session to its recording. */
export function record(sessionId, entry) {
  if (!isValidSessionId(sessionId)) return;
  const file = filePath(sessionId);
  if (!file) return;
  fs.mkdirSync(RECORDED_DIR, { recursive: true });
  let existing = [];
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      existing = [];
    }
  }
  existing.push(entry);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}
