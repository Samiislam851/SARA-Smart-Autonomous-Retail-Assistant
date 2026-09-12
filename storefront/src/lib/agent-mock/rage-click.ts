/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 *
 * This file intentionally crosses BUILD-DECISIONS.md §0 ("no sockets, SSE,
 * or push") to prove out a real-time admin -> shopper demo. It exists only
 * in the working tree for a live rehearsal and must never be `git add`ed or
 * committed. Do not edit BUILD-DECISIONS.md to "make this legal" — the rule
 * still protects the real, committed repo; this prototype is exempt only
 * because it never enters git history.
 *
 * Shared, side-effect-free pieces for the `rage_click` ("frustration
 * burst") signal mock — the demo's designated insurance beat: triggerable
 * in one second with zero setup, so it needs to be the most reliable thing
 * here. Two independent trigger paths both need the SAME chat copy:
 *
 *  - the admin-initiated command (`/api/agent-mock/command`, server-only),
 *  - the optional client-side local detector in `PdpAgentMockListener`.
 *
 * Keeping the copy (and the detector's tuning constants) in one importable
 * place means the two paths can never drift out of sync. Nothing in this
 * file touches the DOM or the network — the local detector's actual
 * pointer-tracking logic (which does need the DOM) stays in the component.
 */

/**
 * The tone is the whole point: acknowledge that the interface just failed
 * the shopper, don't deflect or stay falsely cheerful, and offer exactly
 * one concrete way forward.
 */
export const RAGE_CLICK_CHAT_TEXT =
  "That doesn't seem to be doing anything — sorry. Want me to take you straight to the size guide?";

/** Local-detector tuning, per the spec: 3+ pointerdowns within 800ms,
 * inside a 30px radius, on the same (non-interactive, non-opted-out)
 * element, with a 60s cooldown per element so a single burst doesn't
 * refire on every extra click past the third. */
export const RAGE_CLICK_MIN_EVENTS = 3;
export const RAGE_CLICK_WINDOW_MS = 800;
export const RAGE_CLICK_RADIUS_PX = 30;
export const RAGE_CLICK_COOLDOWN_MS = 60_000;

export interface PointRecord {
  x: number;
  y: number;
  time: number;
}

/** Euclidean distance check — pure, so it's testable without a DOM. Used
 * to decide whether two pointerdowns landed in "the same small area". */
export function withinRadius(a: PointRecord, b: PointRecord, radiusPx: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) <= radiusPx;
}
