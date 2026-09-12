// Picks a decider by AGENT_MODE env var: stub (default) | llm | cached.

import { decide as decideStub } from "./stub.js";
import { decide as decideLlm } from "./llm.js";
import { decide as decideCached } from "./cached.js";

const MODE = process.env.AGENT_MODE || "stub";

const DECIDERS = {
  stub: decideStub,
  llm: decideLlm,
  cached: decideCached,
};

// llm's decide() is always async. stub/cached are sync-returning by default,
// except stub with AGENT_STUB_DELAY_MS set (test-only artificial latency —
// see decide/stub.js), which returns a Promise instead. `await` on the
// caller side (index.js's decideAndBroadcast()) handles all of these —
// awaiting a non-promise value is a no-op that just resolves to it.
export function decide(state, session) {
  const fn = DECIDERS[MODE] ?? decideStub;
  return fn(state, session);
}

export const AGENT_MODE = MODE;
