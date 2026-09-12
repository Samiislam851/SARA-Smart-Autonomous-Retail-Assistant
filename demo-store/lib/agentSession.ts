// Single source of truth for resolving + persisting the active
// `agent_session` id, and for keeping every OTHER sessionStorage-backed
// store that is scoped to that shopper IDENTITY (suggestions tray, cart)
// from leaking across a session switch in the same tab.
//
// `?agent_session=<id>` (DEMO.md "demo pinning") re-pins a tab to a
// DIFFERENT shopper identity without closing it — e.g. a live browser pass
// running session A, then B, then a fresh C in the same tab. Before this
// fix, only the `agent_session` key itself got overwritten; every other
// per-identity sessionStorage key (suggestions tray, unseen-count
// timestamp, cart, applied promo) kept its old value, so a brand-new
// session C would show A/B's cards and cart contents even though the
// server has zero interventions for C.
//
// Resolved once per page load (module-level, evaluated on first import —
// cart.ts and AgentWidget.tsx both import this file specifically so the
// clear-on-change guard below runs, exactly once, before either module's
// own storage reads). A full session switch is always a full navigation
// (see AgentWidget.tsx's handleDemoClick -> window.location.assign), so
// "once per page load" is sufficient — there is no in-page code path that
// changes `?agent_session=` without a reload.
//
// server/public/agent.js is a standalone <script> embed and can't import
// this file — it carries its own copy of this same resolve+clear logic in
// its getSessionId()/clearPerSessionStorage(); keep the two in sync.

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_KEY = "agent_session";

// Keyed to the shopper IDENTITY, not the browser tab — wiped whenever the
// resolved session id changes. `agent_enabled`/`agent_panel_open` are
// deliberately NOT here: those are per-TAB UI preferences (on/off toggle,
// panel collapsed/open), unaffected by which identity is currently active.
const PER_SESSION_KEYS = [
  "agent_suggestions",
  "agent_suggestions_seen_at",
  "agent_cart",
  "agent_cart_promo_code",
];

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // best-effort — matches every other storage access in this codebase
  }
}

function clearPerSessionStorage(): void {
  for (const key of PER_SESSION_KEYS) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // best-effort
    }
  }
}

function resolve(): string {
  if (typeof window === "undefined") return "";

  const fromUrl = new URLSearchParams(window.location.search).get(SESSION_KEY);
  const stored = readStorage(SESSION_KEY);

  if (fromUrl && SESSION_ID_RE.test(fromUrl)) {
    if (fromUrl !== stored) clearPerSessionStorage();
    writeStorage(SESSION_KEY, fromUrl);
    return fromUrl;
  }

  let id = stored;
  if (id && !SESSION_ID_RE.test(id)) id = null; // stale/corrupt stored value
  if (!id) {
    id = "s_" + Math.random().toString(36).slice(2, 10);
    writeStorage(SESSION_KEY, id);
  }
  return id;
}

// Evaluated once, at first import of this module (by whichever of
// cart.ts / AgentWidget.tsx loads first) — every subsequent import gets the
// same cached id, and the clear-on-change guard above has already run.
const AGENT_SESSION_ID = resolve();

export function getSessionId(): string {
  return AGENT_SESSION_ID;
}
