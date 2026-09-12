// Fixture loading/listing helpers for the in-page "no-terminal" demo player
// (GET /demo/fixtures, POST /demo/play/:fixture in index.js). Pure
// filesystem/parsing logic only — the actual event feeding (runSerialized +
// processEvent, session reset, broadcast) stays in index.js since those live
// as closures there.
//
// Fixture names come from the URL (`:fixture` param) — never trust one as a
// filesystem path component, same category of bug as session ids
// (server/contracts.js SESSION_ID_RE) and decide/cached.js's recording path.
// One shared pattern here, checked before any fs access.

import fs from "node:fs";
import path from "node:path";
import { isValidSessionId } from "./contracts.js";

export const FIXTURE_NAME_RE = /^[a-z0-9-]+$/;

const FIXTURES_DIR = path.join(process.cwd(), "sessions");
const RECORDED_DIR = path.join(FIXTURES_DIR, "recorded");

function safeFixturePath(name) {
  if (typeof name !== "string" || !FIXTURE_NAME_RE.test(name)) return null;
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  // Defense in depth: even though FIXTURE_NAME_RE should already reject
  // anything with path separators or "..", never resolve to a path outside
  // the fixtures dir (mirrors decide/cached.js's filePath()).
  const resolvedDir = path.resolve(FIXTURES_DIR);
  const resolved = path.resolve(file);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return file;
}

/** First page_view event's target (the path a browser tab must be on to see
 * this fixture play) — null if the fixture has no page_view event. */
export function fixturePage(fixture) {
  const pv = (fixture.events || []).find((e) => e.type === "page_view");
  return pv?.target ?? null;
}

/**
 * Loads and lightly validates one fixture by name. Returns null (never
 * throws) for a bad/unknown name, missing file, unparsable JSON, or a
 * fixture missing the fields the demo player needs.
 */
export function loadFixture(name) {
  const file = safeFixturePath(name);
  if (!file || !fs.existsSync(file)) return null;
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!fixture || typeof fixture !== "object") return null;
  if (typeof fixture.session !== "string" || !Array.isArray(fixture.events)) return null;
  return {
    name,
    session: fixture.session,
    description: fixture.description ?? "",
    expect: fixture.expect ?? null,
    page: fixturePage(fixture),
    events: fixture.events,
  };
}

/** Every fixture file's basename (no .json ext) in sessions/, in filename
 * order — regardless of whether it has a recording. Callers filter by
 * hasRecording() themselves (that check lives in decide/cached.js). */
export function listFixtureNames() {
  let entries;
  try {
    entries = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.slice(0, -".json".length))
    .filter((name) => FIXTURE_NAME_RE.test(name))
    .sort();
}

/** Total scripted delay across a fixture's events, in ms, before dividing by
 * playback speed — used for POST /demo/play's `estimatedMs` response field. */
export function fixtureDurationMs(fixture) {
  return (fixture.events || []).reduce((sum, e) => sum + (e.delay_ms ?? 0), 0);
}

function recordingPath(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const file = path.join(RECORDED_DIR, `${sessionId}.json`);
  // Defense in depth, same pattern as safeFixturePath()/decide/cached.js's
  // filePath(): never resolve to a path outside the recordings dir.
  const resolvedDir = path.resolve(RECORDED_DIR);
  const resolved = path.resolve(file);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return file;
}

function loadRecordingEntries(sessionId) {
  const file = recordingPath(sessionId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * verifyRecording(fixture) → boolean. Guards against listing a fixture in
 * the demo player whose recording doesn't actually reproduce its `expect` —
 * e.g. an all-noop recording under a `message`/`highlight` expect, which
 * would look like the demo player did nothing when played on camera.
 *
 *   - expect.action === "noop" → verified iff the recording contains no
 *     non-noop proposal at all.
 *   - any other expect.action → verified iff the recording contains at
 *     least one proposal whose action matches expect.action and, when
 *     expect.target is given, whose target also matches.
 *
 * Returns false (never throws) for a fixture with no/malformed `expect`,
 * no recording, or an unparsable recording file.
 */
export function verifyRecording(fixture) {
  const expect = fixture?.expect;
  if (!expect || typeof expect.action !== "string") return false;
  const recording = loadRecordingEntries(fixture.session);
  if (!recording) return false;

  // Each recorded entry is the decider's pre-policy PROPOSAL, shaped
  // {action: {action, target, ...}, trace: {...}} — see decide/cached.js's
  // record()/decide() and policy.js's normalizeAction(). The proposal's
  // action TYPE lives at entry.action.action, not entry.action.
  const proposalAction = (entry) => entry?.action?.action;
  const proposalTarget = (entry) => entry?.action?.target;

  if (expect.action === "noop") {
    return recording.every((entry) => !entry || proposalAction(entry) === "noop");
  }
  return recording.some(
    (entry) => proposalAction(entry) === expect.action && (expect.target == null || proposalTarget(entry) === expect.target)
  );
}
