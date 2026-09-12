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
 * Pure delivery-estimate computation for the `shipping_info_hunt`
 * ("delivery uncertainty") signal mock. Same rule as `variant-churn.ts`:
 * the one thing that actually matters — the date in the chat copy is a
 * REAL estimate computed from *today's* date at call time, never a
 * hardcoded string — lives in one small, side-effect-free place so it's
 * easy to see and to test. No DB access, no SSE here.
 *
 * "Answering the question beats pointing at where the answer lives" — so
 * this returns a concrete sentence ("Dispatches tomorrow, arrives Tue 16
 * Sep. Free returns within 30 days."), not a link to a policy page.
 */

// Dispatch: the next business day after `now` (a weekend push forward to
// Monday, same as any warehouse that doesn't ship Sat/Sun). Transit: a
// couple more business days on top of that — a plausible standard-shipping
// window for a demo, not a claim about any real carrier SLA.
const TRANSIT_BUSINESS_DAYS = 2;
const RETURN_WINDOW_DAYS = 30;

const weekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** The next business day strictly after `date` (skips Saturday/Sunday). */
function nextBusinessDay(date: Date): Date {
  let next = addDays(date, 1);
  while (isWeekend(next)) next = addDays(next, 1);
  return next;
}

/** `date` plus `count` business days, each step skipping weekends. */
function addBusinessDays(date: Date, count: number): Date {
  let result = date;
  for (let i = 0; i < count; i++) result = nextBusinessDay(result);
  return result;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Fixed "Wed 16 Sep" shape regardless of the runtime's default locale —
 * built from three explicit `en-US` formatters rather than one combined
 * formatter, since combined weekday+day+month formatting varies by locale
 * (some insert a comma, some use a 4-letter month). */
function formatDay(date: Date): string {
  return `${weekdayFormatter.format(date)} ${date.getDate()} ${monthFormatter.format(date)}`;
}

/** "tomorrow" when the dispatch date really is tomorrow relative to `now`;
 * otherwise a formatted weekday, so a dispatch pushed past a weekend reads
 * as "Mon 15 Sep" instead of a stale/misleading "tomorrow". */
function dispatchLabel(now: Date, dispatchDate: Date): string {
  return isSameCalendarDay(dispatchDate, addDays(now, 1)) ? "tomorrow" : formatDay(dispatchDate);
}

export interface ShippingEstimate {
  dispatchDate: Date;
  arrivalDate: Date;
  text: string;
}

/**
 * Computes the delivery estimate FROM the current date — never a fixed
 * string, so it can't go stale on camera. `now` defaults to `new Date()`;
 * callers only ever pass it explicitly from tests.
 */
export function computeShippingEstimate(now: Date = new Date()): ShippingEstimate {
  const dispatchDate = nextBusinessDay(now);
  const arrivalDate = addBusinessDays(dispatchDate, TRANSIT_BUSINESS_DAYS);

  const text =
    `Dispatches ${dispatchLabel(now, dispatchDate)}, arrives ${formatDay(arrivalDate)}. ` +
    `Free returns within ${RETURN_WINDOW_DAYS} days.`;

  return { dispatchDate, arrivalDate, text };
}

/** Chat copy for the `shipping_info_hunt` signal: the concrete answer, not
 * a link — pairs with a `reveal` on the shipping/returns accordion so the
 * panel opens as the answer arrives. */
export function shippingHuntChatCopy(now: Date = new Date()): { text: string; chips: string[] } {
  return { text: computeShippingEstimate(now).text, chips: [] };
}
