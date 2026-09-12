// persist.js round-trip test (server/OPS.md "Persistence") — uses node:test
// against a REAL Mongo at 127.0.0.1:27017 (assumed running — this repo's
// dev setup keeps one up for the agent server itself), db "sara_agent_test"
// (dropped at start and end so a rerun never sees stale state and never
// touches the real "sara_agent" db this test's own persist.js instance
// would otherwise share with a live server process). Run with:
//   node --test persist.test.js
//
// Two things are asserted:
//   1. Every persist.js function round-trips through a real Mongo
//      connection (saveEvent/saveDecision/upsertSession/listSessions/
//      getSession/saveOutcome).
//   2. With no init() call (the AGENT_DB_URI-unset case a live index.js
//      hits when persistence is off), every function is a no-op returning
//      null/[] rather than throwing or requiring callers to branch.

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { MongoClient } from "mongodb";
import * as persist from "./persist.js";

const TEST_URI = "mongodb://127.0.0.1:27017/sara_agent_test";

async function dropTestDb() {
  const client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  await client.db("sara_agent_test").dropDatabase();
  await client.close();
}

before(async () => {
  await dropTestDb();
});

after(async () => {
  await persist.close();
  await dropTestDb();
});

test("no-op mode: every function is a safe no-op when init() was never called", async () => {
  // A fresh, never-initialized module state is simulated by simply not
  // calling init() before these — matches a live process with AGENT_DB_URI
  // unset. isEnabled()/isConnected() must both read false.
  assert.equal(persist.isEnabled(), false);
  assert.equal(persist.isConnected(), false);
  assert.equal(await persist.saveEvent("s1", { i: 0, ts: 1, type: "page_view" }), null);
  assert.equal(await persist.saveDecision("s1", { ts: 1 }), null);
  assert.equal(await persist.upsertSession("s1", { site: "default" }), null);
  assert.deepEqual(await persist.listSessions({}), []);
  assert.equal(await persist.getSession("s1"), null);
  assert.equal(await persist.saveOutcome("s1", { action_id: "a1", outcome: "cta" }), null);
});

test("init() against a real Mongo + full round trip", async () => {
  const db = await persist.init(TEST_URI);
  assert.ok(db, "init() should return a connected db handle");
  assert.equal(persist.isConnected(), true);

  const sessionId = "persist_test_s1";

  await persist.saveEvent(sessionId, { i: 0, ts: 1000, type: "page_view", target: "/product/khadi-field-jacket", meta: { site: "default" } });
  await persist.saveEvent(sessionId, { i: 1, ts: 2000, type: "dwell", target: "size-guide", meta: { ms: 22000 } });

  await persist.upsertSession(sessionId, { site: "default", eventCount: 2, lastPage: "/product/khadi-field-jacket" });

  const decisionRecord = {
    ts: 2500,
    eventIndex: 1,
    trigger: "dwell",
    decided: "highlight size-guide",
    reason: "llm",
    ms: 850,
    action: { action: "highlight", target: "size-guide", style: "pulse", duration_ms: 8000, message: null, id: "act_1" },
    trace: {
      ts: 2500,
      signals: ["dwell size-guide 22s"],
      hypothesis: "shopper is hesitating on sizing",
      decision: "highlight size-guide",
      confidence: 0.8,
      why: "dwell above threshold",
    },
    delivered: true,
    mode: "llm",
    model: "sonnet",
    page: "/product/khadi-field-jacket",
  };
  await persist.saveDecision(sessionId, decisionRecord);
  await persist.upsertSession(sessionId, { site: "default", decisionCount: 1 });

  await persist.saveOutcome(sessionId, {
    action_id: "act_1",
    action: "highlight",
    target: "size-guide",
    cta_kind: null,
    outcome: "dismiss",
    ms_visible: 4000,
    ts: 3000,
  });

  // getSession round trip
  const got = await persist.getSession(sessionId);
  assert.ok(got, "getSession should find the session just written");
  assert.equal(got.session.session, sessionId);
  assert.equal(got.session.site, "default");
  assert.equal(got.session.eventCount, 2);
  assert.equal(got.session.decisionCount, 1);
  assert.equal(got.events.length, 2);
  assert.equal(got.events[0].type, "page_view");
  assert.equal(got.events[1].target, "size-guide");
  assert.equal(got.decisions.length, 1);
  assert.equal(got.decisions[0].decided, "highlight size-guide");
  assert.equal(got.decisions[0].trace.confidence, 0.8);
  assert.equal(got.outcomes.length, 1);
  assert.equal(got.outcomes[0].outcome, "dismiss");

  // listSessions
  const list = await persist.listSessions({ limit: 10 });
  const found = list.find((s) => s.session === sessionId);
  assert.ok(found, "listSessions should include the session just written");
  assert.equal(found.site, "default");

  // listSessions with a site filter that doesn't match anything
  const filtered = await persist.listSessions({ limit: 10, site: "some-other-site" });
  assert.equal(filtered.find((s) => s.session === sessionId), undefined);

  // getSession for an id that was never written
  assert.equal(await persist.getSession("no_such_session"), null);
});

test("upsertSession preserves firstSeen across repeated calls, updates lastSeen/updatedAt", async () => {
  const sessionId = "persist_test_s2";
  await persist.upsertSession(sessionId, { site: "default", eventCount: 1 });
  const first = (await persist.getSession(sessionId)).session;
  await new Promise((r) => setTimeout(r, 5));
  await persist.upsertSession(sessionId, { site: "default", eventCount: 2 });
  const second = (await persist.getSession(sessionId)).session;

  assert.equal(first.firstSeen, second.firstSeen, "firstSeen must not change on a second upsert");
  assert.equal(second.eventCount, 2);
  assert.ok(second.updatedAt >= first.updatedAt);
});
