// Optional durable persistence layer — off by default, on when AGENT_DB_URI
// is set. Every durable artifact of the agent (events, decision traces,
// outcome events, a per-session summary) otherwise lives only in
// server/state.js's in-memory Map (LRU-evicted) and server/live-record.js's
// per-session JSON files (opt-in, local disk only, no query surface) — both
// die/reset with the process or the container's ephemeral filesystem. This
// module adds a queryable, durable mirror in MongoDB, reusing the record
// shapes live-record.js already writes (decisions: {ts, eventIndex, trigger,
// decided, reason, ms, action, trace, delivered}; events: {i, ts, type,
// target, meta, replay}) so research-routes.js can serve the same JSON shape
// whether it came from memory, a live-record file, or Mongo.
//
// Design constraints (see server/OPS.md "Persistence"):
//  - All writes are fire-and-forget (`.catch(log)`) — never awaited by the
//    decision loop, never add latency to POST /event or a decision cycle.
//  - A Mongo outage degrades to in-memory/file behavior with ONE warning
//    log (not one per failed write, not a crash) — see warnOnce() below.
//  - When AGENT_DB_URI is unset, every exported function is a no-op
//    returning null/[] so every call site can call unconditionally with no
//    `if (dbEnabled)` branching.
//
// Collections (db "sara_agent" by default, or whatever db the URI names):
//  - sessions:  { _id: sessionId, site, firstSeen, lastSeen, eventCount,
//                 decisionCount, lastPage, updatedAt }
//  - events:    { sessionId, i, ts, type, target, meta, replay }
//  - decisions: { sessionId, ts, eventIndex, trigger, decided, reason, ms,
//                 action, trace, delivered }
//  - outcomes:  { sessionId, action_id, action, target, cta_kind, outcome,
//                 ms_visible, ts }

import { MongoClient } from "mongodb";
import { log } from "./log.js";

let client = null;
let db = null;
let connecting = null;
let warned = false;

function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  log.warn("persist: mongo unavailable, degrading to in-memory/file behavior only", {
    context,
    err: String(err?.message ?? err),
  });
}

/** True once init() has been called with a truthy uri, regardless of
 * whether the connection actually succeeded — mirrors "enabled" in /health. */
export function isEnabled() {
  return Boolean(process.env.AGENT_DB_URI);
}

/** True once a live Mongo connection has been established. */
export function isConnected() {
  return Boolean(db);
}

/**
 * init(uri) — connect and ensure indexes. Safe to call with uri falsy (no-op).
 * Never throws: a connect failure is logged once and leaves db=null, so every
 * other exported function below behaves exactly as if AGENT_DB_URI were unset.
 */
export async function init(uri) {
  if (!uri) return null;
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const dbName = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http$1://")).pathname.replace(/^\//, "") || "sara_agent";
      const database = client.db(dbName);
      await database.collection("sessions").createIndex({ updatedAt: -1 });
      await database.collection("sessions").createIndex({ site: 1 });
      await database.collection("decisions").createIndex({ sessionId: 1, ts: 1 });
      await database.collection("events").createIndex({ sessionId: 1, i: 1 });
      await database.collection("outcomes").createIndex({ sessionId: 1, action_id: 1 });
      db = database;
      log.info("persist: mongo connected", { uri: uri.replace(/\/\/[^@]*@/, "//***@") });
      return db;
    } catch (err) {
      warnOnce("init", err);
      db = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** saveEvent(sessionId, ev) — append one event to the `events` collection.
 * Fire-and-forget by convention (callers don't await); still returns the
 * promise so a caller that WANTS to await (e.g. the test suite) can. */
export async function saveEvent(sessionId, ev) {
  if (!db) return null;
  try {
    return await db.collection("events").insertOne({
      sessionId,
      i: ev.i,
      ts: ev.ts ?? Date.now(),
      type: ev.type,
      target: ev.target ?? null,
      meta: ev.meta ?? null,
      replay: Boolean(ev.replay),
    });
  } catch (err) {
    warnOnce("saveEvent", err);
    return null;
  }
}

/** saveDecision(sessionId, decisionRecord) — append one full decision trace
 * (signals, hypothesis, action, reason, latency, model — whatever the
 * caller's record already contains, e.g. the same shape index.js hands to
 * live-record.js's recordDecision()) to the `decisions` collection. */
export async function saveDecision(sessionId, decisionRecord) {
  if (!db) return null;
  try {
    return await db.collection("decisions").insertOne({ sessionId, ...decisionRecord });
  } catch (err) {
    warnOnce("saveDecision", err);
    return null;
  }
}

/** upsertSession(sessionId, summary) — merge a session-level summary
 * (site, lastPage, eventCount, decisionCount, ... — caller passes absolute
 * counts, not deltas) into the `sessions` collection. firstSeen is set only
 * on insert ($setOnInsert); everything else is $set on every call. */
export async function upsertSession(sessionId, summary = {}) {
  if (!db) return null;
  const now = Date.now();
  try {
    return await db.collection("sessions").updateOne(
      { _id: sessionId },
      {
        $set: { ...summary, lastSeen: now, updatedAt: now },
        $setOnInsert: { firstSeen: now },
      },
      { upsert: true }
    );
  } catch (err) {
    warnOnce("upsertSession", err);
    return null;
  }
}

/** listSessions({limit, site}) → session summaries, most-recently-updated
 * first. [] when disabled/unavailable — never null, so callers can spread
 * it into an array unconditionally. */
export async function listSessions({ limit = 50, site } = {}) {
  if (!db) return [];
  try {
    const q = site ? { site } : {};
    const docs = await db
      .collection("sessions")
      .find(q)
      .sort({ updatedAt: -1 })
      .limit(Math.min(500, Math.max(1, Number(limit) || 50)))
      .toArray();
    return docs.map((d) => ({ ...d, session: d._id }));
  } catch (err) {
    warnOnce("listSessions", err);
    return [];
  }
}

/** getSession(id) → { session, events, decisions } or null. */
export async function getSession(id) {
  if (!db) return null;
  try {
    const [session, events, decisions, outcomes] = await Promise.all([
      db.collection("sessions").findOne({ _id: id }),
      db.collection("events").find({ sessionId: id }).sort({ i: 1 }).toArray(),
      db.collection("decisions").find({ sessionId: id }).sort({ ts: 1 }).toArray(),
      db.collection("outcomes").find({ sessionId: id }).toArray(),
    ]);
    if (!session) return null;
    return { session: { ...session, session: session._id }, events, decisions, outcomes };
  } catch (err) {
    warnOnce("getSession", err);
    return null;
  }
}

/** saveOutcome(sessionId, outcome) — append one outcome event (server's
 * agent_outcome handling — see index.js handleOutcomeEvent / live-record.js
 * recordOutcome) to the `outcomes` collection. */
export async function saveOutcome(sessionId, outcome) {
  if (!db) return null;
  try {
    return await db.collection("outcomes").insertOne({ sessionId, ...outcome });
  } catch (err) {
    warnOnce("saveOutcome", err);
    return null;
  }
}

/** close() — for tests: disconnect cleanly. Not called by index.js (the
 * process just exits with the connection open, same as every other resource
 * this server holds). */
export async function close() {
  if (client) {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
  client = null;
  db = null;
  warned = false;
}
